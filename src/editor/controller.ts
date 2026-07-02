// ---------- controller: the imperative bridge between the React shell and the core ----------
//
// IMPORTANT — module-evaluation ordering. This module is the FIRST to statically import the
// imperative core (model / render / interaction / dom / …). `dom.ts` resolves its element
// references at module-eval time (`export const svgP = byId("svgProfile")`), so the core must not
// be imported until the React shell has mounted the DOM. `EditorApp` therefore pulls THIS module
// in via a dynamic `import()` inside its mount effect — keep every static core import confined to
// this file. The React components import only *types* from the core (erased, eval-free).

import {
  clippedSection,
  DMAX,
  forwardLimit,
  L,
  NMAX,
  NMIN,
  prepare,
  removeSheerPoint,
  removeStationPoint,
  removeTrimPoint,
  removeWeightPoint,
  resetModel,
  waterlineStats,
  weightsAt,
  XFWD,
  type Model,
  type Section,
  type WeightCP,
} from "../core/model";
import { draw3d, View3DMode } from "../core/draw3d";
import { getDrag, setDrag, type Drag } from "../core/drag";
import { addTemplatePoint } from "../core/model";
import { buildJson, loadJsonText } from "../core/json";
import { getDesign, insertDesign, updateDesign } from "../core/supabase";
import { buildPreviewSvg } from "../core/preview";
import {
  invD,
  invN,
  invWY,
  invX,
  invY,
  invZp,
  LH,
  PH,
  WH,
  YMAX,
  YMIN,
  ZTRIMMIN,
} from "../core/view";
import { clamp } from "../core/math";
import { tplColor } from "../core/colors";
import {
  drawPlan,
  drawProfile,
  drawWeights,
  drawCutStation,
  drawStation,
} from "../core/draw2d";
import { ModelSelection, ModelSelectionTarget } from "../core/modelSelection";

import { cv3d, sideTabs, svgC, svgL, svgP, svgW, tplCards } from "./dom";
import { createEditorState, EditorState, Tool } from "./EditorState";

// The editor app's single model+view state. This module is the first (and only) place the editor's
// imperative core is statically imported (see the header note), so it owns the one State instance.
const state = createEditorState();

// the trim/view values React mirrors after a load or revert (the model is the source of truth)
export interface TrimSnapshot {
  waterline: number; // mm below the sheer origin
  rakeDeg: number; // deck rake in degrees (state stores radians)
  mode: View3DMode;
}
export interface BootResult extends TrimSnapshot {
  name: string; // the opened design's name, or "" for a fresh/Untitled hull
}
// the steady-state (non-transient) save indicator, mirrored into React by the dirty poll
export interface SaveView {
  buttonLabel: string; // "Save" | "Save As…"
  kind: "" | "dirty" | "saved";
  text: string;
}

// ---------- design identity (mirrors main.ts) ----------
let currentId: string | null = null; // the open design's row id (null = never saved)
let savedName: string | null = null; // the name stored for currentId; the React title is the working copy
let savedSnapshot = ""; // buildJson(state) as of the last successful save / load

const radToDeg = (r: number): number => (r * 180) / Math.PI;
const snapshot = (): TrimSnapshot => ({
  waterline: state.model.waterline,
  rakeDeg: radToDeg(state.model.deckRake),
  mode: state.draw3dParams.view3dMode,
});

function markSaved(): void {
  savedSnapshot = buildJson(state.model);
}

export function isDirty(): boolean {
  return buildJson(state.model) !== savedSnapshot;
}
// would saving create a new row? (the working title was changed away from the saved design's name)
export function isFork(name: string): boolean {
  return currentId != null && name.trim() !== "" && name.trim() !== savedName;
}
// anything unsaved: edited geometry, or a renamed existing design
export function isUnsaved(name: string): boolean {
  return isDirty() || isFork(name);
}
// the saved design's name (for restoring a blanked title — a name is required to save)
export function savedDesignName(): string | null {
  return savedName;
}

// the steady save indicator for the given working title (the dirty poll calls this each tick)
export function saveView(name: string): SaveView {
  const buttonLabel = isFork(name) ? "Save As…" : "Save";
  if (currentId == null) {
    const dirty = isDirty();
    return {
      buttonLabel,
      kind: dirty ? "dirty" : "",
      text: dirty ? "Unsaved" : "Not saved",
    };
  }
  if (isUnsaved(name))
    return { buttonLabel, kind: "dirty", text: "Unsaved changes" };
  return { buttonLabel, kind: "saved", text: "Saved" };
}

