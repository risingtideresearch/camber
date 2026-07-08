// ---------- curvature combs (shared geometry) ----------
// A curvature "comb" (graph hairs): at sample points along a curve a hair is drawn perpendicular to the
// curve on the OUTSIDE of the bend (away from the centre of curvature), its length proportional to the
// curvature κ. Joining the hair tips gives the ENVELOPE, whose kinks reveal curvature (G²) discontinuities.
// Each comb AUTO-SCALES so its sharpest (high-percentile) hair is `combLen` units long, so it reads on its
// own regardless of the curve's absolute curvature; the reference is a percentile, not the max, so a single
// near-singular tip (a bow closure, a knuckle) doesn't crush the rest of the comb flat.
//
// This module is pure geometry (no DOM, no view transforms): the caller samples a curve into a dense
// polyline — in whatever isotropic space it will be drawn in (2D content coordinates for the SVG editors, 3D
// world units for the 3D view) — and gets back the hairs + envelope in that same space, ready to project.
// The trimmed-sheer comb in model.ts keeps its own bespoke, converged-evaluator implementation; this one is
// the general-purpose polyline version used everywhere the CurvatureControls overlay draws.

import type { Vec2, Vec3 } from "./math";

export interface Comb2 {
  hairs: [Vec2, Vec2][]; // each hair: [root on the curve, tip on the convex side]
  env: Vec2[]; // the envelope: the hair tips, in order along the curve
}
export interface Comb3 {
  hairs: [Vec3, Vec3][];
  env: Vec3[];
}

type Pt = number[]; // a point of any dimension; the builder is dimension-agnostic (κ needs no cross product)

const dist = (a: Pt, b: Pt): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
};

// resample a polyline to K+1 points spaced uniformly by arc length — so the central differences below are
// well-conditioned (a raw polyline can bunch samples where the curve is straight and starve the bends)
function resample(pts: Pt[], K: number): Pt[] {
  const n = pts.length;
  const cum: number[] = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum[n - 1];
  if (!(total > 1e-12)) return pts.slice();
  const out: Pt[] = [];
  let j = 0;
  for (let k = 0; k <= K; k++) {
    const s = (total * k) / K;
    while (j < n - 2 && cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j] || 1,
      t = (s - cum[j]) / seg;
    out.push(pts[j].map((v, d) => v + (pts[j + 1][d] - v) * t));
  }
  return out;
}

// κ and the unit principal normal (toward the centre of curvature) at the middle of a symmetric triple, by
// central differences: κ = |P″⊥| / |P′|² (reparameterization-invariant — no cross product, so it works in
// any dimension). P″⊥ is the component of P″ perpendicular to the tangent — the normal part points toward
// the centre of curvature, so the hair (drawn along −normal) lands on the convex side of the bend.
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

// the shared builder: a dense polyline → `nHairs` hairs + envelope, auto-scaled to `combLen`.
function build(
  pts: Pt[],
  nHairs: number,
  combLen: number,
): { hairs: [Pt, Pt][]; env: Pt[] } {
  const hairs: [Pt, Pt][] = [],
    env: Pt[] = [];
  if (nHairs < 1 || pts.length < 3) return { hairs, env };
  const K = Math.max(nHairs * 2 + 2, 48), // dense uniform-arc resample, independent of the hair count
    Q = resample(pts, K),
    kap: number[] = new Array(Q.length).fill(0),
    nrm: Pt[] = Q.map(() => [] as number[]);
  for (let i = 1; i < Q.length - 1; i++) {
    const s = sampleKN(Q[i - 1], Q[i], Q[i + 1]);
    kap[i] = s.kappa;
    nrm[i] = s.nrm;
  }
  // reference curvature: the 90th percentile of the interior κ (robust to a singular tip at a bow closure)
  const sorted = kap
    .slice(1, Q.length - 1)
    .filter((k) => isFinite(k))
    .sort((a, b) => a - b);
  const kref = sorted.length
    ? sorted[Math.floor(0.9 * (sorted.length - 1))]
    : 0;
  if (!(kref > 1e-12)) return { hairs, env };
  const lo = 1,
    hi = Q.length - 2,
    H = Math.min(nHairs, hi - lo + 1);
  for (let h = 0; h < H; h++) {
    const i =
      H === 1
        ? Math.round((lo + hi) / 2)
        : Math.round(lo + ((hi - lo) * h) / (H - 1));
    if (nrm[i].length === 0) continue;
    const len = Math.min(kap[i] / kref, 1) * combLen,
      tip = Q[i].map((v, d) => v - nrm[i][d] * len);
    hairs.push([Q[i], tip]);
    env.push(tip);
  }
  return { hairs, env };
}

export function polylineComb2(
  pts: Vec2[],
  nHairs: number,
  combLen: number,
): Comb2 {
  const r = build(pts as Pt[], nHairs, combLen);
  return { hairs: r.hairs as [Vec2, Vec2][], env: r.env as Vec2[] };
}

export function polylineComb3(
  pts: Vec3[],
  nHairs: number,
  combLen: number,
): Comb3 {
  const r = build(pts as Pt[], nHairs, combLen);
  return { hairs: r.hairs as [Vec3, Vec3][], env: r.env as Vec3[] };
}

// ---------- the editor-wide curvature-overlay settings ----------
// Owned by EditorApp (the "Curvature" app-bar control), read by every view's draw routine. `on` is the
// master toggle (the Curvature button); the booleans pick which combs are shown per view; the four counts
// set the comb / hair density. Longitudinal counts drive the fore-aft curves (sheer, waterline, centerline,
// 3D longitudinals); section counts drive the transverse curves (templates, cut sections, 3D sections).

export interface CurvatureSettings {
  on: boolean; // master toggle — nothing draws unless this is true
  // Plan view
  planSheer: boolean; // the sheer plan (deck-edge half-breadth) curve
  planWaterline: boolean; // the design-waterline footprint
  // Profile view
  profSheer: boolean; // the sheer-trim curve (the real sheer in side view)
  profCenterline: boolean; // the keel / rocker + stem outline
  profCut: boolean; // the live cut station's profile trace
  // Station templates
  tplSelected: boolean; // the active template's section curve
  tplUnselected: boolean; // the ghosted (inactive) templates' section curves
  // Cut section
  cutRaw: boolean; // the raw interpolated half-section (before the keel mirror/round)
  cutMirrored: boolean; // the mirrored + keel-rounded section (what survives into the hull)
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
    tplSelected: true,
    tplUnselected: false,
    cutRaw: false,
    cutMirrored: true,
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
