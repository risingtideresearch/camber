// ---------- clamped cubic B-spline — C² and variation-diminishing (no overshoot); used for the sheer ----------
// The control points are a control POLYGON, not on-curve points. A clamped cubic B-spline interpolates only
// the first and last control point and APPROXIMATES the interior ones — and by the variation-diminishing
// property the curve stays within the convex hull of the polygon, so it can never overshoot past a control
// point the way an interpolating C² cubic does. The degree drops to fit very short polygons (a line for two
// points, a single quadratic for three). It is evaluated as y(x) by inverting the monotone x(u) component,
// so the sweep sees a genuinely C² function (no resample-and-lerp step).

import { clamp, type Vec2 } from "./math";

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