// ---------- trim / view edits (mutate the model, then redraw) ----------

// TODO here: add the appropriate params to the render functions. Does `render` needs to live in core? or just
// the more specific draw3d(), etc.?
export function setWaterline(mm: number): void {
  state.model.waterline = mm;
  render(state);
}

export function setDeckRake(deg: number): void {
  state.model.deckRake = (deg * Math.PI) / 180;
  render(state);
}

// ---------- View 3D helpers ----------

export function redraw3d(rebuild?: boolean): void {
  draw3d(cv3d, state.model, state.selection, state.draw3dParams, rebuild);
}

export function setView3dMode(mode: View3DMode): void {
  state.draw3dParams.view3dMode = mode;
  redraw3d(true); // rebuild for the new mode (mesh vs lines grid vs sheet)
}

// ---------- column fitting (lifted verbatim from main.ts) ----------
// The right column's width IS each panel's side: both the section editor and the cut station are
// squares that fill that width, stacked vertically. Pick a width that is a sensible fraction of the
// main area but never taller (as a square) than ~0.42 of its height, and never wider than MAX_SIDE.
const MIN_SIDE = 200,
  MAX_SIDE = 420,
  LEFT_GAP = 30; // the three 10px gaps between the four stacked items (3D, blend, plan, profile)

export function fitLayout(): void {
  const mainEl = document.querySelector(".main") as HTMLElement | null;
  const rightCol = document.querySelector(".rightcol") as HTMLElement | null;
  const leftCol = document.querySelector(".leftcol") as HTMLElement | null;
  if (!mainEl || !rightCol || !leftCol) return;
  const w = mainEl.clientWidth,
    h = mainEl.clientHeight;
  if (!w || !h) return;
  const side = Math.max(
    MIN_SIDE,
    Math.min(MAX_SIDE, Math.min(w * 0.34, h * 0.42)),
  );
  rightCol.style.width = `${side}px`;
  const stripAspect = (WH + LH + PH) / 1000;
  const leftMax = Math.max(360, (h - side - LEFT_GAP) / stripAspect);
  leftCol.style.maxWidth = `${leftMax}px`;
}

// resize: reflow the columns, then redraw the (cached-mesh) 3D canvas at its new size
export function handleResize(): void {
  fitLayout();
  redraw3d(false);
}

// ---------- boot: wire interaction, size the columns, load the URL design, first render ----------
export async function boot(): Promise<BootResult> {
  initInteraction(state);

  // the plan / profile / blend strips are sized to the isometric scale (see view.ts); set their
  // viewBox heights from the derived constants so the SVG aspect matches the to-scale drawing.
  svgL.setAttribute("viewBox", `0 0 1000 ${LH}`);
  svgP.setAttribute("viewBox", `0 0 1000 ${PH}`);
  svgW.setAttribute("viewBox", `0 0 1000 ${WH}`);
  fitLayout(); // size the columns before the first render so the 3D canvas picks up its real size

  // Build the default model first: it initializes state.sheer (null until now) and the template /
  // weight arrays that loadHull writes into. An opened design is then loaded over this baseline.
  resetModel(state.model);

  const id = new URLSearchParams(window.location.search).get("id");
  let name = "";
  if (id) {
    try {
      const opened = await getDesign(id);
      loadJsonText(state.model, opened.documentText);
      state.selection = null;
      currentId = id;
      savedName = opened.name;
      name = opened.name;
    } catch (e) {
      console.error("open design failed:", e);
      alert(
        "Couldn't open that design: " +
          (e instanceof Error ? e.message : String(e)),
      );
      resetModel(state.model); // discard any partial load; fall back to a clean default hull
      currentId = null;
      savedName = null;
    }
  } else {
    currentId = null;
    savedName = null;
  }

  // first render (mirrors main.ts redraw(): drop any stale selection, render, refresh the readouts)
  state.selection = null;
  render(state);
  refreshSelUI();
  markSaved();
  return { name, ...snapshot() };
}

