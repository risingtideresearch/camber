// ---------- pointer interaction: dragging points, the cut slider, 3D rotation, and the edit tools ----------

import { clamp, lerp } from "./math";
import {
  state,
  L,
  XFWD,
  NMIN,
  NMAX,
  weightsAt,
  type ActiveTarget,
  type WeightCP,
} from "./model";
import {
  invX,
  invY,
  invZp,
  invN,
  invD,
  invWY,
  YMAX,
  YMIN,
  ZTRIMMIN,
} from "./view";
import { svgL, svgP, svgW, tplCards } from "../editor/dom";
import { render, activeTemplateIndex } from "./render";

interface Drag {
  kind: "slider" | "sheer" | "trim" | "transom" | "stn" | "weight" | "rot";
  svg?: SVGSVGElement;
  idx?: number;
  ti?: number; // template index, for a "stn" drag
  wpart?: "x" | "bnd"; // which part of a weight control point is being dragged
  bnd?: number; // boundary index, for a "weight" / "bnd" drag
  px0?: number;
  py0?: number;
  yaw0?: number;
  pitch0?: number;
}

let CURRENT_DRAG: Drag | null = null;

export function getDrag(): Drag | null {
  return CURRENT_DRAG;
}

export function setDrag(d: Drag | null): void {
  CURRENT_DRAG = d;
}

type DragSpec = {
  kind: Drag["kind"];
  idx?: number;
  ti?: number;
  wpart?: "x" | "bnd";
  bnd?: number;
};

