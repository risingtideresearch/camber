// ---------- topology promotion: lift a family of hulls to one common topology so any of them can blend ----------
//
// Blending is componentwise over index-aligned arrays, so hulls authored with different control-point counts
// can't blend directly. This raises every hull in a family to the family's MAX count in each dimension,
// preserving each hull's shape as closely as the representation allows:
//
//   • UNIT — every hull is converted into the FIRST hull's unit. v2 coordinates are absolute in a real unit,
//     so a 5000 mm hull and a 5 m hull are the same boat and must blend as one; the blend then carries
//     hull[0]'s unit. (Lengths need not match at all: a blend of a 4 m and a 6 m hull is a 5 m hull, which is
//     the point. v1 required one shared `length` only because its coordinates were unitless against it.)
//   • PLAN (a clamped cubic B-spline) — least-squares refit to N uniform-knot control points. Uniform-knot
//     spaces don't nest, so this is approximate (a few mm on a 4 m hull) but the endpoints are pinned exactly.
//     The refit changes the curve's PARAMETERIZATION, and every station is positioned in that parameter, so
//     each station's u is remapped to hold its x — otherwise a refit alone would slide the sections along the
//     hull.
//   • TRIM & SECTION (interpolating centripetal Catmull-Rom) — keep every original point (and its knuckle) and
//     insert extra ON-CURVE points in the widest gaps, so the shape is unchanged and only the knot spacing
//     shifts. A section point is inserted into EVERY station of the hull at the same index, because the loft
//     is built across matching indices.
//   • STATIONS — see "station correspondence" below. This is the one that isn't mechanical.
//
// The transom is always two points, so it needs no promotion.
//
// ---------- station correspondence ----------
// v1 dodged this: a template had no position, so an extra one could be appended at ZERO BLEND WEIGHT and
// change nothing. v2 has no zero-weight state to hide a station in — every station is at a definite u and
// every station affects the loft there — so the question "which station of hull A means the same thing as
// which station of hull B" has to be answered outright.
//
// A CORRESPONDENCE is that answer for one place along the hulls: entry h is the u of that place in hull h, or
// null where hull h has no station there. Promotion fills every null by reading the hull's own LOFT at the
// remapped u, so the inserted station leaves that hull geometrically UNCHANGED — it just gains a handle where
// the surface already was.
//
// `autoCorrespondence` derives a default: each hull's stations are matched against the running merged list by
// a monotone DP that minimises Σ|Δu| (the endpoints are pinned — the first station of every hull is the same
// place, and so is the last). Stations left unmatched become new correspondences of their own, which is the
// "union of u values" fallback — except the u is remapped through the surrounding correspondences rather than
// taken literally, so it lands at the same PLACE in each hull rather than the same number.
//
// The correspondence is data, not a derivation: the editor's Station Correspondence view can hand a
// user-authored set to `promoteFamily` instead, and the auto pass is only the default.

import { type Vec2 } from "./math";
import { loa, type Model } from "./model";
import { applyCommand, rejected } from "./commands";
import { assemble } from "./runtime";
import type { Writable, HullState, StationCP } from "./hull";
import { clampedBSplineSamplerX, planCurve } from "./bspline";
import { convertUnits, type HullData } from "./json";

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

// A scratch model over this hull's data, so the promotions can use the core's own curve evaluators (the loft,
// the trim graph, the section curves) rather than re-deriving them. The trim scalars are irrelevant here —
// nothing below reads the waterline — so they are zeroed rather than carried.
const modelOf = (data: HullData): Model =>
  assemble({ ...data, waterline: 0, deckRake: 0 });

// The stations of a hull, back in writable form. Promotion builds its hulls up in passes, and `applyCommand`
// hands back authored state, so this is the crossing between the two.
const writableStations = (state: HullState): Writable<StationCP>[] =>
  state.stations.map((st) => ({
    u: st.u,
    keelK: st.keelK,
    points: st.points.map((p) => ({ ...p })),
  }));