// Revert: discard edits since the last save/open by reloading the saved snapshot. Returns the
// reverted trim/view values for React to mirror, or null if there was nothing to revert.
export function revert(): TrimSnapshot | null {
  if (!isDirty()) return null;
  if (!confirm("Discard changes since the last save?")) return null;
  loadJsonText(state.model, savedSnapshot);
  state.selection = null;
  render(state);
  refreshSelUI();
  return snapshot();
}

// The one save action: overwrite the open design, or — if the name was changed (fork) or it was
// never saved (create) — insert a new row and re-point the editor at it. Returns the final name
// (which may differ from the input when a create prompts for one), or null if the user cancelled.
// Throws on a backend failure so the caller can surface it.
export async function save(name: string): Promise<{ name: string } | null> {
  const create = currentId == null;
  const fork = isFork(name);
  let finalName = name.trim();
  if (create && !finalName) {
    finalName = prompt("Name this design:", "")?.trim() ?? "";
    if (!finalName) return null; // a name is required to create
  }
  if (!create && !fork) finalName = savedName!; // a plain overwrite keeps the existing name

  const json = buildJson(state.model);
  const preview = buildPreviewSvg(state.model); // a 3/4 wireframe stored with the design for the file view
  if (create || fork) {
    const newId = await insertDesign(finalName, json, preview);
    currentId = newId;
    history.replaceState(
      null,
      "",
      `editor.html?id=${encodeURIComponent(newId)}`,
    );
  } else {
    await updateDesign(currentId!, json, preview);
  }
  savedName = finalName;
  markSaved();
  return { name: finalName };
}

// ---------- drag-move handlers ----------
// Map a drag's new svg point (in a strip's inverse-view coordinates) to model space and mutate the selected
// control point. These read the editor's view transforms, so they live with the editor's pointer wiring
// rather than in the core.
function moveSheer(model: Model, d: Drag, vx: number, vy: number): void {
  const cp = model.sheer.cp[d.idx!],
    n = model.sheer.cp.length;
  // The first point is pinned at the transom (x = 0); every other point — including the LAST — is movable in
  // x, the last running forward to L + XFWD so the plan can be drawn over the bow overhang. y may go below the
  // centerline (down to YMIN) so the sheer plan can cross it to close a tumblehome bow.
  if (d.idx! > 0) {
    const hiX = d.idx! < n - 1 ? model.sheer.cp[d.idx! + 1].x - 80 : L + XFWD;
    const nx = clamp(invX(vx), model.sheer.cp[d.idx! - 1].x + 80, hiX);
    // resample the station's blend onto the current curve at its new x, so moving the plan handle along x
    // barely disturbs the blend (the point stays on the curve it helped define)
    if (nx !== cp.x) cp.w = weightsAt(model, nx);
    cp.x = nx;
  }
  cp.y = clamp(invY(vy), YMIN, YMAX);
}

function moveTrim(model: Model, d: Drag, vx: number, vy: number): void {
  const cp = model.sheer.trim[d.idx!],
    n = model.sheer.trim.length;
  // The first point is pinned at the transom (x = 0); every other point — including the LAST — is movable in
  // x. The last point may run forward to L + XFWD so the sheer trim can extend over the bow overhang.
  if (d.idx! > 0) {
    const hiX = d.idx! < n - 1 ? model.sheer.trim[d.idx! + 1].x - 80 : L + XFWD;
    cp.x = clamp(invX(vx), model.sheer.trim[d.idx! - 1].x + 80, hiX);
  }
  cp.z = clamp(invZp(vy), ZTRIMMIN, 0); // constrained at or below the flat deck (z ≤ 0)
}

function moveTransom(model: Model, d: Drag, vx: number, vy: number): void {
  const cp = model.sheer.transom[d.idx!];
  cp.x = clamp(invX(vx), 0, L * 0.45); // transom stays in the aft region
  cp.z = clamp(invZp(vy), ZTRIMMIN, 0);
}

// drag a station's blend in the weight strip: only the simplex split (the band boundary). x is shared with
// the plan curve and is edited there, so the blend strip has no x-handle.
function moveWeight(model: Model, d: Drag, vy: number): void {
  if (d.wpart !== "x")
    setWeightBoundary(model.sheer.cp[d.idx!], d.bnd!, clamp(invWY(vy), 0, 1));
}

