import initWasm, {
  detectFileFormat,
  readCadDocument,
  readPreviewDxfDocument,
  readDxfString,
  newJwwDocument,
  toJwwBytes,
} from "./wasm/ezjww_wasm.js";
import type {
  DxfDocument,
  DxfEntity,
  CadDocument,
  JwcCoordinateSpace,
  JwwEntity,
  JwwWriteDocument,
} from "../../../src/index";
import "./styles.css";

type ViewMode = "summary" | "entities" | "json";

interface ParsedState {
  fileName: string;
  fileSize: number;
  cad: CadDocument;
  dxf: DxfDocument;
  dxfText: string;
  elapsedMs: number;
  explodeInserts: boolean;
  generatedJww?: Uint8Array;
}

interface CurrentInput {
  name: string;
  size: number;
  bytes: Uint8Array;
  generated?: boolean;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("missing #app");
}

let wasmReady: Promise<void> | null = null;
let parsedState: ParsedState | null = null;
let currentInput: CurrentInput | null = null;
let viewMode: ViewMode = "summary";
let explodeInserts = true;
let jwcCoordinates: JwcCoordinateSpace = "paper_millimeters";
let viewZoom = 1, viewPanX = 0, viewPanY = 0, redrawQueued = false;
// Preview-only POINT display size in CSS pixels at 100% zoom.
const pointDisplayRadius = 0.75;
let showJwwLineTypes = true;
let canvasBackground: "white" | "black" = "black";
// Twofold increase from the V018 32x limit; bounded for iPhone precision.
const MAX_VIEW_ZOOM = 64;
const pointers = new Map<number, {x:number,y:number}>();
type Gesture = {mode:"pan"; origin:{x:number,y:number}; panX:number; panY:number}
  | {mode:"pinch"; distance:number; zoom:number; anchor:{x:number,y:number}};
let gesture: Gesture | null = null;

/* V011: text hit-testing uses the DXF view returned by ezjww.
   No input JWW data is modified and no JWW write-back is attempted. */
type TextHit = {
  index: number; content: string; layer: string;
  x: number; y: number; width: number; height: number; angle: number;
};
let textHits: TextHit[] = [];
let selectedTextIndex: number | null = null;
let tapCandidate: { id: number; x: number; y: number; valid: boolean } | null = null;
// Text edits are tracked separately from immutable original JWW bytes.
type TextChange = { index: number; before: string; after: string };
const textUndoStack: TextChange[] = [];
const textRedoStack: TextChange[] = [];
type OriginalText = { before: string; layer: string; x: number; y: number; rotation: number };
const originalText = new Map<number, OriginalText>();

// V020: original JWW text records are observational only. Never mutate them.
interface NativeJwwText {
  content: string;
  fontName: string;
  textType: number;
  sizeX: number;
  sizeY: number;
  spacing: number;
  angle: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  layerGroup: number;
  layer: number;
}
type PdfRangeMode = "whole" | "viewport" | "rectangle";
let pdfRangeMode: PdfRangeMode = "rectangle";
// Selecting 2 points is a transient input state; PDF output mode and text
// selection must NOT be tied together after the rectangle is complete.
let pdfRangePicking = false;
let pdfRangeStart: {x:number;y:number} | null = null;
let pdfRangeBounds: Bounds | null = null;
const nativeTextByDxfIndex = new Map<number, NativeJwwText>();
let nativeTextMatched = 0;
let nativeTextTotal = 0;

app.innerHTML = `
  <header class="topbar">
    <div>
      <div class="eyebrow">ezjww · V035</div>
      <h1>JWW簡易CAD</h1>
    </div>
    <div class="actions">
      <label class="toggle" hidden>
        <input id="explode-toggle" type="checkbox" checked />
        <span>INSERT展開（内部ON固定）</span>
      </label>
      <label class="toggle" hidden>JWCの座標
        <select id="coordinate-select"><option value="paper_millimeters">紙上mm</option><option value="model_millimeters">実寸mm</option></select>
      </label>
      <button id="save-jww" class="tool-button" type="button" disabled>JWW保存</button>
      <button id="open-share-panel" class="tool-button" type="button" disabled>PDF保存(共有等)</button>
      <button id="sample-button" class="tool-button" type="button" hidden>サンプル読込</button>
      <button id="create-button" class="tool-button" type="button" hidden>JWW作成例</button>
      <button id="download-jww-button" class="tool-button" type="button" disabled hidden>生成JWW保存</button>
      <label class="file-button">
        <input id="file-input" type="file" accept=".jww,.jwc,.jws,application/octet-stream" />
        ファイル選択
      </label>
    </div>
  </header>
  <section id="share-panel" class="cad-share-panel" hidden aria-label="PDF保存・共有">
    <div class="cad-share-head">
      <strong>PDF保存・共有</strong>
      <button id="close-share-panel" type="button" aria-label="PDF設定を閉じる">×</button>
    </div>
    <div class="cad-pdf-settings">
      <label for="pdf-paper-select">用紙
        <select id="pdf-paper-select">
          <option value="A4" selected>A4</option>
          <option value="A3">A3</option>
        </select>
      </label>
      <label for="pdf-range-select">印刷範囲
        <select id="pdf-range-select">
          <option value="whole">図面全体</option>
          <option value="viewport">現在の画面</option>
          <option value="rectangle" selected>範囲指定（2点）</option>
        </select>
      </label>
      <div class="cad-pdf-range-actions">
        <button id="pdf-range-reselect" type="button">範囲を指定・選び直す</button>
        <button id="pdf-range-clear" type="button">範囲をクリア</button>
        <span id="pdf-range-status" role="status" aria-live="polite" hidden></span>
      </div>
      <div class="cad-share-actions">
        <button id="share-pdf" type="button">PDFを保存・共有</button>
      </div>
    </div>
    <p id="share-result" class="cad-share-result" role="status" aria-live="polite" hidden></p>
  </section>

  <main class="shell">
    <section class="left-pane" hidden aria-hidden="true">
      <div id="dropzone" class="dropzone" tabindex="0">
        <div class="drop-title">JWW/JWC/JWSファイルをドロップ</div>
        <div id="status-line" class="drop-status">未読込</div>
      </div>

      <div id="metrics" class="metrics"></div>
      <div id="counts" class="panel"></div>
      <div id="layers" class="panel"></div>
    </section>

    <section class="right-pane">
      <div class="preview-head">
        <div>
          <div class="section-label">Preview</div>
          <div id="preview-meta" class="muted">No drawing</div>
        </div>
        <div class="preview-zoom-controls" aria-label="図面表示操作">
          <button id="zoom-out" type="button">－</button>
          <span id="zoom-level">100%</span>
          <button id="zoom-in" type="button">＋</button>
          <!-- Original line styles are always on. Retain the hidden select as
                 an internal compatibility hook for restored JWW sessions. -->
          <select id="line-style-select" hidden style="display:none" aria-hidden="true">
            <option value="original" selected>原図</option>
          </select>
          <label class="point-size-control">背景
            <select id="canvas-background-select" aria-label="図面の背景色">
              <option value="white">白</option>
              <option value="black" selected>黒</option>
            </select>
          </label>
        </div>
      </div>
      <div class="drawing-frame">
        <div id="drawing-stage" class="drawing-stage">
        <canvas id="preview-canvas" class="preview" width="1200" height="760"></canvas>
        <button id="floating-fit-button" class="floating-fit-button" type="button" hidden aria-label="図面を全体表示">全画面</button>
        <div id="pdf-range-indicator" class="pdf-range-indicator" hidden>PDF範囲：図面上の1点目をタップ</div>
        <button id="pdf-range-exit" class="pdf-range-exit" type="button" hidden>✕ 範囲クリア・文字編集へ</button>
        <div id="text-edit-panel" class="text-edit-panel" hidden>
          <div class="editor-heading"><label for="text-edit-input">文字編集</label><button id="text-edit-close" type="button" aria-label="編集を閉じる">×</button></div>
          <div id="text-selection-status" class="text-selection-status" role="status" aria-live="polite">
            V020：文字をタップすると原図の文字属性を照合できます。
          </div>
          <details id="native-text-attrs" class="native-text-attrs">
            <summary>元JWWの文字属性を表示</summary>
            <div id="native-text-attr-body" class="native-text-attr-body"></div>
          </details>
          <label for="text-edit-input">選択文字を変更</label>
          <input id="text-edit-input" type="text" placeholder="図面の文字を選択してください" autocomplete="off" autocapitalize="off" spellcheck="false" disabled />
          <div class="text-edit-actions">
            <button id="text-edit-apply" type="button" disabled>文字変更</button>
            <button id="text-edit-undo" type="button" disabled>元に戻す</button>
            <button id="text-edit-redo" type="button" disabled>やり直す</button>
            <button id="text-edit-clear" type="button" disabled>選択解除</button>
          </div>
          <div id="text-edit-note" class="text-edit-note">文字変更は端末内の作業に記憶します。JWW保存時は元図・属性を照合して安全に保存できる場合のみ別名出力します。</div>
        </div>

        </div>
        <div id="session-status" class="session-status" hidden aria-hidden="true" style="display:none"></div>
      </div>
      <details class="preview-diagnostics" hidden aria-hidden="true" style="display:none">
        <summary>線種などの表示情報</summary>
        <div id="line-style-status" class="line-style-status" role="status">
          V013：補助線色・補助線種は常時非表示。ほかの線種を再現します。
        </div>
      </details>
      <details id="font-audit-panel" class="font-audit-panel" hidden aria-hidden="true" style="display:none">
        <summary>元図のフォント一覧・文字属性の照合結果</summary>
        <div id="font-audit-body" class="font-audit-body"></div>
      </details>
      <details class="developer-details" hidden aria-hidden="true" style="display:none">
        <summary>開発用の詳細情報</summary>
        <div id="detail" class="detail"></div>
      </details>
    </section>
  </main>
  <div id="leave-confirm" class="leave-confirm" hidden role="dialog" aria-modal="true" aria-labelledby="leave-confirm-title">
    <div class="leave-confirm-card">
      <h2 id="leave-confirm-title">図面を開いています</h2>
      <p id="leave-confirm-description">図面と編集内容は、このiPhone内に一時保存しています。</p>
      <p id="leave-confirm-status" class="leave-confirm-status"></p>
      <div class="leave-confirm-actions">
        <button id="leave-stay" type="button">編集を続ける</button>
        <button id="leave-save" type="button">一時保存して前のページへ</button>
      </div>
      <small>端末内一時保存は元JWWの上書きではありません。JWW保存は別ファイルとして作成します。文字変更JWWは保存後にJw_cad 7.11で確認してください。</small>
    </div>
  </div>
`;

const fileInput = document.querySelector<HTMLInputElement>("#file-input")!;
const sessionStatusElement = document.querySelector<HTMLDivElement>("#session-status")!;
const leaveConfirmModal = document.querySelector<HTMLDivElement>("#leave-confirm")!;
const leaveConfirmStatus = document.querySelector<HTMLParagraphElement>("#leave-confirm-status")!;
const leaveConfirmTitle = document.querySelector<HTMLHeadingElement>("#leave-confirm-title")!;
const leaveConfirmDescription = document.querySelector<HTMLParagraphElement>("#leave-confirm-description")!;
const leaveStayButton = document.querySelector<HTMLButtonElement>("#leave-stay")!;
const leaveSaveButton = document.querySelector<HTMLButtonElement>("#leave-save")!;
const dropzone = document.querySelector<HTMLDivElement>("#dropzone")!;
const statusLine = document.querySelector<HTMLDivElement>("#status-line")!;
const explodeToggle = document.querySelector<HTMLInputElement>("#explode-toggle")!;
const sampleButton = document.querySelector<HTMLButtonElement>("#sample-button")!;
const canvas = document.querySelector<HTMLCanvasElement>("#preview-canvas")!;
const coordinateSelect = document.querySelector<HTMLSelectElement>("#coordinate-select")!;
const saveJwwButton = document.querySelector<HTMLButtonElement>("#save-jww")!;
const createButton = document.querySelector<HTMLButtonElement>("#create-button")!;
const downloadJwwButton = document.querySelector<HTMLButtonElement>("#download-jww-button")!;
const openSharePanelButton = document.querySelector<HTMLButtonElement>("#open-share-panel")!;
const sharePanel = document.querySelector<HTMLElement>("#share-panel")!;
const closeSharePanelButton = document.querySelector<HTMLButtonElement>("#close-share-panel")!;
const pdfPaperSelect = document.querySelector<HTMLSelectElement>("#pdf-paper-select")!;
const pdfRangeSelect = document.querySelector<HTMLSelectElement>("#pdf-range-select")!;
const pdfRangeReselect = document.querySelector<HTMLButtonElement>("#pdf-range-reselect")!;
const pdfRangeClear = document.querySelector<HTMLButtonElement>("#pdf-range-clear")!;
const pdfRangeExit = document.querySelector<HTMLButtonElement>("#pdf-range-exit")!;
const pdfRangeStatus = document.querySelector<HTMLSpanElement>("#pdf-range-status")!;
const pdfRangeIndicator = document.querySelector<HTMLDivElement>("#pdf-range-indicator")!;
const sharePdfButton = document.querySelector<HTMLButtonElement>("#share-pdf")!;
const shareResult = document.querySelector<HTMLParagraphElement>("#share-result")!;
const textEditPanel = document.querySelector<HTMLDivElement>("#text-edit-panel")!;
const textEditInput = document.querySelector<HTMLInputElement>("#text-edit-input")!;
const textEditApply = document.querySelector<HTMLButtonElement>("#text-edit-apply")!;
const textEditUndo = document.querySelector<HTMLButtonElement>("#text-edit-undo")!;
const textEditRedo = document.querySelector<HTMLButtonElement>("#text-edit-redo")!;
const textEditClear = document.querySelector<HTMLButtonElement>("#text-edit-clear")!;
const textEditNote = document.querySelector<HTMLDivElement>("#text-edit-note")!;
const nativeTextAttrs = document.querySelector<HTMLDetailsElement>("#native-text-attrs")!;
const nativeTextAttrBody = document.querySelector<HTMLDivElement>("#native-text-attr-body")!;
const fontAuditBody = document.querySelector<HTMLDivElement>("#font-audit-body")!;
const textEditClose = document.querySelector<HTMLButtonElement>("#text-edit-close")!;
const floatingFitButton = document.querySelector<HTMLButtonElement>("#floating-fit-button")!;