// Refit the plan curve to N control points, then remap every station's u to hold its x.
//
// The stations are positioned in the plan's own parameter, and a refit to a different control count is a new
// parameterization of (almost) the same curve — so u = 0.5 means a different place afterwards. Remapping
// through x (the one coordinate both parameterizations agree on, and monotone in u) pins each station where
// the author put it.
function promotePlan(data: HullData, N: number): void {
  if (data.sheerPlan.length >= N) return;
  const before = planCurve(data.sheerPlan.map((p): Vec2 => [p.x, p.y]));
  const xs = data.stations.map((s) => before.at(s.u)[0]);
  const fit = bsplineRefit(
    data.sheerPlan.map((p): Vec2 => [p.x, p.y]),
    N,
  );
  data.sheerPlan = fit.map(([x, y]) => ({ x, y }));
  const after = planCurve(fit);
  data.stations.forEach((s, i) => (s.u = after.uAtX(xs[i])));
}

// keep every original trim point + insert on-curve points (k = 0) at the widest x-gaps until there are T
function promoteTrim(data: HullData, T: number): void {
  if (data.sheerTrim.length >= T) return;
  const zf = modelOf(data).trimZ; // the trim curve as authored, before any insert
  const pts = data.sheerTrim.map((p) => ({ ...p }));
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
  data.sheerTrim = pts;
}

// Keep every original section point + insert on-curve points at the widest chord gaps until there are S.
//
// The insert goes into EVERY station at the same index — the loft rides matching indices, so a point that
// existed in only some stations would have no curve to ride. `addStationPoint` already does exactly this
// (and reads each station's own curve, so no station's shape changes); it picks the segment from a click, so
// the widest gap is aimed at its midpoint here.
function promoteSection(data: HullData, S: number): void {
  const cur = () => data.stations[0].points.length;
  if (cur() >= S) return;
  while (cur() < S) {
    const m = modelOf(data),
      ref = m.stations[0].points;
    // the widest gap, measured on the reference station's own chords
    let bi = 0,
      bg = -1;
    for (let i = 0; i < ref.length - 1; i++) {
      const g = Math.hypot(ref[i + 1].n - ref[i].n, ref[i + 1].z - ref[i].z);
      if (g > bg) {
        bg = g;
        bi = i;
      }
    }
    // aim at the segment's midpoint; the command finds the nearest segment (this one) and inserts the
    // matching on-curve point into every station
    const out = applyCommand(m, {
      type: "addStationPoint",
      si: 0,
      n: (ref[bi].n + ref[bi + 1].n) / 2,
      z: (ref[bi].z + ref[bi + 1].z) / 2,
    });
    if (rejected(out)) return; // the section has no segment left to take a point
    data.stations = writableStations(out.state);
  }
}

// ---------- station correspondence ----------

// One place along the hulls: entry h is its u in hull h, or null where that hull has no station there.
export type Correspondence = (number | null)[];

// The reference u of a correspondence: the mean of the hulls that do have a station there. Used only to score
// the next hull's DP against it — the ORDER of the list is what carries the correspondence, not this number.
function refU(c: Correspondence): number {
  let s = 0,
    n = 0;
  for (const u of c)
    if (u !== null) {
      s += u;
      n++;
    }
  return n ? s / n : 0;
}