// The weight CP carries a barycentric vector w ∈ Δ^{K−1}. We edit it through its cumulative boundaries
// C[m] = Σ_{j≤m} w[j] (a stacked-band view): dragging boundary b sets C[b], clamped to keep the order
// 0 ≤ C[0] ≤ … ≤ C[K−2] ≤ 1, then w is recovered as consecutive differences — always back in the simplex.
function setWeightBoundary(cp: WeightCP, b: number, val: number): void {
  const K = cp.w.length;
  if (K < 2) return;
  const C: number[] = [];
  let s = 0;
  for (let j = 0; j < K; j++) {
    s += cp.w[j];
    C.push(s);
  }
  const eps = 1e-3,
    lo = b > 0 ? C[b - 1] : 0,
    hi = b < K - 2 ? C[b + 1] : 1;
  C[b] = clamp(val, lo + eps, hi - eps);
  const w: number[] = [];
  let prev = 0;
  for (let j = 0; j < K - 1; j++) {
    w.push(Math.max(0, C[j] - prev));
    prev = C[j];
  }
  w.push(Math.max(0, 1 - prev));
  let t = 0;
  w.forEach((v) => (t += v));
  cp.w = t > 0 ? w.map((v) => v / t) : w.map(() => 1 / K);
}

// ---------- add stations / points ---------- (add* return the inserted index)
// Add a unified station at x: its plan y and its blend w are both read off the CURRENT curves there, so the
// insert changes neither curve — it just adds a handle. (yGiven is the dragged y when adding in the plan
// view; the blend strip passes the plan curve's own y so the station lands on the curve.)
function addStation(model: Model, x: number, yGiven: number): number {
  const cp = model.sheer.cp,
    n = cp.length;
  // may land anywhere forward of the transom, including the bow overhang to L + XFWD, and below the centerline
  x = clamp(x, cp[0].x + 80, L + XFWD);
  let k = cp.findIndex((p) => p.x > x);
  if (k < 0) k = n; // past every existing point → append at the bow end
  cp.splice(k, 0, { x, y: clamp(yGiven, YMIN, YMAX), w: weightsAt(model, x) });
  return k;
}

const addSheerPoint = (model: Model, x: number, y: number): number =>
  addStation(model, x, y);

function addTrimPoint(model: Model, x: number, z: number): number {
  const cp = model.sheer.trim,
    n = cp.length;
  // a new trim point may land anywhere forward of the transom, including the bow overhang up to L + XFWD
  x = clamp(x, cp[0].x + 80, L + XFWD);
  let k = cp.findIndex((p) => p.x > x);
  if (k < 0) k = n; // past every existing point → append at the bow end
  cp.splice(k, 0, { x, z: clamp(z, ZTRIMMIN, 0), k: 0 });
  return k;
}

// add a station from the blend strip: x as given, plan y read off the current plan curve so the station
// lands on it (stations are unified, so this adds the plan handle too).
const addWeightPoint = (model: Model, x: number): number =>
  addStation(model, x, model.sheer.yf(x));

// ---------- wire up the global / per-svg pointer listeners (called once at startup) ----------

