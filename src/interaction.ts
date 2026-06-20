// ---------- pointer interaction: dragging points, the cut slider, 3D rotation, and the edit tools ----------

import { clamp, lerp } from "./math.js";
import { state, L, NMIN, NMAX, DMAX } from "./model.js";
import {
  invX,
  invY,
  invZp,
  invN,
  invD,
  YMAX,
  ZTRIMMIN,
  PH,
  LH,
  STW,
  STH,
} from "./view.js";
import { svgL, svgP, svgA, svgF, cv3d } from "./dom.js";
import { render, draw3d } from "./render.js";

interface Drag {
  kind: "slider" | "sheer" | "trim" | "transom" | "stn" | "knuckle" | "rot";
  svg?: SVGSVGElement;
  vbw?: number;
  vbh?: number;
  idx?: number;
  which?: "aft" | "fore";
  px0?: number;
  py0?: number;
  k0?: number;
  yaw0?: number;
  pitch0?: number;
}

let drag: Drag | null = null;

const isStn = (svg: SVGSVGElement): boolean => svg === svgA || svg === svgF;

export function startDrag(
  d: { kind: Drag["kind"]; idx?: number; which?: "aft" | "fore"; k0?: number },
  svg: SVGSVGElement,
  e: PointerEvent,
): void {
  drag = {
    ...d,
    svg,
    vbw: isStn(svg) ? STW : 1000,
    vbh: isStn(svg) ? STH : svg === svgP ? PH : LH,
    px0: e.clientX, // anchor for relative (horizontal) drags like the knuckle edit
  };
  // mark the acted-on control point so the renderer can highlight it
  const tgt =
    d.kind === "sheer"
      ? "plan"
      : d.kind === "trim"
        ? "trim"
        : d.kind === "transom"
          ? "transom"
          : d.kind === "stn" || d.kind === "knuckle"
            ? d.which!
            : null;
  state.active = tgt ? { tgt, idx: d.idx! } : null;
  e.stopPropagation();
  e.preventDefault();
}

function getVB(d: Drag, e: PointerEvent): [number, number] {
  const r = d.svg!.getBoundingClientRect();
  return [
    ((e.clientX - r.left) * d.vbw!) / r.width,
    ((e.clientY - r.top) * d.vbh!) / r.height,
  ];
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
  if (d.idx! > 0 && d.idx! < n - 1)
    cp.x = clamp(invX(vx), state.sheer.trim[d.idx! - 1].x + 80, state.sheer.trim[d.idx! + 1].x - 80);
  cp.z = clamp(invZp(vy), ZTRIMMIN, 0); // constrained at or below the flat deck (z ≤ 0)
}

function moveTransom(d: Drag, vx: number, vy: number): void {
  const cp = state.sheer.transom[d.idx!];
  cp.x = clamp(invX(vx), 0, L * 0.45); // transom stays in the aft region
  cp.z = clamp(invZp(vy), ZTRIMMIN, 0);
}

// ---------- add / remove control points ----------
function addSheerPoint(x: number, y: number): void {
  const cp = state.sheer.cp,
    n = cp.length;
  x = clamp(x, cp[0].x + 80, cp[n - 1].x - 80);
  let k = cp.findIndex((p) => p.x > x);
  if (k < 1) k = n - 1;
  cp.splice(k, 0, { x, y: clamp(y, 0, YMAX) });
}
function removeSheerPoint(idx: number): void {
  const cp = state.sheer.cp;
  if (cp.length <= 3 || idx <= 0 || idx >= cp.length - 1) return; // keep both ends and a minimum of 3
  cp.splice(idx, 1);
}
function addTrimPoint(x: number, z: number): void {
  const cp = state.sheer.trim,
    n = cp.length;
  x = clamp(x, cp[0].x + 80, cp[n - 1].x - 80);
  let k = cp.findIndex((p) => p.x > x);
  if (k < 1) k = n - 1;
  cp.splice(k, 0, { x, z: clamp(z, ZTRIMMIN, 0) });
}
function removeTrimPoint(idx: number): void {
  const cp = state.sheer.trim;
  if (cp.length <= 3 || idx <= 0 || idx >= cp.length - 1) return; // keep both ends and a minimum of 3
  cp.splice(idx, 1);
}
// add a station point: insert into the clicked array where clicked, and into the other array at the
// matching spot along the same segment, so AFT/FORE stay index-aligned for blending.
function addStationPoint(which: "aft" | "fore", n: number, d: number): void {
  const arr = which === "aft" ? state.AFT : state.FORE,
    other = which === "aft" ? state.FORE : state.AFT;
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
  arr.splice(best, 0, { n: clamp(n, NMIN, NMAX), d: clamp(d, 0, DMAX), k: 0 });
  const oa = other[best - 1],
    ob = other[best];
  other.splice(best, 0, { n: lerp(oa.n, ob.n, bt), d: lerp(oa.d, ob.d, bt), k: 0 });
}
function removeStationPoint(idx: number): void {
  if (state.AFT.length <= 3 || idx <= 0 || idx >= state.AFT.length - 1) return; // keep the sheer point and the deepest point
  state.AFT.splice(idx, 1);
  state.FORE.splice(idx, 1);
}

// ---------- edit tools: move / pen / delete / knuckle ----------
function vbCoords(svg: SVGSVGElement, e: PointerEvent, w: number, h: number): [number, number] {
  const r = svg.getBoundingClientRect();
  return [((e.clientX - r.left) * w) / r.width, ((e.clientY - r.top) * h) / r.height];
}

