// ---------- the parametric hull model + the constant-camber sweep ----------
//
// The hull is a sheet swept along the sheer plan, then trimmed. Reading the pieces in the order they
// compose:
//
//   SHEER PLAN — the outline seen from above, a clamped cubic B-spline. Its own parameter u ∈ [0,1] is the
//   hull's longitudinal coordinate: everything else is positioned in u, not in x, so the sweep never has to
//   invert the plan to find out where it is. (The sheer trim and the transom are the exceptions — they are
//   authored in profile, against x — so they are read through `plan.uAtX`.)
//
//   STATIONS — authored sections, each at a definite u. Point i of every station is one longitudinal curve
//   (the LOFT), which is why every station carries the same number of points: the section at an arbitrary u
//   is those curves read at u, and a section curve drawn through the results.
//
//   THE FRAME — at u the plan gives a point and a heading. The station plane is vertical and normal to that
//   heading, so the planes fan out as the plan turns. A station point's `n` is its offset along the plane's
//   inboard normal and `z` is simply world z: the deck is flat at z = 0 and the hull hangs below it.
//
//   TRIMMING — the swept sheet is cut by the sheer trim (above it is not hull), the centerline (y = 0, where
//   the two halves meet at the keel) and the transom plane. That happens in `mesh.ts`.
//
// Coordinates are ABSOLUTE, in the model's `unit`. There is no unitless scale: a 5 m hull in mm runs x from
// 0 to 5000. The panels the 2D editor draws are therefore fractions of a hull length (see `bounds`), not the
// fixed constants a normalized model could afford — of `viewLen`, the length captured when the hull was
// installed, so that editing it never moves the drawing under the pointer.

import { clamp, type Vec2, type Vec3 } from "./math";
import { pchipSlopes, hermiteEval } from "./pchip";
import { planCurve, type PlanCurve } from "./bspline";
import {
  centripetalParams,
  crChain,
  crCurve,
  evalChain,
  type Bez,
  type Curve,
} from "./spline";
import { boundsOf, type Bounds, type HullState } from "./hull";
// The authored schema, the domain constants and the defaults live in `hull.ts` now, as plain readonly data.
// They are re-exported here so that the geometry's callers keep one import.
export {
  boundsOf,
  loa,
  MIN_PLAN_CP,
  MIN_STATION_PTS,
  MIN_TRIM_CP,
  U_GAP,
  type Bounds,
} from "./hull";

// ---------- types ----------
// The authored control points are `hull.ts`'s, re-exported so that a geometry caller keeps one import. They
// are readonly there and readonly here: a `Model` is built by `assemble()` and then only ever read.
export type {
  PlanCP,
  TrimCP,
  TransomCP,
  StationPointCP,
  StationCP,
} from "./hull";

// The station plane at u: origin on the plan curve, `n` its inboard normal, `T` the plan heading.
export interface Frame {
  p: Vec3;
  T: Vec3;
  n: Vec3;
}

// A section: the (n, z) curve of the station at some u, plus the knuckles that shaped it. `at(v)` runs
// v ∈ [0, vmax] with station point i at v = i exactly. `d(v)` is the exact tangent d(n,z)/dv — the curve
// computes it anyway, and a caller that wants an angle off the section (the deadrise at the keel, say)
// should read it rather than difference `at`.
export interface Section {
  at: (v: number) => Vec2;
  d: (v: number) => Vec2;
  vmax: number; // = S − 1
  ks: number[]; // the blended knuckle at each point
  keelK: number; // the blended keel crease
}

// The hull as the geometry reads it: the authored state, the two session values the drawing needs, and the
// three derived curves. Readonly throughout — a model is built complete by `assemble()` (see `runtime.ts`)
// and never touched again. An edit produces a NEW hull by dispatching a command (see `commands.ts`); there is
// no way to reach in and move a control point, which is what makes one authoritative server able to order every edit.
export interface Model extends HullState {
  readonly x0: number; // the cut-station scrubber's position, in x
  // The hull length the 2D views lay their panels out against. It is CAPTURED when a whole hull is installed
  // (reset / load / blend) and then held, rather than read from the live plan: a control point may be dragged
  // anywhere at all, including past the current bow, and the drawing must not rescale and re-centre itself
  // out from under the pointer while it happens. Session state, like x0 — never serialized.
  readonly viewLen: number;

