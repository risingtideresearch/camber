// ---------- entry point for the interpolation viewer: load 2–5 hull JSONs, blend by weight, show 3D ----------
//
// A separate, read-only app. It imports the same model + renderer as the editor, but never authors
// geometry: it loads several exported hulls (`camber-hull` JSON), forms a convex blend of them per the
// data model's interpolation rule, writes that blend into the shared `state`, and draws the shaded 3D
// hull. The blended hull can be exported as STEP or JSON, just like in the editor.
//
// Per the spec, a blend of variants V₁…Vₙ with weights wᵢ ≥ 0, Σwᵢ = 1 is `Σ wᵢ·Vᵢ`, taken componentwise
// over the shared topology. The exported JSON stores absolute coordinates rather than the spec's cumulative
// increments, but a convex combination of strictly-ordered absolute sequences is itself strictly ordered,
// so blending absolutes is valid and gives the same hull. Blending is defined only within one topology, so
// all loaded hulls must agree on point counts and length.

import { clamp } from "./math.js";
import { state, L, prepare, type Sheer, type StationCP, type WeightCP } from "./model.js";
import { draw3d } from "./render.js";
import { buildJson, parseDocument, type HullData, type ParsedDoc } from "./json.js";
import { getDesign, insertDesign, updateDesign } from "./supabase.js";
import { buildPreviewSvg } from "./preview.js";

interface Hull {
  name: string;
  data: HullData; // absolute model coords, decoded from the HullDocument
  weight: number;
}

// the loaded family (2–5 hulls) and the topology the first one fixes
const hulls: Hull[] = [];
let topo: {
  plan: number;
  trim: number;
  section: number;
  templates: number;
  weights: number;
  length: number;
} | null = null;
const palette: string[] = ["#2b6cb0", "#dd6b20", "#0f766e", "#7c3aed", "#b45309"];

// check a freshly parsed hull against the family's topology (the first hull fixes it). Throws on
// mismatch — only hulls of one topology (and length) can blend.
function checkTopology(data: HullData, length: number): void {
  const t = {
    plan: data.cp.length,
    trim: data.trim.length,
    section: data.templates[0].length,
    templates: data.templates.length,
    weights: data.weights.length,
    length,
  };
  if (!topo) {
    topo = t;
    return;
  }
  if (
    t.plan !== topo.plan ||
    t.trim !== topo.trim ||
    t.section !== topo.section ||
    t.templates !== topo.templates ||
    t.weights !== topo.weights
  )
    throw new Error(
      `topology mismatch — plan/trim/section/templates/weights counts ` +
        `${t.plan}/${t.trim}/${t.section}/${t.templates}/${t.weights}, the family has ` +
        `${topo.plan}/${topo.trim}/${topo.section}/${topo.templates}/${topo.weights}. ` +
        `Only one topology can blend.`,
    );
  if (Math.abs(t.length - topo.length) > 1e-6)
    throw new Error(`length mismatch — ${t.length} vs the family's ${topo.length}. Lengths must match.`);
}

