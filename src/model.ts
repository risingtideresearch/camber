// ---------- the parametric hull model + the constant-camber sweep ----------

import { clamp, lerp, V, type Vec3 } from "./math.js";
import { hobbySamplerX } from "./hobby.js";
import { pchipSlopes, hermiteEval } from "./pchip.js";

// ---------- types ----------
export interface SheerCP {
  x: number;
  y: number;
}
export interface TrimCP {
  x: number;
  z: number;
}
export interface TransomCP {
  x: number;
  z: number;
}
export interface StationCP {
  n: number;
  d: number;
  c: boolean;
}
export interface Sheer {
  cp: SheerCP[];
  trim: TrimCP[];
  transom: TransomCP[];
  yf: (x: number) => number; // plan half-breadth y(x)
  zf: (x: number) => number; // profile sheer-trim z(x) ≤ 0
}

export interface Frame {
  p: Vec3;
  T: Vec3;
  n: Vec3;
  d: Vec3;
}
export interface Station {
  tmax: number;
  n: (u: number) => number;
  d: (u: number) => number;
}
export interface Section {
  pts: Vec3[];
  open: boolean;
  aft: boolean;
  keel: boolean;
}

// ---------- geometric domain constants ----------
export const L = 4000; // length overall (x: 0 = transom, L = bow)
// station coordinate bounds: n from NMIN (outboard → tumblehome) to NMAX (inboard); d down from the sheer
export const NMIN = -450,
  NMAX = 1350,
  DMAX = 1350;

// ---------- defaults ----------
const SHEER_DEF: [number, number][] = [
  [0, 820],
  [1000, 900],
  [2000, 880],
  [3000, 640],
  [4000, 0],
]; // 2D plan curve, flat deck z=0 (meets CL fwd)
// sheer trim line in profile (x, z): the real sheer, constrained below the flat deck (z ≤ 0). The strip
// of swept sheet between the deck (z=0) and this line is trimmed off the final shape. Lowest amidships.
const SHEER_TRIM_DEF: [number, number][] = [
  [0, -60],
  [1333, -280],
  [2667, -260],
  [4000, -40],
];
// transom: a raked plane at the stern, given by two profile points (x, z) — top (near the sheer) and
// bottom (near the keel). The hull keeps the forward side (x ≥ xTransom(z)); the cut is a solid face.
const TRANSOM_DEF: [number, number][] = [
  [150, -55],
  [380, -720],
];
// station sections in the local frame: d = down from the sheer, n = inboard offset. Point 0 = sheer,
// pinned at the origin. The curve descends from the sheer; the centerline clip closes the bottom.
const AFT_DEF: [number, number][] = [
  [0, 0],
  [90, 320],
  [260, 640],
  [560, 880],
  [980, 1000],
]; // fuller (transom)
const FORE_DEF: [number, number][] = [
  [0, 0],
  [150, 430],
  [400, 840],
  [720, 1120],
  [1020, 1220],
]; // deeper / finer (bow)

// ---------- mutable model + view state ----------
export type Tool = "move" | "pen" | "delete" | "corner";
export type View3D = "trimmed" | "sheet";

export interface State {
  sheer: Sheer;
  AFT: StationCP[];
  FORE: StationCP[];
  x0: number;
  rot: { yaw: number; pitch: number };
  view3d: View3D;
  zebra: boolean;
  tool: Tool;
}

export const state: State = {
  sheer: null as unknown as Sheer,
  AFT: [],
  FORE: [],
  x0: 2000,
  rot: { yaw: -0.62, pitch: 0.42 },
  view3d: "trimmed", // "trimmed" = clipped + mirrored hull; "sheet" = untrimmed one side
  zebra: false, // zebra-stripe fairness check on the 3D surface
  tool: "move",
};

export function resetModel(): void {
  state.sheer = {
    cp: SHEER_DEF.map((c) => ({ x: c[0], y: c[1] })),
    trim: SHEER_TRIM_DEF.map((c) => ({ x: c[0], z: c[1] })),
    transom: TRANSOM_DEF.map((c) => ({ x: c[0], z: c[1] })),
    yf: () => 0,
    zf: () => 0,
  };
  state.AFT = AFT_DEF.map((c) => ({ n: c[0], d: c[1], c: false }));
  state.FORE = FORE_DEF.map((c) => ({ n: c[0], d: c[1], c: false }));
  state.x0 = 2000;
}

export function prepare(): void {
  const sheer = state.sheer;
  sheer.yf = hobbySamplerX(sheer.cp.map((p) => [p.x, p.y])); // Hobby curve through the plan control points
  sheer.zf = hobbySamplerX(sheer.trim.map((p) => [p.x, p.z])); // profile sheer-trim curve, z(x) ≤ 0
}