  // ---- derived by assemble(); never authored ----
  readonly plan: PlanCurve; // P(u) = (x, y) and dP/du
  readonly trimZ: (x: number) => number; // the sheer trim's z at x
  readonly loft: Loft;
}

// The authored fields the derived curves are read from — a `HullState` or a whole `Model` alike.
type Authored = Pick<HullState, "sheerPlan" | "sheerTrim" | "stations">;

export const bounds = (model: Model): Bounds => boundsOf(model.viewLen);

// ---------- deck rake (world frame) ----------
// The hull is built deck-flat (deck = z = 0). The deck rake is a rigid rotation of the whole hull by
// model.deckRake about the transverse (y) axis through the sheer origin (x = 0, z = 0). worldZ is the true
// vertical height of a deck-frame point once floated at that rake; the waterline is the horizontal plane at
// worldZ = −waterline, so immersion(x, z) > 0 means the point is submerged.
export const worldZ = (model: Model, x: number, z: number): number =>
  x * Math.sin(model.deckRake) + z * Math.cos(model.deckRake);

export const immersion = (model: Model, x: number, z: number): number =>
  -model.waterline - worldZ(model, x, z);

// ---------- the longitudinal loft ----------
// Point i of every station traces one curve along the hull; the section at an arbitrary u is those curves
// read at u. Three things are lofted, and they do not all want the same interpolant:
//
//   • (n, z) — a non-uniform Catmull-Rom whose knots ARE the stations' u, built by the exact conversion
//     (crChain) so that reading the chain through `param` below reproduces the parametric curve
//     (n, z)(u) itself — C1 in u across every station. The C1 matters in WORLD space: a longitudinal's
//     velocity is the frame's motion (smooth in u) plus the in-plane velocity (dn/du, dz/du) carried by the
//     station plane. The centripetal chain this replaces, re-read as a function of u, kept the in-plane
//     velocity's DIRECTION at a station but jumped its magnitude — and a smooth vector plus a
//     magnitude-jumping one changes direction, so the swept longitudinals kinked (C0, not G1) at every
//     station even though the (n, z) trace on its own looked fair. Knotting at u buys that smoothness at
//     the price of centripetal spacing's no-cusp guarantee: stations close in u with very different
//     sections can now overshoot, as any chordal or uniform Catmull-Rom can.
//
//   • k — PCHIP. A knuckle is a strength in [0,1] and must stay there; Catmull-Rom overshoots, and an
//     overshoot here would either invent a crease past hard or push k negative. PCHIP is shape-preserving,
//     so a chine fading from 1 to 0 fades monotonically and stops.
//
//   • keelK — PCHIP, for the same reason.
export interface Loft {
  S: number; // points per station
  at: (u: number) => { pts: Vec2[]; ks: number[]; keelK: number };
}

function buildLoft(sts: Authored["stations"]): Loft {
  const K = sts.length,
    n = sts[0].points.length;
  // one station: the section is the same everywhere, so there is nothing to interpolate
  if (K === 1) {
    const st = sts[0],
      pts = st.points.map((p): Vec2 => [p.n, p.z]),
      ks = st.points.map((p) => p.k);
    return {
      S: n,
      at: () => ({
        pts: pts.map((p) => [...p] as Vec2),
        ks: ks.slice(),
        keelK: st.keelK,
      }),
    };
  }
  const us = sts.map((s) => s.u);
  // per point index: the (n, z) chain knotted at the stations' u, and the PCHIP slopes for k
  const chains: Bez[][] = [],
    kCurves: { ys: number[]; m: number[] }[] = [];
  for (let i = 0; i < n; i++) {
    const vals = sts.map((s): number[] => [s.points[i].n, s.points[i].z]);
    chains.push(crChain(vals, us, new Array(K).fill(0)));
    const ys = sts.map((s) => s.points[i].k);
    kCurves.push({ ys, m: pchipSlopes(us, ys) });
  }
  const keelYs = sts.map((s) => s.keelK),
    keelM = pchipSlopes(us, keelYs);
  // u → the chain's parameter: knot j sits at parameter j, so this is the piecewise-linear index of u in
  // us. The chain's segments are the exact conversion over these knots, so the per-segment rescale is
  // exact — evalChain here IS the parametric (n, z)(u), not a reparameterized trace of it.
  const param = (u: number): number => {
    const c = clamp(u, us[0], us[K - 1]);
    let j = 0;
    while (j < K - 2 && c > us[j + 1]) j++;
    return j + (c - us[j]) / (us[j + 1] - us[j] || 1);
  };
  return {
    S: n,
    at: (u: number) => {
      const t = param(u),
        uc = clamp(u, us[0], us[K - 1]);
      const pts: Vec2[] = [],
        ks: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = evalChain(chains[i], t);
        pts.push([p[0], p[1]]);
        ks.push(clamp(hermiteEval(us, kCurves[i].ys, kCurves[i].m, uc), 0, 1));
      }
      return {
        pts,
        ks,
        keelK: clamp(hermiteEval(us, keelYs, keelM, uc), 0, 1),
      };
    },
  };
}