// A monotone matching of `a` into `b` that minimises Σ|aᵢ − b_f(i)|, with the ends pinned (a₀↔b₀ and the last
// to the last) and |a| ≤ |b|, so every element of a is matched. Returns f: the index in b for each index of a.
//
// The DP is over suffixes: g(i, j) = min( |aᵢ−bⱼ| + g(i+1, j+1),  g(i, j+1) ) — either aᵢ takes bⱼ, or bⱼ is
// left unmatched and aᵢ tries the next one. O(|a|·|b|) states, each O(1).
function monotoneMatch(a: number[], b: number[]): number[] {
  const m = a.length,
    n = b.length;
  if (m === 0) return [];
  if (m === 1) return [0]; // the only station is the first, and the first always corresponds
  if (m === 2) return [0, n - 1]; // both ends, pinned
  // the interior of a into the interior of b; the ends are pinned outside the DP
  const ai = a.slice(1, m - 1),
    bi = b.slice(1, n - 1),
    p = ai.length,
    q = bi.length;
  const INF = Infinity;
  // g[i][j], with the sentinels g[p][*] = 0 and g[*][q] = INF
  const g: number[][] = Array.from({ length: p + 1 }, () =>
    new Array<number>(q + 1).fill(INF),
  );
  for (let j = 0; j <= q; j++) g[p][j] = 0;
  for (let i = p - 1; i >= 0; i--)
    for (let j = q - 1; j >= 0; j--)
      g[i][j] = Math.min(
        Math.abs(ai[i] - bi[j]) + g[i + 1][j + 1],
        g[i][j + 1],
      );
  // walk the choices back out
  const f: number[] = [0];
  let i = 0,
    j = 0;
  while (i < p) {
    if (j >= q) {
      // not enough room left (only possible if p > q, which the caller prevents) — take what remains
      f.push(Math.min(j + 1, n - 2));
      i++;
      j++;
      continue;
    }
    if (Math.abs(ai[i] - bi[j]) + g[i + 1][j + 1] <= g[i][j + 1]) {
      f.push(j + 1); // +1: bi is b's interior
      i++;
      j++;
    } else j++;
  }
  f.push(n - 1);
  return f;
}

// The family's default correspondence: merge each hull's stations into a running list, matching them against
// it with `monotoneMatch`. A station that finds no match becomes a correspondence of its own — the union
// fallback — inserted at the position the walk reached, so the list stays ordered in EVERY hull at once.
export function autoCorrespondence(datas: HullData[]): Correspondence[] {
  const H = datas.length;
  if (H === 0) return [];
  let merged: Correspondence[] = datas[0].stations.map((st) => {
    const c: Correspondence = new Array(H).fill(null);
    c[0] = st.u;
    return c;
  });
  for (let h = 1; h < H; h++) {
    const us = datas[h].stations.map((s) => s.u),
      refs = merged.map(refU);
    // match the shorter into the longer — the DP fills every element of its first argument
    const next: Correspondence[] = [];
    if (us.length <= refs.length) {
      const f = monotoneMatch(us, refs); // station i of hull h ↔ merged[f[i]]
      const taken = new Map<number, number>();
      f.forEach((j, i) => taken.set(j, i));
      merged.forEach((c, j) => {
        const i = taken.get(j);
        if (i !== undefined) c[h] = us[i];
        next.push(c);
      });
    } else {
      const f = monotoneMatch(refs, us); // merged j ↔ station f[j] of hull h
      const takenU = new Set<number>();
      f.forEach((i) => takenU.add(i));
      let i = 0;
      merged.forEach((c, j) => {
        // hull h's stations before this correspondence's match are unmatched: each becomes its own place
        for (; i < f[j]; i++)
          if (!takenU.has(i)) next.push(newCorr(H, h, us[i]));
        c[h] = us[f[j]];
        next.push(c);
        i = f[j] + 1;
      });
      for (; i < us.length; i++)
        if (!takenU.has(i)) next.push(newCorr(H, h, us[i]));
    }
    merged = next;
  }
  return merged;
}

function newCorr(H: number, h: number, u: number): Correspondence {
  const c: Correspondence = new Array(H).fill(null);
  c[h] = u;
  return c;
}