// ---------- the constant-camber sweep ----------
// Frame at station x: tangent T along the (flat) sheer; d (depth) = straight down; n (inboard) = d × T.
// The station plane is vertical, rotating about z as the sheer heading turns, so stations fan out.
export function frameAt(x: number): Frame {
  const sheer = state.sheer;
  const p: Vec3 = [x, sheer.yf(x), 0];
  const e = 2,
    xa = clamp(x - e, 0, L),
    xb = clamp(x + e, 0, L);
  const T = V.norm([xb - xa, sheer.yf(xb) - sheer.yf(xa), 0]);
  const dn: Vec3 = [0, 0, -1];
  const d = V.norm(V.sub(dn, V.scale(T, V.dot(dn, T))));
  const n = V.norm(V.cross(d, T));
  return { p, T, n, d };
}

// cumulative chord-length parameter for a set of (n,d) points
export function chordParam(ns: number[], ds: number[]): number[] {
  const ts = [0];
  for (let i = 1; i < ns.length; i++) {
    const h = Math.hypot(ns[i] - ns[i - 1], ds[i] - ds[i - 1]);
    ts.push(ts[i - 1] + Math.max(h, 1e-3));
  }
  return ts;
}

// piecewise monotone-Hermite evaluator: the curve is split into independent PCHIP runs at "corner"
// points, so corners are kinks, runs never overshoot, and a two-point run comes out perfectly straight.
export function pieceEval(
  ts: number[],
  fs: number[],
  corners: boolean[],
): (u: number) => number {
  const n = ts.length,
    bnd = [0];
  for (let i = 1; i < n - 1; i++) if (corners[i]) bnd.push(i);
  bnd.push(n - 1);
  const runs: {
    t0: number;
    t1: number;
    tt: number[];
    ff: number[];
    m: number[];
  }[] = [];
  for (let k = 0; k < bnd.length - 1; k++) {
    const a = bnd[k],
      b = bnd[k + 1],
      tt = ts.slice(a, b + 1),
      ff = fs.slice(a, b + 1);
    runs.push({ t0: ts[a], t1: ts[b], tt, ff, m: pchipSlopes(tt, ff) });
  }
  return (u: number) => {
    let r = runs[0];
    for (const rr of runs) {
      r = rr;
      if (u <= rr.t1 + 1e-9) break;
    }
    return hermiteEval(r.tt, r.ff, r.m, clamp(u, r.t0, r.t1));
  };
}

// the blended station section at x, as continuous n(u)/d(u) over u in [0,tmax], corner-aware
export function stationAt(x: number): Station {
  const f = clamp(x / L, 0, 1),
    m = state.AFT.length,
    ns: number[] = [],
    ds: number[] = [],
    cor: boolean[] = [];
  for (let i = 0; i < m; i++) {
    ns.push(lerp(state.AFT[i].n, state.FORE[i].n, f));
    ds.push(lerp(state.AFT[i].d, state.FORE[i].d, f));
    cor.push(!!state.AFT[i].c);
  }
  const ts = chordParam(ns, ds);
  return { tmax: ts[m - 1], n: pieceEval(ts, ns, cor), d: pieceEval(ts, ds, cor) };
}

// the transom plane in profile: longitudinal position x of the cut at height z (linear through the two
// control points, full breadth). The hull keeps the forward side, x ≥ xTransom(z).
export function xTransom(z: number): number {
  const [a, b] = state.sheer.transom;
  return a.x + (b.x - a.x) * ((z - a.z) / (b.z - a.z || 1));
}

