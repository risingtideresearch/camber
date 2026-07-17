// ---------- clamped cubic B-spline — C² and variation-diminishing (no overshoot); used for the sheer ----------
// The control points are a control POLYGON, not on-curve points. A clamped cubic B-spline interpolates only
// the first and last control point and APPROXIMATES the interior ones — and by the variation-diminishing
// property the curve stays within the convex hull of the polygon, so it can never overshoot past a control
// point the way an interpolating C² cubic does. The degree drops to fit very short polygons (a line for two
// points, a single quadratic for three). It is evaluated as y(x) by inverting the monotone x(u) component,
// so the sweep sees a genuinely C² function (no resample-and-lerp step).

import { clamp, type Vec2 } from "./math";

// A clamped cubic B-spline read as a PARAMETRIC curve P(u) = (x(u), y(u)) over u ∈ [0,1], rather than as the
// function y(x) below. This is the sheer plan's own parameter space, and the hull's stations are positioned
// in it — a station's `u` means "here along the plan curve", so the sweep never has to invert x(u) to place
// one. `d` is dP/du, which gives the swept frame its heading.
export interface PlanCurve {
  at: (u: number) => Vec2;
  d: (u: number) => Vec2;
  // u of a given x, by inverting the monotone x(u). Only needed where a curve authored against x (the sheer
  // trim, the transom) has to meet one authored against u.
  uAtX: (x: number) => number;
}

// the knot span containing u for a clamped knot vector (The NURBS Book, A2.1)
function findSpan(n: number, p: number, u: number, U: number[]): number {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let lo = p,
    hi = n + 1,
    mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

// y(x) along a clamped cubic B-spline whose control polygon is `pts` (x strictly increasing, so x(u) is
// monotone and invertible). Returns the curve's y at the given x.
export function clampedBSplineSamplerX(pts: Vec2[]): (x: number) => number {
  const numCP = pts.length;
  if (numCP === 0) return () => 0;
  if (numCP === 1) return () => pts[0][1];
  const p = Math.min(3, numCP - 1), // degree drops for short polygons (line / quadratic / cubic)
    n = numCP - 1;
  // clamped uniform knot vector: (p+1) zeros, (numCP-p-1) interior knots, (p+1) ones
  const U: number[] = [];
  for (let i = 0; i <= p; i++) U.push(0);
  const interior = numCP - p - 1;
  for (let i = 1; i <= interior; i++) U.push(i / (interior + 1));
  for (let i = 0; i <= p; i++) U.push(1);
  const x0 = pts[0][0],
    x1 = pts[numCP - 1][0];
  // de Boor's algorithm on a single coordinate (c = 0 for x, 1 for y), reusing one scratch row: this
  // sampler is hot (every plan-sweep sample / frameAt queries it), so no per-query allocation.
  const d = new Float64Array(p + 1);
  const deBoor1 = (span: number, u: number, c: 0 | 1): number => {
    for (let j = 0; j <= p; j++) d[j] = pts[span - p + j][c];
    for (let r = 1; r <= p; r++)
      for (let j = p; j >= r; j--) {
        const i = span - p + j,
          den = U[i + p - r + 1] - U[i],
          a = den > 0 ? (u - U[i]) / den : 0;
        d[j] = (1 - a) * d[j - 1] + a * d[j];
      }
    return d[p];
  };
  return (x: number) => {
    x = clamp(x, x0, x1);
    // invert the monotone x(u) by bisection on the x component, then read y once at the converged u
    let lo = 0,
      hi = 1,
      mid = 0.5;
    for (let it = 0; it < 36; it++) {
      mid = (lo + hi) / 2;
      if (deBoor1(findSpan(n, p, mid, U), mid, 0) < x) lo = mid;
      else hi = mid;
    }
    return deBoor1(findSpan(n, p, mid, U), mid, 1);
  };
}

// clamped uniform knot vector for `count` control points of degree p
function uniformKnots(count: number, p: number): number[] {
  const U: number[] = [];
  for (let i = 0; i <= p; i++) U.push(0);
  const interior = count - p - 1;
  for (let i = 1; i <= interior; i++) U.push(i / (interior + 1));
  for (let i = 0; i <= p; i++) U.push(1);
  return U;
}

// de Boor over a control polygon of 2-D points, one coordinate at a time
function deBoorAt(pts: Vec2[], U: number[], p: number, u: number): Vec2 {
  const n = pts.length - 1,
    span = findSpan(n, p, u, U),
    d: Vec2[] = [];
  for (let j = 0; j <= p; j++) d.push([...pts[span - p + j]] as Vec2);
  for (let r = 1; r <= p; r++)
    for (let j = p; j >= r; j--) {
      const i = span - p + j,
        den = U[i + p - r + 1] - U[i],
        a = den > 0 ? (u - U[i]) / den : 0;
      d[j] = [
        (1 - a) * d[j - 1][0] + a * d[j][0],
        (1 - a) * d[j - 1][1] + a * d[j][1],
      ];
    }
  return d[p];
}

// The sheer plan as a parametric curve P(u) over its own clamped-uniform knot vector — the space the hull's
// stations are positioned in. The degree drops for short polygons exactly as `clampedBSplineSamplerX` does
// (a line for two points, one quadratic for three), so both readings of the same control points agree.
//
// The derivative is taken exactly, not by finite differences: the hodograph of a degree-p B-spline is the
// degree-(p−1) B-spline whose control points are p·(Pᵢ₊₁ − Pᵢ)/(U[i+p+1] − U[i+1]) over the interior knots.
// Every station's frame reads `d` for its heading, so an exact tangent keeps the swept surface smooth
// rather than merely close.
export function planCurve(pts: Vec2[]): PlanCurve {
  const numCP = pts.length;
  if (numCP === 0) return { at: () => [0, 0], d: () => [1, 0], uAtX: () => 0 };
  if (numCP === 1) {
    const q = pts[0];
    return { at: () => [...q] as Vec2, d: () => [1, 0], uAtX: () => 0 };
  }
  const p = Math.min(3, numCP - 1),
    U = uniformKnots(numCP, p);
  // the hodograph's control polygon + knots (degree p−1, one fewer control point)
  const dPts: Vec2[] = [];
  for (let i = 0; i < numCP - 1; i++) {
    const den = U[i + p + 1] - U[i + 1];
    dPts.push(
      den > 0
        ? [
            (p * (pts[i + 1][0] - pts[i][0])) / den,
            (p * (pts[i + 1][1] - pts[i][1])) / den,
          ]
        : [0, 0],
    );
  }
  const dU = U.slice(1, U.length - 1),
    dp = p - 1;
  const at = (u: number): Vec2 => deBoorAt(pts, U, p, clamp(u, 0, 1));
  const d = (u: number): Vec2 =>
    dp < 1
      ? [dPts[0]?.[0] ?? 1, dPts[0]?.[1] ?? 0] // degree 1 → constant tangent (the single chord)
      : deBoorAt(dPts, dU, dp, clamp(u, 0, 1));
  const x0 = at(0)[0],
    x1 = at(1)[0];
  return {
    at,
    d,
    uAtX: (x: number) => {
      const xc = clamp(x, x0, x1);
      let lo = 0,
        hi = 1;
      for (let it = 0; it < 40; it++) {
        const m = (lo + hi) / 2;
        if (at(m)[0] < xc) lo = m;
        else hi = m;
      }
      return (lo + hi) / 2;
    },
  };
}
