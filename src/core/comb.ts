// ---------- curvature combs (shared geometry) ----------
// A curvature "comb" (graph hairs): at sample points along a curve a hair is drawn perpendicular to the
// curve on the OUTSIDE of the bend (away from the centre of curvature), its length proportional to the
// curvature κ. Joining the hair tips gives the ENVELOPE, whose kinks reveal curvature (G²) discontinuities.
// Each comb AUTO-SCALES so its sharpest (high-percentile) hair is `combLen` units long, so it reads on its
// own regardless of the curve's absolute curvature; the reference is a percentile, not the max, so a single
// near-singular tip (a bow closure, a knuckle) doesn't crush the rest of the comb flat.
//
// This module is pure geometry (no DOM, no view transforms). The caller hands over the curve's ORIGINAL
// definition — an evaluator t → point, in whatever isotropic space the comb will be drawn in (2D content
// coordinates for the SVG editors, 3D world units for the 3D view). The evaluator may be PARTIAL (null
// where the curve doesn't exist: behind the transom plane, above the sheer trim, no waterline crossing);
// each maximal existing run gets its own comb, with the run's edges converged onto the domain boundary by
// bisection. Hairs are spaced uniformly by arc length; each hair's root is a true EVALUATION of the curve
// (the arc-length equation is solved by bisection against the evaluator — never an interpolation between
// samples), and κ comes from central differences of the evaluator at a fine ±ε (~1e-3 of the run, far
// finer than the hair spacing).
//
// Evaluators must be SMOOTH at the ±ε scale: converge any internal root-find by bisection (see model.ts
// bisectRoot) — a coarse scan placed with one linear-interpolation step puts its O(h²) noise straight
// into κ. Every hull curve now has a converged evaluator of its own in mesh.ts (sheerPointAt, keelPointAt,
// longitudinalPointAt, dwlPointAt), so they all come through the builders below; v1 needed a bespoke
// shared-pass variant for the sheer only because its crossing was not converged.

import { clamp, type Vec2, type Vec3 } from "./math";

export interface Comb2 {
  hairs: [Vec2, Vec2][]; // each hair: [root on the curve, tip on the convex side]
  env: Vec2[]; // the envelope: the hair tips, in order along the curve
}
export interface Comb3 {
  hairs: [Vec3, Vec3][];
  env: Vec3[];
}

type Pt = number[]; // a point of any dimension; the builder is dimension-agnostic (κ needs no cross product)
type PartialFn = (t: number) => Pt | null;

const dist = (a: Pt, b: Pt): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
};

// κ and the unit principal normal (toward the centre of curvature) from a symmetric parameter triple
// [f(t−ε), f(t), f(t+ε)], by central differences: κ = |P″⊥| / |P′|² (reparameterization-invariant — the ε
// cancels between numerator and denominator, and there is no cross product, so it works in any dimension).
// P″⊥ is the component of P″ perpendicular to the tangent — the normal part points toward the centre of
// curvature, so the hair (drawn along −normal) lands on the convex side of the bend.
function sampleKN(a: Pt, p: Pt, b: Pt): { kappa: number; nrm: Pt } {
  const dim = p.length,
    d1: number[] = [],
    d2: number[] = [];
  for (let i = 0; i < dim; i++) {
    d1.push((b[i] - a[i]) / 2);
    d2.push(b[i] - 2 * p[i] + a[i]);
  }
  let v = 0;
  for (const c of d1) v += c * c;
  v = Math.sqrt(v);
  if (v < 1e-9) return { kappa: 0, nrm: new Array(dim).fill(0) };
  const t = d1.map((x) => x / v);
  let dot = 0;
  for (let i = 0; i < dim; i++) dot += d2[i] * t[i];
  const perp = d2.map((x, i) => x - dot * t[i]);
  let pl = 0;
  for (const c of perp) pl += c * c;
  pl = Math.sqrt(pl);
  return {
    kappa: pl / (v * v),
    nrm: pl > 1e-12 ? perp.map((x) => x / pl) : new Array(dim).fill(0),
  };
}

// converge a run edge onto the existence boundary: f(tOk) exists, f(tBad) doesn't. Returns the surviving
// side's parameter and its evaluation (a true point on the curve, arbitrarily close to the boundary).
function refineEdge(
  f: PartialFn,
  tBad: number,
  tOk: number,
  pOk: Pt,
): { t: number; p: Pt } {
  let p = pOk;
  for (let i = 0; i < 25; i++) {
    const m = 0.5 * (tBad + tOk),
      q = f(m);
    if (q) {
      tOk = m;
      p = q;
    } else tBad = m;
  }
  return { t: tOk, p };
}