export function initInteraction(state: EditorState): void {
  const params = state.draw3dParams;
  const model = state.model;
  const toolbar = document.getElementById("toolbar")!;
  toolbar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".tool");
    if (b) setTool(b.dataset.tool as typeof state.tool);
  });

  const cv3d = document.getElementById("cv3d") as HTMLCanvasElement;
  cv3d.addEventListener("pointerdown", (e) => {
    setDrag({
      kind: "rot",
      px0: e.clientX,
      py0: e.clientY,
      yaw0: params.rot.yaw,
      pitch0: params.rot.pitch,
    });
    e.preventDefault();
  });
  // scroll-wheel zoom (smooth, multiplicative); the lines overlay is pointer-events:none so this still fires
  cv3d.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      params.zoom = clamp(params.zoom * Math.exp(-e.deltaY * 0.0015), 0.3, 8);
      redraw3d(false); // zoom only redraws GL (mesh is cached)
    },
    { passive: false },
  );

  window.addEventListener("pointermove", (e) => {
    const drag = getDrag();
    if (!drag) return;
    if (drag.kind === "rot") {
      params.rot.yaw = drag.yaw0! + (e.clientX - drag.px0!) * 0.008;
      params.rot.pitch = clamp(
        drag.pitch0! + (e.clientY - drag.py0!) * 0.008,
        -1.45,
        1.45,
      );
      redraw3d(false); // rotation only redraws GL (mesh is cached)
      return;
    }
    const [vx, vy] = getVB(drag, e);
    if (drag.kind === "slider") {
      // the cut scrubs along x — horizontal in all three strips (plan, profile, blend)
      model.x0 = clamp(invX(vx), 0, L);
    } else if (drag.kind === "sheer") moveSheer(model, drag, vx, vy);
    else if (drag.kind === "trim") moveTrim(model, drag, vx, vy);
    else if (drag.kind === "transom") moveTransom(model, drag, vx, vy);
    else if (drag.kind === "weight") moveWeight(model, drag, vy);
    else if (drag.kind === "stn") {
      const arr = model.templates[drag.ti!],
        i = drag.idx!,
        cp = arr[i];
      cp.n = clamp(invN(vx), NMIN, NMAX); // negative = outboard of the sheer (tumblehome)
      const lo = arr[i - 1].d,
        hi = i < arr.length - 1 ? arr[i + 1].d : DMAX; // keep d descending so the section never curls up
      cp.d = clamp(invD(vy), lo, hi);
    }
    render(state);
  });
  window.addEventListener("pointerup", () => {
    setDrag(null); // selection persists after a drag, so the point stays highlighted and editable
  });

  // delete the selected point with Delete/Backspace (unless typing in the knuckle slider)
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (state.selection) {
      e.preventDefault();
      deleteSelected();
    }
  });
  document
    .getElementById("selDelete")!
    .addEventListener("click", deleteSelected);
  document
    .getElementById("selKnuckle")!
    .addEventListener("input", (e) =>
      setSelectedKnuckle(parseFloat((e.target as HTMLInputElement).value)),
    );
  document
    .getElementById("keelRange")!
    .addEventListener("input", (e) =>
      setActiveKeel(parseFloat((e.target as HTMLInputElement).value)),
    );

  // editor backgrounds: in "add" mode click empty space to add a point there (then back to select, with
  // the new point selected); in "select" mode an empty click clears the selection.
  const onBg = (
    svg: SVGSVGElement,
    add: (vx: number, vy: number) => { tgt: ModelSelectionTarget; idx: number },
  ): void => {
    svg.addEventListener("pointerdown", (e) => {
      if (state.tool === "add") {
        const [vx, vy] = vbCoords(svg, e),
          { tgt, idx } = add(vx, vy);
        setTool("select");
        select(tgt, idx); // select() re-renders with the new point highlighted
      } else {
        clearSelection();
      }
    });
  };
  onBg(svgL, (vx, vy) => ({
    tgt: "plan",
    idx: addSheerPoint(model, invX(vx), invY(vy)),
  }));
  onBg(svgP, (vx, vy) => ({
    tgt: "trim",
    idx: addTrimPoint(model, invX(vx), invZp(vy)),
  }));
  // the weight editor (persistent element): add a blend control point at the clicked x
  svgW.addEventListener("pointerdown", (e) => {
    if (state.tool === "add") {
      const [vx] = vbCoords(svgW, e),
        idx = addWeightPoint(model, invX(vx));
      setTool("select");
      select("weight", idx);
    } else {
      clearSelection();
    }
  });

  refreshSelUI();
  refreshKeelUI();
}

// ---------- add / remove whole templates ----------
// a new template starts as a copy of the last and enters every weight CP at zero weight, so the hull is
// unchanged on add; raise its weight in the blend editor to bring it into the mix.

export function addTemplate(model: Model): void {
  if (model.templates.length >= 7) return; // palette / UI cap
  const last = model.templates[model.templates.length - 1];
  model.templates.push(last.map((p) => ({ n: p.n, d: p.d, k: p.k })));
  model.keelK.push(model.keelK[model.keelK.length - 1] ?? 0); // copy the last template's keel knuckle
  model.sheer.cp.forEach((cp) => cp.w.push(0));
  state.selection = null;
  refreshSelUI();
  render(state);
}
export function removeTemplate(model: Model, ti: number): void {
  if (model.templates.length <= 1) return;
  model.templates.splice(ti, 1);
  model.keelK.splice(ti, 1);
  model.sheer.cp.forEach((cp) => {
    cp.w.splice(ti, 1);
    let s = 0;
    cp.w.forEach((v) => (s += v));
    cp.w = s > 0 ? cp.w.map((v) => v / s) : cp.w.map(() => 1 / cp.w.length);
  });
  state.selection = null;
  refreshSelUI();
  render(state);
} // background pointerdown on a (dynamic) template editor: add a point in "add" mode, else clear selection

