// ---------- pointer interaction: dragging points, the cut slider, 3D rotation, and the edit tools ----------

import { clamp, lerp } from "./math.js";
import {
  state,
  L,
  XFWD,
  NMIN,
  NMAX,
  DMAX,
  weightsAt,
  type ActiveTarget,
  type WeightCP,
} from "./model.js";
import { invX, invY, invZp, invN, invD, invWvX, invWvW, YMAX, ZTRIMMIN } from "./view.js";
import { svgL, svgP, svgW, tplCards } from "./dom.js";
import { render, draw3d, activeTemplateIndex } from "./render.js";

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

let drag: Drag | null = null;

type DragSpec = {
  kind: Drag["kind"];
  idx?: number;
  ti?: number;
  wpart?: "x" | "bnd";
  bnd?: number;
};

// map a client (screen) point to the svg's viewBox coordinates via its CTM — handles any CSS scaling and
// preserveAspectRatio letterboxing (the editor svgs are fit-to-box, so their box ≠ their viewBox aspect)
function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number): [number, number] {
  const m = svg.getScreenCTM();
  if (!m) return [0, 0];
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const p = pt.matrixTransform(m.inverse());
  return [p.x, p.y];
}

export function startDrag(d: DragSpec, svg: SVGSVGElement, e: PointerEvent): void {
  drag = { ...d, svg, px0: e.clientX };
  // a drag on a control point selects it (persistently); the x-cut slider / rotation leave the selection
  if (d.kind === "sheer") select("plan", d.idx!);
  else if (d.kind === "trim") select("trim", d.idx!);
  else if (d.kind === "transom") select("transom", d.idx!);
  else if (d.kind === "stn") select("template", d.idx!, d.ti!);
  else if (d.kind === "weight") select("weight", d.idx!);
  e.stopPropagation();
  e.preventDefault();
}

function getVB(d: Drag, e: PointerEvent): [number, number] {
  return svgPoint(d.svg!, e.clientX, e.clientY);
}

function moveSheer(d: Drag, vx: number, vy: number): void {
  const cp = state.sheer.cp[d.idx!],
    n = state.sheer.cp.length;
  if (d.idx! > 0 && d.idx! < n - 1)
    cp.x = clamp(invX(vx), state.sheer.cp[d.idx! - 1].x + 80, state.sheer.cp[d.idx! + 1].x - 80);
  cp.y = clamp(invY(vy), 0, YMAX);
}

function moveTrim(d: Drag, vx: number, vy: number): void {
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

function moveTransom(d: Drag, vx: number, vy: number): void {
  const cp = state.sheer.transom[d.idx!];
  cp.x = clamp(invX(vx), 0, L * 0.45); // transom stays in the aft region
  cp.z = clamp(invZp(vy), ZTRIMMIN, 0);
}

// drag a weight control point: either along x (only the interior CPs; the ends are pinned to 0 / L), or
// one of its internal band boundaries — the cumulative-weight split that edits the simplex value.
function moveWeight(d: Drag, vx: number, vy: number): void {
  const cp = state.weights[d.idx!],
    n = state.weights.length;
  if (d.wpart === "x") {
    // the blend control is vertical: the longitudinal x reads off the vertical position
    if (d.idx! > 0 && d.idx! < n - 1)
      cp.x = clamp(invWvX(vy), state.weights[d.idx! - 1].x + 60, state.weights[d.idx! + 1].x - 60);
  } else {
    // a band boundary reads off the horizontal position (the simplex split)
    setWeightBoundary(cp, d.bnd!, clamp(invWvW(vx), 0, 1));
  }
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

// ---------- add / remove control points ---------- (add* return the inserted index)
function addSheerPoint(x: number, y: number): number {
  const cp = state.sheer.cp,
    n = cp.length;
  x = clamp(x, cp[0].x + 80, cp[n - 1].x - 80);
  let k = cp.findIndex((p) => p.x > x);
  if (k < 1) k = n - 1;
  cp.splice(k, 0, { x, y: clamp(y, 0, YMAX) });
  return k;
}
function removeSheerPoint(idx: number): void {
  const cp = state.sheer.cp;
  if (cp.length <= 3 || idx <= 0 || idx >= cp.length - 1) return; // keep both ends and a minimum of 3
  cp.splice(idx, 1);
}
function addTrimPoint(x: number, z: number): number {
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
      tpl.splice(best, 0, { n: clamp(n, NMIN, NMAX), d: clamp(d, dlo, dhi), k: 0 });
    } else {
      tpl.splice(best, 0, { n: lerp(a.n, b.n, bt), d: lerp(a.d, b.d, bt), k: lerp(a.k, b.k, bt) });
    }
  });
  return best;
}
function removeStationPoint(idx: number): void {
  const len = state.templates[0].length;
  if (len <= 3 || idx <= 0 || idx >= len - 1) return; // keep the sheer point and the deepest point
  state.templates.forEach((t) => t.splice(idx, 1));
}