// The u a hull should place a station at for a correspondence it has no station for.
//
// Not the correspondence's raw u from some other hull — that is a number, and the hulls' parameter spaces are
// not the same space. It is remapped through the nearest correspondences the hull DOES have on either side:
// those are known to be the same place in both hulls, so a linear map between them carries the position
// across. Past the last known correspondence on either side the map falls back to the raw value (there is
// nothing left to interpolate between).
function remapU(corr: Correspondence[], j: number, h: number): number {
  const ref = refU(corr[j]);
  let lo = -1,
    hi = -1;
  for (let k = j - 1; k >= 0; k--)
    if (corr[k][h] !== null) {
      lo = k;
      break;
    }
  for (let k = j + 1; k < corr.length; k++)
    if (corr[k][h] !== null) {
      hi = k;
      break;
    }
  if (lo < 0 && hi < 0) return ref;
  if (lo < 0) return Math.min(ref, corr[hi][h]!);
  if (hi < 0) return Math.max(ref, corr[lo][h]!);
  const a = refU(corr[lo]),
    b = refU(corr[hi]),
    t = b > a ? (ref - a) / (b - a) : 0.5;
  return corr[lo][h]! + (corr[hi][h]! - corr[lo][h]!) * t;
}

// two stations at the same u would make the loft's knots non-monotonic, which no hull can represent
const U_EPS = 1e-4;

// Give every hull a station for every correspondence, reading the ones it lacks off its own loft — so each
// hull is left geometrically unchanged and the family comes out index-aligned.
function promoteStations(datas: HullData[], corr: Correspondence[]): void {
  datas.forEach((data, h) => {
    const m = modelOf(data), // one loft, built BEFORE any insert: every new station is read off the
      loft = m.loft; //        hull as authored, so the inserts never compound
    const out: Writable<StationCP>[] = corr.map((c, j) => {
      if (c[h] !== null) {
        const found = data.stations.find((s) => s.u === c[h]);
        if (found) return found;
      }
      const u = c[h] ?? remapU(corr, j, h),
        { pts, ks, keelK } = loft.at(u);
      return {
        u,
        keelK,
        points: pts.map((p, i) => ({ n: p[0], z: p[1], k: ks[i] })),
      };
    });
    // the correspondence order is the hull order, but a remapped u can land on its neighbour; nudge apart
    for (let j = 1; j < out.length; j++)
      if (out[j].u - out[j - 1].u < U_EPS) out[j].u = out[j - 1].u + U_EPS;
    const over = out.length ? out[out.length - 1].u - 1 : 0;
    if (over > 0) for (const s of out) s.u = Math.max(0, s.u - over);
    data.stations = out;
  });
}

// ---------- the family ----------

// Lift a whole family to the common (max) topology in place, in the FIRST hull's unit. `corr` overrides the
// derived station correspondence (the Station Correspondence view authors one); omit it for the auto pass.
// Returns true if any hull was changed.
export function promoteFamily(
  datas: HullData[],
  corr?: Correspondence[],
): boolean {
  if (datas.length < 2) return false;
  const unit = datas[0].unit;
  let changed = datas.some((d) => d.unit !== unit);
  for (const d of datas) convertUnits(d, unit); // one physical scale before anything is measured

  const N = Math.max(...datas.map((d) => d.sheerPlan.length)),
    T = Math.max(...datas.map((d) => d.sheerTrim.length)),
    S = Math.max(...datas.map((d) => d.stations[0].points.length));
  for (const d of datas) {
    if (
      d.sheerPlan.length !== N ||
      d.sheerTrim.length !== T ||
      d.stations[0].points.length !== S
    )
      changed = true;
    promotePlan(d, N); // first: it remaps the stations' u, which the correspondence is stated in
    promoteTrim(d, T);
    promoteSection(d, S);
  }
  const c = corr ?? autoCorrespondence(datas);
  if (datas.some((d) => d.stations.length !== c.length)) changed = true;
  promoteStations(datas, c);
  return changed;
}

// the family's shared scale, for a caller that wants to report it (the blend of hulls of different lengths is
// a hull of an intermediate length — legitimate, and worth surfacing)
export const familyLoa = (datas: HullData[]): number[] =>
  datas.map((d) => loa({ sheerPlan: d.sheerPlan }));