export function templateBgDown(
  ti: number,
  svg: SVGSVGElement,
  e: PointerEvent,
): void {
  if (state.tool === "add") {
    const [vx, vy] = vbCoords(svg, e),
      idx = addTemplatePoint(state.model, ti, invN(vx), invD(vy));
    setTool("select");
    select("template", idx, ti);
  } else {
    clearSelection();
  }
}

const onSelect = (selection: ModelSelection): void => {
  if (selection) {
    select(selection.tgt, selection.idx, selection.ti);
  }
};

// Re-renders all 2D and 3D views whenever the model or selection changes.
export function render({ model, selection, draw3dParams }: EditorState): void {
  prepare(model);
  // Sample to the hull's true forward closure (forwardLimit), not the LOA: a tumblehome bow closes past x=L,
  // and a fine bow closes before it. Cosine spacing clusters stations toward the transom and the stem, where
  // the keel and waterlines sweep up fastest, so the bow is resolved instead of spanned by a couple of points.
  const NSEC = 80,
    xFwd = forwardLimit(model),
    sections: Section[] = [];
  for (let i = 0; i <= NSEC; i++) {
    const x = (xFwd * (1 - Math.cos((Math.PI * i) / NSEC))) / 2;
    sections.push(clippedSection(model, x, 18));
  }
  let zmin = 0;
  for (const s of sections) {
    if (s.aft) continue;
    for (const p of s.pts) zmin = Math.min(zmin, p[2]);
  }
  drawPlan(svgL, model, selection, sections, zmin, onSelect);
  drawProfile(svgP, model, selection, sections, zmin, onSelect);
  drawWeights(svgW, model, selection, onSelect);
  drawCutStation(svgC, model, selection); // the cut station lives in its own (always-visible) panel in the lower right column
  drawSidePanels(model, selection); // template editors share one tab strip; show the active one
  draw3d(cv3d, model, selection, draw3dParams, true);
  const profVal = document.getElementById("profVal") as HTMLElement;
  const h = clippedSection(model, model.x0, 18);
  // (label uses the live cut) — draft + breadth are measured against the design waterline
  const wl = waterlineStats(model, h),
    open = h.open ? " · open" : "";
  profVal.textContent = wl.wet
    ? `x=${Math.round(model.x0)}${open} · draft ${Math.round(wl.draft)} · WL beam ${Math.round(wl.beam)}`
    : `x=${Math.round(model.x0)}${open} · above WL`;
}

// ---------- the side panel: one tab strip over the per-template editors plus the Cut and Body views ----------
// The per-template editor <svg>s are persistent — rebuilt only when the template COUNT changes, never on a
// plain redraw — so a drag started on one stays bound to a live, measurable element (a recreated svg reports
// a zero-size getBoundingClientRect and breaks the pointer-to-model mapping). Cut and Body are the fixed page
// svgs. The tab strip shows exactly one panel at a time.
let tplEls: SVGSVGElement[] = [];
let sideTab = 0; // active tab: a template index (the Cut view is now its own panel, not a tab)
let prevTplCount = 0;

function buildTemplateSvgs(model: Model): void {
  tplCards.replaceChildren();
  tplEls = [];
  model.templates.forEach((_, j) => {
    const svg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    ) as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 360 360");
    svg.addEventListener("pointerdown", (e) =>
      templateBgDown(j, svg, e as PointerEvent),
    );
    tplCards.append(svg);
    tplEls.push(svg);
  });
}

// show only the active template panel; the others stay drawn but hidden, so switching tabs is instant
function applySideTab(): void {
  tplEls.forEach((svg, j) => (svg.style.display = sideTab === j ? "" : "none"));
}
function setSideTab(model: Model, t: number): void {
  sideTab = t;
  applySideTab();
  buildSideTabs(model);
  refreshKeelUI(); // the keel slider targets the active template tab
}

// the active template tab as a template index (always a template now that Cut is its own panel)
export function activeTemplateIndex(): number | null {
  return sideTab;
}

