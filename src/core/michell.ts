// ---------- Michell's integral: thin-ship wave resistance from the centerplane offsets ----------
//
// Michell (1898): a slender hull with half-breadths y = ±Y(x, z), moving steadily at speed U, has wave
// resistance
//
//   R_w = (4 ρ g² / π U²) ∫₁^∞ |F(λ)|² λ²/√(λ²−1) dλ,
//   F(λ) = ∫∫_S (∂Y/∂x) · exp(k₀ λ² z + i k₀ λ x) dx dz,     k₀ = g/U²  (z ≤ 0 below the waterline)
//
// — the λ = sec θ form of the classical triple integral (Tuck, Scullen & Lazauskas 2000, eqs. 4/6).
// Everything here is evaluated in MODEL units. The only physics that enters is k₀, and k₀·LWL = 1/Fn²,
// so the coefficient
//
//   C_w = R_w / (½ ρ U² S) = (8 k₀² / π S) ∫₁^∞ |F(λ)|² λ²/√(λ²−1) dλ      (S = wetted surface)
//
// is a pure function of hull geometry and Froude number — identical at model and full scale. A display
// layer dimensionalizes: R_w = C_w · ½ ρ U² S_real.
//
// Numerics — the places naive quadrature fails, and the λ endpoint:
//  • The x-kernel e^{ik₀λx} completes ≈ λ/(2π Fn²) cycles over the hull — dozens at low Fn — so
//    fixed-rate sampling aliases and fabricates diverging-wave content. Y is therefore represented as
//    piecewise-linear per depth level and the x-integral of (∂Y/∂x)·e^{iκx} is done in CLOSED FORM per
//    panel (a Filon-type rule — the treatment Tuck recommends for Michell's integral). The quadrature
//    error is then only the O(h²) interpolation of Y, independent of Fn and λ.
//  • The z-kernel e^{k₀λ²z} lives in a surface layer of depth 1/(k₀λ²), far thinner than any affordable
//    grid at large λ; the z-integral of (linear-in-ζ)·e^{−aζ} is likewise closed-form per panel, applied
//    to the per-level (complex) x-integrals — which are SMOOTH in ζ even at a transom, see below.
//  • 1/√(λ²−1) is an integrable endpoint singularity: substituting λ = √(1+u²) turns the weight
//    λ²/√(λ²−1) dλ into λ du, smooth from u = 0, and a plain trapezoid rule applies.
//
// An immersed transom gets the standard DRY-TRANSOM treatment: at each depth the integration domain
// ends exactly on the transom's rake line, with the hull's half-breadth still finite there and NO
// closure panel — the flow is assumed to separate at the edge rather than wrap a solid back wall.
// (Zeroing the offsets aft of the cut instead would model a stair-stepped closing wall whose steps move
// with the grid — hugely resistive and never converging under refinement.) No closure is added at a
// blunt bow either. The deck-rake tilt of the station planes is accepted as-is (the same station-plane
// approximation hydro.ts uses), and thin-ship theory itself assumes a slender hull: treat the output as
// a comparator between variants, not a towing tank.

import {
  clippedSection,
  forwardLimit,
  immersion,
  xTransom,
  type Model,
} from "./model";
import { lerp } from "./math";

// the immersed centerplane offsets Y(x, ζ): per wetted station, the half-breadth at uniform depth
// levels ζ_j = j·dz below the design waterline (0 where there is no hull at that depth)
export interface CenterplaneGrid {
  xs: number[]; // station x (model units), aft → fwd across the wetted span
  Y: Float64Array[]; // per station: half-breadth at levels j = 0..nz (index-aligned with xs)
  nz: number;
  dz: number; // depth-level spacing; the deepest level nz·dz is the overall draft
  first: Int32Array; // per level: index of the first station with hull (−1 = none at this depth)
  // per level, where an immersed transom cuts the hull at this depth: the exact aft domain boundary on
  // the rake line — the level's x-integral starts at (cutX, half-breadth cutY), dry-transom style.
  // cutX = NaN where the hull starts naturally (Y rising smoothly from 0).
  cutX: Float64Array;
  cutY: Float64Array;
  lwl: number;
  draft: number;
  wettedArea: number; // for the C_w normalization (model units²)
}

const NX = 120, // default station count across the wetted span
  NZ = 36, // default depth levels
  MCOLS = 48; // section polyline columns (same default as hydro)