const zoomLevel = document.querySelector<HTMLSpanElement>("#zoom-level")!;
function redrawZoom(): void {
  zoomLevel.textContent = Math.round(viewZoom * 100) + "%";
  scheduleWorkingSave(1300);
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    renderPreview(parsedState);
  });
}
function resetZoom(): void {
  viewZoom = 1; viewPanX = 0; viewPanY = 0;
  zoomLevel.textContent = "100%";
}
function zoomAt(factor: number, pos:{x:number,y:number}): void {
  const r = canvas.getBoundingClientRect(), cx = r.width/2, cy = r.height/2;
  const ax = (pos.x - cx - viewPanX)/viewZoom + cx;
  const ay = (pos.y - cy - viewPanY)/viewZoom + cy;
  viewZoom = Math.min(MAX_VIEW_ZOOM, Math.max(0.5, viewZoom * factor));
  viewPanX = pos.x - cx - (ax-cx)*viewZoom;
  viewPanY = pos.y - cy - (ay-cy)*viewZoom;
  redrawZoom();
}
function localPoint(e:PointerEvent):{x:number,y:number} {
  const r=canvas.getBoundingClientRect();
  return {x:e.clientX-r.left, y:e.clientY-r.top};
}
function startGesture():void {
  const arr=Array.from(pointers.values());
  if (!arr.length) { gesture=null; return; }
  if (arr.length===1) {
    gesture={mode:"pan",origin:{...arr[0]},panX:viewPanX,panY:viewPanY};
  } else {
    const [a,b]=arr, mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    const r=canvas.getBoundingClientRect(),cx=r.width/2,cy=r.height/2;
    gesture={mode:"pinch",distance:Math.max(1,Math.hypot(b.x-a.x,b.y-a.y)),
      zoom:viewZoom,anchor:{x:(mid.x-cx-viewPanX)/viewZoom+cx,y:(mid.y-cy-viewPanY)/viewZoom+cy}};
  }
}
canvas.addEventListener("pointerdown",e=>{
  if(e.pointerType==="mouse"&&e.button!==0)return;
  e.preventDefault();
  const point = localPoint(e);
  pointers.set(e.pointerId,point);
  if (pointers.size === 1) {
    tapCandidate = { id:e.pointerId, x:point.x, y:point.y, valid:true };
  } else if (tapCandidate) {
    tapCandidate.valid = false;
  }
  canvas.setPointerCapture(e.pointerId);startGesture();
});
canvas.addEventListener("pointermove",e=>{
  if(!pointers.has(e.pointerId))return;
  e.preventDefault();
  const point=localPoint(e);
  pointers.set(e.pointerId,point);
  if(tapCandidate && e.pointerId===tapCandidate.id &&
    Math.hypot(point.x-tapCandidate.x,point.y-tapCandidate.y)>9) {
    tapCandidate.valid=false;
  }
  const arr=Array.from(pointers.values());
  if(!gesture)return;
  if(arr.length===1&&gesture.mode==="pan"){
    viewPanX=gesture.panX+arr[0].x-gesture.origin.x;
    viewPanY=gesture.panY+arr[0].y-gesture.origin.y;
  }else if(arr.length>=2&&gesture.mode==="pinch"){
    const [a,b]=arr,mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    viewZoom=Math.min(MAX_VIEW_ZOOM,Math.max(0.5,gesture.zoom*Math.hypot(b.x-a.x,b.y-a.y)/gesture.distance));
    const r=canvas.getBoundingClientRect(),cx=r.width/2,cy=r.height/2;
    viewPanX=mid.x-cx-(gesture.anchor.x-cx)*viewZoom;
    viewPanY=mid.y-cy-(gesture.anchor.y-cy)*viewZoom;
  }
  redrawZoom();
});
function endGesture(e:PointerEvent):void {
  if(!pointers.has(e.pointerId))return;
  const point=localPoint(e);
  const shouldPick=e.type==="pointerup" && pointers.size===1 &&
    tapCandidate?.id===e.pointerId && tapCandidate.valid &&
    Math.hypot(point.x-tapCandidate.x,point.y-tapCandidate.y)<=9;
  pointers.delete(e.pointerId);
  if(tapCandidate?.id===e.pointerId)tapCandidate=null;
  startGesture();
  if (shouldPick) {
    if (pdfRangeMode === "rectangle" && pdfRangePicking) handlePdfRangeTap(point);
    else selectTextAt(point);
  }
}
canvas.addEventListener("pointerup",endGesture);
canvas.addEventListener("pointercancel",endGesture);
canvas.addEventListener("lostpointercapture",endGesture);
canvas.addEventListener("wheel",e=>{
  e.preventDefault();
  const r=canvas.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY*0.002),{x:e.clientX-r.left,y:e.clientY-r.top});
},{passive:false});
document.querySelector<HTMLButtonElement>("#zoom-in")!.addEventListener("click",()=>{
  const r=canvas.getBoundingClientRect();zoomAt(1.5,{x:r.width/2,y:r.height/2});
});
document.querySelector<HTMLButtonElement>("#zoom-out")!.addEventListener("click",()=>{
  const r=canvas.getBoundingClientRect();zoomAt(1/1.5,{x:r.width/2,y:r.height/2});
});
function fitWholeDrawing(): void {
  resetZoom();
  redrawZoom();
}
floatingFitButton.addEventListener("click", fitWholeDrawing);
// Line styles always follow the original JWW; no public mode switch.
document.querySelector<HTMLSelectElement>("#canvas-background-select")!.addEventListener("change", e => {
  canvasBackground = (e.currentTarget as HTMLSelectElement).value === "black" ? "black" : "white";
  redrawZoom();
  scheduleWorkingSave(350);
});
// Keep editing separate from the gesture controls and the original DXF exporter.
textEditInput.addEventListener("input", () => {
  updateTextEditControls();
  updateNavigationProtection();
  scheduleWorkingSave(160);
});
textEditInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyTextEdit();
    textEditInput.blur();
  }
});
textEditApply.addEventListener("click", applyTextEdit);
textEditUndo.addEventListener("click", undoTextEdit);
textEditRedo.addEventListener("click", redoTextEdit);
function closeTextEditor(): void {
  selectedTextIndex = null;
  syncTextEditPanel();
  redrawZoom();
  queueWorkingSave();
  updateNavigationProtection();
}
textEditClear.addEventListener("click", closeTextEditor);
textEditClose.addEventListener("click", closeTextEditor);