// ---------- the blend: Σ wᵢ·Vᵢ componentwise over the shared topology → the shared model state ----------
function blend(): void {
  const total = hulls.reduce((a, h) => a + h.weight, 0) || 1;
  const w = hulls.map((h) => h.weight / total); // normalize to Σ = 1 (barycentric)

  const plan = hulls[0].data.cp.map((_, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.cp[i].x, 0),
    y: hulls.reduce((a, h, k) => a + w[k] * h.data.cp[i].y, 0),
  }));
  const trim = hulls[0].data.trim.map((_, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.trim[i].x, 0),
    z: hulls.reduce((a, h, k) => a + w[k] * h.data.trim[i].z, 0),
    k: hulls.reduce((a, h, kk) => a + w[kk] * h.data.trim[i].k, 0),
  }));
  const transom = hulls[0].data.transom.map((_, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.transom[i].x, 0),
    z: hulls.reduce((a, h, k) => a + w[k] * h.data.transom[i].z, 0),
  }));
  // each template j, blended point-for-point across the family (templates are index-aligned)
  const templates: StationCP[][] = hulls[0].data.templates.map((tpl, j) =>
    tpl.map((_, i) => ({
      n: hulls.reduce((a, h, k) => a + w[k] * h.data.templates[j][i].n, 0),
      d: hulls.reduce((a, h, k) => a + w[k] * h.data.templates[j][i].d, 0),
      k: hulls.reduce((a, h, kk) => a + w[kk] * h.data.templates[j][i].k, 0),
    })),
  );
  // the weight curve, blended control point by control point (a convex blend of simplex points → simplex)
  const weights: WeightCP[] = hulls[0].data.weights.map((wp, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.weights[i].x, 0),
    w: wp.w.map((_, j) => hulls.reduce((a, h, k) => a + w[k] * h.data.weights[i].w[j], 0)),
  }));

  state.sheer = { cp: plan, trim, transom, yf: () => 0, zf: () => 0 } as Sheer;
  state.templates = templates;
  state.weights = weights;
}

// ---------- redraw: blend (if any hulls) then draw the 3D hull ----------
function refresh(): void {
  if (hulls.length === 0) return;
  blend();
  prepare(); // rebuild the sheer samplers for the blended generators
  draw3d(true); // rebuild + draw the mesh
}

// The very first draw (right after an async load) can run before the canvas has its laid-out size, leaving a
// blank 3D view until something redraws. Draw once more next frame, when layout has settled.
function drawAfterLayout(): void {
  requestAnimationFrame(() => {
    if (hulls.length) draw3d(false);
  });
}

// update just the normalized % labels in place — called on every slider input so dragging a slider doesn't
// rebuild (and destroy) the slider element mid-drag, which would abort the drag after the first input event.
function updatePercents(): void {
  const total = hulls.reduce((a, x) => a + x.weight, 0) || 1;
  const pcts = document.querySelectorAll<HTMLElement>("#hullList .pct");
  hulls.forEach((h, i) => {
    if (pcts[i]) pcts[i].textContent = `${((h.weight / total) * 100).toFixed(0)}%`;
  });
}

// ---------- the weights panel (one slider per loaded hull) ----------
function renderPanel(): void {
  const list = document.getElementById("hullList")!;
  list.replaceChildren();
  hulls.forEach((h, i) => {
    const row = document.createElement("div");
    row.className = "hullrow";
    const total = hulls.reduce((a, x) => a + x.weight, 0) || 1;
    const pct = ((h.weight / total) * 100).toFixed(0);
    row.innerHTML =
      `<div class="hullhead">` +
      `<span class="dot" style="background:${palette[i % palette.length]}"></span>` +
      `<span class="hullname" title="${h.name}">${h.name}</span>` +
      `<span class="pct">${pct}%</span>` +
      `</div>` +
      `<input type="range" class="wslider" min="0" max="100" step="1" value="${Math.round(h.weight * 100)}" data-i="${i}">`;
    list.append(row);
  });
  list.querySelectorAll<HTMLInputElement>(".wslider").forEach((sl) => {
    sl.addEventListener("input", () => {
      hulls[+sl.dataset.i!].weight = +sl.value / 100;
      updatePercents(); // in-place; do NOT rebuild the panel while a slider is being dragged
      refresh();
    });
  });
}

function updateStatus(): void {
  const status = document.getElementById("status")!;
  if (hulls.length === 0) {
    status.textContent = "Open a blend from the design library to begin.";
  } else if (hulls.length === 1) {
    status.textContent = "1 hull loaded — needs at least one more to interpolate.";
  } else {
    status.textContent = `${hulls.length} hulls · blending`;
  }
  refreshSaveUI();
}