// Sample the hull's immersed centerplane offsets. For each wetted station the section polyline is
// scanned segment by segment: wherever a segment's immersion range spans a depth level, the half-breadth
// at the crossing is recorded (outermost wins — a tumblehome section is multi-valued in depth and
// thin-ship theory wants the envelope). Depths with no crossing have no hull there and stay 0.
//
// The stations are placed uniformly across the CONVERGED wetted span [xAft, xFwd] (wet/dry boundaries
// bisected below), not across a scan of the whole hull — with the latter, the position of the first and
// last kept station shifted with the station count, and since Michell's integral is phase-sensitive to
// where the offsets begin and end, that endpoint jitter dominated the error.
export function centerplaneGrid(
  model: Model,
  nx: number = NX,
  nz: number = NZ,
  m: number = MCOLS,
): CenterplaneGrid | null {
  const xf = forwardLimit(model);
  if (!(xf > 0)) return null;
  // wet(x): the trimmed section exists and reaches below the waterline (cheap probe for the bisections)
  const wet = (x: number): boolean => {
    const sec = clippedSection(model, x, 8);
    if (sec.aft) return false;
    return sec.pts.some((p) => immersion(model, p[0], p[2]) > 0);
  };
  const bisect = (a: number, b: number): number => {
    // b is wet; converge the wet/dry boundary toward it
    for (let i = 0; i < 30; i++) {
      const mid = (a + b) / 2;
      if (wet(mid)) b = mid;
      else a = mid;
    }
    return (a + b) / 2;
  };
  // coarse scan for the wet bracket, then converge both ends
  const NSCAN = 64;
  let kLo = -1,
    kHi = -1;
  for (let k = 0; k <= NSCAN; k++) {
    if (!wet((xf * k) / NSCAN)) continue;
    if (kLo < 0) kLo = k;
    kHi = k;
  }
  if (kLo < 0 || kHi - kLo < 2) return null;
  const xAft =
      kLo === 0 ? 0 : bisect((xf * (kLo - 1)) / NSCAN, (xf * kLo) / NSCAN),
    xFwd =
      kHi === NSCAN ? xf : bisect((xf * (kHi + 1)) / NSCAN, (xf * kHi) / NSCAN);
  if (!(xFwd - xAft > 0)) return null;
  // inset the sampled span a hair so the endpoint stations are decisively wet: sampling AT the bisected
  // boundary lands on a marginal section that may or may not survive the wetness test, and a dropped
  // endpoint would put the first kept station back on a grid-dependent lattice.
  const eps = (xFwd - xAft) * 1e-4,
    x0 = xAft + eps,
    x1 = xFwd - eps;
  interface Sta {
    x: number;
    imms: number[]; // immersion (depth below the WL, >0 submerged) per polyline point
    ys: number[]; // |half-breadth| per polyline point
    girth: number; // full wetted girth (both sides), for the wetted area
  }
  const stas: Sta[] = [];
  let draft = 0;
  for (let k = 0; k <= nx; k++) {
    const x = x0 + ((x1 - x0) * k) / nx,
      sec = clippedSection(model, x, m);
    if (sec.aft) continue;
    const imms = sec.pts.map((p) => immersion(model, p[0], p[2])),
      dmax = Math.max(...imms);
    if (dmax <= 0) continue; // dry section
    let girthH = 0;
    for (let i = 0; i < sec.pts.length - 1; i++) {
      const ia = imms[i],
        ib = imms[i + 1];
      if (ia <= 0 && ib <= 0) continue;
      // wetted fraction of the segment (clip a straddling segment at the waterline)
      let f = 1;
      if (ia < 0) f = ib / (ib - ia);
      else if (ib < 0) f = ia / (ia - ib);
      const a = sec.pts[i],
        b = sec.pts[i + 1];
      girthH += f * Math.hypot(b[1] - a[1], b[2] - a[2]);
    }
    draft = Math.max(draft, dmax);
    stas.push({
      x,
      imms,
      ys: sec.pts.map((p) => Math.abs(p[1])),
      girth: 2 * girthH,
    });
  }
  if (stas.length < 3 || !(draft > 0)) return null;
  const dz = draft / nz;
  const Y = stas.map((s) => {
    const row = new Float64Array(nz + 1);
    for (let i = 0; i < s.imms.length - 1; i++) {
      const ia = s.imms[i],
        ib = s.imms[i + 1];
      if (ia === ib) continue;
      const lo = Math.min(ia, ib),
        hi = Math.max(ia, ib);
      const j0 = Math.max(0, Math.ceil(lo / dz)),
        j1 = Math.min(nz, Math.floor(hi / dz));
      for (let j = j0; j <= j1; j++) {
        const t = (j * dz - ia) / (ib - ia),
          y = lerp(s.ys[i], s.ys[i + 1], t);
        if (y > row[j]) row[j] = y;
      }
    }
    return row;
  });
  let wsa = 0;
  for (let i = 0; i < stas.length - 1; i++)
    wsa +=
      ((stas[i].girth + stas[i + 1].girth) / 2) * (stas[i + 1].x - stas[i].x);
  const xs = stas.map((s) => s.x),
    n = xs.length;
  // Per level: is the hull's aft end at this depth the transom's rake plane (a dry-transom cut) or a
  // natural fade (rocker / bow)? Decided from GEOMETRY, not from the sampled Y pattern — the fanned
  // station planes smear the transom edge over a small x-range, so a pattern-based test flips with the
  // grid spacing and the two resolutions would compute different physical models. Here: find the plane's
  // x at this depth; if the hull is present at the first station forward of it, the level is cut there —
  // the domain starts at (cutX, cutY) with cutY extrapolated from the two stations forward (clamped ≥ 0)
  // — and `first` points at that station, dropping the sliver stations in the smear zone aft of the
  // plane. Otherwise the hull ends naturally forward of the plane: cutX = NaN, `first` is the first
  // hull-bearing station, and the smooth emergence ramp is kept.
  const first = new Int32Array(nz + 1).fill(-1),
    cutX = new Float64Array(nz + 1).fill(NaN),
    cutY = new Float64Array(nz + 1);
  const sinR = Math.sin(model.deckRake),
    cosR = Math.cos(model.deckRake);
  for (let j = 0; j <= nz; j++) {
    // transom-plane x at this depth: solve x = xTransom(z) with worldZ(x, z) = −(waterline + ζ_j)
    // (xTransom is linear in z and the rake coupling is weak, so the fixed point converges immediately)
    let xc = xs[0];
    for (let it = 0; it < 3; it++)
      xc = xTransom(model, (-(model.waterline + j * dz) - xc * sinR) / cosR);
    xc = Math.max(xc, xs[0]); // a plane aft of the wetted span cannot cut it
    let is = -1;
    for (let i = 0; i < n; i++)
      if (xs[i] >= xc) {
        is = i;
        break;
      }
    if (is >= 0 && is < n - 1 && Y[is][j] > 0) {
      // hull present right at the plane ⇒ transom-cut level
      first[j] = is;
      cutX[j] = xc;
      cutY[j] = Math.max(
        0,
        Y[is][j] +
          ((Y[is + 1][j] - Y[is][j]) * (xc - xs[is])) / (xs[is + 1] - xs[is]),
      );
    } else {
      for (let i = 0; i < n; i++)
        if (Y[i][j] > 0) {
          first[j] = i;
          break;
        }
    }
  }
  return {
    xs,
    Y,
    nz,
    dz,
    first,
    cutX,
    cutY,
    lwl: xs[n - 1] - xs[0],
    draft,
    wettedArea: wsa,
  };
}