createButton.addEventListener("click", () => { void createDrawing(); });
downloadJwwButton.addEventListener("click", () => {
  if (!parsedState?.generatedJww) return;
  const url = URL.createObjectURL(new Blob([Uint8Array.from(parsedState.generatedJww)], {
    type: "application/octet-stream",
  }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "created.jww";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
coordinateSelect.addEventListener("change", () => {
  jwcCoordinates = coordinateSelect.value as JwcCoordinateSpace;
  void reparseCurrentInput();
});
/**
 * V022: native iOS share sheet integration.
 *
 * All three outputs are generated on the device from already loaded data.
 * Unsupported file types fall back to download; no automatic upload or
 * submission to a remote server is performed.
 */
function saveFileLocally(file: File): void {
  const blobUrl = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
/**
 * iOS Safari can open PDF Blob downloads as a new page. Returning from
 * its built-in PDF viewer may re-create the CAD tab with NO drawing.
 * Use the iOS file share sheet ("ファイルに保存") instead of Blob navigation.
 */
function isIosBrowser(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function canShareFile(file: File): boolean {
  try {
    return typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({files:[file]});
  } catch {
    return false;
  }
}

function filenameStem(): string {
  return (parsedState?.fileName ?? "drawing").replace(/\.[^.]*$/, "");
}

let shareStatusTimer: ReturnType<typeof setTimeout> | null = null;
function shareStatus(message: string): void {
  if (shareStatusTimer !== null) clearTimeout(shareStatusTimer);
  shareResult.textContent = message;
  shareResult.hidden = !message;
  if (message) {
    shareStatusTimer = setTimeout(() => {
      shareResult.hidden = true;
      shareStatusTimer = null;
    }, 6500);
  }
}

async function shareOrDownload(file: File): Promise<void> {
  // Never navigate away from CAD with a PDF Blob download on iPhone.
  // The native share sheet includes iOS "ファイルに保存" and Mail/LINE.
  const fileList=[file];
  if (!canShareFile(file)) {
    if (file.type==="application/pdf" && isIosBrowser()) {
      shareStatus("PDFの保存メニューを開けません。Safariで開いてから再度お試しください。図面はそのまま保持しています。");
      return;
    }
    saveFileLocally(file);
    shareStatus("この形式は直接共有できないためファイルを保存しました。");
    return;
  }
  try {
    // Preserve the iPhone user gesture: no awaits before navigator.share.
    await navigator.share({files:fileList,title:file.name});
    shareStatus("共有画面を終了しました。保存・送信結果は選択したアプリで確認してください。");
  } catch (error) {
    if (error instanceof DOMException && error.name==="AbortError") {
      shareStatus("操作をキャンセルしました。");
      return;
    }
    const reason=error instanceof Error?error.message:String(error);
    if (file.type==="application/pdf" && isIosBrowser()) {
      // Never auto-fallback to Safari PDF navigation on an iPhone.
      shareStatus("iPhoneのPDF保存メニューを開けませんでした："+reason);
    } else {
      saveFileLocally(file);
      shareStatus("直接共有できなかったためファイルを保存しました："+reason);
    }
  }
}

/**
 * Non-destructive JWW save: for the original drawing return identical bytes;
 * for edited JWW, change ONLY the serialized MFC Unicode TEXT content.
 * A strict parse-back and comparison reject unsupported or ambiguous cases.
 * This does not re-create the drawing with the lossy version-700 writer.
 */
interface SerializedMfcString {
  content: string;
  end: number;
  unicode: boolean;
}
function mfcStringAt(bytes:Uint8Array,at:number,encoding:"shift_jis"|"utf-8"="shift_jis"):SerializedMfcString|null {
  if (at<0 || at>=bytes.length) return null;
  let offset=at, count=bytes[offset++]!, unicode=false;
  const word=():number|null=>{
    if(offset+2>bytes.length)return null;
    const v=bytes[offset]!|(bytes[offset+1]!<<8);offset+=2;return v;
  };
  const dword=():number|null=>{
    if(offset+4>bytes.length)return null;
    const v=(bytes[offset]!|(bytes[offset+1]!<<8)|
      (bytes[offset+2]!<<16)|(bytes[offset+3]!<<24))>>>0;offset+=4;return v;
  };
  if(count===255){
    const w=word();if(w===null)return null;
    if(w===0xfffe){
      unicode=true;
      if(offset>=bytes.length)return null;
      const inner=bytes[offset++]!;
      if(inner<255)count=inner;
      else {
        const w2=word();if(w2===null)return null;
        if(w2<65535)count=w2;
        else {const d=dword();if(d===null)return null;count=d;}
      }
    }else if(w<65535)count=w;
    else {const d=dword();if(d===null)return null;count=d;}
  }
  const size=count*(unicode?2:1);
  if(!Number.isSafeInteger(size)||size<0||offset+size>bytes.length)return null;
  try {
    // The Rust JWW parser uses non-fatal decoding with replacement and
    // diagnostics; match its interpretation before strictly re-reading
    // and verifying every unchanged entity in the output file.
    const decoder=new TextDecoder(unicode?"utf-16le":encoding,{fatal:false});
    const content=decoder.decode(bytes.subarray(offset,offset+size)).replace(/\0+$/u,"");
    return {content,end:offset+size,unicode};
  }catch{return null;}
}
function nativeTextHeader(t:NativeJwwText):Uint8Array {
  // CDataMoji: 4 x f64 position, u32 text_type, 4 x f64 text properties
  const arr=new Uint8Array(68),v=new DataView(arr.buffer);
  [t.startX,t.startY,t.endX,t.endY].forEach((x,i)=>v.setFloat64(i*8,x,true));
  v.setUint32(32,t.textType,true);
  [t.sizeX,t.sizeY,t.spacing,t.angle].forEach((x,i)=>v.setFloat64(36+i*8,x,true));
  return arr;
}
function mfcUnicodeString(value:string):Uint8Array {
  const units=value.length, head=units<255?4:units<65534?6:10;
  const out=new Uint8Array(head+2*units);
  out[0]=255;out[1]=254;out[2]=255;
  const dv=new DataView(out.buffer);
  if(units<255)out[3]=units;
  else if(units<65534){out[3]=255;dv.setUint16(4,units,true);}
  else {out[3]=255;dv.setUint16(4,65535,true);dv.setUint32(6,units,true);}
  for(let i=0;i<units;i++)dv.setUint16(head+2*i,value.charCodeAt(i),true);
  return out;
}
interface JwwTextPatch { start:number;end:number; replacement:Uint8Array; index:number }
function editedJwwBytes(): Uint8Array {
  if(!currentInput || !parsedState || parsedState.cad.format!=="jww") {
    throw new Error("JWW図面を開いてください。");
  }
  if(currentUnappliedText()) {
    throw new Error("入力中の文字があります。「文字変更」で確定してからJWW保存してください。");
  }
  // Preserve the DXF exporter contract: its changes have no index field.
  // The native JWW writer alone uses the index from the originalText Map.
  const changes:Array<OriginalText & {index:number;after:string}>=[];
  for(const [index,original] of originalText){
    const entity=parsedState.dxf.entities[index];
    if(entity?.type==="TEXT" && typeof entity.content==="string" &&
       entity.content!==original.before){
      changes.push({index,...original,after:entity.content});
    }
  }
  if(changes.length===0) {
    return Uint8Array.from(currentInput.bytes);
  }
  const doc=parsedState.cad.document;
  // Native JWW versions below 700 are not assumed to understand arbitrary
  // Unicode CString changes. Do not ever rewrite their entire archives.
  if(doc.header.version!==700){
    throw new Error("変更済JWWの安全保存はJWW形式700のみ対応です。元図JWW保存またはPDFをご使用ください。");
  }
  if(doc.diagnostics.some(d=>d.severity==="error")){
    throw new Error("元JWWの解析にエラーがあります。元の図形を守るため文字変更JWWの保存を行いません。");
  }
  const raw=currentInput.bytes;
  const sourceEncoding=(doc as unknown as {text_encoding?:string}).text_encoding;
  const byEntity=new Map<number,string>();
  const patches:JwwTextPatch[]=[];
  for(const change of changes){
    const match=nativeTextByDxfIndex.get(change.index);
    if(!match || match.content!==change.before){
      throw new Error("変更文字「"+change.before+"」の元JWW位置を一意に確認できません。別の図面情報を変更せず保存を中止しました。");
    }
    const indexes:number[]=[];
    for(let i=0;i<doc.entities.length;i++){
      const e=doc.entities[i];
      if(e.type==="TEXT" && e.content===match.content &&
        e.start_x===match.startX && e.start_y===match.startY &&
        e.end_x===match.endX && e.end_y===match.endY &&
        e.text_type===match.textType && e.font_name===match.fontName &&
        e.base.layer===match.layer && e.base.layer_group===match.layerGroup){
        indexes.push(i);
      }
    }
    if(indexes.length!==1){
      throw new Error("元JWW内の文字の同定が不確実なため、変更JWW保存を中止しました。");
    }
    const signature=nativeTextHeader(match);
    let found:JwwTextPatch|null=null,count=0;
    let headerCount=0,fontCount=0,contentCount=0;
    let ansiMatched=false,unicodeMatched=false;
    for(let offset=0;offset+signature.length+7<=raw.length;offset++){
      if(raw[offset]!==signature[0] || raw[offset+8]!==signature[8] ||
         raw[offset+32]!==signature[32] || raw[offset+60]!==signature[60])continue;
      let same=true;
      for(let j=0;j<signature.length;j++){
        if(raw[offset+j]!==signature[j]){same=false;break;}
      }
      if(!same)continue;
      headerCount++;
      const font=mfcStringAt(raw,offset+signature.length);
      if(!font || font.content!==match.fontName)continue;
      fontCount++;
      const content=mfcStringAt(raw,font.end,sourceEncoding==="utf-8"?"utf-8":"shift_jis");
      if(!content || content.content!==change.before)continue;
      contentCount++;
      // V035: source JWW text may be CP932 (ANSI CString) even when its
      // version is 700. V029 wrongly rejected ALL such strings.
      // Replacing with a Unicode CString is valid for version-700 archives.
      // The complete parsed drawing is verified before any file is offered.
      if(content.unicode) unicodeMatched=true;
      else ansiMatched=true;
      found={start:font.end,end:content.end,replacement:mfcUnicodeString(change.after),index:indexes[0]};
      count++;
      if(count>1)break;
    }
    if(count!==1||!found){
      const reason=count>1?"同じ候補が複数あります"
        :headerCount===0?"文字の座標・寸法の記録が一致しません"
        :fontCount===0?"フォント情報の記録が一致しません"
        :contentCount===0?"文字列の格納形式が一致しません"
        :"安全に確定できません";
      throw new Error("元JWW文字「"+change.before+"」を特定できません（"+reason+"）。"+
        "元図を守るため保存を中止しました。"+
        "［座標:"+headerCount+"／フォント:"+fontCount+
        "／文字:"+contentCount+"／UTF16:"+unicodeMatched+
        "／CP932:"+ansiMatched+"］");
    }
    byEntity.set(found.index,change.after);
    patches.push(found);
  }
  patches.sort((a,b)=>a.start-b.start);
  for(let i=1;i<patches.length;i++)if(patches[i].start<patches[i-1].end) {
    throw new Error("変更範囲が重複したため、JWW保存を中止しました。");
  }
  const newLength=raw.length+patches.reduce((n,p)=>n+p.replacement.length-(p.end-p.start),0);
  if(newLength<=0 || newLength>1000000000)throw new Error("JWWファイル容量が制限を超えました。");
  const output=new Uint8Array(newLength);
  let from=0,to=0;
  for(const p of patches){
    output.set(raw.subarray(from,p.start),to);to+=p.start-from;
    output.set(p.replacement,to);to+=p.replacement.length;from=p.end;
  }
  output.set(raw.subarray(from),to);
  const reread=readCadDocument(output) as CadDocument;
  if(reread.format!=="jww")throw new Error("保存結果をJWWとして再読込できません。");
  const rd=reread.document;
  if(rd.diagnostics.some(d=>d.severity==="error")){
    throw new Error("書き出したJWWに解析エラーがあるため保存を中止しました。");
  }
  const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  const sourceObj=doc as unknown as Record<string,unknown>;
  const verifyObj=rd as unknown as Record<string,unknown>;
  for(const key of ["header","block_defs","images","entity_counts",
    "block_def_names","validation","metadata_settings"] as const){
    if(!equal(sourceObj[key],verifyObj[key]))throw new Error(
      "元図の情報（"+key+"）が一致しないため保存を拒否しました。");
  }
  if(doc.entities.length!==rd.entities.length)throw new Error("図形数が変化するため保存を中止しました。");
  for(let i=0;i<doc.entities.length;i++){
    const original=doc.entities[i],outputEntity=rd.entities[i];
    const expected=byEntity.has(i)?{...original,content:byEntity.get(i)}:original;
    if(!equal(expected,outputEntity)) {
      throw new Error("文字以外の図形や属性、または文字内容に差があるため保存を中止しました（要素"+i+"）。");
    }
  }
  return output;
}
function editedJwwFile():File {
  const verifiedBytes=editedJwwBytes();
  return new File([Uint8Array.from(verifiedBytes)],
    filenameStem()+(effectiveTextChanges().length?"_文字変更.jww":"_原図.jww"),
    {type:"application/octet-stream"});
}
function jwwSaveError(error:unknown):void {
  const message=error instanceof Error?error.message:String(error);
  alert("JWW保存を安全に完了できません。元JWWは変更されていません。\n\n"+message);
}
saveJwwButton.addEventListener("click",()=>{
  try {
    const file=editedJwwFile();
    saveFileLocally(file);
    setWorkingStatus("JWWを別名保存しました："+file.name);
    if(effectiveTextChanges().length>0) {
      alert("変更済みJWWを別名で保存しました。Jw_cad 7.11で図形・レイヤ・文字を確認してください。\n元JWWは変更していません。");
    }
  }catch(error){jwwSaveError(error);}
});
/**
 * V024: portable single-page image PDF. This is intentionally a FIT-TO-PAGE
 * raster PDF, not a 1:50 etc. CAD-scale or vector PDF. No network resources.
 * JPEG is embedded directly into PDF using /DCTDecode.
 */
function pdfFromJpeg(jpeg: Uint8Array, imgWidth: number, imgHeight: number,
    pageWidth: number, pageHeight: number): Uint8Array {
  if (!jpeg.length || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("JPEG画像が正しく生成されませんでした");
  }
  const encoder = new TextEncoder();
  const fragments: Uint8Array[] = [];
  let length = 0;
  const append = (bytes: Uint8Array): void => {
    fragments.push(bytes);
    length += bytes.byteLength;
  };
  const write = (value: string): void => { append(encoder.encode(value)); };
  const offsets: number[] = [0];
  const object = (id: number, body: string): void => {
    offsets[id] = length;
    write(id + " 0 obj\n" + body + "\nendobj\n");
  };
  write("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " +
    pageWidth.toFixed(3) + " " + pageHeight.toFixed(3) +
    "] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>");
  offsets[4] = length;
  write("4 0 obj\n<< /Type /XObject /Subtype /Image /Width " + imgWidth +
    " /Height " + imgHeight +
    " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " +
    jpeg.length + " >>\nstream\n");
  append(jpeg);
  write("\nendstream\nendobj\n");
  const instructions = "q\n" + pageWidth.toFixed(3) + " 0 0 " +
    pageHeight.toFixed(3) + " 0 0 cm\n/Im0 Do\nQ\n";
  const stream = encoder.encode(instructions);
  offsets[5] = length;
  write("5 0 obj\n<< /Length " + stream.length + " >>\nstream\n");
  append(stream);
  write("endstream\nendobj\n");
  const xrefStart = length;
  write("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i++) {
    write(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
  }
  write("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
    xrefStart + "\n%%EOF\n");
  const output = new Uint8Array(length);
  let pos = 0;
  for (const part of fragments) {
    output.set(part, pos);
    pos += part.byteLength;
  }
  return output;
}

function cadPdfFile(paper: "A4" | "A3", mode: PdfRangeMode = pdfRangeMode): File {
  if (!parsedState) throw new Error("図面を読み込んでください");
  const dxf = parsedState.dxf;
  const isJwc = !!dxf.jwc_conversion_report;
  const hidden = new Set(isJwc ? dxf.layers.filter(l => l.frozen).map(l => l.name) : []);
  const preview = document.createElement("canvas").getContext("2d");
  if (!preview) throw new Error("PDF用描画を準備できません");
  const widths = new Map<DxfEntity, number>();
  let index = 0;
  for (const entity of dxf.entities) {
    if (entity.type === "TEXT" && isJwc) {
      widths.set(entity, dxf.text_width_factors?.[index++] ?? 1);
    }
  }
  const drawingBounds = dxfBounds(dxf.entities.filter(e => !hidden.has(e.layer)), preview, widths);
  if (!drawingBounds) throw new Error("出力できる図形がありません");
  const bounds = mode === "whole" ? drawingBounds
    : mode === "viewport" ? viewBoundsInCad() : pdfRangeBounds;
  if (!bounds) {
    throw new Error("印刷範囲が未指定です。図面上で1点目と2点目をタップしてください。");
  }
  if (bounds.maxX - bounds.minX <= 1e-8 || bounds.maxY - bounds.minY <= 1e-8) {
    throw new Error("印刷範囲が小さすぎます。2点を選び直してください。");
  }
  const isLandscape = (bounds.maxX - bounds.minX) > (bounds.maxY - bounds.minY);
  const dimensions = paper === "A3" ? [841.89, 1190.55] : [595.28, 841.89];
  const pageW = isLandscape ? dimensions[1] : dimensions[0];
  const pageH = isLandscape ? dimensions[0] : dimensions[1];
  // A4 ~3500px, A3 ~4700px on long side, with an iPhone memory cap.
  let width = Math.round(pageW / Math.max(pageW, pageH) * (paper === "A3" ? 4700 : 3500));
  let height = Math.round(pageH / Math.max(pageW, pageH) * (paper === "A3" ? 4700 : 3500));
  const pixelCount = width * height;
  if (pixelCount > 16000000) {
    const factor = Math.sqrt(16000000 / pixelCount);
    width = Math.max(1, Math.floor(width * factor));
    height = Math.max(1, Math.floor(height * factor));
  }
  const image = document.createElement("canvas");
  image.width = width;
  image.height = height;
  const ctx = image.getContext("2d");
  if (!ctx) throw new Error("PDFの高解像度画像を生成できません");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  // Drawing is always printed on white; do not change the live black/white UI.
  drawDxf(ctx, width, height, dxf, {
    exportMode: true,
    exportWhole: mode === "whole",
    exportBounds: bounds,
    backgroundOverride: "white",
    zoom: 1,
    panX: 0,
    panY: 0,
    padding: Math.min(width, height) * 0.045,
    strokePx: Math.max(1.45, paper === "A3" ? 2 : 1.7),
  });
  const dataUrl = image.toDataURL("image/jpeg", 0.96);
  if (!dataUrl.startsWith("data:image/jpeg;base64,")) {
    throw new Error("JPEG画像の生成に失敗しました");
  }
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const jpeg = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) jpeg[i] = binary.charCodeAt(i);
  const pdf = pdfFromJpeg(jpeg, width, height, pageW, pageH);
  const suffix = mode === "whole" ? "全体"
    : mode === "viewport" ? "画面範囲" : "指定範囲";
  return new File([Uint8Array.from(pdf)], filenameStem() + "_" + paper +
    (isLandscape ? "横" : "縦") + "_" + suffix + ".pdf", { type: "application/pdf" });
}

function updateShareControls(): void {
  const loaded = parsedState !== null;
  saveJwwButton.disabled = !loaded || parsedState?.cad.format !== "jww";
  openSharePanelButton.disabled = !loaded;
  sharePdfButton.disabled = !loaded;
  pdfPaperSelect.disabled = !loaded;
  pdfRangeSelect.disabled = !loaded;
}

openSharePanelButton.addEventListener("click", () => {
  // Start saving the source JWW and editing session well before exporting.
  void queueWorkingSave();
  updateShareControls();
  shareResult.textContent = "";
  shareResult.hidden = true;
  sharePanel.hidden = !sharePanel.hidden;
});
closeSharePanelButton.addEventListener("click", () => {
  sharePanel.hidden = true;
});
/** V025: derive print bounds in the same CAD coordinate system as drawDxf. */
function viewMapping(): {
  bounds: Bounds;
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
} | null {
  if (!parsedState) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const dxf = parsedState.dxf, isJwc = !!dxf.jwc_conversion_report;
  const hidden = new Set(isJwc ? dxf.layers.filter(l => l.frozen).map(l=>l.name) : []);
  const context = canvas.getContext("2d");
  if (!context) return null;
  const widths = new Map<DxfEntity, number>();
  let textIndex = 0;
  for (const e of dxf.entities) {
    if (e.type === "TEXT" && isJwc) {
      widths.set(e, dxf.text_width_factors?.[textIndex++] ?? 1);
    }
  }
  const bounds = dxfBounds(dxf.entities.filter(e=>!hidden.has(e.layer)), context, widths);
  if (!bounds) return null;
  const modelWidth = Math.max(1, bounds.maxX-bounds.minX);
  const modelHeight = Math.max(1, bounds.maxY-bounds.minY);
  const scale = Math.min((rect.width-56)/modelWidth,(rect.height-56)/modelHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    bounds, scale, width:rect.width, height:rect.height,
    offsetX:isJwc ? (rect.width-modelWidth*scale)/2 : 28,
    offsetY:isJwc ? (rect.height-modelHeight*scale)/2 : 28,
  };
}
function viewportPointToCad(p: {x:number;y:number}): {x:number;y:number} | null {
  const m=viewMapping();
  if (!m) return null;
  const sx=(p.x-m.width/2-viewPanX)/viewZoom + m.width/2;
  const sy=(p.y-m.height/2-viewPanY)/viewZoom + m.height/2;
  return {
    x:m.bounds.minX+(sx-m.offsetX)/m.scale,
    y:m.bounds.minY+(m.height-m.offsetY-sy)/m.scale,
  };
}
function cadPointToViewport(p: {x:number;y:number}): {x:number;y:number} | null {
  const m=viewMapping();
  if (!m) return null;
  const sx=m.offsetX+(p.x-m.bounds.minX)*m.scale;
  const sy=m.height-m.offsetY-(p.y-m.bounds.minY)*m.scale;
  return {
    x:m.width/2+viewPanX+(sx-m.width/2)*viewZoom,
    y:m.height/2+viewPanY+(sy-m.height/2)*viewZoom,
  };
}
function viewBoundsInCad(): Bounds | null {
  const rect=canvas.getBoundingClientRect();
  const p1=viewportPointToCad({x:0,y:0});
  const p2=viewportPointToCad({x:rect.width,y:rect.height});
  if (!p1 || !p2) return null;
  return {minX:Math.min(p1.x,p2.x),minY:Math.min(p1.y,p2.y),
    maxX:Math.max(p1.x,p2.x),maxY:Math.max(p1.y,p2.y)};
}
function resetPdfRangeOnNewDrawing(): void {
  // A reopened drawing must always accept ordinary text taps.
  pdfRangeMode="rectangle";
  pdfRangePicking=false;
  pdfRangeStart=null;
  pdfRangeBounds=null;
  pdfRangeSelect.value="rectangle";
  updatePdfRangeUi();
}
/** Leave the print-range tool without changing any CAD, text or undo data. */
function clearPdfRangeAndReturnToEditing(): void {
  pdfRangeMode="rectangle";
  pdfRangePicking=false;
  pdfRangeStart=null;
  pdfRangeBounds=null;
  pdfRangeSelect.value="rectangle";
  updatePdfRangeUi();
  redrawZoom();
  queueWorkingSave();
  shareStatus("PDFの印刷範囲を解除しました。図面をタップして文字編集できます。");
}
function updatePdfRangeUi(): void {
  const selecting = pdfRangeMode === "rectangle";
  const picking = selecting && pdfRangePicking;
  pdfRangeReselect.disabled = !parsedState;
  pdfRangeClear.disabled = !parsedState || !selecting || !(pdfRangeStart || pdfRangeBounds);
  pdfRangeExit.hidden = !selecting || !parsedState ||
    !(picking || pdfRangeStart || pdfRangeBounds);
  pdfRangeIndicator.hidden = !picking || !parsedState;
  pdfRangeStatus.hidden = !picking && !pdfRangeBounds;
  if (selecting) {
    const label = pdfRangeBounds && !picking ? "範囲指定済み"
      : pdfRangeStart ? "2点目をタップ" : "1点目をタップ";
    pdfRangeIndicator.textContent = "PDF範囲：" + label;
    pdfRangeStatus.textContent = label;
  }
}
function handlePdfRangeTap(point: {x:number;y:number}): void {
  if (!pdfRangePicking || pdfRangeMode!=="rectangle") return;
  const cad=viewportPointToCad(point);
  if (!cad) return;
  if (!pdfRangeStart || pdfRangeBounds) {
    pdfRangeStart=cad;
    pdfRangeBounds=null;
  } else {
    const a=pdfRangeStart;
    const m=viewMapping();
    const minSpan=m ? 12/(m.scale*viewZoom) : 0;
    if (Math.abs(cad.x-a.x)<minSpan || Math.abs(cad.y-a.y)<minSpan) {
      pdfRangeStatus.hidden=false;
      pdfRangeStatus.textContent="範囲が小さすぎます。離れた位置をタップしてください。";
      return;
    }
    pdfRangeBounds={
      minX:Math.min(a.x,cad.x),maxX:Math.max(a.x,cad.x),
      minY:Math.min(a.y,cad.y),maxY:Math.max(a.y,cad.y),
    };
    // From this point tapping text selects text, NOT a new rectangle.
    // The completed rectangle remains available to the PDF exporter.
    pdfRangePicking=false;
  }
  updatePdfRangeUi();
  redrawZoom();
  scheduleWorkingSave(450);
}
function drawPdfRangeOverlay(ctx:CanvasRenderingContext2D): void {
  if (pdfRangeMode!=="rectangle") return;
  ctx.save();
  ctx.setLineDash([6,4]);
  ctx.strokeStyle="#f59e0b";
  ctx.fillStyle="rgba(245,158,11,.12)";
  ctx.lineWidth=2;
  if (pdfRangeBounds) {
    const a=cadPointToViewport({x:pdfRangeBounds.minX,y:pdfRangeBounds.minY});
    const b=cadPointToViewport({x:pdfRangeBounds.maxX,y:pdfRangeBounds.maxY});
    if (a&&b) {
      const left=Math.min(a.x,b.x),top=Math.min(a.y,b.y);
      const w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);
      ctx.fillRect(left,top,w,h);
      ctx.strokeRect(left,top,w,h);
    }
  } else if (pdfRangeStart) {
    const a=cadPointToViewport(pdfRangeStart);
    if (a) {
      ctx.beginPath();
      ctx.moveTo(a.x-14,a.y);ctx.lineTo(a.x+14,a.y);
      ctx.moveTo(a.x,a.y-14);ctx.lineTo(a.x,a.y+14);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function selectedPdfPaper(): "A4" | "A3" {
  return pdfPaperSelect.value === "A3" ? "A3" : "A4";
}
pdfRangeSelect.addEventListener("change", () => {
  const next = pdfRangeSelect.value;
  pdfRangeMode = next === "viewport" ? "viewport"
    : next === "rectangle" ? "rectangle" : "whole";
  pdfRangePicking = pdfRangeMode === "rectangle";
  pdfRangeStart = null;
  pdfRangeBounds = null;
  updatePdfRangeUi();
  redrawZoom();
  scheduleWorkingSave(350);
  if (pdfRangeMode === "rectangle") {
    document.querySelector("#drawing-stage")?.scrollIntoView({
      block: "center", behavior: "smooth",
    });
  }
});
pdfRangeReselect.addEventListener("click", () => {
  pdfRangeStart = null;
  pdfRangeBounds = null;
  pdfRangeMode = "rectangle";
  pdfRangePicking = true;
  pdfRangeSelect.value = "rectangle";
  updatePdfRangeUi();
  redrawZoom();
  scheduleWorkingSave(350);
  document.querySelector("#drawing-stage")?.scrollIntoView({
    block: "center", behavior: "smooth",
  });
});
pdfRangeClear.addEventListener("click", clearPdfRangeAndReturnToEditing);
pdfRangeExit.addEventListener("click", clearPdfRangeAndReturnToEditing);
function ensurePdfRangeSelected(): boolean {
  if (pdfRangeMode !== "rectangle" || pdfRangeBounds) return true;
  pdfRangePicking=true;
  pdfRangeStart=null;
  updatePdfRangeUi();
  redrawZoom();
  shareStatus("PDF範囲の対角2点を図面上でタップしてから、もう一度PDF保存・共有を押してください。");
  document.querySelector("#drawing-stage")?.scrollIntoView({
    block:"center",behavior:"smooth",
  });
  return false;
}
sharePdfButton.addEventListener("click", () => {
  if (!ensurePdfRangeSelected()) return;
  try {
    void queueWorkingSave();
    const file = cadPdfFile(selectedPdfPaper(), pdfRangeMode);
    // On iPhone the share sheet offers both "ファイルに保存" and
    // LINE/Gmail. No PDF Blob navigation and no duplicate save handler.
    void shareOrDownload(file);
  } catch (error) {
    shareStatus("PDF作成に失敗しました：" + String(error));
  }
});
/**
 * V026 - crash/reload/back resilient local CAD session.
 *
 * IndexedDB stores the ORIGINAL bytes, never rewritten JWW bytes, alongside
 * preview-only text replacements. A copy is taken for each snapshot.
 *
 * Storage is local to this browser/PWA installation: there are no uploads.
 * Browser data removal, private mode and iOS eviction can remove the draft.
 */
interface PersistedTextEdit {
  index: number;
  original: OriginalText;
  after: string;
}
interface StoredWorkingSession {
  version: 1;
  fileName: string;
  fileSize: number;
  bytes: Uint8Array;
  generated: boolean;
  savedAt: number;
  edits: PersistedTextEdit[];
  undoStack: TextChange[];
  redoStack: TextChange[];
  selectedTextIndex: number | null;
  draft: { index: number; value: string } | null;
  viewZoom: number;
  viewPanX: number;
  viewPanY: number;
  canvasBackground: "white" | "black";
  showJwwLineTypes: boolean;
  explodeInserts: boolean;
  jwcCoordinates: JwcCoordinateSpace;
  pdfRangeMode: PdfRangeMode;
  pdfRangeStart: {x:number;y:number} | null;
  pdfRangeBounds: Bounds | null;
  pdfPaper: "A4" | "A3";
}

let workingDbPromise: Promise<IDBDatabase> | null = null;
let workingWriteTail: Promise<void> = Promise.resolve();
let workingSaveTimer: ReturnType<typeof setTimeout> | null = null;
let restoringWorkingSession = false;
let recoveryFailureWasReported = false;
let workingRecoveryPromise: Promise<void> | null = null;
let userOpenedFile = false;
let readingUserFile = false;
let workingWriteRevision = 0;
let lastWorkingSaveError = "";
let leaveGuardArmed = false;
let leaveDialogOpen = false;
let leavingAfterConfirmation = false;

// V031: keep recovery/diagnostic information internally without a visible
// message below the drawing. Blocking save errors still use existing dialogs.
function setWorkingStatus(message: string, warning = false): void {
  sessionStatusElement.textContent = message;
  sessionStatusElement.hidden = true;
  if (warning) console.warn("[JWW簡易CAD]", message);
}
function workingDb(): Promise<IDBDatabase> {
  if (workingDbPromise) return workingDbPromise;
  workingDbPromise = new Promise<IDBDatabase>((resolve,reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("このブラウザは端末内保存に対応していません"));
      return;
    }
    const request = indexedDB.open("JWW_CAD_LOCAL_WORK_V026",1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("sessions")) {
        request.result.createObjectStore("sessions");
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ??
      new Error("iPhoneの一時保存領域を開けませんでした"));
    request.onblocked = () => reject(new Error("一時保存領域がほかの画面で使用中です"));
  }).catch(error => {
    workingDbPromise = null;
    throw error;
  });
  return workingDbPromise;
}
async function getStoredWorkingSession(): Promise<StoredWorkingSession | null> {
  const db=await workingDb();
  return new Promise((resolve,reject) => {
    const request=db.transaction("sessions","readonly").objectStore("sessions").get("latest");
    request.onsuccess = () => resolve((request.result as StoredWorkingSession | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("一時保存の読込に失敗しました"));
  });
}
async function writeStoredWorkingSession(data: StoredWorkingSession): Promise<void> {
  const db=await workingDb();
  await new Promise<void>((resolve,reject) => {
    const transaction=db.transaction("sessions","readwrite");
    transaction.objectStore("sessions").put(data,"latest");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("一時保存が中断されました"));
    transaction.onerror = () => reject(transaction.error ?? new Error("一時保存の書き込みに失敗しました"));
  });
}
function currentUnappliedText(): {index:number;value:string} | null {
  if (selectedTextIndex === null) return null;
  const entity=selectedTextEntity();
  if (!entity || entity.content === textEditInput.value) return null;
  return {index:selectedTextIndex,value:textEditInput.value};
}
function hasPendingCadChanges(): boolean {
  return !!parsedState &&
    (effectiveTextChanges().length > 0 || currentUnappliedText() !== null);
}
function makeWorkingSnapshot(): StoredWorkingSession | null {
  if (!currentInput || !parsedState) return null;
  const edits: PersistedTextEdit[] = [];
  for (const [index,orig] of originalText) {
    const entity=parsedState.dxf.entities[index];
    if (entity?.type==="TEXT" && typeof entity.content==="string") {
      edits.push({index,original:{...orig},after:entity.content});
    }
  }
  return {
    version:1,
    fileName:currentInput.name,fileSize:currentInput.size,
    bytes:Uint8Array.from(currentInput.bytes),generated:!!currentInput.generated,
    savedAt:Date.now(),
    edits,undoStack:textUndoStack.map(e=>({...e})),redoStack:textRedoStack.map(e=>({...e})),
    selectedTextIndex,draft:currentUnappliedText(),
    viewZoom,viewPanX,viewPanY,canvasBackground,showJwwLineTypes,
    explodeInserts,jwcCoordinates,pdfRangeMode,
    pdfRangeStart:pdfRangeStart?{...pdfRangeStart}:null,
    pdfRangeBounds:pdfRangeBounds?{...pdfRangeBounds}:null,
    pdfPaper:selectedPdfPaper(),
  };
}
function scheduleWorkingSave(delay = 300): void {
  if (!parsedState || restoringWorkingSession) return;
  if (workingSaveTimer !== null) clearTimeout(workingSaveTimer);
  workingSaveTimer=setTimeout(() => {
    workingSaveTimer=null;
    queueWorkingSave();
  },delay);
}
function queueWorkingSave(showFeedback = false): Promise<void> {
  if (workingSaveTimer !== null) {
    clearTimeout(workingSaveTimer);
    workingSaveTimer=null;
  }
  if (restoringWorkingSession) return workingWriteTail;
  const snapshot=makeWorkingSnapshot();
  if (!snapshot) return workingWriteTail;
  const revision=++workingWriteRevision;
  // V028: background autosave must never trigger status/layout movement.
  if (showFeedback) setWorkingStatus("iPhone内に作業を一時保存中…");
  workingWriteTail=workingWriteTail.catch(() => undefined).then(async () => {
    // Do not let queued snapshots of an older file overwrite the latest file.
    if (revision !== workingWriteRevision) return;
    try {
      await writeStoredWorkingSession(snapshot);
      const previousError=lastWorkingSaveError;
      lastWorkingSaveError="";
      if (revision===workingWriteRevision) {
        if (showFeedback) {
          setWorkingStatus("iPhone内に一時保存済：" + snapshot.fileName +
            (snapshot.edits.length || snapshot.draft ? "（文字変更を含む）" : "") +
            " ／ " + new Date(snapshot.savedAt).toLocaleTimeString("ja-JP"));
        } else if (previousError) {
          sessionStatusElement.hidden=true;
        }
      }
    } catch (error) {
      lastWorkingSaveError=error instanceof Error ? error.message : String(error);
      if (revision===workingWriteRevision) {
        setWorkingStatus("一時保存できません：" + lastWorkingSaveError +
          "。重要な作業はJWWまたはPDFで別名保存し、元図を残してください。",true);
      }
    }
  });
  return workingWriteTail;
}
function matchesStoredText(entity:DxfEntity|undefined, orig:OriginalText):boolean {
  return entity?.type==="TEXT" && entity.content===orig.before &&
    entity.layer===orig.layer &&
    typeof entity.x==="number" && Math.abs(entity.x-orig.x)<0.001 &&
    typeof entity.y==="number" && Math.abs(entity.y-orig.y)<0.001 &&
    Math.abs((entity.rotation??0)-orig.rotation)<0.001;
}
function ensureWorkingRecovery(force=false): Promise<void> {
  if (workingRecoveryPromise) return workingRecoveryPromise;
  workingRecoveryPromise=restoreWorkingSessionOnStartup(force).finally(() => {
    workingRecoveryPromise=null;
  });
  return workingRecoveryPromise;
}
function showRecoveryProblemOnce(message:string):void {
  if (recoveryFailureWasReported) return;
  recoveryFailureWasReported=true;
  // This is an exceptional dialog, not a persistent notification below CAD.
  window.setTimeout(()=>{
    alert("前回の図面を復元できませんでした。\n\n" + message +
      "\n\n元のJWWファイルは変更していません。必要に応じて「ファイル選択」から開き直してください。");
  },0);
}
// Read live state through a function: parseBytes() mutates parsedState,
// so an early empty-state guard must not narrow it to "never" after await.
function hasActiveDrawing(): boolean { return parsedState !== null; }
async function restoreWorkingSessionOnStartup(force=false):Promise<void> {
  if (hasActiveDrawing() || restoringWorkingSession) return;
  if (!force && (currentInput || userOpenedFile)) return;
  let snapshot:StoredWorkingSession|null=null;
  try {
    snapshot=await getStoredWorkingSession();
  } catch(error) {
    const reason=error instanceof Error?error.message:String(error);
    setWorkingStatus("端末内の一時保存が使えません：" + reason,true);
    if (force) showRecoveryProblemOnce(reason);
    return;
  }
  // A Safari PDF viewer can return to an empty, partially initialized app.
  // Force-recovery is allowed even if an earlier load left currentInput set,
  // but never overwrite a healthy drawing or a file currently being read.
  if (!snapshot || hasActiveDrawing() || readingUserFile ||
      (!force && (userOpenedFile || currentInput))) return;
  if (snapshot.version!==1 || !snapshot.bytes ||
      !["string"].includes(typeof snapshot.fileName)) {
    setWorkingStatus("前回の一時保存データの形式が異なります。",true);
    return;
  }
  restoringWorkingSession=true;
  try {
    // Strictly reuse the same JWW/JWC/JWS reader used by file input.
    const input:CurrentInput={
      name:snapshot.fileName,size:snapshot.fileSize,
      bytes:Uint8Array.from(snapshot.bytes),generated:snapshot.generated,
    };
    currentInput=input;
    explodeInserts=snapshot.explodeInserts;
    jwcCoordinates=snapshot.jwcCoordinates;
    explodeToggle.checked=explodeInserts;
    coordinateSelect.value=jwcCoordinates;
    await parseBytes(input);
    if (!parsedState) throw new Error("図面データを復元できませんでした");
    // Do not partially replace a changed/unsupported entity. Validate all
    // indices and the ORIGINAL bytes before applying any preview edit.
    for (const item of snapshot.edits) {
      if (!matchesStoredText(parsedState.dxf.entities[item.index],item.original)) {
        throw new Error("保存した文字と元図の照合に失敗しました。文字変更は復元していません");
      }
    }
    for (const change of [...snapshot.undoStack,...snapshot.redoStack]) {
      if (parsedState.dxf.entities[change.index]?.type!=="TEXT") {
        throw new Error("文字変更履歴を安全に復元できませんでした");
      }
    }
    for (const item of snapshot.edits) {
      originalText.set(item.index,{...item.original});
      parsedState.dxf.entities[item.index].content=item.after;
    }
    textUndoStack.push(...snapshot.undoStack.map(e=>({...e})));
    textRedoStack.push(...snapshot.redoStack.map(e=>({...e})));
    viewZoom=Number.isFinite(snapshot.viewZoom)
      ? Math.max(0.5,Math.min(MAX_VIEW_ZOOM,snapshot.viewZoom)):1;
    viewPanX=Number.isFinite(snapshot.viewPanX)?snapshot.viewPanX:0;
    viewPanY=Number.isFinite(snapshot.viewPanY)?snapshot.viewPanY:0;
    canvasBackground=snapshot.canvasBackground==="black"?"black":"white";
    // V031: override stale "solid" preview preferences from V020-V030.
    // The native JWW line types and layer attributes are never altered.
    showJwwLineTypes=true;
    document.querySelector<HTMLSelectElement>("#canvas-background-select")!.value=canvasBackground;
    document.querySelector<HTMLSelectElement>("#line-style-select")!.value="original";
    // Print cropping is a temporary tool. Do not restore its touch-capture
    // mode from V025/V026 drafts: previously it made text impossible to pick.
    // Keep the original drawing, edited text, viewport and undo history.
    // PDF uses rectangle by default, while normal text taps remain active.
    pdfRangeMode="rectangle";
    pdfRangePicking=false;
    pdfRangeStart=null;
    pdfRangeBounds=null;
    pdfRangeSelect.value=pdfRangeMode;
    pdfPaperSelect.value=snapshot.pdfPaper==="A3"?"A3":"A4";
    selectedTextIndex=typeof snapshot.selectedTextIndex==="number" &&
      parsedState.dxf.entities[snapshot.selectedTextIndex]?.type==="TEXT"
      ?snapshot.selectedTextIndex:null;
    updatePdfRangeUi();
    render();
    if (snapshot.draft && snapshot.draft.index===selectedTextIndex) {
      textEditInput.value=snapshot.draft.value;
      updateTextEditControls();
    }
    redrawZoom();
    statusLine.textContent=snapshot.fileName+" ／ 前回の作業を復元しました";
    setWorkingStatus("前回の作業を復元しました：" + snapshot.fileName +
      " ／ 文字変更 " + effectiveTextChanges().length + "件。元JWWは変更していません。");
  } catch(error) {
    const reason=error instanceof Error?error.message:String(error);
    setWorkingStatus("復元に問題があります：" + reason,true);
    // A failed recovery must not lock the app into an empty screen forever.
    if (!parsedState) {
      currentInput=null;
      showRecoveryProblemOnce(reason);
    } else {
      // If native file parsing succeeded, preserve the original drawing
      // even when one historical text edit is no longer safely applicable.
      render();
      showRecoveryProblemOnce("元の図面は読み込めましたが、文字の復元に問題があります：" + reason);
    }
  } finally {
    restoringWorkingSession=false;
    updateNavigationProtection();
  }
}
/**
 * Browser back: a one-entry history guard allows a custom confirmation.
 * Safari/iOS may bypass popstate or beforeunload in some lifecycle paths,
 * so the IndexedDB snapshot above remains the essential recovery mechanism.
 */
function beforeLeaving(event:BeforeUnloadEvent):void {
  if (leavingAfterConfirmation || !hasPendingCadChanges()) return;
  queueWorkingSave();
  event.preventDefault();
  event.returnValue="";
}
function updateNavigationProtection():void {
  if (restoringWorkingSession) return;
  const dirty=hasPendingCadChanges();
  if (dirty && !leavingAfterConfirmation) {
    // Safari may not display its own prompt; IndexedDB recovery is primary.
    window.addEventListener("beforeunload",beforeLeaving);
  } else {
    window.removeEventListener("beforeunload",beforeLeaving);
  }
  // V028: keep a one-entry history guard for ALL loaded drawings, not
  // just files whose text has changed. Original-only PDF export is protected.
  if (!parsedState || leavingAfterConfirmation || leaveDialogOpen) return;
  if (window.history.state?.__jwwWorkGuardV026) {
    leaveGuardArmed=true;
  } else if (!leaveGuardArmed) {
    window.history.pushState(
      {...(typeof window.history.state==="object" && window.history.state!==null
        ?window.history.state:{}),__jwwWorkGuardV026:true},
      "",window.location.href,
    );
    leaveGuardArmed=true;
  }
}
function showBackConfirmation():void {
  leaveDialogOpen=true;
  leaveConfirmModal.hidden=false;
  const dirty=hasPendingCadChanges();
  leaveConfirmTitle.textContent=dirty
    ? "編集中の図面があります"
    : "図面を開いたままにしますか？";
  leaveConfirmDescription.textContent=dirty
    ? "変更した文字と図面をiPhone内に一時保存しています。作業を続ける場合は「図面に戻る」を押してください。"
    : "文字は未変更ですが、現在の図面と表示位置をiPhone内に保存しています。「図面に戻る」でCAD画面を維持できます。";
  leaveStayButton.textContent="図面に戻る";
  leaveConfirmStatus.textContent=lastWorkingSaveError
    ? "端末内保存でエラー：" + lastWorkingSaveError
    : dirty
      ? "現在の文字変更：" + effectiveTextChanges().length + "件。"
      : "文字変更なし。元の図面を開いたままにできます。";
  leaveStayButton.focus();
}
window.addEventListener("popstate",(event:PopStateEvent) => {
  if (event.state?.__jwwWorkGuardV026) {
    leaveGuardArmed=true;
    return;
  }
  if (!leaveGuardArmed) return;
  leaveGuardArmed=false;
  if (parsedState && !leavingAfterConfirmation) {
    // V034: Safari Back acts like the PDF panel's × on its FIRST press.
    // The synthetic CAD history guard is then restored without navigating
    // away, without showing the exit-confirmation modal, and without
    // discarding the open JWW, its edits, zoom or selected PDF bounds.
    if (!sharePanel.hidden) {
      sharePanel.hidden = true;
      updateNavigationProtection(); // re-arm the single Back guard
      return;
    }
    // Only Back from the ordinary CAD view may ask whether to leave.
    // This also protects drawings that have not been text-edited.
    void queueWorkingSave();
    showBackConfirmation();
  } else {
    window.history.back();
  }
});
leaveStayButton.addEventListener("click", () => {
  leaveConfirmModal.hidden=true;
  leaveDialogOpen=false;
  updateNavigationProtection();
});
leaveSaveButton.addEventListener("click", () => {
  leaveConfirmStatus.textContent="一時保存を完了しています…";
  leaveSaveButton.disabled=true;
  void queueWorkingSave(true).then(() => {
    leaveSaveButton.disabled=false;
    if (lastWorkingSaveError) {
      leaveConfirmStatus.textContent="保存に失敗しました：" +
        lastWorkingSaveError+"。可能な場合はJWWかPDFを別名保存してから画面を離れてください。";
      return;
    }
    leavingAfterConfirmation=true;
    window.removeEventListener("beforeunload",beforeLeaving);
    leaveDialogOpen=false;
    leaveConfirmModal.hidden=true;
    window.history.back();
  });
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState==="hidden") void queueWorkingSave();
});
window.addEventListener("pagehide", () => {
  void queueWorkingSave();
});
window.addEventListener("pageshow",event => {
  if (parsedState) {
    // A WebKit back/forward-cache restore must retain the open CAD as-is.
    updateNavigationProtection();
    if (event.persisted) redrawZoom();
  } else {
    // PDF previews can return to a recreated or stale page. Retry
    // IndexedDB restoration EVEN IF an earlier read left currentInput set.
    void ensureWasm().then(()=>ensureWorkingRecovery(true));
  }
});
document.addEventListener("visibilitychange",()=>{
  if (document.visibilityState==="visible" && !parsedState) {
    void ensureWasm().then(()=>ensureWorkingRecovery(true));
  }
});

function effectiveTextChanges(): Array<OriginalText & { after: string }> {
  const state = parsedState;
  if (!state) return [];
  const changes: Array<OriginalText & { after: string }> = [];
  for (const [index, original] of originalText) {
    const entity = state.dxf.entities[index];
    if (entity?.type === "TEXT" && typeof entity.content === "string" &&
        entity.content !== original.before) {
      changes.push({ ...original, after: entity.content });
    }
  }
  return changes;
}
window.addEventListener("resize", redrawZoom);
void ensureWasm().then(async () => {
  if (!parsedState) statusLine.textContent = "待機中";
  await ensureWorkingRecovery();
}).catch(error => {
  if (!parsedState) statusLine.textContent = "起動準備に失敗：" + String(error);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) {
    void parseFile(file);
  }
});

explodeToggle.addEventListener("change", () => {
  explodeInserts = explodeToggle.checked;
  if (parsedState) {
    void reparseCurrentInput();
  }
});

sampleButton.addEventListener("click", () => {
  void loadSample();
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragging");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  const file = event.dataTransfer?.files[0];
  if (file) {
    fileInput.files = event.dataTransfer?.files ?? null;
    void parseFile(file);
  }
});

for (const button of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  button.addEventListener("click", () => {
    viewMode = button.dataset.tab as ViewMode;
    document
      .querySelectorAll<HTMLButtonElement>(".tab")
      .forEach((node) => node.classList.toggle("active", node === button));
    render();
  });
}

async function reparseCurrentInput(): Promise<void> {
  if (!currentInput) {
    render();
    return;
  }
  await parseBytes(currentInput);
}

async function parseFile(file: File): Promise<void> {
  // A new drawing replaces the single "last working session" on this device.
  // Never silently discard unfinished text changes from the current drawing.
  if (hasPendingCadChanges()) {
    const proceed=window.confirm(
      "編集中の文字があります。別の図面を開くと、この端末の一時保存も新しい図面に切り替わります。\n" +
      "必要な場合は「キャンセル」で戻り、先に「JWW保存」を行ってください。\n\n" +
      "現在の編集を終了して新しい図面を開きますか？",
    );
    if (!proceed) {
      fileInput.value="";
      return;
    }
  }
  userOpenedFile = true;
  readingUserFile = true;
  try {
    resetZoom();
    const bytes = new Uint8Array(await file.arrayBuffer());
    currentInput = {
      name: file.name,
      size: file.size,
      bytes,
    };
    await parseBytes(currentInput);
  } finally {
    readingUserFile = false;
  }
}

async function loadSample(): Promise<void> {
  statusLine.textContent = "サンプル読込中";
  try {
    const response = await fetch("/samples/Test1.jww");
    if (!response.ok) {
      throw new Error(`sample load failed: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    currentInput = {
      name: "Test1.jww",
      size: bytes.byteLength,
      bytes,
    };
    resetZoom();
    await parseBytes(currentInput);
  } catch (error) {
    statusLine.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function createDrawing(): Promise<void> {
  statusLine.textContent = "JWW作成中";
  try {
    await ensureWasm();
    const drawing = newJwwDocument() as JwwWriteDocument;
    drawing.options.memo = "ブラウザーで作成\r\n";
    drawing.options.layer_groups[0].name = "作成例";
    const base = {
      group: 0, pen_style: 1, pen_color: 1, pen_width: 0, layer: 0, layer_group: 0, flag: 0,
    };
    drawing.entities.push(
      { type: "LINE", base: { ...base }, start_x: -50, start_y: -20, end_x: 50, end_y: -20 },
      {
        type: "CIRCLE", base: { ...base, pen_color: 2 }, center_x: -30, center_y: 10,
        radius: 10, start_angle: 0, arc_angle: 2 * Math.PI, tilt_angle: 0,
        flatness: 1, is_full_circle: true,
      },
      {
        type: "ARC", base: { ...base, pen_color: 3 }, center_x: 0, center_y: 10,
        radius: 10, start_angle: 350 * (Math.PI / 180), arc_angle: 30 * (Math.PI / 180),
        tilt_angle: 0, flatness: 1, is_full_circle: false,
      },
      {
        type: "POINT", base: { ...base, pen_color: 4 }, x: 30, y: 10,
        is_temporary: false, code: 0, angle: 0, scale: 0,
      },
      {
        type: "TEXT", base: { ...base }, start_x: -50, start_y: -35, end_x: -20, end_y: -35,
        text_type: 0, size_x: 3, size_y: 3, spacing: 0, angle: 0,
        font_name: "ＭＳ ゴシック", content: "日本語 ABC",
      },
    );
    const bytes = toJwwBytes(drawing);
    currentInput = { name: "created.jww", size: bytes.byteLength, bytes, generated: true };
    resetZoom();
    await parseBytes(currentInput);
  } catch (error) {
    statusLine.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function parseBytes(input: CurrentInput): Promise<void> {
  selectedTextIndex = null;
  textHits = [];
  textUndoStack.length = 0;
  textRedoStack.length = 0;
  sharePanel.hidden = true;
  originalText.clear();
  updateNavigationProtection();
  resetPdfRangeOnNewDrawing();
  nativeTextByDxfIndex.clear();
  nativeTextMatched = 0;
  nativeTextTotal = 0;
  nativeTextAttrs.open = false;
  fontAuditBody.textContent = "";
  statusLine.textContent = "読込中";
  try {
    await ensureWasm();
    const started = performance.now();
    if (!detectFileFormat(input.bytes)) {
      throw new Error("JWW/JWC/JWSシグネチャを確認できません");
    }

    const cad = readCadDocument(input.bytes) as CadDocument;
    // The preview-only converter omits JWW pen_color=9 OR pen_style=9.
    // The original DXF save continues through readDxfString with no filtering.
    const dxf = readPreviewDxfDocument(input.bytes, explodeInserts, 32, jwcCoordinates) as DxfDocument;
    const dxfText = readDxfString(input.bytes, explodeInserts, 32, jwcCoordinates);
    buildNativeTextMatches(cad, dxf);
    renderFontAudit(cad);

    parsedState = {
      fileName: input.name,
      fileSize: input.size,
      cad,
      dxf,
      dxfText,
      elapsedMs: performance.now() - started,
      explodeInserts,
      generatedJww: input.generated ? input.bytes : undefined,
    };
    statusLine.textContent = `${input.name} / ${formatBytes(input.size)}`;
    render();
    updateNavigationProtection();
    // Wait for initial source-byte persistence before file loading is
    // considered finished. Later PDF sharing cannot erase an unsaved source.
    if (!restoringWorkingSession) await queueWorkingSave();
  } catch (error) {
    parsedState = null;
    statusLine.textContent = error instanceof Error ? error.message : String(error);
    render();
    updateNavigationProtection();
  }
}

async function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm().then(() => undefined);
  }
  return wasmReady;
}

function render(): void {
  renderMetrics(parsedState);
  renderCounts(parsedState);
  renderLayers(parsedState?.cad ?? null);
  downloadJwwButton.disabled = !parsedState?.generatedJww;
  updateShareControls();
  coordinateSelect.disabled = parsedState?.cad.format !== "jwc";
  floatingFitButton.hidden = !parsedState;
  renderPreview(parsedState);
  renderDetail(parsedState);
  syncTextEditPanel();
}

function renderMetrics(state: ParsedState | null): void {
  const target = document.querySelector<HTMLDivElement>("#metrics")!;
  if (!state) {
    target.innerHTML = metricMarkup([
      ["Version", "-"],
      ["Entities", "-"],
      ["DXF", "-"],
      ["Parse", "-"],
    ]);
    return;
  }

  target.innerHTML = metricMarkup([
    ["Format / Version", state.cad.format !== "jwc" ? `${state.cad.format.toUpperCase()} ${state.cad.document.header.version}` : `JWC ${state.cad.document.header.source_version ?? "版不明"}`],
    ["Entities", formatNumber(state.cad.document.entities.length)],
    ["DXF", formatNumber(state.dxf.entities.length)],
    ["Parse", `${state.elapsedMs.toFixed(1)} ms`],
  ]);
}

function renderCounts(state: ParsedState | null): void {
  const target = document.querySelector<HTMLDivElement>("#counts")!;
  if (!state) {
    target.innerHTML = panelTitle("Entity Counts") + emptyLine();
    return;
  }

  const rows = Object.entries(state.cad.document.entity_counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([type, count]) => `
        <tr>
          <td>${escapeHtml(type)}</td>
          <td class="num">${formatNumber(count)}</td>
        </tr>
      `,
    )
    .join("");

  const validation = state.cad.format !== "jwc" ? state.cad.document.validation : null;
  target.innerHTML = `
    ${panelTitle("Entity Counts")}
    <table class="data-table">
      <tbody>${rows}</tbody>
    </table>
    <div class="status-grid">
      <span>Block refs</span>
      <strong>${validation ? `${validation.resolved_references}/${validation.total_references}` : "定義なし"}</strong>
      <span>Unsupported</span>
      <strong>${state.dxf.unsupported_entities.length}</strong>
    </div>
  `;
}

function renderLayers(cad: CadDocument | null): void {
  const target = document.querySelector<HTMLDivElement>("#layers")!;
  if (!cad) {
    target.innerHTML = panelTitle("Layer Groups") + emptyLine();
    return;
  }
  if (cad.format === "jws") {
    const groups = cad.document.header.group_scales.map((scale, index) =>
      `<li><span>${index.toString(16).toUpperCase()}</span><strong>1:${scale}</strong><em>設定なし</em></li>`,
    ).join("");
    target.innerHTML = `${panelTitle("Layer Group Scales")}<p>JWSは保存座標で表示します。色・線種には既定値を使います。</p><ul class="layer-list">${groups}</ul>`;
    return;
  }
  const groups = cad.document.header.layer_groups.map((group, index) => {
    const name = typeof group.name === "string" ? group.name : group.name.text;
    const names = group.layers.map(layer => typeof layer.name === "string" ? layer.name : layer.name.text);
    const state = typeof group.state === "number" ? String(group.state) : group.state.visible ? "表示" : "非表示";
    return `<li><span>${index.toString(16).toUpperCase()}</span><strong>${escapeHtml(name)} / 1:${group.scale} / ${state}</strong><em>${names.filter(n => n.trim()).length}</em></li>`;
  }).join("");
  target.innerHTML = `${panelTitle("Layer Groups")}<ul class="layer-list">${groups}</ul>`;
}

function renderPreview(state: ParsedState | null): void {
  const meta = document.querySelector<HTMLDivElement>("#preview-meta")!;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.fillStyle = canvasBackground === "black" ? "#000000" : "#f7f8fb";
  context.fillRect(0, 0, rect.width, rect.height);

  if (!state) {
    meta.textContent = "No drawing";
    textHits = [];
    document.querySelector<HTMLDivElement>("#line-style-status")!.textContent =
      "V012：図面を開くと線種を再現します。";
    updateTextSelectionStatus();
    drawEmptyPreview(context, rect.width, rect.height);
    return;
  }

  meta.textContent = `${state.fileName} / ${state.cad.format === "jwc" ? (jwcCoordinates === "paper_millimeters" ? "紙上mm" : "実寸mm") : state.explodeInserts ? "exploded" : "inserted"}`;
  drawDxf(context, rect.width, rect.height, state.dxf);
  drawPdfRangeOverlay(context);
}

function renderDetail(state: ParsedState | null): void {
  const target = document.querySelector<HTMLDivElement>("#detail")!;
  if (!state) {
    target.innerHTML = `<div class="empty-detail">No data</div>`;
    return;
  }

  if (viewMode === "entities") {
    target.innerHTML = renderEntityTable(state.cad);
    return;
  }

  if (viewMode === "json") {
    const json = JSON.stringify(state.cad, null, 2);
    target.innerHTML = `<pre class="json-view">${escapeHtml(json)}</pre>`;
    return;
  }

  const unresolved = state.cad.format !== "jwc" && state.cad.document.validation.has_unresolved;
  target.innerHTML = `
    <div class="summary-grid">
      <div>
        <span>File</span>
        <strong>${escapeHtml(state.fileName)}</strong>
      </div>
      <div>
        <span>Size</span>
        <strong>${formatBytes(state.fileSize)}</strong>
      </div>
      <div>
        <span>Blocks</span>
        <strong>${formatNumber(state.cad.format !== "jwc" ? state.cad.document.block_defs.length : 0)}</strong>
      </div>
      <div>
        <span>DXF text</span>
        <strong>${formatBytes(new Blob([state.dxfText]).size)}</strong>
      </div>
    </div>
    <div class="issue-line ${unresolved ? "warn" : ""}">
      ${state.cad.format === "jwc" ? "フォントは代替表示です。字間の完全再現には対応していません。" : unresolved ? "未解決のBLOCK参照あり" : "BLOCK参照は解決済み"}
    </div>
    <div class="issue-line">${state.cad.document.diagnostics.map(d => escapeHtml(d.message)).join("<br>")}</div>
    ${state.dxf.jwc_conversion_report ? `<details><summary>変換時の既定値・再現上の制約</summary><ul>${state.dxf.jwc_conversion_report.notices.map(n => `<li>${escapeHtml(n.field)}: ${escapeHtml(n.detail)}</li>`).join("")}</ul></details>` : ""}
  `;
}

function renderEntityTable(cad: CadDocument): string {
  const rows = cad.document.entities.slice(0, 200).map((entity, index) => {
    let layer: string, color: string, point: string;
    if ("base" in entity) {
      layer = `${entity.base.layer_group}:${entity.base.layer}`;
      color = String(entity.base.pen_color);
      point = firstPoint(entity);
    } else {
      const address = "attributes" in entity ? entity.attributes.layer : entity.layer;
      layer = `${address.group}:${address.layer}`;
      color = "attributes" in entity ? String(entity.attributes.pen_color) : "pen_color" in entity ? String(entity.pen_color) : "text_preset" in entity && cad.format === "jwc" ? String(cad.document.header.text_presets[entity.text_preset].pen_color) : "未格納";
      const position = "start" in entity ? entity.start : "center" in entity ? entity.center : entity.position;
      point = `${position.x.toFixed(2)}, ${position.y.toFixed(2)}`;
    }
    return `<tr><td class="num">${index + 1}</td><td>${escapeHtml(entity.type)}</td><td class="num">${layer}</td><td class="num">${color}</td><td>${point}</td></tr>`;
  }).join("");
  return `<table class="entity-table"><thead><tr><th>#</th><th>Type</th><th>Layer</th><th>Color</th><th>${cad.format === "jwc" ? "元座標" : "Point"}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function drawDxf(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  dxf: DxfDocument,
  options: {
    exportMode?: boolean; exportWhole?: boolean; zoom?: number;
    panX?: number; panY?: number; padding?: number; strokePx?: number;
    backgroundOverride?: "white" | "black"; exportBounds?: Bounds;
  } = {},
): void {
  const exportMode = options.exportMode === true;
  const drawingBackground = options.backgroundOverride ?? canvasBackground;
  const renderZoom = options.zoom ?? viewZoom;
  const renderPanX = options.panX ?? viewPanX;
  const renderPanY = options.panY ?? viewPanY;
  const isJwc = !!dxf.jwc_conversion_report;
  if (!exportMode) textHits = [];
  const hidden = new Set(isJwc ? dxf.layers.filter(layer => layer.frozen).map(layer => layer.name) : []);
  const widths = new Map<DxfEntity, number>();
  let textIndex = 0;
  for (const entity of dxf.entities) {
    if (entity.type === "TEXT" && isJwc) widths.set(entity, dxf.text_width_factors?.[textIndex++] ?? 1);
  }
  const visible = dxf.entities.filter(entity => !hidden.has(entity.layer));
  // Preserve the original entity index despite layer filtering.
  const visibleIndices = dxf.entities.flatMap((entity, index) =>
    hidden.has(entity.layer) ? [] : [index]);
  // ezjww supplies real JWW line-style definitions as DXF LTYPE patterns.
  // These are in paper millimetres: positive=ink, negative=gap.
  const definedLineTypes = new Map(dxf.line_types.map(t => [t.name.toUpperCase(), t.pattern] as const));
  const layersByName = new Map(dxf.layers.map(layer => [layer.name, layer] as const));
  let patternedCount = 0;
  let unknownCount = 0;
  const bounds = options.exportBounds ?? dxfBounds(visible, context, widths);
  if (!bounds) {
    drawEmptyPreview(context, width, height);
    return;
  }

  const padding = options.padding ?? 28;
  const modelWidth = Math.max(1, bounds.maxX - bounds.minX);
  const modelHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(
    (width - padding * 2) / modelWidth,
    (height - padding * 2) / modelHeight,
  );

  const offsetX = (exportMode || isJwc) ? (width - modelWidth * scale) / 2 : padding;
  const offsetY = (exportMode || isJwc) ? (height - modelHeight * scale) / 2 : padding;
  const toScreen = (x: number, y: number): [number, number] => [
    offsetX + (x - bounds.minX) * scale,
    height - offsetY - (y - bounds.minY) * scale,
  ];

  // Jw_cad black canvas does not show the light-mode checking grid.
  if (!exportMode && canvasBackground === "white") drawGrid(context, width, height);
  context.save();
  if (options.exportBounds) {
    // Crop crossing lines, fills and text at the requested window.
    context.beginPath();
    context.rect(padding, padding, width-2*padding, height-2*padding);
    context.clip();
  }
  context.translate(width/2 + renderPanX, height/2 + renderPanY);
  context.scale(renderZoom, renderZoom);
  context.translate(-width/2, -height/2);
  context.lineCap = "round";
  context.lineJoin = "round";

  // V021: CAD drawing order (bottom -> top): SOLID, geometry, TEXT.
  // Keep the original sequence *inside each group*, and retain each entity's
  // original visible index for hit-testing and native-text mapping.
  const solidIndices: number[] = [];
  const geometryIndices: number[] = [];
  const textIndices: number[] = [];
  for (let i = 0; i < visible.length; i++) {
    const type = visible[i].type;
    if (type === "SOLID") solidIndices.push(i);
    else if (type === "TEXT") textIndices.push(i);
    else geometryIndices.push(i);
  }
  const drawOrder = [...solidIndices, ...geometryIndices, ...textIndices];
  for (const index of drawOrder) {
    const entity = visible[index];
    // White background retains V018 display colors. Black uses the
    // source JWW palette converted to DXF ACI by ezjww (an approximation
    // when JWW used arbitrary user-customized RGB colors).
    const originalWhiteColor = isJwc
      ? (({132: "#00a5a5", 18: "#260000", 92: "#00a500", 52: "#a5a500", 212: "#a500a5"} as Record<number, string>)[entity.color] ?? colorFor(entity.color))
      : colorFor(entity.color);
    context.strokeStyle = drawingBackground === "black" ? dxfAciColor(entity.color) : originalWhiteColor;
    context.fillStyle = context.strokeStyle;
    context.lineWidth = (options.strokePx ?? 1.2) / renderZoom;
    if (entity.type === "LINE" || entity.type === "ARC" ||
        entity.type === "CIRCLE" || entity.type === "ELLIPSE") {
      const lineStyle = findLineStyle(entity, definedLineTypes, layersByName);
      if (lineStyle.pattern && lineStyle.pattern.length >= 2) patternedCount += 1;
      if (lineStyle.unresolved) unknownCount += 1;
      context.setLineDash(showJwwLineTypes && lineStyle.pattern
        ? previewDashPattern(lineStyle.pattern, scale, renderZoom) : []);
    } else {
      // Solids, points and labels must not inherit the previous line's dash.
      context.setLineDash([]);
    }
    drawEntity(context, entity, toScreen, scale, widths.get(entity), renderZoom, drawingBackground);
    // Text glyphs now render after all lines/circles/points, so they appear
    // in front. Preserve the original array index for text selection.
    if (!exportMode && entity.type === "TEXT" && hasNumbers(entity, "x", "y") && entity.content) {
      const [baseX,baseY] = toScreen(entity.x,entity.y);
      const fontHeight = Math.max(0.1,(entity.height ?? 2.5)*scale);
      const widthFactor = textWidthFactorFor(entity,widths.get(entity));
      context.save();
      context.font = fontHeight + "px sans-serif";
      const measuredWidth = measureJwCadText(context, entity.content).width * widthFactor;
      context.restore();
      const centerX=width/2,centerY=height/2;
      textHits.push({
        index:visibleIndices[index],content:entity.content,layer:entity.layer,
        x:centerX+renderPanX+(baseX-centerX)*renderZoom,
        y:centerY+renderPanY+(baseY-centerY)*renderZoom,
        width:Math.max(0.5,measuredWidth*renderZoom),
        height:Math.max(0.5,fontHeight*renderZoom),
        angle:-degToRad(entity.rotation ?? 0),
      });
    }
  }
  context.restore();
  if (!exportMode) {
    document.querySelector<HTMLDivElement>("#line-style-status")!.textContent =
      "V013：補助線色・補助線種を除外 / 線種：" + (showJwwLineTypes ? "原図表示" : "すべて実線") +
      " / 破線・鎖線等 " + patternedCount.toLocaleString("ja-JP") + "要素" +
      " / 線種定義 " + dxf.line_types.length + "種類" +
      (unknownCount ? " / 未解決 " + unknownCount + "要素" : "");
    drawSelectedTextHighlight(context);
    updateTextSelectionStatus();
  }
}


/**
 * DXF LTYPE patterns from ezjww are alternating signed millimetres on paper.
 * Keep real ratios and zoom with the CAD view; mildly exaggerate very short
 * segments to avoid solid-looking chain lines on a phone at overall fit.
 * This changes canvas appearance only, never JWW data or exported DXF.
 */
type PreviewLineStyle = { pattern: number[] | null; unresolved: boolean };
const knownLinePatterns: Record<string, number[]> = {
  DASHED: [0.6, -0.3],
  JWC_DASHED1: [1.25, -1.25],
  JWC_DASHED2: [2.5, -2.5],
  JWC_DASHED3: [0.6, -0.6],
  JWC_DASHDOT1: [7.5, -1.25, 1.25, -1.25],
  JWC_DASHDOT2: [12.5, -2.5, 2.5, -2.5],
  JWC_DIVIDE1: [7.5, -1.25, 1.25, -1.25, 1.25, -1.25],
};

function findLineStyle(
  entity: DxfEntity,
  definitions: Map<string, number[]>,
  layers: Map<string, { line_type: string }>,
): PreviewLineStyle {
  let name = (entity.line_type || "BYLAYER").toUpperCase();
  if (name === "BYLAYER") {
    name = (layers.get(entity.layer)?.line_type || "CONTINUOUS").toUpperCase();
  }
  if (name === "CONTINUOUS" || name === "BYBLOCK" || name === "BYLAYER" || !name) {
    return { pattern: null, unresolved: false };
  }
  const pattern = definitions.get(name) ?? knownLinePatterns[name];
  if (!pattern) return { pattern: null, unresolved: true };
  if (pattern.length < 2 || !pattern.every(Number.isFinite)) {
    return { pattern: null, unresolved: false };
  }
  return { pattern, unresolved: false };
}

function previewDashPattern(
  pattern: number[], baseScale: number, zoom: number,
): number[] {
  const lengths = pattern.map(v => Math.abs(v)).filter(v => v > 1e-9);
  if (!lengths.length) return [];
  const smallest = Math.min(...lengths) * baseScale * zoom;
  const largest = Math.max(...lengths) * baseScale * zoom;
  // Minimum legibility ~1.5 CSS px; cap the longest segment at 72 CSS px.
  // Preserve original spacing once the pattern is already legible.
  let factor = smallest < 1.5 ? 1.5 / Math.max(smallest, 1e-9) : 1;
  if (largest * factor > 72) factor = 72 / Math.max(largest, 1e-9);
  factor = Math.max(0.01, Math.min(64, factor));
  return pattern.map(mm => mm === 0 ? 0.6 / zoom : Math.max(0.03, Math.abs(mm) * baseScale * factor));
}

function drawEntity(
  context: CanvasRenderingContext2D,
  entity: DxfEntity,
  toScreen: (x: number, y: number) => [number, number],
  scale: number,
  textWidthFactor?: number,
  renderZoom = viewZoom,
  drawingBackground: "white" | "black" = canvasBackground,
): void {
  if (entity.type === "LINE" && hasNumbers(entity, "x1", "y1", "x2", "y2")) {
    const [x1, y1] = toScreen(entity.x1, entity.y1);
    const [x2, y2] = toScreen(entity.x2, entity.y2);
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
    return;
  }

  if (entity.type === "CIRCLE" && hasNumbers(entity, "center_x", "center_y", "radius")) {
    const [x, y] = toScreen(entity.center_x, entity.center_y);
    context.beginPath();
    // Real CAD circles must preserve their radius.  The former
    // 0.8px minimum artificially enlarged small circles at overall-fit.
    // Both radius and adjacent line distances now share the exact
    // model-to-screen scale, including canvas pinch zoom.
    const radiusInView = Math.abs(entity.radius) * scale;
    if (!Number.isFinite(radiusInView) || radiusInView <= 0) return;
    context.arc(x, y, radiusInView, 0, Math.PI * 2);
    context.stroke();
    return;
  }

  if (entity.type === "ARC" && hasNumbers(entity, "center_x", "center_y", "radius", "start_angle", "end_angle")) {
    drawArcPolyline(context, entity, toScreen);
    return;
  }

  if (entity.type === "ELLIPSE" && hasNumbers(entity, "center_x", "center_y", "major_axis_x", "major_axis_y", "minor_ratio")) {
    const [x, y] = toScreen(entity.center_x, entity.center_y);
    const major = Math.hypot(entity.major_axis_x, entity.major_axis_y) * scale;
    context.beginPath();
    context.ellipse(x, y, major, major * entity.minor_ratio, -Math.atan2(entity.major_axis_y, entity.major_axis_x), -(entity.end_param ?? Math.PI * 2), -(entity.start_param ?? 0));
    context.stroke();
    return;
  }

  if (entity.type === "SOLID" && hasNumbers(entity, "x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4")) {
    const p1 = toScreen(entity.x1, entity.y1);
    const p2 = toScreen(entity.x2, entity.y2);
    const p3 = toScreen(entity.x3, entity.y3);
    const p4 = toScreen(entity.x4, entity.y4);
    context.save();
    // Match the former light-mode tone, but make the fill opaque.
    // Transparent fills produce dark overlap seams across adjoining SOLIDs.
    const solidColor = String(context.fillStyle);
    context.fillStyle = drawingBackground === "white"
      ? solidColorOnWhite(solidColor) : solidColor;
    context.beginPath();
    context.moveTo(...p1);
    context.lineTo(...p2);
    context.lineTo(...p3);
    context.lineTo(...p4);
    context.closePath();
    context.fill();
    // A hairline in the SAME fill color closes anti-alias gaps between
    // adjoining polygons; unlike the old differently tinted boundary line,
    // it cannot create a visible border on a same-color contiguous surface.
    context.strokeStyle = context.fillStyle;
    context.lineWidth = 0.7 / renderZoom;
    context.setLineDash([]);
    context.stroke();
    context.restore();
    return;
  }

  if (entity.type === "POINT" && hasNumbers(entity, "x", "y")) {
    const [x, y] = toScreen(entity.x, entity.y);
    context.beginPath();
    // POINT glyphs are drawn under the canvas zoom transform.
    // Use zoom-aware inverse radius, allowing modest growth but capping
    // visual size so dimension markers do not obscure nearby annotations.
    const screenRadius = Math.min(3.2,
      Math.max(0.55, pointDisplayRadius * Math.sqrt(renderZoom)));
    context.arc(x, y, screenRadius / renderZoom, 0, Math.PI * 2);
    context.fill();
    return;
  }

  if (entity.type === "TEXT" && hasNumbers(entity, "x", "y")) {
    const [x, y] = toScreen(entity.x, entity.y);
    context.save();
    context.translate(x, y);
    context.rotate(-degToRad(entity.rotation ?? 0));
    context.scale(textWidthFactorFor(entity, textWidthFactor), 1);
    context.font = `${Math.max(0.1, (entity.height ?? 2.5) * scale)}px sans-serif`;
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    drawJwCadText(context, entity.content ?? "");
    context.restore();
    return;
  }
}



/**
 * Jw_cad's terminal middle dots are JUSTIFICATION instructions, not printed
 * punctuation. Each terminal fullwidth "・" adds one fullwidth advance, and
 * a final halfwidth "･" adds 1/2 advance, spread between visible glyphs.
 *
 * Examples: "土台継手部・" -> wider evenly spaced "土台継手部".
 * Internal dots remain literal. A trailing space also keeps the dot literal.
 * Only the preview canvas is changed; raw JWW and edited DXF text remain intact.
 */
interface JwCadTextLayout {
  visibleText: string;
  glyphs: string[];
  gap: number;
  width: number;
  justified: boolean;
}
function measureJwCadText(context: CanvasRenderingContext2D, raw: string): JwCadTextLayout {
  const suffix = /(?:・+･?|･)$/u.exec(raw)?.[0];
  const visible = suffix ? raw.slice(0, -suffix.length) : raw;
  const glyphs = Array.from(visible);
  if (!suffix || glyphs.length < 1) {
    return { visibleText: raw, glyphs: Array.from(raw), gap: 0,
      width: context.measureText(raw).width, justified: false };
  }
  const extraFull = Array.from(suffix).filter(ch => ch === "・").length;
  const extraHalf = suffix.endsWith("･") ? 0.5 : 0;
  const fullAdvance = context.measureText("あ").width;
  const extraWidth = (extraFull + extraHalf) * fullAdvance;
  // With one character there are no inter-character gaps; suppress control
  // suffix but do not invent a location for the added blank.
  const gap = glyphs.length > 1 ? extraWidth / (glyphs.length - 1) : 0;
  const normalWidth = glyphs.reduce((total, ch) => total + context.measureText(ch).width, 0);
  return { visibleText: visible, glyphs, gap,
    width: normalWidth + gap * (glyphs.length - 1), justified: true };
}
function drawJwCadText(context: CanvasRenderingContext2D, raw: string): void {
  const layout = measureJwCadText(context, raw);
  if (!layout.justified) {
    context.fillText(raw, 0, 0);
    return;
  }
  let x = 0;
  for (const ch of layout.glyphs) {
    context.fillText(ch, x, 0);
    x += context.measureText(ch).width + layout.gap;
  }
}

function textWidthFactorFor(entity:DxfEntity, fromJwc?:number):number {
  const f=fromJwc ?? entity.width_factor ?? 1;
  return Number.isFinite(f) ? Math.max(0.1,Math.min(10,f)) : 1;
}
function selectedHit():TextHit | undefined {
  return textHits.find(t=>t.index===selectedTextIndex);
}
function updateTextSelectionStatus():void {
  const el=document.querySelector<HTMLDivElement>("#text-selection-status")!;
  const selected=selectedHit();
  if(selected) {
    el.textContent="V014 選択文字: 「"+selected.content+"」 / レイヤ: "+selected.layer+
      " / 画面変更 "+textUndoStack.length+"件";
  } else {
    el.textContent=parsedState
      ? "V014：文字候補 "+textHits.length+"件。図面の文字をタップして選択してください。"
      : "V014：図面を開くと文字を選択・変更できます。";
  }
}
function selectTextAt(point:{x:number,y:number}):void {
  let best:TextHit|undefined, bestDistance=Number.POSITIVE_INFINITY;
  for(const t of textHits) {
    // Undo the display rotation so hit areas match angled CAD text.
    const dx=point.x-t.x,dy=point.y-t.y;
    const c=Math.cos(t.angle),s=Math.sin(t.angle);
    const lx=c*dx+s*dy,ly=-s*dx+c*dy;
    const outsideX=Math.max(0,-lx,lx-t.width);
    const outsideY=Math.max(0,-t.height-ly,ly);
    const dist=Math.hypot(outsideX,outsideY);
    if(dist<=10 && dist<bestDistance) {best=t;bestDistance=dist;}
  }
  selectedTextIndex=best?.index ?? null;
  syncTextEditPanel();
  redrawZoom();
  scheduleWorkingSave(500);
  updateNavigationProtection();
}


/**
 * Use only direct JWW TEXTs whose original content, anchor and angle uniquely
 * identify the TEXT produced by DXF conversion. Exploded block text is
 * deliberately "not verified": its coordinates can undergo INSERT transforms.
 */
function nativeTextFromEntity(e: JwwEntity): NativeJwwText | null {
  if (e.type !== "TEXT") return null;
  const t = e.text ?? e;
  if (typeof t.content !== "string" || typeof t.start_x !== "number" ||
      typeof t.start_y !== "number" || typeof t.end_x !== "number" ||
      typeof t.end_y !== "number") return null;
  const values = [t.start_x, t.start_y, t.end_x, t.end_y,
    t.size_x, t.size_y, t.spacing, t.angle];
  if (!values.every(v => typeof v === "number" && Number.isFinite(v))) return null;
  return {
    content: t.content, fontName: t.font_name ?? "",
    textType: t.text_type ?? 0, sizeX: t.size_x!, sizeY: t.size_y!,
    spacing: t.spacing!, angle: t.angle!,
    startX: t.start_x, startY: t.start_y,
    endX: t.end_x, endY: t.end_y,
    layerGroup: e.base.layer_group, layer: e.base.layer,
  };
}
function smallAngleDiffDegrees(a: number, b: number): number {
  const diff = ((a - b) % 360 + 540) % 360 - 180;
  return Math.abs(diff);
}
function buildNativeTextMatches(cad: CadDocument, dxf: DxfDocument): void {
  nativeTextByDxfIndex.clear();
  nativeTextMatched = 0;
  nativeTextTotal = 0;
  if (cad.format !== "jww") return;
  const native = cad.document.entities.map(nativeTextFromEntity)
    .filter((t): t is NativeJwwText => t !== null);
  nativeTextTotal = native.length;
  const byContent = new Map<string, NativeJwwText[]>();
  for (const t of native) {
    const group = byContent.get(t.content) ?? [];
    group.push(t);
    byContent.set(t.content, group);
  }
  const tentative = new Map<number, NativeJwwText>();
  const nativeUsages = new Map<NativeJwwText, number>();
  for (const [index, dxfText] of dxf.entities.entries()) {
    if (dxfText.type !== "TEXT" || !dxfText.content ||
        !Number.isFinite(dxfText.x) || !Number.isFinite(dxfText.y)) continue;
    const candidates = (byContent.get(dxfText.content) ?? []).filter(t =>
      Math.abs(t.startX - dxfText.x!) <= 0.001 &&
      Math.abs(t.startY - dxfText.y!) <= 0.001 &&
      smallAngleDiffDegrees(t.angle, dxfText.rotation ?? 0) <= 0.001);
    if (candidates.length !== 1) continue;
    const source = candidates[0];
    tentative.set(index, source);
    nativeUsages.set(source, (nativeUsages.get(source) ?? 0) + 1);
  }
  for (const [index, source] of tentative) {
    // Do not make a positive assertion if two DXF entities share one source.
    if (nativeUsages.get(source) !== 1) continue;
    nativeTextByDxfIndex.set(index, source);
  }
  nativeTextMatched = nativeTextByDxfIndex.size;
}
function charIsHalfCell(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return (cp >= 0x20 && cp <= 0x80) || cp === 0xA5 ||
    cp === 0x203E || (cp >= 0xF8F0 && cp <= 0xF8F3) ||
    (cp >= 0xFF61 && cp <= 0xFF9F);
}
function textCellInfo(raw: string): string {
  let half = 0, full = 0;
  for (const c of Array.from(raw)) {
    if (charIsHalfCell(c)) half++;
    else full++;
  }
  return "全角相当 " + full + "字 / 半角相当 " + half +
    "字 / 合計 " + (full + half * 0.5) + "文字幅相当";
}
function formatSourceValue(value: number): string {
  return Number.isFinite(value) ? Number(value.toFixed(5)).toLocaleString("ja-JP") : "不明";
}
function addNativeAttr(label: string, value: string): void {
  const row = document.createElement("div");
  row.className = "native-text-attr-row";
  const name = document.createElement("span");
  name.textContent = label;
  const data = document.createElement("strong");
  data.textContent = value;
  row.append(name, data);
  nativeTextAttrBody.appendChild(row);
}
function renderNativeTextAttributes(dxfText: DxfEntity | null): void {
  nativeTextAttrBody.replaceChildren();
  if (!dxfText || selectedTextIndex === null) {
    nativeTextAttrs.open = false;
    return;
  }
  const native = nativeTextByDxfIndex.get(selectedTextIndex);
  if (!native) {
    addNativeAttr("元JWW", "未照合（ブロック内の文字、同位置の重複等の可能性）");
    addNativeAttr("画面表示の文字高さ", formatSourceValue(dxfText.height ?? 0));
    addNativeAttr("画面表示のフォント", "Safari標準の sans-serif（元フォントではありません）");
    return;
  }
  addNativeAttr("照合", "元JWWの直接文字と一意に一致");
  addNativeAttr("元文字列", native.content);
  addNativeAttr("フォント名", native.fontName || "未指定（JWW記録値が空欄）");
  addNativeAttr("文字種番号", String(native.textType));
  addNativeAttr("文字幅 size_x", formatSourceValue(native.sizeX) + "（元データ値）");
  addNativeAttr("文字高さ size_y", formatSourceValue(native.sizeY) + "（元データ値）");
  addNativeAttr("文字間隔 spacing", formatSourceValue(native.spacing) + "（元データ値）");
  addNativeAttr("角度", formatSourceValue(native.angle) + "°");
  addNativeAttr("始点と終点の距離", formatSourceValue(
    Math.hypot(native.endX-native.startX, native.endY-native.startY)) + "（元データ値）");
  addNativeAttr("全角・半角", textCellInfo(native.content));
  addNativeAttr("レイヤ", native.layerGroup.toString(16).toUpperCase() +
    "-" + native.layer.toString(16).toUpperCase());
  addNativeAttr("iPhoneの描画フォント", "sans-serif（代替フォント）");
  addNativeAttr("DXF表示用の文字高さ", formatSourceValue(dxfText.height ?? 0));
  addNativeAttr("DXF表示用の幅係数", formatSourceValue(dxfText.width_factor ?? 1));
}
function renderFontAudit(cad: CadDocument): void {
  fontAuditBody.replaceChildren();
  if (cad.format !== "jww") {
    fontAuditBody.textContent = "元JWWのフォント一覧はJWW形式で読み込んだときに表示します。";
    return;
  }
  const direct = cad.document.entities.map(nativeTextFromEntity)
    .filter((x): x is NativeJwwText => x !== null);
  const blocks = cad.document.block_defs.flatMap(block =>
    block.entities.map(nativeTextFromEntity)
      .filter((x): x is NativeJwwText => x !== null));
  const tally = (source: NativeJwwText[]) => {
    const map = new Map<string, number>();
    for (const t of source) {
      const font = t.fontName || "未指定（空欄）";
      map.set(font, (map.get(font) ?? 0) + 1);
    }
    return [...map].sort((a,b)=> b[1]-a[1] || a[0].localeCompare(b[0], "ja"));
  };
  const title = document.createElement("p");
  title.textContent = "元JWW：直接文字 " + direct.length +
    "件／ブロック定義内 " + blocks.length +
    "件（未使用定義を含む）／画面の文字との一意照合 " + nativeTextMatched +
    "件。元図のフォント名であり、iPhoneの表示フォントとは異なります。";
  fontAuditBody.appendChild(title);
  for (const [label, source] of [
    ["直接文字", direct], ["ブロック定義内の文字", blocks],
  ] as const) {
    const heading = document.createElement("strong");
    heading.textContent = label;
    fontAuditBody.appendChild(heading);
    const rows = document.createElement("div");
    rows.className = "font-audit-rows";
    const counts = tally(source);
    if (!counts.length) rows.textContent = "該当なし";
    for (const [font, count] of counts) {
      const row = document.createElement("div");
      row.textContent = font + "：" + count.toLocaleString("ja-JP") + "件";
      rows.appendChild(row);
    }
    fontAuditBody.appendChild(rows);
  }
}

/** V014: preview edit state is intentionally independent from source bytes. */
function selectedTextEntity(): DxfEntity | null {
  if (!parsedState || selectedTextIndex === null) return null;
  const entity = parsedState.dxf.entities[selectedTextIndex];
  return entity?.type === "TEXT" && typeof entity.content === "string" ? entity : null;
}
function updateTextEditControls(): void {
  const entity = selectedTextEntity();
  textEditApply.disabled = !entity ||
    textEditInput.value.length === 0 || textEditInput.value === entity.content;
  textEditUndo.disabled = textUndoStack.length === 0;
  textEditRedo.disabled = textRedoStack.length === 0;
  textEditClear.disabled = !entity;
  updateShareControls();
}
function syncTextEditPanel(): void {
  const entity = selectedTextEntity();
  textEditPanel.hidden = !entity;
  textEditInput.disabled = !entity;
  renderNativeTextAttributes(entity);
  textEditInput.value = entity?.content ?? "";
  textEditNote.textContent = "変更履歴：" + textUndoStack.length +
    "件／現在の変更文字：" + effectiveTextChanges().length +
    "件。JWW保存時は文字と属性を照合して別名保存します。元のJWWは変更しません。";
  updateTextEditControls();
}
function applyTextEdit(): void {
  const entity = selectedTextEntity();
  if (!entity) return;
  const after = textEditInput.value;
  if (after.length === 0 || entity.content === after) return;
  const index = selectedTextIndex!;
  if (!originalText.has(index)) {
    const original = entity;
    if (typeof original.x !== "number" || typeof original.y !== "number") {
      textEditNote.textContent = "文字の座標情報が不足しています。JWW保存の可否も文字位置の照合結果によります。";
      return;
    }
    originalText.set(index, {
      before: original.content!,
      layer: original.layer,
      x: original.x,
      y: original.y,
      rotation: original.rotation ?? 0,
    });
  }
  const change: TextChange = {
    index, before: entity.content!, after,
  };
  textUndoStack.push(change);
  textRedoStack.length = 0;
  entity.content = after;
  syncTextEditPanel();
  redrawZoom();
  queueWorkingSave();
  updateNavigationProtection();
}
function undoTextEdit(): void {
  if (!parsedState) return;
  const change = textUndoStack.pop();
  if (!change) return;
  const entity = parsedState.dxf.entities[change.index];
  if (entity?.type !== "TEXT") {
    textUndoStack.push(change);
    return;
  }
  entity.content = change.before;
  textRedoStack.push(change);
  selectedTextIndex = change.index;
  syncTextEditPanel();
  redrawZoom();
  queueWorkingSave();
  updateNavigationProtection();
}
function redoTextEdit(): void {
  if (!parsedState) return;
  const change = textRedoStack.pop();
  if (!change) return;
  const entity = parsedState.dxf.entities[change.index];
  if (entity?.type !== "TEXT") {
    textRedoStack.push(change);
    return;
  }
  entity.content = change.after;
  textUndoStack.push(change);
  selectedTextIndex = change.index;
  syncTextEditPanel();
  redrawZoom();
  queueWorkingSave();
  updateNavigationProtection();
}

function drawSelectedTextHighlight(ctx:CanvasRenderingContext2D):void {
  const t=selectedHit();
  if(!t)return;
  ctx.save();
  ctx.translate(t.x,t.y);
  ctx.rotate(t.angle);
  ctx.fillStyle="rgba(253,186,56,0.20)";
  ctx.strokeStyle="#f59e0b";
  ctx.lineWidth=2;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.rect(-3,-t.height-4,t.width+6,t.height+8);
  ctx.fill();ctx.stroke();
  ctx.restore();
}

function drawArcPolyline(
  context: CanvasRenderingContext2D,
  entity: DxfEntity,
  toScreen: (x: number, y: number) => [number, number],
): void {
  let start = degToRad(entity.start_angle ?? 0);
  let end = degToRad(entity.end_angle ?? 0);
  if (end < start) {
    end += Math.PI * 2;
  }

  const steps = Math.max(8, Math.ceil((end - start) / (Math.PI / 24)));
  context.beginPath();
  for (let i = 0; i <= steps; i += 1) {
    const t = start + ((end - start) * i) / steps;
    const x = (entity.center_x ?? 0) + (entity.radius ?? 0) * Math.cos(t);
    const y = (entity.center_y ?? 0) + (entity.radius ?? 0) * Math.sin(t);
    const point = toScreen(x, y);
    if (i === 0) {
      context.moveTo(...point);
    } else {
      context.lineTo(...point);
    }
  }
  context.stroke();
}

function dxfBounds(entities: DxfEntity[], context: CanvasRenderingContext2D, widths: Map<DxfEntity, number>): Bounds | null {
  const points: Array<[number, number]> = [];
  for (const entity of entities) {
    collectDxfPoints(entity, points);
    if (widths.has(entity) && hasNumbers(entity, "x", "y", "height")) {
      context.font = "100px sans-serif";
      const metrics = context.measureText(entity.content ?? "");
      const factor = entity.height / 100;
      const left = -metrics.actualBoundingBoxLeft * factor * widths.get(entity)!;
      const right = metrics.actualBoundingBoxRight * factor * widths.get(entity)!;
      const bottom = -metrics.actualBoundingBoxDescent * factor;
      const top = metrics.actualBoundingBoxAscent * factor;
      const angle = degToRad(entity.rotation ?? 0);
      for (const [x, y] of [[left, bottom], [right, bottom], [left, top], [right, top]]) {
        points.push([entity.x + x * Math.cos(angle) - y * Math.sin(angle), entity.y + x * Math.sin(angle) + y * Math.cos(angle)]);
      }
    }
  }
  if (points.length === 0) {
    return null;
  }

  let minX = points[0][0];
  let minY = points[0][1];
  let maxX = minX;
  let maxY = minY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function collectDxfPoints(entity: DxfEntity, out: Array<[number, number]>): void {
  if (hasNumbers(entity, "x1", "y1", "x2", "y2")) {
    out.push([entity.x1, entity.y1], [entity.x2, entity.y2]);
  }
  if (hasNumbers(entity, "x3", "y3", "x4", "y4")) {
    out.push([entity.x3, entity.y3], [entity.x4, entity.y4]);
  }
  if (hasNumbers(entity, "x", "y")) {
    out.push([entity.x, entity.y]);
  }
  if (entity.type === "ELLIPSE" && hasNumbers(entity, "center_x", "center_y", "major_axis_x", "major_axis_y", "minor_ratio")) {
    const rx = Math.hypot(entity.major_axis_x, entity.major_axis_y * entity.minor_ratio);
    const ry = Math.hypot(entity.major_axis_y, entity.major_axis_x * entity.minor_ratio);
    out.push([entity.center_x - rx, entity.center_y - ry], [entity.center_x + rx, entity.center_y + ry]);
  }
  if (hasNumbers(entity, "center_x", "center_y", "radius")) {
    out.push(
      [entity.center_x - entity.radius, entity.center_y - entity.radius],
      [entity.center_x + entity.radius, entity.center_y + entity.radius],
    );
  }
}

function drawGrid(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.strokeStyle = "#d9dde5";
  context.lineWidth = 1;
  context.beginPath();
  for (let x = 0; x <= width; x += 48) {
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += 48) {
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
}

function drawEmptyPreview(context: CanvasRenderingContext2D, width: number, height: number): void {
  drawGrid(context, width, height);
  context.fillStyle = "#6b7280";
  context.font = "14px system-ui, sans-serif";
  context.textAlign = "center";
  context.fillText("No visible drawing data", width / 2, height / 2);
}

function hasNumbers<T extends string>(
  entity: DxfEntity,
  ...keys: T[]
): entity is DxfEntity & Record<T, number> {
  return keys.every((key) => typeof entity[key as keyof DxfEntity] === "number");
}

function firstPoint(entity: JwwEntity): string {
  const x = entity.start_x ?? entity.center_x ?? entity.x ?? entity.ref_x ?? entity.point1_x;
  const y = entity.start_y ?? entity.center_y ?? entity.y ?? entity.ref_y ?? entity.point1_y;
  if (typeof x !== "number" || typeof y !== "number") {
    return "-";
  }
  return `${x.toFixed(2)}, ${y.toFixed(2)}`;
}

function metricMarkup(items: Array<[string, string]>): string {
  return items
    .map(
      ([label, value]) => `
        <div class="metric">
          <span>${label}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `,
    )
    .join("");
}

function panelTitle(title: string): string {
  return `<div class="panel-title">${title}</div>`;
}

function emptyLine(): string {
  return `<div class="muted line">-</div>`;
}


/** ACI color palette, matching ezjww's DXF converter for JWW screen colors. */
function dxfAciColor(raw: number): string {
  const aci = Math.abs(Math.trunc(raw));
  if (aci === 0 || aci === 7 || aci === 256) return "#ffffff";
  const primaries = ["", "#ff0000", "#ffff00", "#00ff00", "#00ffff",
    "#0000ff", "#ff00ff", "#ffffff", "#808080", "#c0c0c0"];
  if (aci >= 1 && aci <= 9) return primaries[aci];
  if (aci >= 250 && aci <= 255) {
    const c = [0x54,0x76,0x98,0xbb,0xdd,0xff][aci-250];
    return rgbCss(c,c,c);
  }
  if (aci >= 10 && aci <= 249) {
    const group = Math.floor((aci - 10)/10), shade = (aci-10)%10;
    const hi = [1,0.65,0.5,0.3,0.15][Math.floor(shade/2)];
    const lo = shade%2 === 1 ? hi/2 : 0;
    const k=(group%4)/4;
    const rise=lo+(hi-lo)*k, fall=hi-(hi-lo)*k;
    const triplets=[
      [hi,rise,lo],[fall,hi,lo],[lo,hi,rise],
      [lo,fall,hi],[rise,lo,hi],[hi,lo,fall],
    ];
    const [r,g,b]=triplets[Math.floor(group/4)];
    return rgbCss(Math.round(255*r),Math.round(255*g),Math.round(255*b));
  }
  return "#ffffff";
}
function rgbCss(r:number,g:number,b:number): string {
  const byte = (v:number) => Math.max(0,Math.min(255,v)).toString(16).padStart(2,"0");
  return "#" + byte(r) + byte(g) + byte(b);
}
/** Light-mode SOLIDs keep roughly the V018 appearance, but are now opaque. */
function solidColorOnWhite(color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const n=parseInt(color.slice(1),16);
  const bg=[247,248,251], amount=0.22;
  const result=[(n>>16)&255,(n>>8)&255,n&255]
    .map((v,i)=>Math.round(bg[i]*(1-amount)+v*amount));
  return rgbCss(result[0],result[1],result[2]);
}

function colorFor(color: number): string {
  const palette = [
    "#111827",
    "#b91c1c",
    "#15803d",
    "#0f766e",
    "#1d4ed8",
    "#7c2d12",
    "#6d28d9",
    "#374151",
  ];
  return palette[Math.abs(color) % palette.length];
}

function degToRad(value: number): number {
  return (value * Math.PI) / 180;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("ja-JP").format(value);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

render();
window.addEventListener("resize", () => renderPreview(parsedState));