// the tab strip: one tab per template (its accent color; the active one carries a ✕ to remove it), then a
// "+" to add a template.
function buildSideTabs(model: Model): void {
  sideTabs.replaceChildren();
  const K = model.templates.length;
  model.templates.forEach((_, j) => {
    const active = sideTab === j,
      tab = document.createElement("button");
    tab.className = "tab tpltab" + (active ? " active" : "");
    tab.style.setProperty("--tab", tplColor(j));
    const lbl = document.createElement("span");
    lbl.textContent = `T${j + 1}`;
    tab.append(lbl);
    if (active && K > 1) {
      const x = document.createElement("span");
      x.className = "tabx";
      x.textContent = "✕";
      x.title = "Remove this template";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        removeTemplate(model, j);
      });
      tab.append(x);
    }
    tab.addEventListener("click", () => setSideTab(model, j));
    sideTabs.append(tab);
  });
  const add = document.createElement("button");
  add.className = "tab tabadd";
  add.textContent = "+";
  add.title =
    "Add a section template (enters the blend at zero weight; raise it in the blend editor)";
  add.disabled = K >= 7;
  add.addEventListener("click", () => addTemplate(model));
  sideTabs.append(add);
}

// redraw the side panel: (re)build the template svgs when the count changes, draw each, refresh the tabs
export function drawSidePanels(model: Model, selection: ModelSelection): void {
  const K = model.templates.length;
  if (tplEls.length !== K) {
    const grew = K > prevTplCount && prevTplCount > 0; // a freshly added template becomes active
    buildTemplateSvgs(model);
    if (grew) sideTab = K - 1;
    prevTplCount = K;
  }
  if (sideTab >= K) sideTab = K - 1; // a removed template → clamp
  tplEls.forEach((svg, j) => drawStation(model, selection, svg, j, onSelect));
  buildSideTabs(model);
  applySideTab();
  refreshKeelUI(); // keep the keel slider in sync after add/remove/clamp of the active tab
} // ---------- tools (select / add) + the selected-point actions ----------

export function vbCoords(
  svg: SVGSVGElement,
  e: PointerEvent,
): [number, number] {
  return svgPoint(svg, e.clientX, e.clientY);
}
function setToolCursor(): void {
  const cur = state.tool === "add" ? "crosshair" : "default";
  // resolve the strip svgs and the template-card container by id (they live in the editor DOM) rather than
  // importing the editor's element references, so the core stays free of an editor dependency
  ["svgPlan", "svgProfile", "svgWeights", "templateCards"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.cursor = cur; // dynamic per-template svgs inherit the container cursor
  });
}

export function setTool(name: Tool): void {
  state.tool = name;
  const toolbar = document.getElementById("toolbar")!;
  toolbar
    .querySelectorAll<HTMLElement>(".tool")
    .forEach((t) => t.classList.toggle("active", t.dataset.tool === name));
  setToolCursor();
}

// ---------- selection ----------
// the knuckle-carrying point array for the current selection (a template, or the sheer trim), or null.
// Both StationCP and TrimCP carry `.k`, so the knuckle slider drives either.
function selArr(): { k: number }[] | null {
  const model = state.model;
  const s = state.selection;
  if (!s) return null;
  if (s.tgt === "template" && s.ti !== undefined) return model.templates[s.ti];
  if (s.tgt === "trim") return model.sheer.trim;
  return null;
}

export function select(
  tgt: ModelSelectionTarget,
  idx: number,
  ti?: number,
): void {
  state.selection = { tgt, idx, ti };
  refreshSelUI();
  render(state); // draw the highlight immediately (selecting need not involve a drag)
}

export function clearSelection(): void {
  if (!state.selection) return;
  state.selection = null;
  refreshSelUI();
  render(state);
}
// can the selected point be deleted? ends are pinned; the sheer/trim/template keep a minimum of 3; the
// weight curve keeps its two ends; the transom is a fixed pair of points.
function canDelete(
  model: Model,
  s: { tgt: ModelSelectionTarget; idx: number },
): boolean {
  if (s.tgt === "transom") return false;
  if (s.tgt === "plan")
    return (
      model.sheer.cp.length > 3 &&
      s.idx > 0 &&
      s.idx < model.sheer.cp.length - 1
    );
  if (s.tgt === "trim")
    return (
      model.sheer.trim.length > 3 &&
      s.idx > 0 &&
      s.idx < model.sheer.trim.length - 1
    );
  if (s.tgt === "weight")
    return (
      model.sheer.cp.length > 3 &&
      s.idx > 0 &&
      s.idx < model.sheer.cp.length - 1
    );
  const len = model.templates[0].length; // template
  return len > 3 && s.idx > 0 && s.idx < len - 1;
}