// ---------- saving the blend to the library ----------
// First save creates a new design (button reads "Save As…"). After that the button reads "Save" and
// overwrites that design, flipping back to "Save As…" only when the name is changed (which forks a new one) —
// exactly like the hull editor.
let currentId: string | null = null; // the saved design's row id (null until first save)
let savedName: string | null = null; // the name stored for currentId
let savedSnapshot = ""; // buildJson() of the last save
let savingNow = false;
let flashUntil = 0;

const nameInput = () => document.getElementById("blendName") as HTMLInputElement;
const saveBtnEl = () => document.getElementById("saveAs") as HTMLButtonElement;
const saveStateEl = () => document.getElementById("saveState")!;

function defaultBlendName(): string {
  return hulls.length ? `Blend of ${hulls.map((h) => h.name).join(" + ")}`.slice(0, 120) : "Untitled blend";
}
// would saving create a new row? (never saved, or the name was changed away from the saved design)
function willFork(): boolean {
  const name = nameInput().value.trim();
  return currentId == null || (name !== "" && name !== savedName);
}
function isDirty(): boolean {
  if (hulls.length === 0) return false;
  if (currentId == null) return true; // never saved → always unsaved work
  return buildJson() !== savedSnapshot || nameInput().value.trim() !== savedName;
}
function refreshSaveUI(): void {
  saveBtnEl().textContent = willFork() ? "Save As…" : "Save";
  saveBtnEl().disabled = hulls.length < 1 || savingNow;
  if (savingNow || Date.now() < flashUntil) return;
  const st = saveStateEl();
  if (hulls.length < 1) {
    st.className = "savestate";
    st.textContent = "";
  } else if (isDirty()) {
    st.className = "savestate dirty";
    st.textContent = "Unsaved";
  } else {
    st.className = "savestate saved";
    st.textContent = "Saved";
  }
}

async function doSave(): Promise<void> {
  if (savingNow || hulls.length < 1) return;
  const fork = willFork();
  let name = nameInput().value.trim();
  if (fork) {
    if (!name) {
      name = prompt("Name this blend:", defaultBlendName())?.trim() ?? "";
      if (!name) return;
      nameInput().value = name;
    }
  } else {
    name = savedName!; // plain overwrite keeps the existing name
  }
  savingNow = true;
  flashUntil = 0;
  saveBtnEl().disabled = true;
  saveStateEl().className = "savestate";
  saveStateEl().textContent = "Saving…";
  try {
    const json = buildJson(); // the blended hull is already in `state`
    const preview = buildPreviewSvg();
    if (fork) currentId = await insertDesign(name, json, preview);
    else await updateDesign(currentId!, json, preview);
    savedName = name;
    savedSnapshot = json;
    nameInput().value = name;
    flashUntil = Date.now() + 1400;
    saveStateEl().className = "savestate saved";
    saveStateEl().textContent = "Saved ✓";
  } catch (e) {
    saveStateEl().className = "savestate dirty";
    saveStateEl().textContent = "Save failed";
    alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
  } finally {
    savingNow = false;
    refreshSaveUI();
  }
}

function closeToLibrary(): void {
  if (isDirty() && !confirm("Discard the unsaved blend and return to the library?")) return;
  window.location.href = "index.html";
}

// add every variant of a parsed document to the family (a HullDocument can carry several), checking each
// against the shared topology. Collects any per-variant problems into `errs`.
function addParsedDoc(parsed: ParsedDoc, base: string, errs: string[]): void {
  let vi = 0;
  for (const data of parsed.variants) {
    if (hulls.length >= 5) {
      errs.push(`${base}: family is full (max 5 hulls) — some variants skipped`);
      break;
    }
    try {
      checkTopology(data, parsed.length);
    } catch (e) {
      errs.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
      vi++;
      continue;
    }
    const name = data.name ?? (parsed.variants.length > 1 ? `${base} #${vi + 1}` : base);
    hulls.push({ name, data, weight: 1 });
    vi++;
  }
}