// ---------- the sheer trim as a graph z(x) ----------
// The sheer trim is authored in profile and has to answer "z at this x" — and it answers it constantly, once
// per hull column in the mesh sweep. A parametric (x, z) curve would have to invert its x component (a
// bisection) on every one of those calls; a graph does not. So the trim is a MONOTONE-x PCHIP: its control
// points' x strictly increase (the one thing the edit operations still hold — see `hair`), so z is a plain
// 1-D Hermite function of x with no inversion. This drops the trim out of the sweep's hot path entirely.
//
// The trade: the control points are read as PCHIP knots, not as a parametric Catmull-Rom, so the curve's
// exact shape shifts slightly from the old fit and a trim point's knuckle `k` no longer bends the curve
// (PCHIP is shape-preserving, with no corner to author). The 2-D profile view draws the trim through this
// same `trimZ`, so what is cut and what is drawn stay identical.
function trimGraph(pts: Authored["sheerTrim"]): (x: number) => number {
  const xs = pts.map((p) => p.x),
    zs = pts.map((p) => p.z),
    x0 = xs[0],
    x1 = xs[xs.length - 1];
  if (xs.length < 2) return () => zs[0] ?? 0;
  const m = pchipSlopes(xs, zs);
  return (x: number) => hermiteEval(xs, zs, m, clamp(x, x0, x1));
}

// ---------- deriving the curves ----------
// The three samplers a `Model` carries, built from authored data alone. `assemble()` in `runtime.ts` is the
// caller that matters: it passes back whichever of the three its slice revisions say are still good, so a
// waterline drag rebuilds none of them and a trim drag rebuilds one.

export interface Derived {
  plan: PlanCurve;
  trimZ: (x: number) => number;
  loft: Loft;
}

export function buildDerived(
  hull: Authored,
  reuse: Partial<Derived> = {},
): Derived {
  return {
    plan: reuse.plan ?? planCurve(hull.sheerPlan.map((p): Vec2 => [p.x, p.y])),
    trimZ: reuse.trimZ ?? trimGraph(hull.sheerTrim),
    loft: reuse.loft ?? buildLoft(hull.stations),
  };
}

// ---------- the sweep ----------
// The frame at u: the plan gives the origin and the heading; the station plane is vertical and normal to it.
// n̂ = d̂ × T̂ with d̂ = (0,0,−1) straight down, i.e. (Ty, −Tx, 0) — inboard for a hull whose sheer lies to
// starboard.
export function frameAt(model: Model, u: number): Frame {
  const [x, y] = model.plan.at(u),
    [dx, dy] = model.plan.d(u),
    l = Math.hypot(dx, dy) || 1;
  const T: Vec3 = [dx / l, dy / l, 0];
  return { p: [x, y, 0], T, n: [T[1], -T[0], 0] };
}

// the world point of a station-frame offset: z is world z, so only n is carried by the frame
export const stationWorld = (fr: Frame, n: number, z: number): Vec3 => [
  fr.p[0] + n * fr.n[0],
  fr.p[1] + n * fr.n[1],
  z,
];

// The section at u: the lofted points, drawn through with a centripetal Catmull-Rom in the (n, z) plane and
// creased by the lofted knuckles. Station point i sits at parameter i.
export function sectionAt(model: Model, u: number): Section {
  const { pts, ks, keelK } = model.loft.at(u),
    c: Curve = crCurve(
      pts.map((p) => [...p]),
      centripetalParams(pts.map((p) => [...p])),
      ks,
    );
  return {
    at: (v) => c.at(v) as Vec2,
    d: (v) => c.d(v) as Vec2,
    vmax: c.vmax,
    ks,
    keelK,
  };
}

