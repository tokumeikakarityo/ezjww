import initWasm, {
  detectFileFormat,
  readCadDocument,
  readDxfDocument,
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
let pointDisplayRadius = 1.2;
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

app.innerHTML = `
  <header class="topbar">
    <div>
      <div class="eyebrow">ezjww</div>
      <h1>Browser Parser</h1>
    </div>
    <div class="actions">
      <label class="toggle">
        <input id="explode-toggle" type="checkbox" checked />
        <span>INSERT展開</span>
      </label>
      <label class="toggle">JWCの座標
        <select id="coordinate-select"><option value="paper_millimeters">紙上mm</option><option value="model_millimeters">実寸mm</option></select>
      </label>
      <button id="download-button" class="tool-button" type="button" disabled>DXF保存</button>
      <button id="sample-button" class="tool-button" type="button">サンプル読込</button>
      <button id="create-button" class="tool-button" type="button">JWW作成例</button>
      <button id="download-jww-button" class="tool-button" type="button" disabled>生成JWW保存</button>
      <label class="file-button">
        <input id="file-input" type="file" accept=".jww,.jwc,.jws,application/octet-stream" />
        ファイル選択
      </label>
    </div>
  </header>

  <main class="shell">
    <section class="left-pane">
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
        <div class="tabs" role="tablist" aria-label="表示切替">
          <button class="tab active" data-tab="summary" type="button">概要</button>
          <button class="tab" data-tab="entities" type="button">一覧</button>
          <button class="tab" data-tab="json" type="button">JSON</button>
        </div>
        <div class="preview-zoom-controls" aria-label="図面表示操作">
          <button id="zoom-out" type="button">－</button>
          <span id="zoom-level">100%</span>
          <button id="zoom-in" type="button">＋</button>
          <button id="zoom-fit" type="button">全体</button>
          <label class="point-size-control">点の表示
            <select id="point-size-select" aria-label="点の表示サイズ">
              <option value="0.75">小</option>
              <option value="1.2" selected>標準</option>
              <option value="2">大</option>
            </select>
          </label>
        </div>
        <div id="text-selection-status" class="text-selection-status" role="status" aria-live="polite">
          V011：図面を拡大し、文字をタップすると内容とレイヤを表示します（選択のみ）。
        </div>
      </div>
      <canvas id="preview-canvas" class="preview" width="1200" height="760"></canvas>
      <div id="detail" class="detail"></div>
    </section>
  </main>
`;

const fileInput = document.querySelector<HTMLInputElement>("#file-input")!;
const dropzone = document.querySelector<HTMLDivElement>("#dropzone")!;
const statusLine = document.querySelector<HTMLDivElement>("#status-line")!;
const explodeToggle = document.querySelector<HTMLInputElement>("#explode-toggle")!;
const sampleButton = document.querySelector<HTMLButtonElement>("#sample-button")!;
const canvas = document.querySelector<HTMLCanvasElement>("#preview-canvas")!;
const coordinateSelect = document.querySelector<HTMLSelectElement>("#coordinate-select")!;
const downloadButton = document.querySelector<HTMLButtonElement>("#download-button")!;
const createButton = document.querySelector<HTMLButtonElement>("#create-button")!;
const downloadJwwButton = document.querySelector<HTMLButtonElement>("#download-jww-button")!;

const zoomLevel = document.querySelector<HTMLSpanElement>("#zoom-level")!;
function redrawZoom(): void {
  zoomLevel.textContent = Math.round(viewZoom * 100) + "%";
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
  viewZoom = Math.min(32, Math.max(0.5, viewZoom * factor));
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
    viewZoom=Math.min(32,Math.max(0.5,gesture.zoom*Math.hypot(b.x-a.x,b.y-a.y)/gesture.distance));
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
  if(shouldPick)selectTextAt(point);
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
document.querySelector<HTMLButtonElement>("#zoom-fit")!.addEventListener("click",()=>{
  resetZoom();redrawZoom();
});
// Display-only option: neither JWW bytes nor CAD coordinate attributes are modified.
document.querySelector<HTMLSelectElement>("#point-size-select")!.addEventListener("change", e => {
  pointDisplayRadius = Number((e.currentTarget as HTMLSelectElement).value);
  redrawZoom();
});

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
downloadButton.addEventListener("click", () => {
  if (!parsedState) return;
  const url = URL.createObjectURL(new Blob([parsedState.dxfText], { type: "application/dxf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = parsedState.fileName.replace(/\.[^.]*$/, "") + ".dxf";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

void ensureWasm().then(() => {
  statusLine.textContent = "待機中";
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
  resetZoom();
  const bytes = new Uint8Array(await file.arrayBuffer());
  currentInput = {
    name: file.name,
    size: file.size,
    bytes,
  };
  await parseBytes(currentInput);
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
  statusLine.textContent = "読込中";
  try {
    await ensureWasm();
    const started = performance.now();
    if (!detectFileFormat(input.bytes)) {
      throw new Error("JWW/JWC/JWSシグネチャを確認できません");
    }

    const cad = readCadDocument(input.bytes) as CadDocument;
    const dxf = readDxfDocument(input.bytes, explodeInserts, 32, jwcCoordinates) as DxfDocument;
    const dxfText = readDxfString(input.bytes, explodeInserts, 32, jwcCoordinates);

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
  } catch (error) {
    parsedState = null;
    statusLine.textContent = error instanceof Error ? error.message : String(error);
    render();
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
  downloadButton.disabled = !parsedState;
  downloadJwwButton.disabled = !parsedState?.generatedJww;
  coordinateSelect.disabled = parsedState?.cad.format !== "jwc";
  renderPreview(parsedState);
  renderDetail(parsedState);
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
  context.fillStyle = "#f7f8fb";
  context.fillRect(0, 0, rect.width, rect.height);

  if (!state) {
    meta.textContent = "No drawing";
    textHits = [];
    updateTextSelectionStatus();
    drawEmptyPreview(context, rect.width, rect.height);
    return;
  }

  meta.textContent = `${state.fileName} / ${state.cad.format === "jwc" ? (jwcCoordinates === "paper_millimeters" ? "紙上mm" : "実寸mm") : state.explodeInserts ? "exploded" : "inserted"}`;
  drawDxf(context, rect.width, rect.height, state.dxf);
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
): void {
  const isJwc = !!dxf.jwc_conversion_report;
  textHits = [];
  const hidden = new Set(isJwc ? dxf.layers.filter(layer => layer.frozen).map(layer => layer.name) : []);
  const widths = new Map<DxfEntity, number>();
  let textIndex = 0;
  for (const entity of dxf.entities) {
    if (entity.type === "TEXT" && isJwc) widths.set(entity, dxf.text_width_factors?.[textIndex++] ?? 1);
  }
  const visible = dxf.entities.filter(entity => !hidden.has(entity.layer));
  const bounds = dxfBounds(visible, context, widths);
  if (!bounds) {
    drawEmptyPreview(context, width, height);
    return;
  }

  const padding = 28;
  const modelWidth = Math.max(1, bounds.maxX - bounds.minX);
  const modelHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(
    (width - padding * 2) / modelWidth,
    (height - padding * 2) / modelHeight,
  );

  const offsetX = isJwc ? (width - modelWidth * scale) / 2 : padding;
  const offsetY = isJwc ? (height - modelHeight * scale) / 2 : padding;
  const toScreen = (x: number, y: number): [number, number] => [
    offsetX + (x - bounds.minX) * scale,
    height - offsetY - (y - bounds.minY) * scale,
  ];

  drawGrid(context, width, height);
  context.save();
  context.translate(width/2 + viewPanX, height/2 + viewPanY);
  context.scale(viewZoom, viewZoom);
  context.translate(-width/2, -height/2);
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const [index, entity] of visible.entries()) {
    context.strokeStyle = isJwc ? ({132: "#00a5a5", 18: "#260000", 92: "#00a500", 52: "#a5a500", 212: "#a500a5"} as Record<number, string>)[entity.color] ?? colorFor(entity.color) : colorFor(entity.color);
    context.fillStyle = context.strokeStyle;
    context.lineWidth = 1.2 / viewZoom;
    const dash = entity.line_type === "JWC_DASHED1" ? 1.25 : entity.line_type === "JWC_DASHED2" ? 2.5 : 0;
    context.setLineDash(dash ? [dash * scale, dash * scale] : []);
    drawEntity(context, entity, toScreen, scale, widths.get(entity));
    if (entity.type === "TEXT" && hasNumbers(entity, "x", "y") && entity.content) {
      const [baseX,baseY] = toScreen(entity.x,entity.y);
      const fontHeight = Math.max(0.1,(entity.height ?? 2.5)*scale);
      const widthFactor = textWidthFactorFor(entity,widths.get(entity));
      context.save();
      context.font = fontHeight + "px sans-serif";
      const measuredWidth = context.measureText(entity.content).width * widthFactor;
      context.restore();
      const centerX=width/2,centerY=height/2;
      textHits.push({
        index,content:entity.content,layer:entity.layer,
        x:centerX+viewPanX+(baseX-centerX)*viewZoom,
        y:centerY+viewPanY+(baseY-centerY)*viewZoom,
        width:Math.max(0.5,measuredWidth*viewZoom),
        height:Math.max(0.5,fontHeight*viewZoom),
        angle:-degToRad(entity.rotation ?? 0),
      });
    }
  }
  context.restore();
  drawSelectedTextHighlight(context);
  updateTextSelectionStatus();
}

function drawEntity(
  context: CanvasRenderingContext2D,
  entity: DxfEntity,
  toScreen: (x: number, y: number) => [number, number],
  scale: number,
  textWidthFactor?: number,
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
    context.arc(x, y, Math.max(0.8, entity.radius * scale), 0, Math.PI * 2);
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
    context.globalAlpha = 0.22;
    context.beginPath();
    context.moveTo(...p1);
    context.lineTo(...p2);
    context.lineTo(...p3);
    context.lineTo(...p4);
    context.closePath();
    context.fill();
    context.globalAlpha = 1;
    context.stroke();
    return;
  }

  if (entity.type === "POINT" && hasNumbers(entity, "x", "y")) {
    const [x, y] = toScreen(entity.x, entity.y);
    context.beginPath();
    // POINT glyphs are drawn under the canvas zoom transform.
    // Use zoom-aware inverse radius, allowing modest growth but capping
    // visual size so dimension markers do not obscure nearby annotations.
    const screenRadius = Math.min(3.2,
      Math.max(0.55, pointDisplayRadius * Math.sqrt(viewZoom)));
    context.arc(x, y, screenRadius / viewZoom, 0, Math.PI * 2);
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
    context.fillText(entity.content ?? "", 0, 0);
    context.restore();
    return;
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
    el.textContent="選択文字: 「"+selected.content+"」 / レイヤ: "+selected.layer+
      "（JWW→DXF表示上の文字。編集・保存は未実装）";
  } else {
    el.textContent=parsedState
      ? "V011：文字候補 "+textHits.length+"件。拡大して文字をタップしてください（選択のみ）。"
      : "V011：図面を開いて文字をタップしてください（選択のみ）。";
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
  redrawZoom();
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