// ∫₀^h (1−s/h)e^{−a(ζ₀+s)}ds = e^{−aζ₀}·h·φ0(ah) and ∫₀^h (s/h)e^{−a(ζ₀+s)}ds = e^{−aζ₀}·h·φ1(ah):
// the closed-form z-panel weights for a linear integrand against the depth kernel. Series below
// t = 0.01, where the direct expressions lose digits to cancellation.
function phi01(t: number): [number, number] {
  if (t < 0.01) {
    const p0 = 0.5 - t / 6 + (t * t) / 24 - (t * t * t) / 120,
      p1 = 0.5 - t / 3 + (t * t) / 8 - (t * t * t) / 30;
    return [p0, p1];
  }
  const e = Math.exp(-t),
    tt = t * t;
  return [(t - 1 + e) / tt, (1 - (1 + t) * e) / tt];
}

// |F(λ)|² for one λ. Per depth level, the x-integral H(ζ_j) = ∫(∂Y/∂x)e^{iκx}dx is exact per panel for
// the piecewise-linear Y — starting, at a transom-cut level, from the exact rake-line boundary (the
// partial panel from (cutX, cutY) to the first station). The depth integral F = ∫e^{−aζ}H(ζ)dζ then
// folds the levels with the closed-form panel weights; H(ζ) is smooth in ζ (the cut boundary moves
// continuously with depth), so its piecewise-linear representation converges cleanly even at a transom.
function spectrum2(g: CenterplaneGrid, k0: number, lam: number): number {
  const a = k0 * lam * lam,
    kap = k0 * lam,
    { nz, dz, xs, Y, first, cutX, cutY } = g,
    n = xs.length;
  const t = a * dz,
    [p0, p1] = phi01(t),
    r = Math.exp(-t);
  // level weights: level j takes φ0 from the panel below it and φ1 from the panel above it. Both
  // exponentials are carried forward (no division by r — it underflows to 0 at extreme kernel decay).
  const lev = new Float64Array(nz + 1);
  let rj = 1, // r^j = e^{−a·ζ_j}
    rjm = 1; // r^{j−1}
  for (let j = 0; j <= nz; j++) {
    let w = 0;
    if (j < nz) w += p0 * rj;
    if (j > 0) w += p1 * rjm;
    lev[j] = dz * w;
    rjm = rj;
    rj *= r;
  }
  const cs = new Float64Array(n),
    sn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cs[i] = Math.cos(kap * xs[i]);
    sn[i] = Math.sin(kap * xs[i]);
  }
  // per x-panel: ∫slope·e^{iκx}dx = slope·(e^{iκx₊} − e^{iκx₋})/(iκ) ⇒ with e^{iκx} = c+is: (Δs − iΔc)/κ
  let fre = 0,
    fim = 0;
  for (let j = 0; j <= nz; j++) {
    const w = lev[j];
    if (w === 0) continue; // kernel dead this deep — skip the level
    const i0 = first[j];
    if (i0 < 0) continue;
    let hre = 0,
      him = 0,
      start = Math.max(0, i0 - 1); // include the natural-emergence ramp panel
    if (!Number.isNaN(cutX[j])) {
      // dry-transom cut: exact partial panel from the rake line to the first station, no closure aft
      const dx = xs[i0] - cutX[j];
      if (dx > 1e-9) {
        const slope = (Y[i0][j] - cutY[j]) / dx,
          cc = Math.cos(kap * cutX[j]),
          ss = Math.sin(kap * cutX[j]);
        hre += (slope * (sn[i0] - ss)) / kap;
        him += (-slope * (cs[i0] - cc)) / kap;
      }
      start = i0;
    }
    for (let i = start; i < n - 1; i++) {
      const dy = Y[i + 1][j] - Y[i][j];
      if (dy === 0) continue;
      const slope = dy / (xs[i + 1] - xs[i]);
      hre += (slope * (sn[i + 1] - sn[i])) / kap;
      him += (-slope * (cs[i + 1] - cs[i])) / kap;
    }
    fre += w * hre;
    fim += w * him;
  }
  return fre * fre + fim * fim;
}