// map a client (screen) point to the svg's viewBox coordinates via its CTM — handles any CSS scaling and
// preserveAspectRatio letterboxing (the editor svgs are fit-to-box, so their box ≠ their viewBox aspect)
function svgPoint(
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

export function startDrag(
  d: DragSpec,
  svg: SVGSVGElement,
  e: PointerEvent,
): void {
  setDrag({ ...d, svg, px0: e.clientX });
  // a drag on a control point selects it (persistently); the x-cut slider / rotation leave the selection
  if (d.kind === "sheer") select("plan", d.idx!);
  else if (d.kind === "trim") select("trim", d.idx!);
  else if (d.kind === "transom") select("transom", d.idx!);
  else if (d.kind === "stn") select("template", d.idx!, d.ti!);
  else if (d.kind === "weight") select("weight", d.idx!);
  e.stopPropagation();
  e.preventDefault();
}

export function getVB(d: Drag, e: PointerEvent): [number, number] {
  return svgPoint(d.svg!, e.clientX, e.clientY);
}

export function moveSheer(d: Drag, vx: number, vy: number): void {
  const cp = state.sheer.cp[d.idx!],
    n = state.sheer.cp.length;
  // The first point is pinned at the transom (x = 0); every other point — including the LAST — is movable in
  // x, the last running forward to L + XFWD so the plan can be drawn over the bow overhang. y may go below the
  // centerline (down to YMIN) so the sheer plan can cross it to close a tumblehome bow.
  if (d.idx! > 0) {
    const hiX = d.idx! < n - 1 ? state.sheer.cp[d.idx! + 1].x - 80 : L + XFWD;
    const nx = clamp(invX(vx), state.sheer.cp[d.idx! - 1].x + 80, hiX);
    // resample the station's blend onto the current curve at its new x, so moving the plan handle along x
    // barely disturbs the blend (the point stays on the curve it helped define)
    if (nx !== cp.x) cp.w = weightsAt(nx);
    cp.x = nx;
  }
  cp.y = clamp(invY(vy), YMIN, YMAX);
}

export function moveTrim(d: Drag, vx: number, vy: number): void {
  const cp = state.sheer.trim[d.idx!],
    n = state.sheer.trim.length;
  // The first point is pinned at the transom (x = 0); every other point — including the LAST — is movable in
  // x. The last point may run forward to L + XFWD so the sheer trim can extend over the bow overhang.
  if (d.idx! > 0) {
    const hiX = d.idx! < n - 1 ? state.sheer.trim[d.idx! + 1].x - 80 : L + XFWD;
    cp.x = clamp(invX(vx), state.sheer.trim[d.idx! - 1].x + 80, hiX);
  }
  cp.z = clamp(invZp(vy), ZTRIMMIN, 0); // constrained at or below the flat deck (z ≤ 0)
}

export function moveTransom(d: Drag, vx: number, vy: number): void {
  const cp = state.sheer.transom[d.idx!];
  cp.x = clamp(invX(vx), 0, L * 0.45); // transom stays in the aft region
  cp.z = clamp(invZp(vy), ZTRIMMIN, 0);
}

// drag a station's blend in the weight strip: only the simplex split (the band boundary). x is shared with
// the plan curve and is edited there, so the blend strip has no x-handle.
export function moveWeight(d: Drag, vy: number): void {
  if (d.wpart !== "x")
    setWeightBoundary(state.sheer.cp[d.idx!], d.bnd!, clamp(invWY(vy), 0, 1));
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

// ---------- add / remove stations ---------- (add* return the inserted index)
// Add a unified station at x: its plan y and its blend w are both read off the CURRENT curves there, so the
// insert changes neither curve — it just adds a handle. (yGiven is the dragged y when adding in the plan
// view; the blend strip passes the plan curve's own y so the station lands on the curve.)
function addStation(x: number, yGiven: number): number {
  const cp = state.sheer.cp,
    n = cp.length;
  // may land anywhere forward of the transom, including the bow overhang to L + XFWD, and below the centerline
  x = clamp(x, cp[0].x + 80, L + XFWD);
  let k = cp.findIndex((p) => p.x > x);
  if (k < 0) k = n; // past every existing point → append at the bow end
  cp.splice(k, 0, { x, y: clamp(yGiven, YMIN, YMAX), w: weightsAt(x) });
  return k;
}
export const addSheerPoint = (x: number, y: number): number => addStation(x, y);
function removeStation(idx: number): void {
  const cp = state.sheer.cp;
  if (cp.length <= 3 || idx <= 0 || idx >= cp.length - 1) return; // keep both ends and a minimum of 3
  cp.splice(idx, 1);
}
const removeSheerPoint = removeStation;
export function addTrimPoint(x: number, z: number): number {
  const cp = state.sheer.trim,
    n = cp.length;
  // a new trim point may land anywhere forward of the transom, including the bow overhang up to L + XFWD
  x = clamp(x, cp[0].x + 80, L + XFWD);
  let k = cp.findIndex((p) => p.x > x);
  if (k < 0) k = n; // past every existing point → append at the bow end
  cp.splice(k, 0, { x, z: clamp(z, ZTRIMMIN, 0), k: 0 });
  return k;
}
function removeTrimPoint(idx: number): void {
  const cp = state.sheer.trim;
  if (cp.length <= 3 || idx <= 0 || idx >= cp.length - 1) return; // keep both ends and a minimum of 3
  cp.splice(idx, 1);
}

// add a section point: pick the segment of template `ti` nearest the click, insert there, and insert the
// matching index into EVERY template (at the same param along its own segment) so they stay index-aligned.
function addTemplatePoint(ti: number, n: number, d: number): number {
  const arr = state.templates[ti];
  let best = 1,
    bt = 0.5,
    bd = Infinity;
  for (let i = 0; i < arr.length - 1; i++) {
    const ax = arr[i].n,
      ay = arr[i].d,
      vx = arr[i + 1].n - ax,
      vy = arr[i + 1].d - ay,
      L2 = vx * vx + vy * vy || 1;
    const t = clamp(((n - ax) * vx + (d - ay) * vy) / L2, 0, 1),
      px = ax + vx * t,
      py = ay + vy * t,
      dist = Math.hypot(n - px, d - py);
    if (dist < bd) {
      bd = dist;
      best = i + 1;
      bt = t;
    }
  }
  state.templates.forEach((tpl, j) => {
    const a = tpl[best - 1],
      b = tpl[best];
    if (j === ti) {
      const dlo = Math.min(a.d, b.d),
        dhi = Math.max(a.d, b.d);
      tpl.splice(best, 0, {
        n: clamp(n, NMIN, NMAX),
        d: clamp(d, dlo, dhi),
        k: 0,
      });
    } else {
      tpl.splice(best, 0, {
        n: lerp(a.n, b.n, bt),
        d: lerp(a.d, b.d, bt),
        k: lerp(a.k, b.k, bt),
      });
    }
  });
  return best;
}
function removeStationPoint(idx: number): void {
  const len = state.templates[0].length;
  if (len <= 3 || idx <= 0 || idx >= len - 1) return; // keep the sheer point and the deepest point
  state.templates.forEach((t) => t.splice(idx, 1));
}

// add a station from the blend strip: x as given, plan y read off the current plan curve so the station
// lands on it (stations are unified, so this adds the plan handle too).
export const addWeightPoint = (x: number): number =>
  addStation(x, state.sheer.yf(x));
const removeWeightPoint = removeStation;

// ---------- add / remove whole templates ----------
// a new template starts as a copy of the last and enters every weight CP at zero weight, so the hull is
// unchanged on add; raise its weight in the blend editor to bring it into the mix.
export function addTemplate(): void {
  if (state.templates.length >= 7) return; // palette / UI cap
  const last = state.templates[state.templates.length - 1];
  state.templates.push(last.map((p) => ({ n: p.n, d: p.d, k: p.k })));
  state.keelK.push(state.keelK[state.keelK.length - 1] ?? 0); // copy the last template's keel knuckle
  state.sheer.cp.forEach((cp) => cp.w.push(0));
  state.selected = null;
  refreshSelUI();
  render();
}
export function removeTemplate(ti: number): void {
  if (state.templates.length <= 1) return;
  state.templates.splice(ti, 1);
  state.keelK.splice(ti, 1);
  state.sheer.cp.forEach((cp) => {
    cp.w.splice(ti, 1);
    let s = 0;
    cp.w.forEach((v) => (s += v));
    cp.w = s > 0 ? cp.w.map((v) => v / s) : cp.w.map(() => 1 / cp.w.length);
  });
  state.selected = null;
  refreshSelUI();
  render();
}

// ---------- tools (select / add) + the selected-point actions ----------
export function vbCoords(
  svg: SVGSVGElement,
  e: PointerEvent,
): [number, number] {
  return svgPoint(svg, e.clientX, e.clientY);
}

function setToolCursor(): void {
  const cur = state.tool === "add" ? "crosshair" : "default";
  [svgL, svgP, svgW].forEach((s) => (s.style.cursor = cur));
  tplCards.style.cursor = cur; // dynamic per-template svgs inherit the container cursor
}

export function setTool(name: typeof state.tool): void {
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
  const s = state.selected;
  if (!s) return null;
  if (s.tgt === "template" && s.ti !== undefined) return state.templates[s.ti];
  if (s.tgt === "trim") return state.sheer.trim;
  return null;
}

export function select(tgt: ActiveTarget, idx: number, ti?: number): void {
  state.selected = { tgt, idx, ti };
  refreshSelUI();
  render(); // draw the highlight immediately (selecting need not involve a drag)
}
export function clearSelection(): void {
  if (!state.selected) return;
  state.selected = null;
  refreshSelUI();
  render();
}

// can the selected point be deleted? ends are pinned; the sheer/trim/template keep a minimum of 3; the
// weight curve keeps its two ends; the transom is a fixed pair of points.
function canDelete(s: { tgt: ActiveTarget; idx: number }): boolean {
  if (s.tgt === "transom") return false;
  if (s.tgt === "plan")
    return (
      state.sheer.cp.length > 3 &&
      s.idx > 0 &&
      s.idx < state.sheer.cp.length - 1
    );
  if (s.tgt === "trim")
    return (
      state.sheer.trim.length > 3 &&
      s.idx > 0 &&
      s.idx < state.sheer.trim.length - 1
    );
  if (s.tgt === "weight")
    return (
      state.sheer.cp.length > 3 &&
      s.idx > 0 &&
      s.idx < state.sheer.cp.length - 1
    );
  const len = state.templates[0].length; // template
  return len > 3 && s.idx > 0 && s.idx < len - 1;
}

// points that carry a knuckle (k): every sheer-trim point, and every template point but the pinned sheer
// point (idx 0). The plan/transom/weight points do not.
function hasKnuckle(s: { tgt: ActiveTarget; idx: number }): boolean {
  return s.tgt === "trim" || (s.tgt === "template" && s.idx > 0);
}

function labelFor(s: { tgt: ActiveTarget; idx: number; ti?: number }): string {
  if (s.tgt === "template")
    return `Template ${(s.ti ?? 0) + 1} · point ${s.idx + 1}`;
  if (s.tgt === "weight") return `Blend point ${s.idx + 1}`;
  const name = { plan: "Sheer (plan)", trim: "Sheer trim", transom: "Transom" }[
    s.tgt as "plan" | "trim" | "transom"
  ];
  return `${name} · point ${s.idx + 1}`;
}

export function deleteSelected(): void {
  const s = state.selected;
  if (!s || !canDelete(s)) return;
  if (s.tgt === "plan") removeSheerPoint(s.idx);
  else if (s.tgt === "trim") removeTrimPoint(s.idx);
  else if (s.tgt === "weight") removeWeightPoint(s.idx);
  else removeStationPoint(s.idx); // template (removes the matching index from every template)
  state.selected = null;
  refreshSelUI();
  render();
}

export function setSelectedKnuckle(k: number): void {
  const s = state.selected,
    arr = selArr();
  if (!s || !arr || !hasKnuckle(s)) return;
  arr[s.idx].k = clamp(k, 0, 1);
  render();
}

// reflect the current selection in the (always-visible) selection panel: label, delete, knuckle slider.
// The panel keeps constant height — the knuckle slider and delete are present but disabled when they don't
// apply — so selecting a point never reflows the side column.
export function refreshSelUI(): void {
  const label = document.getElementById("selLabel")!,
    del = document.getElementById("selDelete") as HTMLButtonElement,
    krange = document.getElementById("selKnuckle") as HTMLInputElement;
  const s = state.selected;
  label.textContent = s ? labelFor(s) : "No point selected";
  label.classList.toggle("muted", !s);
  del.disabled = !s || !canDelete(s);
  const arr = selArr(),
    knuckle = !!(s && arr && hasKnuckle(s));
  krange.disabled = !knuckle;
  krange.value = knuckle ? String(arr![s!.idx].k) : "0";
}

// the keel-knuckle slider edits the active template tab's keel (centerline) knuckle; it is disabled on the
// Cut / Body views (which are not a single template). Kept in sync by the side-panel render + tab switches.
export function setActiveKeel(k: number): void {
  const ti = activeTemplateIndex();
  if (ti === null || ti >= state.keelK.length) return;
  state.keelK[ti] = clamp(k, 0, 1);
  refreshKeelUI();
  render();
}

export function refreshKeelUI(): void {
  const r = document.getElementById("keelRange") as HTMLInputElement,
    v = document.getElementById("keelVal") as HTMLElement,
    ctl = document.getElementById("keelCtl") as HTMLElement;
  const ti = activeTemplateIndex(),
    on = ti !== null && ti < state.keelK.length;
  r.disabled = !on;
  ctl.classList.toggle("disabled", !on);
  const k = on ? state.keelK[ti!] : 0;
  r.value = String(k);
  v.textContent = on ? k.toFixed(2) : "—";
}

// click on a template point → select it (and, if it can move, start dragging). The pinned sheer-origin
// (idx 0) selects but does not drag.
export function stnPointDown(
  ti: number,
  idx: number,
  end: boolean,
  svg: SVGSVGElement,
  e: PointerEvent,
): void {
  e.stopPropagation();
  if (end) {
    select("template", idx, ti);
    return;
  }
  startDrag({ kind: "stn", ti, idx }, svg, e);
}
export function sheerPointDown(
  idx: number,
  svg: SVGSVGElement,
  e: PointerEvent,
): void {
  e.stopPropagation();
  startDrag({ kind: "sheer", idx }, svg, e);
}
export function trimPointDown(
  idx: number,
  svg: SVGSVGElement,
  e: PointerEvent,
): void {
  e.stopPropagation();
  startDrag({ kind: "trim", idx }, svg, e);
}
export function transomPointDown(
  idx: number,
  svg: SVGSVGElement,
  e: PointerEvent,
): void {
  e.stopPropagation();
  startDrag({ kind: "transom", idx }, svg, e);
}
// a weight-curve handle: `part` is "x" (drag the control point along the hull) or "bnd" (drag band
// boundary `bnd`, editing the simplex split at that control point).
export function weightHandleDown(
  idx: number,
  part: "x" | "bnd",
  bnd: number,
  svg: SVGSVGElement,
  e: PointerEvent,
): void {
  e.stopPropagation();
  startDrag({ kind: "weight", idx, wpart: part, bnd }, svg, e);
}

// background pointerdown on a (dynamic) template editor: add a point in "add" mode, else clear selection
export function templateBgDown(
  ti: number,
  svg: SVGSVGElement,
  e: PointerEvent,
): void {
  if (state.tool === "add") {
    const [vx, vy] = vbCoords(svg, e),
      idx = addTemplatePoint(ti, invN(vx), invD(vy));
    setTool("select");
    select("template", idx, ti);
  } else {
    clearSelection();
  }
}
