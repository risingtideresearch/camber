// ---------- clamped cubic B-spline — C² and variation-diminishing (no overshoot); used for the sheer ----------
// The control points are a control POLYGON, not on-curve points. A clamped cubic B-spline interpolates only
// the first and last control point and APPROXIMATES the interior ones — and by the variation-diminishing
// property the curve stays within the convex hull of the polygon, so it can never overshoot past a control
// point the way an interpolating C² cubic does. The degree drops to fit very short polygons (a line for two
// points, a single quadratic for three). It is evaluated as y(x) by inverting the monotone x(u) component,
// so the sweep sees a genuinely C² function (no resample-and-lerp step).

import { clamp, type Vec2 } from "./math.js";

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

// de Boor's algorithm: the curve point at parameter u in span `span`
function deBoor(span: number, u: number, U: number[], P: Vec2[], p: number): Vec2 {
  const d: Vec2[] = [];
  for (let j = 0; j <= p; j++) d[j] = [P[span - p + j][0], P[span - p + j][1]];
  for (let r = 1; r <= p; r++)
    for (let j = p; j >= r; j--) {
      const i = span - p + j,
        den = U[i + p - r + 1] - U[i],
        a = den > 0 ? (u - U[i]) / den : 0;
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
    }
  return d[p];
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
  return (x: number) => {
    x = clamp(x, x0, x1);
    // invert the monotone x(u) by bisection, then read y at that u
    let lo = 0,
      hi = 1,
      pt = pts[0];
    for (let it = 0; it < 36; it++) {
      const mid = (lo + hi) / 2;
      pt = deBoor(findSpan(n, p, mid, U), mid, U, pts, p);
      if (pt[0] < x) lo = mid;
      else hi = mid;
    }
    return pt[1];
  };
}