// points that carry a knuckle (k): every sheer-trim point, and every template point but the pinned sheer
// point (idx 0). The plan/transom/weight points do not.
function hasKnuckle(s: { tgt: ModelSelectionTarget; idx: number }): boolean {
  return s.tgt === "trim" || (s.tgt === "template" && s.idx > 0);
}

function labelFor(s: {
  tgt: ModelSelectionTarget;
  idx: number;
  ti?: number;
}): string {
  if (s.tgt === "template")
    return `Template ${(s.ti ?? 0) + 1} · point ${s.idx + 1}`;
  if (s.tgt === "weight") return `Blend point ${s.idx + 1}`;
  const name = { plan: "Sheer (plan)", trim: "Sheer trim", transom: "Transom" }[
    s.tgt as "plan" | "trim" | "transom"
  ];
  return `${name} · point ${s.idx + 1}`;
}

export function deleteSelected(): void {
  const model = state.model;
  const s = state.selection;
  if (!s || !canDelete(model, s)) return;
  if (s.tgt === "plan") removeSheerPoint(model, s.idx);
  else if (s.tgt === "trim") removeTrimPoint(model, s.idx);
  else if (s.tgt === "weight") removeWeightPoint(model, s.idx);
  else removeStationPoint(model, s.idx); // template (removes the matching index from every template)
  state.selection = null;
  refreshSelUI();
  render(state);
}

export function setSelectedKnuckle(k: number): void {
  const s = state.selection,
    arr = selArr();
  if (!s || !arr || !hasKnuckle(s)) return;
  arr[s.idx].k = clamp(k, 0, 1);
  render(state);
}

// reflect the current selection in the (always-visible) selection panel: label, delete, knuckle slider.
// The panel keeps constant height — the knuckle slider and delete are present but disabled when they don't
// apply — so selecting a point never reflows the side column.

export function refreshSelUI(): void {
  const label = document.getElementById("selLabel")!,
    del = document.getElementById("selDelete") as HTMLButtonElement,
    krange = document.getElementById("selKnuckle") as HTMLInputElement;
  const s = state.selection;
  label.textContent = s ? labelFor(s) : "No point selected";
  label.classList.toggle("muted", !s);
  del.disabled = !s || !canDelete(state.model, s);
  const arr = selArr(),
    knuckle = !!(s && arr && hasKnuckle(s));
  krange.disabled = !knuckle;
  krange.value = knuckle ? String(arr![s!.idx].k) : "0";
}
// the keel-knuckle slider edits the active template tab's keel (centerline) knuckle; it is disabled on the
// Cut / Body views (which are not a single template). Kept in sync by the side-panel render + tab switches.

export function setActiveKeel(k: number): void {
  const model = state.model;
  const ti = activeTemplateIndex();
  if (ti === null || ti >= model.keelK.length) return;
  model.keelK[ti] = clamp(k, 0, 1);
  refreshKeelUI();
  render(state);
}

export function refreshKeelUI(): void {
  const r = document.getElementById("keelRange") as HTMLInputElement,
    v = document.getElementById("keelVal") as HTMLElement,
    ctl = document.getElementById("keelCtl") as HTMLElement;
  const ti = activeTemplateIndex(),
    on = ti !== null && ti < state.model.keelK.length;
  r.disabled = !on;
  ctl.classList.toggle("disabled", !on);
  const k = on ? state.model.keelK[ti!] : 0;
  r.value = String(k);
  v.textContent = on ? k.toFixed(2) : "—";
} // map a client (screen) point to the svg's viewBox coordinates via its CTM — handles any CSS scaling and
// preserveAspectRatio letterboxing (the editor svgs are fit-to-box, so their box ≠ their viewBox aspect)

export function svgPoint(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): [number, number] {
  const m = svg.getScreenCTM();
  if (!m) return [0, 0];
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const p = pt.matrixTransform(m.inverse());
  return [p.x, p.y];
}
export function getVB(d: Drag, e: PointerEvent): [number, number] {
  return svgPoint(d.svg!, e.clientX, e.clientY);
}
