// ---------- the parametric hull model + the constant-camber sweep ----------

import { clamp, lerp, V, type Vec3 } from "./math";
import {
  knuckleSlopes,
  hermiteEvalLR,
  pchipSlopes,
  hermiteEval,
  naturalCubicSlopes,
} from "./pchip";
import { clampedBSplineSamplerX } from "./bspline";

// ---------- types ----------
// A longitudinal control STATION: it carries both the plan half-breadth y AND the blend weight w (the
// barycentric template mix) at this x. The two used to be separate arrays (sheer cps + weight cps) at nearly
// the same x's; unified here so one station drives both curves. w has length = template count, in the simplex.
export interface SheerCP {
  x: number;
  y: number;
  w: number[];
}
export interface TrimCP {
  x: number;
  z: number;
  k: number; // knuckle ∈ [0,1]: 0 = smooth, 1 = hard corner — same as the template points
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
// {x, w} shape of a blend control point — used by the weight sampler and when migrating old documents that
// stored the blend as its own array. The live model now carries w on SheerCP (the unified station).
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
  ts?: number[]; // the template points' parameters in this station's u-scale (for knuckle-column alignment)
  keelV?: number; // keel crease strength ∈ [0,1]: 0 = flat/round, 1 = hard V (mirrored-keel station only)
}
export interface Section {
  pts: Vec3[];
  open: boolean;
  aft: boolean;
  keel: boolean;
  // column indices (into pts) that sit on a crease line — a template-point knuckle and (when keel) the
  // keel itself. The columns are placed exactly on those lines so a hard edge has somewhere to live; the
  // surface/mesh builders give them a tangent break (knot multiplicity / per-side normals). Empty unless
  // trimmed. The actual sharpness is data-driven: a faded knuckle (low k) on a crease column stays smooth.
  creaseCols: number[];
  creaseK: number[]; // crease strength ∈ [0,1] parallel to creaseCols (blended knuckle k; keel V-ness)
}

// ---------- geometric domain constants ----------
export const L = 1000; // length overall, UNITLESS (x: 0 = transom, L = bow). All coordinates are in these units.
// Forward room past the LOA shown in the plan/profile editors. The boat length stays L, but a tumblehome bow
// closes a little past it (the emergent stem), so the sheer-TRIM line is allowed to carry control points into
// [L, L+XFWD] to shape that overhang; the 2D strips reserve this much extra x so those points are reachable.
export const XFWD = 100;
// station coordinate bounds: n from NMIN (outboard → tumblehome) to NMAX (inboard); d down from the sheer
export const NMIN = -113,
  NMAX = 338,
  DMAX = 338;

// ---------- defaults ----------
const SHEER_DEF: [number, number][] = [
  [0, 205],
  [250, 225],
  [500, 220],
  [750, 160],
  [1000, 0],
]; // 2D plan curve, flat deck z=0 (meets CL fwd)
// sheer trim line in profile (x, z): the real sheer, constrained below the flat deck (z ≤ 0). The strip
// of swept sheet between the deck (z=0) and this line is trimmed off the final shape. Lowest amidships.
const SHEER_TRIM_DEF: [number, number][] = [
  [0, -15],
  [333, -70],
  [667, -65],
  [1000, -10],
];
// transom: a raked plane at the stern, given by two profile points (x, z) — top (near the sheer) and
// bottom (near the keel). The hull keeps the forward side (x ≥ xTransom(z)); the cut is a solid face.
const TRANSOM_DEF: [number, number][] = [
  [38, -14],
  [95, -180],
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
    [23, 80, 0],
    [65, 160, 1],
    [140, 220, 0],
    [245, 250, 0],
  ], // fuller (transom), hard chine at the bilge
  [
    [0, 0, 0],
    [38, 108, 0],
    [100, 210, 0],
    [180, 280, 0],
    [255, 305, 0],
  ], // deeper / finer (bow), round bilge
];
// the default weight curve: full weight on template 0 at the transom, handing off linearly to the last
// template at the bow — i.e. exactly the old linear aft→fore tween (a straight edge of the simplex).
function defaultWeights(k: number): WeightCP[] {
  const e = (j: number) =>
    Array.from({ length: k }, (_, i) => (i === j ? 1 : 0));
  return [
    { x: 0, w: e(0) },
    { x: L, w: e(k - 1) },
  ];
}