// add a weight control point at x, taking its barycentric value from the current curve there (so the path
// is unchanged by the insert — a new handle on the same line), then it can be dragged to bend the path.
function addWeightPoint(x: number): number {
  const w = state.weights,
    n = w.length;
  x = clamp(x, w[0].x + 60, w[n - 1].x - 60);
  let k = w.findIndex((p) => p.x > x);
  if (k < 1) k = n - 1;
  w.splice(k, 0, { x, w: weightsAt(x) });
  return k;
}
function removeWeightPoint(idx: number): void {
  const n = state.weights.length;
  if (n <= 2 || idx <= 0 || idx >= n - 1) return; // keep the two end control points
  state.weights.splice(idx, 1);
}

// add a blend control point at the midpoint of the widest gap between adjacent control points (the
// "+ blend point" button) — its weight is read off the current curve so the path is unchanged, then
// it is selected ready to drag.
export function addBlendPoint(): void {
  const w = state.weights;
  if (w.length < 2) return;
  let bi = 0,
    bg = -1;
  for (let i = 0; i < w.length - 1; i++) {
    const g = w[i + 1].x - w[i].x;
    if (g > bg) {
      bg = g;
      bi = i;
    }
  }
  const idx = addWeightPoint((w[bi].x + w[bi + 1].x) / 2);
  select("weight", idx);
}

