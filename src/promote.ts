// ---------- topology promotion: lift a family of hulls to one common topology so any of them can blend ----------
//
// Hulls authored with different control-point counts can't be blended directly (the blend is componentwise
// over index-aligned arrays). This raises every hull in a family to the family's MAX count in each dimension,
// preserving each hull's shape as closely as the representation allows:
//   • plan (clamped cubic B-spline) — least-squares refit to N uniform-knot control points. Uniform-knot
//     spaces don't nest, so this is approximate (a few mm on a 4 m hull) but the endpoints are pinned exactly;
//     the per-station blend weights are resampled along the refit stations.
//   • trim & section (interpolating knuckle-Hermite) — keep every original point (and its knuckle) and insert
//     extra on-curve points in the widest gaps, so knuckles stay exact and only the tangent estimate shifts.
//   • template count — append duplicates of the last template at zero blend weight, so each hull is unchanged
//     at its own end of the blend while the extra templates still take part in the interior of the mix.
// Length is shared by construction (the model's fixed L) and the transom is always two points, so neither
// needs promotion.

import { type Vec2 } from "./math.js";
import { fairEval, chordParam, buildWeightSampler } from "./model.js";
import { clampedBSplineSamplerX } from "./bspline.js";
import { type HullData } from "./json.js";

// ---- minimal clamped-B-spline machinery for the least-squares refit (NURBS Book A2.1/A2.2) ----
function findSpan(n: number, p: number, u: number, U: number[]): number {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let lo = p,
    hi = n + 1,
    m = (lo + hi) >> 1;
  while (u < U[m] || u >= U[m + 1]) {
    if (u < U[m]) hi = m;
    else lo = m;
    m = (lo + hi) >> 1;
  }
  return m;
}
function basisFuns(span: number, u: number, p: number, U: number[]): number[] {
  const N = new Array(p + 1).fill(0),
    left = new Array(p + 1).fill(0),
    right = new Array(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const t = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * t;
      saved = left[j - r] * t;
    }
    N[j] = saved;
  }
  return N;
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
// solve A x = b (square, small) by Gaussian elimination with partial pivoting and a tiny ridge for safety
function gaussSolve(A: number[][], b: number[]): number[] {
  const n = A.length,
    M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) M[i][i] += 1e-9;
  for (let c = 0; c < n; c++) {
    let pv = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(M[r][c]) > Math.abs(M[pv][c])) pv = r;
    [M[c], M[pv]] = [M[pv], M[c]];
    for (let r = 0; r < n; r++)
      if (r !== c) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

// least-squares refit of the clamped B-spline whose control polygon is `pts` to `N` control points,
// pinning the (interpolated) endpoints exactly (Piegl & Tiller §9.4.1)
function bsplineRefit(pts: Vec2[], N: number): Vec2[] {
  const yf = clampedBSplineSamplerX(pts),
    x0 = pts[0][0],
    x1 = pts[pts.length - 1][0],
    S = 200;
  const Q: Vec2[] = [];
  for (let i = 0; i <= S; i++) {
    const x = x0 + ((x1 - x0) * i) / S;
    Q.push([x, yf(x)]);
  }
  // chord-length parameters for the samples
  const d = [0];
  for (let i = 1; i <= S; i++)
    d[i] = d[i - 1] + Math.hypot(Q[i][0] - Q[i - 1][0], Q[i][1] - Q[i - 1][1]);
  const tot = d[S] || 1,
    t = d.map((v) => v / tot);
  const p = Math.min(3, N - 1),
    U = uniformKnots(N, p),
    n = N - 1;
  // collocation rows; endpoints (cp 0 and N−1) are pinned to Q[0] / Q[S]
  const row: number[][] = [];
  for (let k = 0; k <= S; k++) {
    const sp = findSpan(n, p, t[k], U),
      bf = basisFuns(sp, t[k], p, U),
      r = new Array(N).fill(0);
    for (let j = 0; j <= p; j++) r[sp - p + j] = bf[j];
    row.push(r);
  }
  const free = N - 2;
  if (free <= 0) return [Q[0], Q[S]]; // N === 2: just the endpoints
  const ATA = Array.from({ length: free }, () => new Array(free).fill(0));
  const Rx = new Array(free).fill(0),
    Ry = new Array(free).fill(0);
  for (let k = 1; k < S; k++) {
    const rx = Q[k][0] - row[k][0] * Q[0][0] - row[k][N - 1] * Q[S][0],
      ry = Q[k][1] - row[k][0] * Q[0][1] - row[k][N - 1] * Q[S][1];
    for (let i = 0; i < free; i++) {
      const Ni = row[k][i + 1];
      Rx[i] += Ni * rx;
      Ry[i] += Ni * ry;
      for (let j = 0; j < free; j++) ATA[i][j] += Ni * row[k][j + 1];
    }
  }
  const Px = gaussSolve(
      ATA.map((r) => [...r]),
      Rx,
    ),
    Py = gaussSolve(
      ATA.map((r) => [...r]),
      Ry,
    );
  const out: Vec2[] = [Q[0]];
  for (let i = 0; i < free; i++) out.push([Px[i], Py[i]]);
  out.push(Q[S]);
  return out;
}