// ---------- mutable model + view state ----------
export type Tool = "select" | "add";
// the 3D view's mutually-exclusive display mode: "render" = shaded trimmed hull; "body" / "buttocks" /
// "waterline" = the lines plan (SVG overlay) with that non-chine family; "zebra" = zebra-striped trimmed hull
// (fairness check); "sheet" = the untrimmed shaded sweep (one side, no trims/mirror).
// "body" / "buttocks" / "waterline" are the three lines-plan modes: same drawing, differing only in which
// non-chine line family is drawn (stations / constant-y cuts / constant-z cuts). render / zebra / sheet are
// the shaded GL modes.
export type View3DMode =
  "render" | "body" | "buttocks" | "waterline" | "zebra" | "sheet";
export const LINES_MODES: View3DMode[] = ["body", "buttocks", "waterline"];
// curve fairing: "pchip" = C¹ monotone, shape-preserving (the default, guarantees the invariants);
// "c2" = C² natural cubic (curvature-continuous, interpolating — but can overshoot); "bspline" = an
// approximating clamped cubic B-spline (C² and variation-diminishing, so no overshoot — the control points
// become a polygon the section is pulled inside of). Both c2 and bspline are experimental and drop the
// per-point knuckles (no chines); the weight curve only honors c2 (in logit space) and ignores bspline.
export type Fairing = "pchip" | "c2" | "bspline";

// which kind of control point is currently selected, so the renderer can highlight it. A "template"
// selection also carries which template (state.selected.ti); a "weight" selection is a weight CP.
export type ActiveTarget = "plan" | "trim" | "transom" | "template" | "weight";

export interface State {
  sheer: Sheer;
  templates: StationCP[][]; // K ≥ 1 section templates, index-aligned (all share the section count)
  keelK: number[]; // per-template keel (centerline) knuckle ∈ [0,1]: 0 = C¹-smooth keel across the
  // centerline, 1 = a hard V. Blended along the hull like the point knuckles. Index-aligned with templates.
  weightFn: (x: number) => number[]; // evaluated weight curve x → simplex; rebuilt by prepare() from sheer.cp
  x0: number;
  waterline: number; // depth (≥0) of the design waterline below the sheer origin (deck datum at x=0, z=0)
  deckRake: number; // deck rake angle (rad, +ve = bow up): a rigid rotation of the whole hull about the
  // transverse (y) axis through the sheer origin. Everything is built deck-flat (z=0); the boat floats at this rake.
  rot: { yaw: number; pitch: number };
  zoom: number; // 3D view zoom multiplier on the fixed framing (1 = default; scroll wheel adjusts)
  view3dMode: View3DMode; // mutually-exclusive 3D display mode (render / body / buttocks / waterline / zebra / sheet)
  fairing: Fairing; // which curve fairing to use (session toggle; not part of the saved model)
  tool: Tool;
  selected: { tgt: ActiveTarget; idx: number; ti?: number } | null;
}

export const state: State = {
  sheer: null as unknown as Sheer,
  templates: [],
  keelK: [],
  weightFn: () => [1],
  x0: 500,
  waterline: 150,
  deckRake: 0,
  rot: { yaw: -0.62, pitch: 0.42 },
  zoom: 1,
  view3dMode: "render", // shaded trimmed hull by default
  fairing: "pchip", // C¹ shape-preserving (keeps the chines); "c2"/"bspline" are code-toggle experiments
  tool: "select", // "select" = click a point to select (then drag/delete/knuckle); "add" = click to add
  selected: null, // the persistently selected control point (highlighted in the editors)
};

export function resetModel(): void {
  state.templates = TEMPLATE_DEFS.map((t) =>
    t.map((c) => ({ n: c[0], d: c[1], k: c[2] })),
  );
  state.keelK = state.templates.map(() => 0); // keels default to C¹-smooth across the centerline
  // each station carries its blend w, sampled here from the default linear aft→fore handoff
  const wf0 = buildWeightSampler(defaultWeights(state.templates.length));
  state.sheer = {
    cp: SHEER_DEF.map((c) => ({ x: c[0], y: c[1], w: wf0(c[0]) })),
    trim: SHEER_TRIM_DEF.map((c) => ({ x: c[0], z: c[1], k: 0 })),
    transom: TRANSOM_DEF.map((c) => ({ x: c[0], z: c[1] })),
    yf: () => 0,
    zf: () => 0,
  };
  state.x0 = 500;
  state.waterline = 150;
  state.deckRake = 0;
}