// ---------- file loading ----------
async function loadFiles(files: FileList | File[]): Promise<void> {
  const errs: string[] = [];
  for (const f of Array.from(files)) {
    try {
      addParsedDoc(parseDocument(await f.text()), f.name.replace(/\.json$/i, "") || "hull", errs);
    } catch (e) {
      errs.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  renderPanel();
  updateStatus();
  refresh();
  drawAfterLayout();
  if (errs.length) alert("Some files could not be loaded:\n\n" + errs.join("\n"));
}

// ---------- library loading (opened from the design library with ?ids=a,b,c) ----------
async function loadByIds(ids: string[]): Promise<void> {
  const errs: string[] = [];
  for (const id of ids) {
    try {
      const { name, documentText } = await getDesign(id);
      addParsedDoc(parseDocument(documentText), name, errs);
    } catch (e) {
      errs.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  renderPanel();
  updateStatus();
  refresh();
  drawAfterLayout();
  if (errs.length) alert("Some designs could not be loaded:\n\n" + errs.join("\n"));
}

// ---------- wire up ----------
function init(): void {
  state.x0 = L / 2;

  // drag-and-drop onto the whole page (still works for loading JSON files, though there's no Load button)
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ["dragenter", "dragover", "dragleave", "drop"].forEach((ev) =>
    document.addEventListener(ev, stop, false),
  );
  document.addEventListener("drop", (e: DragEvent) => {
    if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files);
  });

  // equal-weights reset
  document.getElementById("equalBtn")!.addEventListener("click", () => {
    hulls.forEach((h) => (h.weight = 1));
    renderPanel();
    refresh();
  });

  // save the current blend to the library / close back to it
  document.getElementById("blendName")!.addEventListener("input", refreshSaveUI);
  document.getElementById("saveAs")!.addEventListener("click", doSave);
  document.getElementById("closeBtn")!.addEventListener("click", closeToLibrary);
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  setInterval(refreshSaveUI, 300);

  // the 3D canvas fills a CSS box; redraw it when the box resizes (mesh is cached)
  window.addEventListener("resize", () => {
    if (hulls.length) draw3d(false);
  });

  // 3D display mode — a single mutually-exclusive choice (render / lines / zebra / sheet), like the editor
  const view3dModes = document.getElementById("view3dModes")!;
  view3dModes.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.vmode");
    if (!b) return;
    state.view3dMode = b.dataset.mode as typeof state.view3dMode;
    view3dModes.querySelectorAll(".vmode").forEach((x) => x.classList.toggle("on", x === b));
    if (hulls.length) draw3d(true);
  });

  // 3D rotation (view-only; no model is touched)
  const cv = document.getElementById("cv3d") as HTMLCanvasElement;
  let rot: { px: number; py: number; yaw: number; pitch: number } | null = null;
  cv.addEventListener("pointerdown", (e) => {
    rot = { px: e.clientX, py: e.clientY, yaw: state.rot.yaw, pitch: state.rot.pitch };
    e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => {
    if (!rot || !hulls.length) return;
    state.rot.yaw = rot.yaw + (e.clientX - rot.px) * 0.008;
    state.rot.pitch = clamp(rot.pitch + (e.clientY - rot.py) * 0.008, -1.45, 1.45);
    draw3d(false);
  });
  window.addEventListener("pointerup", () => (rot = null));
  // scroll-wheel zoom (the lines overlay is pointer-events:none so this still reaches the canvas)
  cv.addEventListener(
    "wheel",
    (e) => {
      if (!hulls.length) return;
      e.preventDefault();
      state.zoom = clamp(state.zoom * Math.exp(-e.deltaY * 0.0015), 0.3, 8);
      draw3d(false);
    },
    { passive: false },
  );

  // opened from the design library? load that selection straight from Supabase.
  const ids = new URLSearchParams(window.location.search).get("ids");
  if (ids) loadByIds(ids.split(",").filter(Boolean));

  updateStatus();
}

init();