// raise the template count to K by appending duplicates of the last template at zero blend weight
function promoteTemplates(data: HullData, K: number): void {
  while (data.templates.length < K) {
    data.templates.push(
      data.templates[data.templates.length - 1].map((p) => ({ ...p })),
    );
    data.cp.forEach((c) => c.w.push(0)); // the new template contributes nothing to THIS hull (Σw still = 1)
  }
}

// refit the plan curve to N control points, resampling each station's blend weights along the new stations
function promotePlan(data: HullData, N: number): void {
  if (data.cp.length >= N) return;
  const wf = buildWeightSampler(data.cp); // the weight curve over the existing stations
  const fit = bsplineRefit(
    data.cp.map((c): Vec2 => [c.x, c.y]),
    N,
  );
  data.cp = fit.map(([x, y]) => ({ x, y, w: wf(x) }));
}

// keep every original trim point + insert on-curve points (k = 0) at the widest x-gaps until there are T
function promoteTrim(data: HullData, T: number): void {
  if (data.trim.length >= T) return;
  const zf = fairEval(
    data.trim.map((p) => p.x),
    data.trim.map((p) => p.z),
    data.trim.map((p) => p.k),
  );
  const pts = data.trim.map((p) => ({ ...p }));
  while (pts.length < T) {
    let bi = 0,
      bg = -1;
    for (let i = 0; i < pts.length - 1; i++) {
      const g = pts[i + 1].x - pts[i].x;
      if (g > bg) {
        bg = g;
        bi = i;
      }
    }
    const xm = (pts[bi].x + pts[bi + 1].x) / 2;
    pts.splice(bi + 1, 0, { x: xm, z: zf(xm), k: 0 });
  }
  data.trim = pts;
}

// keep every original section point + insert on-curve points (k = 0) at the widest chord gaps until S, per template
function promoteSection(data: HullData, S: number): void {
  if (data.templates[0].length >= S) return; // all templates share one section count
  data.templates = data.templates.map((tpl) => {
    const ts = chordParam(
        tpl.map((p) => p.n),
        tpl.map((p) => p.d),
      ),
      nf = fairEval(
        ts,
        tpl.map((p) => p.n),
        tpl.map((p) => p.k),
      ),
      df = fairEval(
        ts,
        tpl.map((p) => p.d),
        tpl.map((p) => p.k),
      );
    const pts = tpl.map((p, i) => ({ ...p, t: ts[i] }));
    while (pts.length < S) {
      let bi = 0,
        bg = -1;
      for (let i = 0; i < pts.length - 1; i++) {
        const g = pts[i + 1].t - pts[i].t;
        if (g > bg) {
          bg = g;
          bi = i;
        }
      }
      const tm = (pts[bi].t + pts[bi + 1].t) / 2;
      pts.splice(bi + 1, 0, { n: nf(tm), d: df(tm), k: 0, t: tm });
    }
    return pts.map(({ t: _t, ...p }) => p); // drop the helper param
  });
}

// lift a whole family to the common (max) topology in place. Returns true if any hull was changed.
export function promoteFamily(datas: HullData[]): boolean {
  if (datas.length < 2) return false;
  const N = Math.max(...datas.map((d) => d.cp.length)),
    T = Math.max(...datas.map((d) => d.trim.length)),
    S = Math.max(...datas.map((d) => d.templates[0].length)),
    K = Math.max(...datas.map((d) => d.templates.length));
  let changed = false;
  for (const d of datas) {
    if (
      d.cp.length !== N ||
      d.trim.length !== T ||
      d.templates[0].length !== S ||
      d.templates.length !== K
    )
      changed = true;
    promoteTemplates(d, K); // first — sets each station's weight vector to length K
    promotePlan(d, N); // then refit the plan (weights resampled with the final K length)
    promoteTrim(d, T);
    promoteSection(d, S);
  }
  return changed;
}