// C_w = R_w/(½ρU²S) at one Froude number (Fn on the waterline length), from a sampled grid
export function michellCw(g: CenterplaneGrid, fn: number): number {
  if (!(fn > 0) || !(g.lwl > 0) || !(g.wettedArea > 0)) return NaN;
  const k0 = 1 / (fn * fn * g.lwl);
  // λ cutoff: beyond λmax the kernel's surface layer e^{−k₀λ²ζ} has killed the spectrum (k₀λ²·draft ≥ 10)
  // and the remaining algebraic tail is negligible; λ ≥ 6 always, so moderate-Fn tails are honest too.
  const lamMax = Math.max(6, Math.sqrt(10 / (k0 * g.draft))),
    uMax = Math.sqrt(lamMax * lamMax - 1);
  // resolve the |F|² oscillation: its phase is ≈ k₀λ·LWL, so dλ ≈ 2πFn²/16 per sample (du ≤ dλ)
  const du0 = Math.min(0.05, (2 * Math.PI * fn * fn) / 16),
    nu = Math.min(8000, Math.max(64, Math.ceil(uMax / du0))),
    du = uMax / nu;
  let sum = 0;
  for (let i = 0; i <= nu; i++) {
    const u = i * du,
      lam = Math.sqrt(1 + u * u),
      w = i === 0 || i === nu ? 0.5 : 1;
    sum += w * spectrum2(g, k0, lam) * lam * du;
  }
  return ((8 * k0 * k0) / (Math.PI * g.wettedArea)) * sum;
}

export interface MichellCurve {
  fns: number[];
  cw: number[]; // C_w per Froude number (NaN where it can't be evaluated)
  lwl: number; // model units — dimensionalize with the display scale
  wettedArea: number;
}

// the C_w(Fn) curve for a prepared model; null when the hull has no wetted sections
export function michellCurve(
  model: Model,
  fns: number[],
  nx: number = NX,
  nz: number = NZ,
): MichellCurve | null {
  const g = centerplaneGrid(model, nx, nz);
  if (!g) return null;
  return {
    fns,
    cw: fns.map((fn) => michellCw(g, fn)),
    lwl: g.lwl,
    wettedArea: g.wettedArea,
  };
}