// the transom plane in profile: the x of the cut at height z (linear through the two control points, full
// breadth). The hull keeps the forward side, x ≥ xTransom(z).
export function xTransom(model: Model, z: number): number {
  const [a, b] = model.transom;
  return a.x + (b.x - a.x) * ((z - a.z) / (b.z - a.z || 1));
}

// ---------- bisection ----------
// Refine a bracketed sign change of g on [a,b] (ga = g(a); the root stays bracketed with g(a) on ga's side).
// A coarse scan finds the crossing between two samples; placing it with one linear-interpolation step leaves
// an O(h²) error that is pure NOISE to anything that differentiates the result — the curvature combs second-
// difference these points and jitter visibly. 40 halvings converge to ~1e-12·span, so the swept geometry is
// smooth down to float precision.
export function bisectRoot(
  g: (v: number) => number,
  a: number,
  b: number,
  ga: number,
): number {
  for (let i = 0; i < 40; i++) {
    const m = 0.5 * (a + b);
    if (g(m) < 0 === ga < 0) a = m;
    else b = m;
  }
  return 0.5 * (a + b);
}

// ---------- the trim test ----------
// How far inside the hull a section point is, as one signed number: the hull keeps a point iff it is at or
// below the sheer trim, at or inboard of the centerline, and forward of the transom plane. Taking the MIN of
// the three makes "kept" a single sign test, so one bisection converges whichever constraint happens to bind
// — the sheer trim at the top, the centerline or the transom at the bottom — with no case analysis.
export function keepAt(model: Model, fr: Frame, nz: Vec2): number {
  const p = stationWorld(fr, nz[0], nz[1]);
  return Math.min(
    model.trimZ(p[0]) - p[2], // at or below the sheer trim
    p[1], // at or inboard of the centerline
    p[0] - xTransom(model, p[2]), // forward of the transom
  );
}

// ---------- world-space queries on a section ----------
export const sectionWorld = (fr: Frame, sec: Section, v: number): Vec3 => {
  const [n, z] = sec.at(v);
  return stationWorld(fr, n, z);
};

// a uniform sampling of the plan's parameter, for the 2D sweep curves
export function sampleU(N = 160): number[] {
  return Array.from({ length: N + 1 }, (_, i) => i / N);
}

// ---------- knot longitudinals ----------
// The loft curve of each station-point index (each KNOT), untrimmed: curve i is the locus knot i traces
// along the whole plan — the u-interpolation a section at any u is read from. Two readings of the same
// curves, one loft sweep each (loft.at evaluates every index at once, so the indices share the pass):
//
//   • WORLD — placed by the frame at each u exactly as the sweep places its sections, for the plan /
//     profile strips and the 3D view. Runs over all of u ∈ [0,1]: beyond the outermost stations the loft
//     clamps, but the frame still moves, so the curve carries on along the plan at a frozen section.
//   • SECTION — the raw (n, z) interpolation itself, for the station editor. Runs only between the
//     outermost stations, where the loft actually interpolates; the clamped tails would pile onto the end
//     points as zero-length segments.
export function knotLongitudinalsWorld(model: Model, N = 120): Vec3[][] {
  const S = model.loft.S,
    out: Vec3[][] = Array.from({ length: S }, () => []);
  for (let j = 0; j <= N; j++) {
    const u = j / N,
      fr = frameAt(model, u),
      pts = model.loft.at(u).pts;
    for (let i = 0; i < S; i++)
      out[i].push(stationWorld(fr, pts[i][0], pts[i][1]));
  }
  return out;
}

export function knotLongitudinalsSection(model: Model, N = 120): Vec2[][] {
  const sts = model.stations,
    u0 = sts[0].u,
    u1 = sts[sts.length - 1].u,
    S = model.loft.S,
    out: Vec2[][] = Array.from({ length: S }, () => []);
  if (u1 <= u0) return out; // one station: the loft is constant, there is no curve in (n, z)
  for (let j = 0; j <= N; j++) {
    const pts = model.loft.at(u0 + ((u1 - u0) * j) / N).pts;
    for (let i = 0; i < S; i++) out[i].push(pts[i]);
  }
  return out;
}