// the swept half-section at x as M+1 world points resampled along the station. When `trim` is set it
// runs from the sheer-trim line (top: the strip above it, between deck and trim, is cut off) down to the
// centerline (y ≥ 0; the keel point, last, y = 0, emerges from the clip) and reports `open` if it never
// reaches the centerline. Untrimmed, it runs the full station from the deck — the raw swept sheet.
// Because the flat sheer makes the station's d-axis point straight down, z = -d(u): the sheer trim at
// z = z_s(x) is simply the station depth d = -z_s(x).
export function sweptSection(x: number, M: number, trim: boolean, clipTransom = true): Section {
  const fr = frameAt(x),
    st = stationAt(x);
  const W = (u: number): Vec3 => {
    const nn = st.n(u),
      dd = st.d(u);
    return [
      fr.p[0] + nn * fr.n[0] + dd * fr.d[0],
      fr.p[1] + nn * fr.n[1] + dd * fr.d[1],
      fr.p[2] + nn * fr.n[2] + dd * fr.d[2],
    ];
  };
  let umin = 0,
    umax = st.tmax,
    open = true,
    empty = false;
  if (trim) {
    const dtrim = -state.sheer.zf(x), // depth of the sheer line below the deck
      FN = 160;
    if (dtrim > 0) {
      // sheer trim: first depth reaching dtrim — top of section.
      umin = st.tmax; // scan the WHOLE station (not stopped by the keel below)
      for (let i = 1; i <= FN; i++) {
        const u = (st.tmax * i) / FN;
        if (st.d(u) >= dtrim) {
          const da = st.d((st.tmax * (i - 1)) / FN);
          umin = (st.tmax * (i - 1 + (dtrim - da) / (st.d(u) - da || 1))) / FN;
          break;
        }
      }
    }
    let prev = W(0); // centerline crossing: first u where half-breadth < 0 → keel
    for (let i = 1; i <= FN; i++) {
      const u = (st.tmax * i) / FN,
        w = W(u);
      if (prev[1] >= 0 && w[1] < 0) {
        umax = (st.tmax * (i - 1 + prev[1] / (prev[1] - w[1]))) / FN;
        open = false;
        break;
      }
      prev = w;
    }
    // if the keel is reached shallower than the sheer trim, the entire section is above the trim ⇒ no hull here
    if (umin >= umax - 1e-6) empty = true;
  }
  // transom clip: keep the largest u-interval that is forward of the raked transom plane. A vertical
  // section meets the raked plane cleanly, so the cut trims either the top or the bottom of the section.
  let ua = umin,
    ub = umax,
    aft = empty,
    keel = trim && !open && !empty;
  if (empty) ua = ub = umax;
  if (trim && !empty && clipTransom) {
    const SN = 200,
      g = (u: number) => {
        const w = W(u);
        return w[0] - xTransom(w[2]);
      };
    let pg = g(umin),
      pu = umin,
      s: number | null = pg >= 0 ? umin : null;
    let best: [number, number] | null = null;
    const add = (a: number, b: number) => {
      if (!best || b - a > best[1] - best[0]) best = [a, b];
    };
    for (let i = 1; i <= SN; i++) {
      const u = umin + ((umax - umin) * i) / SN,
        cg = g(u);
      if (pg < 0 !== cg < 0) {
        const uc = pu + (u - pu) * (pg / (pg - cg)); // forward/aft crossing
        if (cg >= 0) s = uc;
        else {
          if (s !== null) add(s, uc);
          s = null;
        }
      }
      pg = cg;
      pu = u;
    }
    if (s !== null) add(s, umax);
    if (!best) {
      aft = true;
      ua = ub = umax;
      keel = false;
    } else {
      ua = best[0];
      ub = best[1];
      keel = ub >= umax - 1e-6 && !open;
    }
  }
  const pts: Vec3[] = [];
  for (let j = 0; j <= M; j++) pts.push(W(ua + ((ub - ua) * j) / M));
  if (keel) pts[M][1] = 0;
  return { pts, open, aft, keel };
}

export function clippedSection(x: number, M: number): Section {
  return sweptSection(x, M, true);
}

// the transom face outline (starboard, top→bottom): walk down the transom plane and read the hull's
// half-breadth at each depth, bounded above by the sheer trim and below by the centerline (keel).
export function transomEdge(): Vec3[] {
  const out: Vec3[] = [],
    DN = 90;
  for (let i = 0; i <= DN; i++) {
    const d = (DMAX * i) / DN,
      z = -d,
      x = xTransom(z);
    if (x < 0 || x > L) continue;
    if (d < -state.sheer.zf(x)) continue; // above the sheer trim → not yet hull
    const st = stationAt(x),
      fr = frameAt(x);
    if (d > st.tmax) break;
    let u = st.tmax;
    const K = 160; // invert st.d(u)=d
    for (let k = 1; k <= K; k++) {
      const uu = (st.tmax * k) / K,
        dd = st.d(uu);
      if (dd >= d) {
        const d0 = st.d((st.tmax * (k - 1)) / K);
        u = (st.tmax * (k - 1 + (d - d0) / (dd - d0 || 1))) / K;
        break;
      }
    }
    const y = fr.p[1] + st.n(u) * fr.n[1];
    if (y < 0) break; // crossed the centerline → keel reached
    out.push([x, y, z]);
  }
  return out;
}

// trace a contour where component `comp` (1=y, 2=z) equals `val` across a set of sections → runs of pts
export function contour(sections: Section[], val: number, comp: number): Vec3[][] {
  const runs: Vec3[][] = [];
  let run: Vec3[] = [];
  for (const s of sections) {
    if (s.aft) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    } // gap across the transom
    let f: Vec3 | null = null;
    for (let j = 0; j < s.pts.length - 1; j++) {
      const a = s.pts[j],
        b = s.pts[j + 1];
      if ((a[comp] - val) * (b[comp] - val) <= 0 && a[comp] !== b[comp]) {
        const t = (val - a[comp]) / (b[comp] - a[comp]);
        f = [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
        break;
      }
    }
    if (f) run.push(f);
    else {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}
