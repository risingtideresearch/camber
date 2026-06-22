// ---------- the parametric hull model + the constant-camber sweep ----------

import { clamp, lerp, V, type Vec3 } from "./math.js";
import { hobbySamplerX } from "./hobby.js";
import {
  knuckleSlopes,
  hermiteEvalLR,
  pchipSlopes,
  hermiteEval,
  naturalCubicSlopes,
} from "./pchip.js";

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
  k: number; // knuckle ∈ [0,1]: 0 = smooth, 1 = hard corner; blends. (point 0, the pinned sheer, is left smooth)
}
// a control point of the longitudinal weight curve: at station x, the barycentric mix `w` of the
// templates (w[j] ≥ 0, Σ w[j] = 1 — a point in the (K−1)-simplex). The curve is faired between these.
export interface WeightCP {
  x: number;
  w: number[]; // length = template count K; in the simplex
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
// [n, d, k] — k is the knuckle at that point (point 0, the pinned sheer, is left smooth; the last point's
// knuckle bends the final segment, so a hard chine can run into the keel). The bilge point
// (index 2) is a hard chine aft (k=1) that fades to a round bilge forward (k=0): a hard-chine planing
// stern blending into a soft bow along the length of the one hull.
// the default family of section templates (the old aft → fore pair). Each is one template; the weight
// curve below blends them along the hull. More templates can be added in the editor.
const TEMPLATE_DEFS: [number, number, number][][] = [
  [
    [0, 0, 0],
    [90, 320, 0],
    [260, 640, 1],
    [560, 880, 0],
    [980, 1000, 0],
  ], // fuller (transom), hard chine at the bilge
  [
    [0, 0, 0],
    [150, 430, 0],
    [400, 840, 0],
    [720, 1120, 0],
    [1020, 1220, 0],
  ], // deeper / finer (bow), round bilge
];
// the default weight curve: full weight on template 0 at the transom, handing off linearly to the last
// template at the bow — i.e. exactly the old linear aft→fore tween (a straight edge of the simplex).
function defaultWeights(k: number): WeightCP[] {
  const e = (j: number) => Array.from({ length: k }, (_, i) => (i === j ? 1 : 0));
  return [
    { x: 0, w: e(0) },
    { x: L, w: e(k - 1) },
  ];
}

// ---------- mutable model + view state ----------
export type Tool = "select" | "add";
export type View3D = "trimmed" | "sheet";
// curve fairing: "pchip" = C¹ monotone, shape-preserving (the default, guarantees the invariants);
// "c2" = C² natural cubic (curvature-continuous; the weight curve runs it in logit space to stay in the
// simplex, the station curves run it directly — experimental, drops the knuckles and the no-overshoot guard).
export type Fairing = "pchip" | "c2";

// which kind of control point is currently selected, so the renderer can highlight it. A "template"
// selection also carries which template (state.selected.ti); a "weight" selection is a weight CP.
export type ActiveTarget = "plan" | "trim" | "transom" | "template" | "weight";

export interface State {
  sheer: Sheer;
  templates: StationCP[][]; // K ≥ 1 section templates, index-aligned (all share the section count)
  weights: WeightCP[]; // the longitudinal blend path through the simplex; ≥ 2 control points
  weightFn: (x: number) => number[]; // evaluated weight curve x → simplex; rebuilt by prepare()
  x0: number;
  waterline: number; // depth (≥0) of the design waterline below the sheer origin (deck datum at x=0, z=0)
  deckRake: number; // deck rake angle (rad, +ve = bow up): a rigid rotation of the whole hull about the
  // transverse (y) axis through the sheer origin. Everything is built deck-flat (z=0); the boat floats at this rake.
  rot: { yaw: number; pitch: number };
  view3d: View3D;
  zebra: boolean;
  fairing: Fairing; // which curve fairing to use (session toggle; not part of the saved model)
  tool: Tool;
  selected: { tgt: ActiveTarget; idx: number; ti?: number } | null;
}

export const state: State = {
  sheer: null as unknown as Sheer,
  templates: [],
  weights: [],
  weightFn: () => [1],
  x0: 2000,
  waterline: 600,
  deckRake: 0,
  rot: { yaw: -0.62, pitch: 0.42 },
  view3d: "trimmed", // "trimmed" = clipped + mirrored hull; "sheet" = untrimmed one side
  zebra: false, // zebra-stripe fairness check on the 3D surface
  fairing: "pchip", // C¹ shape-preserving by default; "c2" switches to the natural-cubic fairing
  tool: "select", // "select" = click a point to select (then drag/delete/knuckle); "add" = click to add
  selected: null, // the persistently selected control point (highlighted in the editors)
};

export function resetModel(): void {
  state.sheer = {
    cp: SHEER_DEF.map((c) => ({ x: c[0], y: c[1] })),
    trim: SHEER_TRIM_DEF.map((c) => ({ x: c[0], z: c[1] })),
    transom: TRANSOM_DEF.map((c) => ({ x: c[0], z: c[1] })),
    yf: () => 0,
    zf: () => 0,
  };
  state.templates = TEMPLATE_DEFS.map((t) => t.map((c) => ({ n: c[0], d: c[1], k: c[2] })));
  state.weights = defaultWeights(state.templates.length);
  state.x0 = 2000;
  state.waterline = 600;
  state.deckRake = 0;
}

// ---------- deck rake (world frame) ----------
// The hull is built deck-flat (deck = z = 0). The deck rake is a rigid rotation of the whole hull by
// state.deckRake about the transverse (y) axis through the sheer origin (x=0, z=0). worldZ is the true
// vertical height of a deck-frame point once floated at that rake; the waterline is the horizontal plane
// at worldZ = −waterline, so immersion(x,z) > 0 means the point is submerged.
export const worldZ = (x: number, z: number): number =>
  x * Math.sin(state.deckRake) + z * Math.cos(state.deckRake);
export const immersion = (x: number, z: number): number => -state.waterline - worldZ(x, z);

export function prepare(): void {
  const sheer = state.sheer;
  sheer.yf = hobbySamplerX(sheer.cp.map((p) => [p.x, p.y])); // Hobby curve through the plan control points
  sheer.zf = hobbySamplerX(sheer.trim.map((p) => [p.x, p.z])); // profile sheer-trim curve, z(x) ≤ 0
  state.weightFn = buildWeightSampler(state.weights); // the longitudinal blend path through the simplex
}

// ---------- the weight curve: a shape-preserving interpolation through the simplex ----------
// The longitudinal blend weights w(x) ∈ Δ^{K−1}. Control points carry (x, w). Each barycentric component
// wⱼ(x) is interpolated across the control x's with the same monotone PCHIP fairing the section templates
// use: it passes through the authored values and, being shape-preserving, never overshoots, so each
// component stays in [0,1]. Renormalizing the vector to Σ = 1 lands it back on the simplex. The curve thus
// hits every control point exactly (at a control station the components already sum to 1, so the
// renormalization is the identity there) yet stays valid and C¹ — and tracks the control points tightly,
// unlike an approximating B-spline that would smooth past the interior ones.

// project a vector onto the simplex the cheap way: clamp negatives (float noise) away, renormalize to Σ=1
function normSimplex(w: number[]): number[] {
  let s = 0;
  const c = w.map((v) => {
    const x = v > 0 ? v : 0;
    s += x;
    return x;
  });
  return s > 0 ? c.map((v) => v / s) : c.map(() => 1 / c.length);
}

export function buildWeightSampler(weights: WeightCP[]): (x: number) => number[] {
  const cps = weights.length;
  if (cps <= 1) {
    const w = cps ? normSimplex(weights[0].w) : [1];
    return () => w.slice();
  }
  const K = weights[0].w.length,
    xs = weights.map((c) => c.x),
    xLo = xs[0],
    xHi = xs[cps - 1];
  if (state.fairing === "c2") {
    // C² path: interpolate the softmax pre-image (log-weights) with a natural cubic — overshoot there is
    // harmless — then softmax back, so the curve is curvature-continuous and always in the (open) simplex.
    // A pure-template control point (a 0 weight) is clamped to ε, so corners sit a hair inside the simplex.
    const eps = 1e-4,
      logs: { ys: number[]; m: number[] }[] = [];
    for (let j = 0; j < K; j++) {
      const ys = weights.map((c) => Math.log(Math.max(c.w[j], eps)));
      logs.push({ ys, m: naturalCubicSlopes(xs, ys) });
    }
    return (x: number) => {
      const xc = clamp(x, xLo, xHi),
        u = logs.map((c) => hermiteEval(xs, c.ys, c.m, xc)),
        mx = Math.max(...u);
      let s = 0;
      const e = u.map((v) => {
        const ev = Math.exp(v - mx);
        s += ev;
        return ev;
      });
      return e.map((v) => v / s); // softmax → open simplex
    };
  }
  // C¹ default: per-component shape-preserving (PCHIP) interpolation, renormalized onto the simplex
  const comps: { ys: number[]; m: number[] }[] = [];
  for (let j = 0; j < K; j++) {
    const ys = weights.map((c) => c.w[j]);
    comps.push({ ys, m: pchipSlopes(xs, ys) });
  }
  return (x: number) => {
    const xc = clamp(x, xLo, xHi);
    return normSimplex(comps.map((c) => hermiteEval(xs, c.ys, c.m, xc)));
  };
}

// fair a station-curve component (n or d) through its points: the C¹ knuckle-aware monotone Hermite by
// default, or — in "c2" mode — a curvature-continuous natural cubic (knuckles and the no-overshoot
// monotonicity guard do not apply in that mode; it is for comparing fairness, not for guaranteed validity).
export function fairEval(ts: number[], fs: number[], ks: number[]): (u: number) => number {
  if (state.fairing === "c2") {
    const m = naturalCubicSlopes(ts, fs),
      t0 = ts[0],
      t1 = ts[ts.length - 1];
    return (u: number) => hermiteEval(ts, fs, m, clamp(u, t0, t1));
  }
  return knuckleEval(ts, fs, ks);
}

// the blend weights at station x, a point in the (K−1)-simplex
export function weightsAt(x: number): number[] {
  return state.weightFn(x);
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

// knuckle-aware monotone-Hermite evaluator: one continuous Hermite chain with per-point left/right
// tangents blended toward the secants by k. k=0 is plain (smooth) PCHIP; an isolated k=1 is a knuckle; two
// adjacent k=1 points bound a perfectly straight segment. Replaces the old run-splitting corner model.
export function knuckleEval(
  ts: number[],
  fs: number[],
  ks: number[],
): (u: number) => number {
  const { L: lo, R: hi } = knuckleSlopes(ts, fs, ks),
    t0 = ts[0],
    t1 = ts[ts.length - 1];
  return (u: number) => hermiteEvalLR(ts, fs, lo, hi, clamp(u, t0, t1));
}

// the blended station section at x, as continuous n(u)/d(u) over u in [0,tmax]. At each station the
// templates are mixed by the weight curve w(x) — section(x)[i] = Σⱼ w[j]·templates[j][i] — componentwise
// in (n, d, k). The knuckle k is blended along the hull just like n and d, so a chine can fade from hard
// to soft as the weight curve hands off between a creased template and a smooth one.
export function stationAt(x: number): Station {
  const w = weightsAt(x),
    tpl = state.templates,
    K = tpl.length,
    m = tpl[0].length,
    ns: number[] = [],
    ds: number[] = [],
    ks: number[] = [];
  for (let i = 0; i < m; i++) {
    let n = 0,
      d = 0,
      k = 0;
    for (let j = 0; j < K; j++) {
      const p = tpl[j][i];
      n += w[j] * p.n;
      d += w[j] * p.d;
      k += w[j] * p.k;
    }
    ns.push(n);
    ds.push(d);
    ks.push(k);
  }
  const ts = chordParam(ns, ds);
  return { tmax: ts[m - 1], n: fairEval(ts, ns, ks), d: fairEval(ts, ds, ks) };
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
