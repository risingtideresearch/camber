// ---------- centripetal Catmull-Rom with per-point knuckles ----------
//
// Every curve in the hull except the sheer plan (which stays a clamped B-spline) is one of these: the sheer
// trim, each station's section, and the longitudinal loft that carries a station point along the hull.
//
// The curve interpolates its points and is built by the exact non-uniform Catmull-Rom → Bézier conversion
// (`crChain`): each segment, read over its local s ∈ [0,1], IS the Catmull-Rom polynomial over its own
// knot interval. Two properties of that construction are what the rest of the model leans on:
//
//   • The Bézier control points are GEOMETRIC. They are derived from the knot spacing, but once derived they
//     describe the shape without reference to it — the chain can be evaluated over ANY parameterization and
//     still trace the same shape. That is what lets `evalChain` put knot j at parameter exactly j (see
//     below): the traversal speed changes, the curve does not.
//
//   • Centripetal spacing (tⱼ₊₁ = tⱼ + |ΔQ|^½) is what makes that shape well behaved — no cusps and no
//     self-intersection however unevenly the points are spaced, which uniform or chordal spacing can't
//     promise. See Yuksel et al., "Parameterization and Applications of Catmull-Rom Curves".
//
// Knot j sits at parameter exactly j, so a caller sampling uniformly in the parameter lands on every knot.
// The mesh depends on this: it puts an edge loop on each station point, which is where a knuckle's hard
// shading has to live.
//
// KNUCKLES. k ∈ [0,1] per point pulls the Bézier control points on either side of that point from their
// Catmull-Rom positions toward the ones that would make the touching segment straight. k=0 is the plain
// smooth curve. An isolated k=1 is a corner: each side arrives along its own chord, so the tangent breaks.
// Two ADJACENT k=1 points make the segment between them exactly straight — both its interior control points
// land on the chord. In between, k fades the corner continuously, so a chine can soften along the hull.

import { lerp } from "./math";

// A point of any dimension. The section curve is 2-D (n, z); the longitudinal loft is 2-D as well but knots
// at the stations' u — its caller's real argument, not a derived spacing (see `crChain`).
export type Pt = number[];

// One cubic Bézier segment: [B0, B1, B2, B3], B0/B3 on the curve.
export type Bez = [Pt, Pt, Pt, Pt];

const add = (a: Pt, b: Pt): Pt => a.map((v, i) => v + b[i]);
const sub = (a: Pt, b: Pt): Pt => a.map((v, i) => v - b[i]);
const scale = (a: Pt, s: number): Pt => a.map((v) => v * s);
const lerpPt = (a: Pt, b: Pt, t: number): Pt =>
  a.map((v, i) => lerp(v, b[i], t));

// Centripetal knot spacing over `pts`: t₀ = 0, tⱼ₊₁ = tⱼ + |Qⱼ₊₁ − Qⱼ|^½. Coincident points would give a
// zero step and divide by zero in the tangent formula, so each step has a floor.
export function centripetalParams(pts: Pt[]): number[] {
  const t = [0];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(...sub(pts[i], pts[i - 1]));
    t.push(t[i - 1] + Math.max(Math.sqrt(d), 1e-6));
  }
  return t;
}

// The Catmull-Rom derivative dP/dt at P₁ — the standard non-uniform tangent; with t evenly spaced by h it
// reduces to the uniform Catmull-Rom's (P₂ − P₀)/2h. `t` are the knots of the three points involved. The
// chain builder scales it by a segment's own knot span to that segment's local [0,1] parameter.
function tangent(
  p0: Pt,
  p1: Pt,
  p2: Pt,
  t0: number,
  t1: number,
  t2: number,
): Pt {
  const a = scale(sub(p1, p0), 1 / (t1 - t0)),
    b = scale(sub(p2, p0), 1 / (t2 - t0)),
    c = scale(sub(p2, p1), 1 / (t2 - t1));
  return add(sub(a, b), c);
}

// The segment p→q as a Bézier, from tangents m1 (leaving p) and m2 (arriving at q) already scaled to the
// segment's local [0,1] parameter, creased by the knuckles kp/kq: each interior control point is pulled
// toward the one that makes this segment straight. k at the point nearest that control point governs it, so
// a corner at p bends only the sides that touch p.
function seg(p: Pt, q: Pt, m1: Pt, m2: Pt, kp: number, kq: number): Bez {
  const chord = sub(q, p),
    cp = Math.min(Math.max(kp, 0), 1),
    cq = Math.min(Math.max(kq, 0), 1);
  const b1 = lerpPt(add(p, scale(m1, 1 / 3)), add(p, scale(chord, 1 / 3)), cp),
    b2 = lerpPt(sub(q, scale(m2, 1 / 3)), sub(q, scale(chord, 1 / 3)), cq);
  return [p, b1, b2, q];
}