function setToolCursor(): void {
  const cur =
    state.tool === "pen"
      ? "crosshair"
      : state.tool === "move"
        ? "default"
        : state.tool === "knuckle"
          ? "ew-resize"
          : "pointer";
  [svgL, svgP, svgA, svgF].forEach((s) => (s.style.cursor = cur));
}

export function setTool(name: typeof state.tool): void {
  state.tool = name;
  const toolbar = document.getElementById("toolbar")!;
  toolbar
    .querySelectorAll<HTMLElement>(".tool")
    .forEach((t) => t.classList.toggle("active", t.dataset.tool === name));
  setToolCursor();
}

// click on a point: act per active tool. Pen does nothing on a point (adds happen on empty space).
export function stnPointDown(
  which: "aft" | "fore",
  idx: number,
  end: boolean,
  svg: SVGSVGElement,
  e: PointerEvent,
): void {
  e.stopPropagation();
  if (state.tool === "delete") {
    if (!end) removeStationPoint(idx);
    setTool("move");
    render();
    return;
  }
  if (state.tool === "knuckle") {
    // drag left/right across the point to set its knuckle (0 = smooth, 1 = hard corner)
    const arr = which === "aft" ? state.AFT : state.FORE;
    if (idx > 0 && idx < arr.length - 1)
      startDrag({ kind: "knuckle", which, idx, k0: arr[idx].k }, svg, e);
    return;
  }
  if (state.tool === "move" && !end) startDrag({ kind: "stn", which, idx }, svg, e);
}
export function sheerPointDown(idx: number, svg: SVGSVGElement, e: PointerEvent): void {
  e.stopPropagation();
  if (state.tool === "delete") {
    removeSheerPoint(idx);
    setTool("move");
    render();
    return;
  }
  if (state.tool === "knuckle") {
    setTool("move");
    return;
  } // the sheer has no knuckle points
  if (state.tool === "move") startDrag({ kind: "sheer", idx }, svg, e);
}
export function trimPointDown(idx: number, svg: SVGSVGElement, e: PointerEvent): void {
  e.stopPropagation();
  if (state.tool === "delete") {
    removeTrimPoint(idx);
    setTool("move");
    render();
    return;
  }
  if (state.tool === "knuckle") {
    setTool("move");
    return;
  } // the sheer trim has no knuckle points
  if (state.tool === "move") startDrag({ kind: "trim", idx }, svg, e);
}
export function transomPointDown(idx: number, svg: SVGSVGElement, e: PointerEvent): void {
  e.stopPropagation();
  if (state.tool === "move") startDrag({ kind: "transom", idx }, svg, e);
  // only the two transom points; no add/delete
  else setTool("move");
}

// ---------- wire up the global / per-svg pointer listeners (called once at startup) ----------
export function initInteraction(): void {
  const toolbar = document.getElementById("toolbar")!;
  toolbar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".tool");
    if (b) setTool(b.dataset.tool as typeof state.tool);
  });

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
      state.x0 = clamp(invX(vx), 0, L);
    } else if (drag.kind === "sheer") moveSheer(drag, vx, vy);
    else if (drag.kind === "trim") moveTrim(drag, vx, vy);
    else if (drag.kind === "transom") moveTransom(drag, vx, vy);
    else if (drag.kind === "stn") {
      const arr = drag.which === "aft" ? state.AFT : state.FORE,
        i = drag.idx!,
        cp = arr[i];
      cp.n = clamp(invN(vx), NMIN, NMAX); // negative = outboard of the sheer (tumblehome)
      const lo = arr[i - 1].d,
        hi = i < arr.length - 1 ? arr[i + 1].d : DMAX; // keep d descending so the section never curls up
      cp.d = clamp(invD(vy), lo, hi);
    } else if (drag.kind === "knuckle") {
      // horizontal drag sets the knuckle: right → harder (k→1), left → smoother (k→0).
      const arr = drag.which === "aft" ? state.AFT : state.FORE,
        w = drag.svg!.getBoundingClientRect().width || 1,
        dk = (e.clientX - drag.px0!) / (w * 0.5); // half the panel width = full 0..1 sweep
      arr[drag.idx!].k = clamp(drag.k0! + dk, 0, 1);
    }
    render();
  });
  window.addEventListener("pointerup", () => {
    drag = null;
    if (state.active) {
      state.active = null; // drop the highlight
      render();
    }
  });

  // pen: click empty space in an editor to add a point there, then return to the move tool
  svgL.addEventListener("pointerdown", (e) => {
    if (state.tool !== "pen") return;
    const [vx, vy] = vbCoords(svgL, e, 1000, LH);
    addSheerPoint(invX(vx), invY(vy));
    setTool("move");
    render();
  });
  svgP.addEventListener("pointerdown", (e) => {
    if (state.tool !== "pen") return;
    const [vx, vy] = vbCoords(svgP, e, 1000, PH);
    addTrimPoint(invX(vx), invZp(vy));
    setTool("move");
    render();
  });
  svgA.addEventListener("pointerdown", (e) => {
    if (state.tool !== "pen") return;
    const [vx, vy] = vbCoords(svgA, e, STW, STH);
    addStationPoint("aft", invN(vx), invD(vy));
    setTool("move");
    render();
  });
  svgF.addEventListener("pointerdown", (e) => {
    if (state.tool !== "pen") return;
    const [vx, vy] = vbCoords(svgF, e, STW, STH);
    addStationPoint("fore", invN(vx), invD(vy));
    setTool("move");
    render();
  });
}