// ---------- deck rake (world frame) ----------
// The hull is built deck-flat (deck = z = 0). The deck rake is a rigid rotation of the whole hull by
// state.deckRake about the transverse (y) axis through the sheer origin (x=0, z=0). worldZ is the true
// vertical height of a deck-frame point once floated at that rake; the waterline is the horizontal plane
// at worldZ = −waterline, so immersion(x,z) > 0 means the point is submerged.
export const worldZ = (x: number, z: number): number =>
  x * Math.sin(state.deckRake) + z * Math.cos(state.deckRake);
export const immersion = (x: number, z: number): number =>
  -state.waterline - worldZ(x, z);

export function prepare(): void {
  const sheer = state.sheer;
  // the plan half-breadth y(x): a clamped cubic B-spline over the plan control points — C² and
  // variation-diminishing, so it can't overshoot the control polygon (the plan points are handles, the curve
  // interpolating only the first and last). Evaluated directly as y(x), so the swept frame's heading is smooth.
  // Past the forward end (x > last cp) it is EXTRAPOLATED linearly (continuing the end slope) so a tumblehome
  // bow can let the sheer guide cross the centerline (y < 0) and the surface taper to a closed stem. Aft is
  // left clamped.
  const yfRaw = clampedBSplineSamplerX(sheer.cp.map((p) => [p.x, p.y]));
  const xEnd = sheer.cp[sheer.cp.length - 1].x,
    slopeEnd = yfRaw(xEnd) - yfRaw(xEnd - 1);
  sheer.yf = (x: number) =>
    x <= xEnd ? yfRaw(x) : yfRaw(xEnd) + (x - xEnd) * slopeEnd;
  // profile sheer-trim z(x) ≤ 0: the same knuckle-aware fairing the templates use (interpolating, with
  // per-point knuckles), parameterized by x — so a hard sheer-line corner is possible, like a chine.
  sheer.zf = fairEval(
    sheer.trim.map((p) => p.x),
    sheer.trim.map((p) => p.z),
    sheer.trim.map((p) => p.k),
  );
  state.weightFn = buildWeightSampler(state.sheer.cp); // the blend path, read from the unified stations
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

export function buildWeightSampler(
  weights: WeightCP[],
): (x: number) => number[] {
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

// fair a station-curve component (n or d) through its points, parameterized by the chord position t. The
// C¹ knuckle-aware monotone Hermite by default; in "c2" mode a curvature-continuous natural cubic; in
// "bspline" mode an approximating clamped cubic B-spline of the component over t (C², no overshoot — the
// points are a control polygon, not interpolated except at the ends). The c2 and bspline modes ignore the
// knuckles; they are for comparing fairness, not for guaranteed validity.
export function fairEval(
  ts: number[],
  fs: number[],
  ks: number[],
): (u: number) => number {
  if (state.fairing === "bspline")
    return clampedBSplineSamplerX(ts.map((t, i) => [t, fs[i]]));
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
  // The finite-difference span is floored at 0 but NOT capped at L: past the LOA the sheer is extrapolated
  // linearly (see prepare()), and the bow extension needs a real tangent there — capping at L would collapse
  // xa==xb==L into a zero (degenerate) tangent.
  const e = 2,
    xa = Math.max(x - e, 0),
    xb = x + e;
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

// the blended keel (centerline) knuckle at station x: Σⱼ w[j]·keelK[j] — the per-template keel knuckle
// faired along the hull just like the point knuckles, so a hard-V keel can fade to a smooth one.
export function keelKAt(x: number): number {
  const w = weightsAt(x),
    kk = state.keelK;
  let k = 0;
  for (let j = 0; j < w.length; j++) k += w[j] * (kk[j] ?? 0);
  return k;
}

// fraction of the half-section parameter (up from the keel toward the sheer) over which the keel is rounded
// — a small fillet near the centerline crossing, so it slides smoothly with the keel and a broad round of a
// straight panel never builds up into a migrating bump. Small enough to leave a flat/panel bottom above it.
const KEEL_FLAT_ZONE = 0.28;
// Blended-knuckle strength at/above which the grid columns are FULLY chine-anchored (so the chine line has no
// drift); below it the alignment relaxes toward the even grid as the chine fades to nothing. See sweptSection.
const KNUCKLE_PIN = 0.35;
// A flat/round keel is only FAIR where the section meets the centerline near-perpendicular in plan. Where
// the sheer flares, the station planes fan (n̂ ⟂ the sheer tangent, not the centerline) and a flat keel
// rides up into a centerline ridge in true transverse sections (the "pucker") — only a V crosses such an
// oblique meeting cleanly. So a flat keel is eased toward its natural V as the plan FLARE (the sheer
// tangent's heading off the x-axis) rises: honored as authored below KEEL_FLAT_FLARE, fully a V above
// KEEL_V_FLARE, smoothstep between. keelK is a floor — keelK = 1 is always a V regardless of flare.
const KEEL_FLAT_FLARE = 12 * (Math.PI / 180),
  KEEL_V_FLARE = 45 * (Math.PI / 180);

// Build the section as a curve continuous across the boat centerline, the keel knuckle kc controlling the
// keel: 0 = flat (C¹-smooth round bottom), 1 = a hard V. An earlier version rebuilt this from a discrete
// knot set — the authored points inboard of the y=0 crossing, plus a keel knot, mirrored. But which points
// fell inboard CHANGED one at a time as n_cl slid up the stem, and each such change stepped the keel shape:
// the visible deadrise creases. This version never rebuilds from moving knots. The starboard half IS the
// authored half-section curve itself (chines preserved, and it varies smoothly with x), reflected about the
// centerline to make the port half; the only keel control is a smooth flattening of the depth near the
// crossing. Both the reflection point (n_cl, d*) and the flattening vary smoothly in x, so the swept keel
// is smooth. The keel knuckle kc sets the character (0 = flat/round, 1 = hard V), eased toward a V where
// the plan flare would make a flat keel unfair (see KEEL_FLAT_FLARE/KEEL_V_FLARE). Returns null for an
// open section (the curve never reaches the centerline) or a degenerate frame.
function mirrorKeelStation(
  x: number,
  ns: number[],
  ds: number[],
  ks: number[],
  kc: number,
): Station | null {
  const fr = frameAt(x),
    ny = fr.n[1],
    py = fr.p[1];
  if (Math.abs(ny) < 1e-6) return null; // station plane parallel to the centerline — no clean crossing
  const ncl = -py / ny; // inboard offset where world y = 0
  const ts = chordParam(ns, ds),
    nf = fairEval(ts, ns, ks),
    df = fairEval(ts, ds, ks),
    tmax = ts[ts.length - 1];
  // The STARBOARD span between the section's two world-centerline crossings: uA (the up-crossing, where the
  // section first reaches y ≥ 0) and ustar (the down-crossing — the keel). For a normal hull the deck (u=0)
  // is already to starboard, so uA = 0 and this is the whole half-section. For a tumblehome bow past the LOA
  // the sheer guide is to PORT (py < 0), so uA > 0 and we drop the deck→centerline part — which lets this same
  // keel-symmetric construction close the bow, no special lens case.
  let pu = 0,
    py0 = py + nf(0) * ny,
    uA = py0 >= 0 ? 0 : -1,
    ustar = -1;
  const FN = 240;
  for (let i = 1; i <= FN; i++) {
    const u = (tmax * i) / FN,
      y = py + nf(u) * ny;
    if (uA < 0) {
      if (py0 < 0 && y >= 0) uA = pu + (u - pu) * (-py0 / (y - py0)); // up-crossing into starboard
    } else if (py0 >= 0 && y < 0) {
      ustar = pu + (u - pu) * (py0 / (py0 - y)); // down-crossing: the keel
      break;
    }
    pu = u;
    py0 = y;
  }
  if (uA < 0 || ustar <= uA + 1e-6) return null; // open: no starboard span reaching the centerline
  const half = ustar - uA, // u-length of the kept starboard half
    dstar = df(ustar);
  // Round the keel over a SMALL fillet just inboard of the centerline crossing — a zone whose width is a
  // fixed fraction (KEEL_FLAT_ZONE) of the starboard span, so it slides smoothly WITH the keel crossing. A
  // constant fillet running along the keel approach stays longitudinally fair even where that approach is a
  // straight chine/deadrise panel. (An earlier version made the zone broad and anchored z0 to an inboard
  // chine; the zone then stepped in size as the crossing slid past a chine — a longitudinal blister. And a
  // broad round of a straight panel is itself a big bump that migrates.) The fillet is small, so it rounds
  // only near the keel and leaves a flat/panel bottom above it alone (no inflection / reversal).
  const z0 = ustar - half * KEEL_FLAT_ZONE;
  // plan flare = the sheer tangent's heading off the x-axis (n̂ = (Ty,−Tx,0) ⇒ flare = atan2(|Ty|,|Tx|)).
  // Ease a flat keel toward its natural V as flare rises, so an oblique centerline meeting becomes a fair V
  // instead of a ridge (the narrow-flared-transom pucker). keelK is the floor: flatten f = (1−kc)·(1−flareV).
  const flare = Math.atan2(Math.abs(fr.n[0]), Math.abs(fr.n[1]));
  let flareV = clamp(
    (flare - KEEL_FLAT_FLARE) / (KEEL_V_FLARE - KEEL_FLAT_FLARE),
    0,
    1,
  );
  flareV = flareV * flareV * (3 - 2 * flareV); // smoothstep
  const f = (1 - clamp(kc, 0, 1)) * (1 - flareV); // flatten amount: 1 = round keel, 0 = natural V
  // reflected symmetric section over U ∈ [0, 2·ustar], keel at the midpoint U = ustar. The keel character is
  // set by the depth's SLOPE at the crossing: the reflection turns a zero slope into a smooth keel and a
  // nonzero slope into a V (corner). Over the zone [z0, ustar] the depth is blended (by f, via a C² weight)
  // toward a target depth profile; the smootherstep weight has zero value AND slope at z0, so the blend joins
  // the section C² there with no shoulder, and uses only df VALUES (continuous across chines) so it stays
  // robust. The target is a fair PARABOLA with its vertex (zero slope) at the keel and passing through the
  // section at z0 — constant curvature, spread evenly, so f=1 gives a gently ROUNDED keel rather than a flat
  // strip with sharp shoulders (the old failure). f=0 leaves the natural slope ⇒ the reflected V.
  const span = ustar - z0,
    d0z = df(z0),
    c = (dstar - d0z) / (span * span); // parabola curvature: vertex at the keel, through (z0, d0z)
  const warp = (u: number) => {
    const d0 = df(u);
    if (f <= 0 || u <= z0) return d0;
    const t = Math.min((u - z0) / span, 1),
      g = t * t * t * (t * (t * 6 - 15) + 10), // smootherstep (C²) blend weight
      v = ustar - u,
      target = dstar - c * v * v; // fair parabolic round to a flat keel tangent
    return d0 + f * g * (target - d0);
  };
  // U ∈ [0, 2·half]: the starboard half [0,half] maps to the original span [uA,ustar], the keel sits at the
  // midpoint U = half, and the port half reflects the starboard one about the centerline offset n_cl.
  const umap = (U: number): number => uA + (U <= half ? U : 2 * half - U);
  return {
    tmax: 2 * half,
    n: (U: number) => (U <= half ? nf(umap(U)) : 2 * ncl - nf(umap(U))),
    d: (U: number) => warp(umap(U)),
    ts: ts.map((t) => t - uA), // template points shifted into the [0,half] starboard span (uA=0 ⇒ unchanged)
    keelV: 1 - f, // keel crease strength: 0 = flat/round (smooth), 1 = hard V (for shading the keel crease)
  };
}

// the blended station section at x, as continuous n(u)/d(u) over u in [0,tmax]. At each station the
// templates are mixed by the weight curve w(x) — section(x)[i] = Σⱼ w[j]·templates[j][i] — componentwise
// in (n, d, k). The knuckle k is blended along the hull just like n and d, so a chine can fade from hard
// to soft as the weight curve hands off between a creased template and a smooth one. With mirrorKeel set
// (the trimmed hull), the curve is reflected about the centerline so the keel knuckle applies — see
// mirrorKeelStation; the parameter then runs sheer→keel→port-sheer and the keel sits at the midpoint.
export function stationAt(x: number, mirrorKeel = false): Station {
  // Past the LOA (the bow extension for a tumblehome bow) freeze the section SHAPE at x = L — the templates and
  // weight curve are only defined on [0, L] — but keep building it through mirrorKeelStation, which now handles
  // the sheer guide having crossed the centerline (it reflects the starboard span [uA, ustar]). So the bow
  // closes through the same keel-symmetric construction as the rest of the hull, swept along the extrapolated
  // sheer, with no special case.
  const xw = Math.min(x, L),
    w = weightsAt(xw),
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
  if (mirrorKeel) {
    // null ⇒ the section never reaches the centerline (an open bow station, or past the bow closure where the
    // swept lens has vanished). For the trimmed hull that means NO hull here — return a degenerate (tmax 0)
    // station so sweptSection reports `aft`. (Falling back to the raw, un-mirrored half-section instead would
    // resurrect the full deep section past the closure — the "wings".)
    return (
      mirrorKeelStation(x, ns, ds, ks, keelKAt(xw)) ?? {
        tmax: 0,
        n: () => 0,
        d: () => 0,
        ts: [0],
      }
    );
  }
  const ts = chordParam(ns, ds);
  return {
    tmax: ts[m - 1],
    n: fairEval(ts, ns, ks),
    d: fairEval(ts, ds, ks),
    ts,
  };
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
export function sweptSection(
  x: number,
  M: number,
  trim: boolean,
  clipTransom = true,
): Section {
  const fr = frameAt(x),
    st = stationAt(x, trim); // trimmed hull: the keel-knuckle symmetric section; sheet: the raw half
  const W = (u: number): Vec3 => {
    const nn = st.n(u),
      dd = st.d(u);
    return [
      fr.p[0] + nn * fr.n[0] + dd * fr.d[0],
      fr.p[1] + nn * fr.n[1] + dd * fr.d[1],
      fr.p[2] + nn * fr.n[2] + dd * fr.d[2],
    ];
  };
  // Bow extension: where the sheer guide has crossed the centerline (yf < 0, forward of the LOA via the
  // extrapolation in prepare) the station straddles the centerline. mirrorKeelStation builds the same keel-
  // symmetric, keel-rounded section it does everywhere (reflecting the starboard span [uA, ustar]), and the
  // normal trim + centerline + transom clipping below closes the bow — no special case.
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
          // clamp ≥ 0: at a bow lens the very top of the section already sits below the trim (da ≥ dtrim), so
          // the interpolation would go negative — keep the whole section from its top instead of crossing the
          // centerline to port. (For a normal section the top is the deck at d=0 < dtrim, so this is a no-op.)
          umin = Math.max(
            0,
            (st.tmax * (i - 1 + (dtrim - da) / (st.d(u) - da || 1))) / FN,
          );
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
  // column parameters across [ua, ub]. For the trimmed hull, PIN a column on each potential-knuckle template
  // point (one that is a knuckle in some template, so a crease may run through it). The anchor is at a fixed
  // column index (even fills between anchors), so the chine line is one consistent grid column the surface /
  // mesh can crease along. The anchor's POSITION blends from the even-grid spot toward the knuckle param by
  // the local blended knuckle strength: where the chine is strong it sits on the chine; where it fades (the
  // fine bow, or it leaves the kept span) the columns relax to even — matching the chineless hull, so the
  // sweep stays fair with no resampling step. Sharpness is data-driven; the crease column is just a home.
  const creaseCols: number[] = [],
    creaseK: number[] = [];
  let colU: number[];
  const evenU = (j: number) => ua + ((ub - ua) * j) / M;
  const pots =
    trim && st.ts
      ? st.ts
          .map((_, i) => i)
          .filter((i) => state.templates.some((t) => (t[i]?.k ?? 0) > 0))
      : [];
  if (pots.length) {
    const w = weightsAt(x),
      margin = (ub - ua) * 0.04;
    const kn = pots
      .map((i) => ({
        u: clamp(st.ts![i], ua + margin, ub - margin), // clamp so the anchor count is constant along the hull
        k: clamp(
          state.templates.reduce((s, t, j) => s + w[j] * (t[i]?.k ?? 0), 0),
          0,
          1,
        ),
      }))
      .sort((a, b) => a.u - b.u);
    // The crease column itself always SITS ON the chine (the template point's swept locus), so the drawn /
    // exported chine line tracks the real chine regardless of how hard the knuckle is. The FILL columns
    // between anchors still relax from knuckle-aligned toward the even grid by the blended knuckle strength
    // (wK) — where the chine softens the interior spacing eases back to even, which keeps the keel deadrise
    // fair; only the crease line is pinned. (Earlier the crease column too was lerped toward even, dragging
    // the drawn chine away from its true line where the knuckle faded.)
    // Blend the WHOLE column distribution between the even grid and the chine-anchored grid by wK (so there is
    // never an isolated column — that breaks the surface). But wK SATURATES: once the blended knuckle is past
    // ~KNUCKLE_PIN the columns are fully chine-anchored, so the drawn/exported chine sits on its true line with
    // no drift; only as the chine genuinely fades toward nothing does the grid relax to even (which keeps the
    // keel fair where the chine crowds it near a fine bow). A plain-linear wK drifted the chine even at
    // moderate strength; full pinning roughened the keel where the chine faded — this does neither.
    let wK = clamp(Math.max(...kn.map((a) => a.k)) / KNUCKLE_PIN, 0, 1);
    wK = wK * wK * (3 - 2 * wK); // smoothstep
    const anchors = [ua, ...kn.map((a) => a.u), ub],
      segs = anchors.length - 1;
    colU = [ua];
    let col = 0;
    for (let s = 0; s < segs; s++) {
      const cnt = Math.floor(M / segs) + (s < M % segs ? 1 : 0); // deterministic ⇒ stable column indices
      for (let t = 1; t <= cnt; t++) {
        const aligned = anchors[s] + ((anchors[s + 1] - anchors[s]) * t) / cnt,
          e = evenU(col + t);
        colU.push(e + wK * (aligned - e)); // even grid → chine-anchored grid, by the (saturating) wK
      }
      col += cnt;
      if (s < segs - 1) {
        creaseCols.push(col); // a consistent crease column (the export puts a knot here)
        creaseK.push(kn[s].k); // its blended knuckle strength (kn is sorted to match the anchor order)
      }
    }
  } else {
    colU = Array.from({ length: M + 1 }, (_, j) => evenU(j));
  }
  const pts: Vec3[] = colU.map(W);
  if (keel) {
    pts[M][1] = 0;
    creaseCols.push(M); // the keel is a crease line too (a V keel; flat keels stay smooth, data-driven)
    creaseK.push(clamp(st.keelV ?? 0, 0, 1));
  }
  return { pts, open, aft, keel, creaseCols, creaseK };
}

export function clippedSection(x: number, M: number): Section {
  return sweptSection(x, M, true);
}

// The forward limit of the hull: the largest x where a trimmed section still exists, but NEVER past the
// plan's last control point — the hull is not extrapolated beyond what the user drew. The bow closes where
// the sections vanish (the forefoot rises above the sheer trim, or a tumblehome lens shrinks to nothing) if
// that happens at or before the last cp; otherwise the hull ends at the last cp (a blunt bow, the cue to
// extend the sheer plan further). Near the bow the forefoot rises above the trim, so sections go empty.
export function forwardLimit(): number {
  const exists = (x: number): boolean => !sweptSection(x, 4, true, false).aft;
  const xEnd = state.sheer.cp[state.sheer.cp.length - 1].x; // the plan's last control point: the hard forward bound
  if (exists(xEnd)) return xEnd; // still a section at the last cp — the hull ends there (blunt, or just closing)
  let lo = xEnd * 0.5,
    hi = xEnd;
  if (!exists(lo)) return xEnd; // section already gone amidships (degenerate model) — don't clamp shorter
  for (let k = 0; k < 24; k++) {
    const m = (lo + hi) / 2;
    if (exists(m)) lo = m;
    else hi = m;
  }
  return lo; // the last x with a (vanishingly small) section ⇒ the bow closes here
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
    const st = stationAt(x, true), // match the trimmed hull's keel-knuckle section
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
export function contour(
  sections: Section[],
  val: number,
  comp: number,
): Vec3[][] {
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