// The chain of Bézier segments through `vals` — the exact conversion of the non-uniform Catmull-Rom over
// the knots `t`, creased by `ks`: both of a segment's tangents are scaled by ITS OWN knot span, so segment
// j, read over its local s ∈ [0,1], IS the Catmull-Rom polynomial over t ∈ [tⱼ, tⱼ₊₁].
//
// What that buys depends on how the chain is read:
//
//   • READ AT ITS KNOTS — the caller maps its argument linearly onto each knot interval — the chain is the
//     parametric curve P(t) itself, C1 in t across every knot: the segments meeting there agree on the one
//     derivative dP/dt, not merely its direction. The loft is read this way, at u, and that C1 is what
//     keeps the swept longitudinals G1 in world space (see model.ts).
//
//   • SAMPLED UNIFORMLY in the chain parameter v (knot j at parameter j — the sections, whose mesh
//     sampling and combs run in v): the trace is the same curve, because the control points are geometric,
//     and the tangent DIRECTION at a knot is continuous; d/dv's magnitude steps there by the ratio of the
//     adjacent knot spans. G1, which is what a drawn or meshed section needs.
//
// `t` is passed in rather than derived so the caller can knot the chain in whatever space its argument
// lives in: the loft passes the stations' u outright; the sections spread theirs by the centripetal
// distance measured in `vals` itself (`crCurveAuto`).
//
// At the ends there is no neighbor to reach across, so the tangent is the chord itself. That is exactly what
// the tangent formula yields for a phantom point reflected through the endpoint, which is the usual way to
// close a Catmull-Rom, so the ends need no special case beyond this substitution.
export function crChain(vals: Pt[], t: number[], ks: number[]): Bez[] {
  const n = vals.length,
    segs: Bez[] = [];
  for (let j = 0; j < n - 1; j++) {
    const p = vals[j],
      q = vals[j + 1],
      chord = sub(q, p),
      dt = t[j + 1] - t[j];
    const m1 =
      j > 0
        ? scale(tangent(vals[j - 1], p, q, t[j - 1], t[j], t[j + 1]), dt)
        : chord;
    const m2 =
      j + 2 < n
        ? scale(tangent(p, q, vals[j + 2], t[j], t[j + 1], t[j + 2]), dt)
        : chord;
    segs.push(seg(p, q, m1, m2, ks[j] ?? 0, ks[j + 1] ?? 0));
  }
  return segs;
}

// Evaluate the chain at parameter v ∈ [0, segs.length]: knot j is at v = j exactly, and v is clamped to the
// ends (the curve is not extrapolated). Since each segment spans one unit of v, `v | 0` picks the segment
// and the fraction is its local Bézier parameter.
export function evalChain(segs: Bez[], v: number): Pt {
  const n = segs.length;
  if (n === 0) return [];
  const c = Math.min(Math.max(v, 0), n),
    j = Math.min(Math.floor(c), n - 1),
    s = c - j,
    [b0, b1, b2, b3] = segs[j];
  const u = 1 - s,
    w0 = u * u * u,
    w1 = 3 * u * u * s,
    w2 = 3 * u * s * s,
    w3 = s * s * s;
  return b0.map((_, i) => w0 * b0[i] + w1 * b1[i] + w2 * b2[i] + w3 * b3[i]);
}

// dP/dv at v, in the same parameter as `evalChain` (used for tangents / normals along a section).
export function evalChainD(segs: Bez[], v: number): Pt {
  const n = segs.length;
  if (n === 0) return [];
  const c = Math.min(Math.max(v, 0), n),
    j = Math.min(Math.floor(c), n - 1),
    s = c - j,
    [b0, b1, b2, b3] = segs[j];
  const u = 1 - s,
    w0 = 3 * u * u,
    w1 = 6 * u * s,
    w2 = 3 * s * s;
  return b0.map(
    (_, i) =>
      w0 * (b1[i] - b0[i]) + w1 * (b2[i] - b1[i]) + w2 * (b3[i] - b2[i]),
  );
}

// A ready-to-sample curve through `vals`, spaced by `t` and creased by `ks`. The common case — build once,
// sample many times — so the chain is computed here and captured.
export interface Curve {
  at: (v: number) => Pt;
  d: (v: number) => Pt;
  vmax: number; // the parameter of the last knot (= vals.length − 1)
}

export function crCurve(vals: Pt[], t: number[], ks: number[]): Curve {
  const segs = crChain(vals, t, ks);
  return {
    at: (v) => evalChain(segs, v),
    d: (v) => evalChainD(segs, v),
    vmax: segs.length,
  };
}

// The common case: knots spaced by the centripetal distance measured in `vals` itself.
export const crCurveAuto = (vals: Pt[], ks: number[]): Curve =>
  crCurve(vals, centripetalParams(vals), ks);