// ---------- add / remove whole templates ----------
// a new template starts as a copy of the last and enters every weight CP at zero weight, so the hull is
// unchanged on add; raise its weight in the blend editor to bring it into the mix.
export function addTemplate(): void {
  if (state.templates.length >= 7) return; // palette / UI cap
  const last = state.templates[state.templates.length - 1];
  state.templates.push(last.map((p) => ({ n: p.n, d: p.d, k: p.k })));
  state.keelK.push(state.keelK[state.keelK.length - 1] ?? 0); // copy the last template's keel knuckle
  state.weights.forEach((cp) => cp.w.push(0));
  state.selected = null;
  refreshSelUI();
  render();
}
export function removeTemplate(ti: number): void {
  if (state.templates.length <= 1) return;
  state.templates.splice(ti, 1);
  state.keelK.splice(ti, 1);
  state.weights.forEach((cp) => {
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
function vbCoords(svg: SVGSVGElement, e: PointerEvent): [number, number] {
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
  if (s.tgt === "plan") return state.sheer.cp.length > 3 && s.idx > 0 && s.idx < state.sheer.cp.length - 1;
  if (s.tgt === "trim") return state.sheer.trim.length > 3 && s.idx > 0 && s.idx < state.sheer.trim.length - 1;
  if (s.tgt === "weight") return state.weights.length > 2 && s.idx > 0 && s.idx < state.weights.length - 1;
  const len = state.templates[0].length; // template
  return len > 3 && s.idx > 0 && s.idx < len - 1;
}

// points that carry a knuckle (k): every sheer-trim point, and every template point but the pinned sheer
// point (idx 0). The plan/transom/weight points do not.
function hasKnuckle(s: { tgt: ActiveTarget; idx: number }): boolean {
  return s.tgt === "trim" || (s.tgt === "template" && s.idx > 0);
}

function labelFor(s: { tgt: ActiveTarget; idx: number; ti?: number }): string {
  if (s.tgt === "template") return `Template ${(s.ti ?? 0) + 1} · point ${s.idx + 1}`;
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

function setSelectedKnuckle(k: number): void {
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
function setActiveKeel(k: number): void {
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
export function sheerPointDown(idx: number, svg: SVGSVGElement, e: PointerEvent): void {
  e.stopPropagation();
  startDrag({ kind: "sheer", idx }, svg, e);
}
export function trimPointDown(idx: number, svg: SVGSVGElement, e: PointerEvent): void {
  e.stopPropagation();
  startDrag({ kind: "trim", idx }, svg, e);
}
export function transomPointDown(idx: number, svg: SVGSVGElement, e: PointerEvent): void {
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
export function templateBgDown(ti: number, svg: SVGSVGElement, e: PointerEvent): void {
  if (state.tool === "add") {
    const [vx, vy] = vbCoords(svg, e),
      idx = addTemplatePoint(ti, invN(vx), invD(vy));
    setTool("select");
    select("template", idx, ti);
  } else {
    clearSelection();
  }
}

// ---------- wire up the global / per-svg pointer listeners (called once at startup) ----------
export function initInteraction(): void {
  const toolbar = document.getElementById("toolbar")!;
  toolbar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".tool");
    if (b) setTool(b.dataset.tool as typeof state.tool);
  });

  const cv3d = document.getElementById("cv3d") as HTMLCanvasElement;
  cv3d.addEventListener("pointerdown", (e) => {
    drag = {
      kind: "rot",
      px0: e.clientX,
      py0: e.clientY,
      yaw0: state.rot.yaw,
      pitch0: state.rot.pitch,
    };
    e.preventDefault();
  });
  // scroll-wheel zoom (smooth, multiplicative); the lines overlay is pointer-events:none so this still fires
  cv3d.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      state.zoom = clamp(state.zoom * Math.exp(-e.deltaY * 0.0015), 0.3, 8);
      draw3d(false);
    },
    { passive: false },
  );

  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (drag.kind === "rot") {
      state.rot.yaw = drag.yaw0! + (e.clientX - drag.px0!) * 0.008;
      state.rot.pitch = clamp(drag.pitch0! + (e.clientY - drag.py0!) * 0.008, -1.45, 1.45);
      draw3d(false); // rotation only redraws GL (mesh is cached)
      return;
    }
    const [vx, vy] = getVB(drag, e);
    if (drag.kind === "slider") {
      // the cut scrubs along x — horizontal in plan/profile, but vertical in the blend control
      state.x0 = clamp(drag.svg === svgW ? invWvX(vy) : invX(vx), 0, L);
    } else if (drag.kind === "sheer") moveSheer(drag, vx, vy);
    else if (drag.kind === "trim") moveTrim(drag, vx, vy);
    else if (drag.kind === "transom") moveTransom(drag, vx, vy);
    else if (drag.kind === "weight") moveWeight(drag, vx, vy);
    else if (drag.kind === "stn") {
      const arr = state.templates[drag.ti!],
        i = drag.idx!,
        cp = arr[i];
      cp.n = clamp(invN(vx), NMIN, NMAX); // negative = outboard of the sheer (tumblehome)
      const lo = arr[i - 1].d,
        hi = i < arr.length - 1 ? arr[i + 1].d : DMAX; // keep d descending so the section never curls up
      cp.d = clamp(invD(vy), lo, hi);
    }
    render();
  });
  window.addEventListener("pointerup", () => {
    drag = null; // selection persists after a drag, so the point stays highlighted and editable
  });

  // delete the selected point with Delete/Backspace (unless typing in the knuckle slider)
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (state.selected) {
      e.preventDefault();
      deleteSelected();
    }
  });
  document.getElementById("selDelete")!.addEventListener("click", deleteSelected);
  document
    .getElementById("selKnuckle")!
    .addEventListener("input", (e) => setSelectedKnuckle(parseFloat((e.target as HTMLInputElement).value)));
  document
    .getElementById("keelRange")!
    .addEventListener("input", (e) => setActiveKeel(parseFloat((e.target as HTMLInputElement).value)));

  // editor backgrounds: in "add" mode click empty space to add a point there (then back to select, with
  // the new point selected); in "select" mode an empty click clears the selection.
  const onBg = (
    svg: SVGSVGElement,
    add: (vx: number, vy: number) => { tgt: ActiveTarget; idx: number },
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
  onBg(svgL, (vx, vy) => ({ tgt: "plan", idx: addSheerPoint(invX(vx), invY(vy)) }));
  onBg(svgP, (vx, vy) => ({ tgt: "trim", idx: addTrimPoint(invX(vx), invZp(vy)) }));
  // the weight editor (persistent element): add a blend control point at the clicked x
  svgW.addEventListener("pointerdown", (e) => {
    if (state.tool === "add") {
      const [, vy] = vbCoords(svgW, e),
        idx = addWeightPoint(invWvX(vy));
      setTool("select");
      select("weight", idx);
    } else {
      clearSelection();
    }
  });

  refreshSelUI();
  refreshKeelUI();
}