// one maximal existing run of a partial evaluator: its (non-uniform) parameter/point table for arc-length
// bracketing, the cumulative chord lengths, and the converged domain [t0, t1]
interface Run {
  pr: number[];
  pp: Pt[];
  cum: number[];
  total: number;
  t0: number;
  t1: number;
}

// scan [t0,t1] at K+1 uniform parameters and split into maximal existing runs, edges refined by bisection
function scanRuns(f: PartialFn, t0: number, t1: number, K: number): Run[] {
  const ts: number[] = [],
    ps: (Pt | null)[] = [];
  for (let i = 0; i <= K; i++) {
    const t = t0 + ((t1 - t0) * i) / K;
    ts.push(t);
    ps.push(f(t));
  }
  const runs: Run[] = [];
  let i = 0;
  while (i <= K) {
    if (!ps[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 <= K && ps[j + 1]) j++;
    const pr: number[] = [],
      pp: Pt[] = [];
    if (i > 0) {
      const e = refineEdge(f, ts[i - 1], ts[i], ps[i]!);
      if (e.t < ts[i]) {
        pr.push(e.t);
        pp.push(e.p);
      }
    }
    for (let k = i; k <= j; k++) {
      pr.push(ts[k]);
      pp.push(ps[k]!);
    }
    if (j < K) {
      const e = refineEdge(f, ts[j + 1], ts[j], ps[j]!);
      if (e.t > ts[j]) {
        pr.push(e.t);
        pp.push(e.p);
      }
    }
    const cum = [0];
    for (let k = 1; k < pr.length; k++)
      cum.push(cum[k - 1] + dist(pp[k - 1], pp[k]));
    const total = cum[cum.length - 1];
    if (pr.length >= 2 && total > 1e-9)
      runs.push({ pr, pp, cum, total, t0: pr[0], t1: pr[pr.length - 1] });
    i = j + 1;
  }
  return runs;
}

// place a hair root exactly on the curve at arc length s into the run: bracket the containing chord
// segment via the cumulative table, then bisect the parameter until the chord from the segment's start
// matches the remaining length. The root is a true evaluation f(t*) — the table only brackets.
function placeHair(f: PartialFn, run: Run, s: number): { t: number; p: Pt } {
  const { pr, pp, cum } = run;
  let k = 0;
  while (k < cum.length - 2 && cum[k + 1] < s) k++;
  const r = s - cum[k],
    seg = cum[k + 1] - cum[k];
  if (r <= 1e-12) return { t: pr[k], p: pp[k] };
  if (r >= seg - 1e-12) return { t: pr[k + 1], p: pp[k + 1] };
  let a = pr[k],
    b = pr[k + 1];
  for (let i = 0; i < 14; i++) {
    const m = 0.5 * (a + b);
    const q = f(m);
    if (q && dist(pp[k], q) < r) a = m;
    else b = m;
  }
  const t = 0.5 * (a + b);
  return { t, p: f(t) ?? pp[k] };
}

// the shared builder: a (possibly partial) exact evaluator → one comb per existing run. `nHairs` is spread
// across the runs by arc length; ONE reference curvature (the 90th-percentile hair κ, robust to a singular
// tip) scales every run, since they are pieces of the same curve.
function buildCombs(
  f: PartialFn,
  t0: number,
  t1: number,
  nHairs: number,
  combLen: number,
): { hairs: [Pt, Pt][]; env: Pt[] }[] {
  if (nHairs < 1 || !(t1 > t0)) return [];
  const K = Math.max(4 * nHairs, 96),
    runs = scanRuns(f, t0, t1, K);
  if (!runs.length) return [];
  const grand = runs.reduce((s, r) => s + r.total, 0);
  const perRun = runs.map((run) => {
    const H = Math.max(1, Math.round((nHairs * run.total) / grand)),
      hs: { root: Pt; kappa: number; nrm: Pt }[] = [];
    for (let h = 0; h < H; h++) {
      const s = H === 1 ? run.total / 2 : (run.total * h) / (H - 1),
        { t, p } = placeHair(f, run, s);
      // κ by fine central differences of the evaluator itself: ε ~1e-3 of the run's parameter span — far
      // finer than the hair spacing — with the stencil centre clamped inside the domain, so an endpoint
      // hair carries the curvature just inside the edge (the one-sided limit, to O(ε)).
      const eps = (run.t1 - run.t0) * 1e-3,
        tc = clamp(t, run.t0 + eps, run.t1 - eps),
        qa = f(tc - eps),
        qc = tc === t ? p : f(tc),
        qb = f(tc + eps);
      if (qa && qc && qb) {
        const kn = sampleKN(qa, qc, qb);
        hs.push({ root: p, kappa: kn.kappa, nrm: kn.nrm });
      } else hs.push({ root: p, kappa: 0, nrm: p.map(() => 0) });
    }
    return hs;
  });
  const kaps = perRun
    .flat()
    .map((h) => h.kappa)
    .filter((k) => isFinite(k))
    .sort((a, b) => a - b);
  const kref = kaps.length ? kaps[Math.floor(0.9 * (kaps.length - 1))] : 0;
  if (!(kref > 1e-12)) return [];
  return perRun.map((hs) => {
    const hairs: [Pt, Pt][] = [],
      env: Pt[] = [];
    for (const h of hs) {
      const len = Math.min(h.kappa / kref, 1) * combLen || 0,
        tip = h.root.map((v, d) => v - h.nrm[d] * len);
      hairs.push([h.root, tip]);
      env.push(tip);
    }
    return { hairs, env };
  });
}

export function curveCombs2(
  f: (t: number) => Vec2 | null,
  t0: number,
  t1: number,
  nHairs: number,
  combLen: number,
): Comb2[] {
  return buildCombs(f, t0, t1, nHairs, combLen).map((c) => ({
    hairs: c.hairs as [Vec2, Vec2][],
    env: c.env as Vec2[],
  }));
}

export function curveCombs3(
  f: (t: number) => Vec3 | null,
  t0: number,
  t1: number,
  nHairs: number,
  combLen: number,
): Comb3[] {
  return buildCombs(f, t0, t1, nHairs, combLen).map((c) => ({
    hairs: c.hairs as [Vec3, Vec3][],
    env: c.env as Vec3[],
  }));
}

// ---------- the editor-wide curvature-overlay settings ----------
// Owned by EditorApp (the "Curvature" app-bar control), read by every view's draw routine. `on` is the
// master toggle (the Curvature button); the booleans pick which combs are shown per view; the four counts
// set the comb / hair density. Longitudinal counts drive the fore-aft curves (sheer, waterline, centerline,
// 3D longitudinals); section counts drive the transverse curves (stations, cut sections, 3D sections).

export interface CurvatureSettings {
  on: boolean; // master toggle — nothing draws unless this is true
  // Plan view
  planSheer: boolean; // the sheer plan (deck-edge half-breadth) curve
  planWaterline: boolean; // the design-waterline footprint
  // Profile view
  profSheer: boolean; // the sheer-trim curve (the real sheer in side view)
  profCenterline: boolean; // the keel / rocker + stem outline
  profCut: boolean; // the live cut station's profile trace
  // Stations
  stnSelected: boolean; // the active station's section curve
  stnUnselected: boolean; // the ghosted (inactive) stations' section curves
  // Cut section
  cutSection: boolean; // the lofted section at the cut
  // 3D view
  d3Sheer: boolean; // the trimmed sheer edge
  d3Centerline: boolean; // the keel / centerline curve
  d3Longitudinals: boolean; // a family of fore-aft longitudinal curves
  d3Sections: boolean; // a family of transverse section curves
  // densities
  nLongHairs: number; // hairs per longitudinal (fore-aft) comb
  nSectHairs: number; // hairs per section (transverse) comb
  nLongCombs: number; // number of 3D longitudinal combs
  nSectCombs: number; // number of 3D section combs
}

export function defaultCurvature(): CurvatureSettings {
  return {
    on: false,
    planSheer: true,
    planWaterline: false,
    profSheer: true,
    profCenterline: false,
    profCut: false,
    stnSelected: true,
    stnUnselected: false,
    cutSection: true,
    d3Sheer: true,
    d3Centerline: false,
    d3Longitudinals: false,
    d3Sections: false,
    nLongHairs: 40,
    nSectHairs: 30,
    nLongCombs: 8,
    nSectCombs: 12,
  };
}
