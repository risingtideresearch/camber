// ---------- large-angle stability: the cross curves (KN) and the GZ curve at a given ∇ and VCG ----------
//
// `hydro.ts` answers the UPRIGHT question — what floats at the model's design waterline, with stability
// stopping at the small-angle KMt. This module answers the heeled one: how much righting arm the hull has at
// 5°, 40°, 70°, for a stated displacement and centre of gravity. Both cut the hull with `sweep.ts`, which
// owns the integration; this module owns only what to do with the answers.
//
// The whole design turns on one identity. Heel the hull to φ; buoyancy acts vertically upward through the
// heeled centre of buoyancy B. Drop a perpendicular onto that line of action from G and you get GZ, the
// righting arm; drop it from K — the keel point, on the centerline at the baseline — and you get KN:
//
//     KN(φ, ∇) = y_B·cos φ + z_B·sin φ            (B measured from K)
//     GZ(φ, ∇, VCG) = KN(φ, ∇) − VCG·sin φ
//
// K is fixed by the hull's geometry; G moves with every loading condition. So KN depends only on hull shape,
// heel and displacement — and VCG never enters the flotation solve at all. That is what makes a whole family
// of (∇, VCG) pairs cheap: build the KN table ONCE, and every GZ curve after it is an interpolation plus a
// subtraction. Nothing about the second step is approximate; it is the identity above.
//
// The table is built by MARCHING, not by root-finding. `stationGeometry` is waterline-independent, so the
// hull is sampled once and every heel angle and every sinkage after it re-cuts those same cached points. ∇
// is monotone in the waterline height, so sweeping the waterline from "dry" to "fully immersed" and
// recording (∇, KN) at each step produces a table that inverts directly: to get KN at a target ∇ you
// interpolate it, rather than solving for the waterline that produces it. No convergence logic, and no
// failure mode at large heel where the waterplane degenerates — a vanishing waterplane is just a flat spot.
//
// Units are MODEL units throughout: ∇ in units³ and KN / GZ / VCG in units. `vol` here is the same quantity
// `Hydro.vol` reports (both come from `sweep.ts`), and VCG is measured above the same keel baseline.
//
// What is assumed, and what it costs:
//
//   • FIXED TRIM. The hull heels at the model's own deckRake; it is not free to trim as it heels. This is
//     the one real modelling assumption here, and the first thing to revisit. Free trim would make each
//     (φ, ∇) a 2×2 balance — a genuine root-find — and would re-introduce a weak VCG coupling (G's world-x
//     shifts by z_G·sin θ), which is exactly the term standard KN tabulation neglects.
//   • WATERTIGHT TO THE SHEER. Past the angle where the deck edge goes under, the hull as modelled is open,
//     so the immersed section is closed by a flat cap across the sheer. `deckDown` flags every table entry
//     where that cap is carrying load — beyond it the numbers describe a hull with a deck on it.
//   • Heel needs no new approximation. It rotates about the longitudinal axis, so within a station plane it
//     only tilts the waterline into a straight slanted cut of the outline already there. Nothing here is
//     worse at 70° than it is at 0°.

import { type Model } from "./model";
import { type HullSampling } from "./mesh";
import { cut, heightSpan, stationGeometry, type StationGeom } from "./sweep";
import { hermiteEval, pchipSlopes } from "./pchip";

const STEPS = 32; // sinkage steps per heel angle — the table's resolution in ∇
const HEEL_STEP = 5; // default heel spacing, degrees
const HEEL_MAX = 90;

const DEG = Math.PI / 180;

export interface CrossCurves {
  keelZ: number; // K — the world height (at zero heel) that VCG and KN are measured above
  heel: number[]; // heel angles, RADIANS, ascending
  // per heel angle, the sinkage march. `vol` is strictly increasing, so `kn` inverts against it directly.
  vol: number[][]; // ∇ at each step (model units³)
  kn: number[][]; // KN at each step (model units)
  wl: number[][]; // the waterline's world height at each step
  deckDown: boolean[][]; // the sheer is submerged somewhere — the watertight cap is carrying load
  sheerZ: number[]; // lowest heeled sheer height at each heel angle
  knSlope: number[][]; // PCHIP slopes of kn against vol, precomputed so many lookups stay cheap
  wlSlope: number[][]; // PCHIP slopes of waterline height against vol, for sheer-clearance lookup
}

export interface CrossCurveOpts {
  heel?: number[]; // heel angles in DEGREES (default 0…90 by 5); sorted and de-duplicated
  steps?: number; // sinkage steps per heel angle
}

// One immersed condition: the hull cut by a heeled waterplane at a stated height.
export interface Immersed {
  vol: number; // ∇
  yB: number; // transverse centre of buoyancy (hull frame, + to starboard)
  zB: number; // vertical centre of buoyancy ABOVE the keel baseline
  kn: number; // y_B·cos φ + z_B·sin φ
  deckDown: boolean; // the lowest sheer point is under the waterline
  sheerZ: number; // lowest heeled sheer height
}

export { stationGeometry, type StationGeom };

// Cut the hull with the waterplane heeled to φ and sitting at world height `wlZ`. φ > 0 heels to STARBOARD,
// so the immersed volume shifts to starboard with it — y_B > 0, KN > 0, a righting arm.
export function immersedAt(
  geom: StationGeom,
  heelRad: number,
  wlZ: number,
): Immersed {
  const c = cut(geom, heelRad, wlZ);
  const zB = c.zBWorld - geom.keelZ;
  return {
    vol: c.vol,
    yB: c.yB,
    zB,
    kn: c.yB * Math.cos(heelRad) + zB * Math.sin(heelRad),
    deckDown: c.deckDown,
    sheerZ: c.sheerZ,
  };
}

// ---------- the KN table ----------

// `sampling` is the hull already swept — see `stationGeometry`. Use STABILITY_NS / STABILITY_GIRTH if there
// is no sampling to hand; reuse the host's if there is. The whole table comes off this ONE sweep.
export function crossCurves(
  model: Model,
  sampling: HullSampling,
  opts: CrossCurveOpts = {},
): CrossCurves | null {
  const geom = stationGeometry(model, sampling);
  if (!geom) return null;
  const steps = Math.max(4, Math.round(opts.steps ?? STEPS));
  const heel = (
    opts.heel ??
    Array.from(
      { length: Math.floor(HEEL_MAX / HEEL_STEP) + 1 },
      (_, i) => i * HEEL_STEP,
    )
  )
    .map((d) => d * DEG)
    .sort((a, b) => a - b)
    .filter((v, i, a) => i === 0 || v > a[i - 1] + 1e-12);

  const out: CrossCurves = {
    keelZ: geom.keelZ,
    heel,
    vol: [],
    kn: [],
    wl: [],
    deckDown: [],
    sheerZ: [],
    knSlope: [],
    wlSlope: [],
  };

  for (const phi of heel) {
    const [hMin, hMax] = heightSpan(geom, phi);
    const vol: number[] = [],
      kn: number[] = [],
      wl: number[] = [],
      dd: boolean[] = [];
    let sheerZ = Infinity;
    for (let k = 0; k <= steps; k++) {
      const wlZ = hMin + ((hMax - hMin) * k) / steps,
        im = immersedAt(geom, phi, wlZ);
      sheerZ = im.sheerZ;
      // keep the table strictly increasing in ∇ so it inverts: a fine keel or a flat bottom can hold ∇
      // still over several steps, and a repeated abscissa has no inverse.
      if (vol.length && im.vol <= vol[vol.length - 1] + 1e-12) continue;
      vol.push(im.vol);
      kn.push(im.kn);
      wl.push(wlZ);
      dd.push(im.deckDown);
    }
    out.vol.push(vol);
    out.kn.push(kn);
    out.wl.push(wl);
    out.deckDown.push(dd);
    out.sheerZ.push(sheerZ);
    out.knSlope.push(vol.length >= 2 ? pchipSlopes(vol, kn) : [0]);
    out.wlSlope.push(vol.length >= 2 ? pchipSlopes(vol, wl) : [0]);
  }
  return out;
}

// KN at heel index `i` and displaced volume `vol`, monotonically interpolated across the table. NaN outside
// the hull's range — below it the hull does not float at all, above it there is no more hull to immerse —
// so an impossible displacement shows up as N/A rather than as a silently extrapolated number.
export function knAt(cc: CrossCurves, i: number, vol: number): number {
  const xs = cc.vol[i],
    ys = cc.kn[i];
  if (!xs || xs.length < 2) return NaN;
  if (vol < xs[0] || vol > xs[xs.length - 1]) return NaN;
  return hermiteEval(xs, ys, cc.knSlope[i], vol);
}

export interface GzPoint {
  heel: number; // radians
  gz: number; // righting arm, model units (NaN where the displacement is off the table)
  deckDown: boolean; // the deck edge is under at this condition
}

// The GZ curve for one (displacement, VCG) pair. `vol` is ∇ in model units³ — the same quantity `Hydro.vol`
// reports — and `vcg` is the centre of gravity's height above the keel baseline.
//
// This is where the whole scheme pays off: no flotation is solved here. Every point is one interpolation in
// the KN table plus one subtraction, so a second VCG against the same displacement, or a whole matrix of
// loading conditions, costs essentially nothing on top of the table that already exists.
export function gzCurve(cc: CrossCurves, vol: number, vcg: number): GzPoint[] {
  return cc.heel.map((heel, i) => {
    const kn = knAt(cc, i, vol);
    // whether the deck is under at THIS displacement: read off the nearest table step at or above it
    const xs = cc.vol[i];
    let k = 0;
    while (k < xs.length - 1 && xs[k] < vol) k++;
    return {
      heel,
      gz: kn - vcg * Math.sin(heel),
      deckDown: cc.deckDown[i][k] ?? false,
    };
  });
}

// ---------- the envelope over a rectangle of conditions ----------
//
// A loading condition is rarely known to a single point. The lightship estimate carries a tolerance, the VCG
// estimate carries another, and the useful question is then not "what is the GZ curve" but "what band does
// every curve in that rectangle lie inside".
//
// VCG needs no search. GZ = KN − VCG·sin φ and sin φ ≥ 0 over 0…90°, so at every heel GZ is non-increasing
// in VCG: the highest curve of the family takes the LOWEST VCG and the lowest curve the highest. That half
// of the rectangle is exact rather than sampled — only its two VCG edges are ever evaluated.
//
// Displacement does need one. KN is not monotone in ∇ — a hull picks up righting arm as it immerses its
// flare and gives it back as it buries it — so the extreme can sit inside the interval rather than at either
// end, and the corners of the rectangle are not enough. What makes the scan cheap is that KN is a PCHIP over
// the sinkage march: `samples` points across ONE interval is at least as fine as the table underneath, which
// spans the hull's whole range in about as many steps.
//
// The two edges are POINTWISE extremes, so neither is the GZ curve of any single condition — the ∇ attaining
// the maximum at 20° need not be the one attaining it at 60°. They bound the family without belonging to it,
// which is why nothing that belongs to one condition — a peak, a deck-edge point — may be drawn on them.

export interface KnEnvelope {
  readonly min: number[]; // per heel row, the least KN over the displacement interval
  readonly max: number[]; // ...and the greatest
}

/**
 * The least and greatest KN over a displacement interval, one pair per tabulated heel.
 *
 * NaN for any heel row whose own march does not cover the whole interval: a bound taken over part of a range
 * is not a bound over that range. The rows genuinely stop short of one another at large heel, so a band that
 * ends before the curve it brackets is the honest picture rather than an edge case.
 */
export function knEnvelope(
  cc: CrossCurves,
  vol0: number,
  vol1: number,
  samples = 32,
): KnEnvelope {
  const lo = Math.min(vol0, vol1),
    hi = Math.max(vol0, vol1),
    steps = Math.max(1, Math.round(samples)),
    min: number[] = [],
    max: number[] = [];
  for (let i = 0; i < cc.heel.length; i++) {
    let least = Infinity,
      greatest = -Infinity;
    for (let k = 0; k <= steps; k++) {
      const kn = knAt(cc, i, lo + ((hi - lo) * k) / steps);
      if (!Number.isFinite(kn)) {
        least = greatest = NaN;
        break;
      }
      least = Math.min(least, kn);
      greatest = Math.max(greatest, kn);
    }
    min.push(least);
    max.push(greatest);
  }
  return { min, max };
}

export interface GzBound {
  heel: number; // radians
  lo: number; // the least righting arm anywhere in the rectangle, at this heel
  hi: number; // ...and the greatest
}

/**
 * The band every GZ curve in a displacement × VCG rectangle lies inside.
 *
 * `hi` takes the lowest VCG against the largest KN and `lo` the highest against the smallest, which is the
 * monotonicity above applied at each heel. A rectangle of zero extent returns the curve itself, twice.
 */
export function gzEnvelope(
  cc: CrossCurves,
  volRange: readonly [number, number],
  vcgRange: readonly [number, number],
  samples = 32,
): GzBound[] {
  const kn = knEnvelope(cc, volRange[0], volRange[1], samples),
    vcgLo = Math.min(vcgRange[0], vcgRange[1]),
    vcgHi = Math.max(vcgRange[0], vcgRange[1]);
  return cc.heel.map((heel, i) => {
    const sine = Math.sin(heel);
    return {
      heel,
      lo: kn.min[i] - vcgHi * sine,
      hi: kn.max[i] - vcgLo * sine,
    };
  });
}

// ---------- values and envelopes at a chosen heel ----------

/** KN at an arbitrary heel, linearly interpolated between the cross-curve heel rows. */
export function knAtHeel(cc: CrossCurves, vol: number, heel: number): number {
  if (
    !cc.heel.length ||
    !Number.isFinite(heel) ||
    heel < cc.heel[0] ||
    heel > cc.heel[cc.heel.length - 1]
  )
    return NaN;
  let hi = 0;
  while (hi < cc.heel.length && cc.heel[hi] < heel) hi++;
  if (hi === 0 || Math.abs(cc.heel[hi] - heel) < 1e-12)
    return knAt(cc, hi, vol);
  const lo = hi - 1,
    kn0 = knAt(cc, lo, vol),
    kn1 = knAt(cc, hi, vol),
    t = (heel - cc.heel[lo]) / (cc.heel[hi] - cc.heel[lo]);
  return Number.isFinite(kn0) && Number.isFinite(kn1)
    ? kn0 + t * (kn1 - kn0)
    : NaN;
}

/** GZ at a chosen heel for one displacement and VCG. */
export function gzAtHeel(
  cc: CrossCurves,
  vol: number,
  vcg: number,
  heel: number,
): number {
  return knAtHeel(cc, vol, heel) - vcg * Math.sin(heel);
}

/** VCG at which GZ is exactly `target` at the chosen heel. */
export function vcgForGzAtHeel(
  cc: CrossCurves,
  vol: number,
  heel: number,
  target = 0,
): number {
  const sine = Math.sin(heel),
    kn = knAtHeel(cc, vol, heel);
  return sine > 1e-12 && Number.isFinite(kn) ? (kn - target) / sine : NaN;
}

/** Waterline clearance below the lowest sheer at one tabulated heel; negative means immersed. */
export function sheerClearanceAt(
  cc: CrossCurves,
  heelIndex: number,
  vol: number,
): number {
  const xs = cc.vol[heelIndex],
    ys = cc.wl[heelIndex];
  if (!xs || xs.length < 2 || vol < xs[0] || vol > xs[xs.length - 1])
    return NaN;
  const wl = hermiteEval(xs, ys, cc.wlSlope[heelIndex], vol);
  return cc.sheerZ[heelIndex] - wl;
}

/** First positive heel at which the lowest sheer reaches the waterline, interpolated between heel rows. */
export function sheerImmersionAngle(cc: CrossCurves, vol: number): number {
  let previousHeel = NaN,
    previousClearance = NaN;
  for (let i = 0; i < cc.heel.length; i++) {
    const heel = cc.heel[i];
    if (heel < -1e-12) continue;
    const clearance = sheerClearanceAt(cc, i, vol);
    if (!Number.isFinite(clearance)) continue;
    if (clearance <= 0) {
      if (!Number.isFinite(previousClearance) || previousClearance <= 0)
        return heel;
      const t = previousClearance / (previousClearance - clearance);
      return previousHeel + t * (heel - previousHeel);
    }
    previousHeel = heel;
    previousClearance = clearance;
  }
  return NaN;
}

// ---------- maximum righting lever ----------

/** The largest tabulated righting lever and the heel at which it occurs. */
export function maximumGz(
  cc: CrossCurves,
  vol: number,
  vcg: number,
  minHeel = 0,
): GzPoint {
  let best: GzPoint = { heel: NaN, gz: NaN, deckDown: false };
  for (const point of gzCurve(cc, vol, vcg))
    if (
      point.heel >= minHeel - 1e-12 &&
      Number.isFinite(point.gz) &&
      (!Number.isFinite(best.gz) || point.gz > best.gz)
    )
      best = point;
  return best;
}

/**
 * The highest VCG at which the largest righting lever still occurs at or beyond `minHeel` — the KG bound
 * IMO's "angle of maximum GZ not less than 25°" puts on a displacement.
 *
 * Raising the centre of gravity subtracts VCG·sin φ, which grows with heel, so it takes more off the far end
 * of the curve than the near end and walks the peak DOWN the heel axis. Writing A(VCG) for the best arm at
 * or beyond `minHeel` and B(VCG) for the best below it, both are upper envelopes of straight lines whose
 * slopes are −sin φ over their own side of the split; every φ on A's side has a larger sine than every φ on
 * B's, so A falls strictly faster and A − B crosses zero exactly once. That crossing is the bound, and it is
 * bisected for here because both envelopes change which line they ride as VCG moves.
 *
 * Returns −Infinity where the peak is already early at VCG 0 — nothing complies — and NaN off the table.
 * The comparison is `maximumGz`'s own, so the contour and the reading beside it cannot disagree.
 */
export function vcgForMaximumGzHeel(
  cc: CrossCurves,
  vol: number,
  minHeel: number,
): number {
  const late = (vcg: number): boolean => {
    const peak = maximumGz(cc, vol, vcg);
    return Number.isFinite(peak.gz) && peak.heel >= minHeel - 1e-12;
  };
  if (!Number.isFinite(maximumGz(cc, vol, 0).gz)) return NaN;
  if (!late(0)) return -Infinity;
  // Once the best arm beyond `minHeel` is gone the peak cannot be there, so the VCG that takes it to zero
  // brackets the crossing from above — and it is already computed in closed form.
  const hi = vcgForMaximumGz(cc, vol, 0, minHeel);
  if (!Number.isFinite(hi)) return NaN;
  let lo = 0,
    top = Math.max(hi, lo);
  if (late(top)) return top; // the whole column complies; the bound is off the top of it
  for (
    let k = 0;
    k < 60 && top - lo > 1e-12 * Math.max(1, Math.abs(top));
    k++
  ) {
    const mid = (lo + top) / 2;
    if (late(mid)) lo = mid;
    else top = mid;
  }
  return (lo + top) / 2;
}

/**
 * VCG at which the largest GZ at or beyond `minHeel` is exactly `target`.
 *
 * Each heel contributes the straight boundary VCG = (KN − target) / sin φ. The condition only needs one
 * heel to reach the target, so their upper envelope is the limiting VCG. Zero heel is omitted because its
 * righting lever is identically zero and cannot be inverted against VCG.
 */
export function vcgForMaximumGz(
  cc: CrossCurves,
  vol: number,
  target: number,
  minHeel = 0,
): number {
  let vcg = -Infinity;
  for (let i = 0; i < cc.heel.length; i++) {
    const heel = cc.heel[i],
      sine = Math.sin(heel),
      kn = knAt(cc, i, vol);
    if (heel < minHeel - 1e-12 || sine <= 1e-12 || !Number.isFinite(kn))
      continue;
    vcg = Math.max(vcg, (kn - target) / sine);
  }
  return vcg;
}

// ---------- the area under the GZ curve ----------
//
// The dynamic criteria measure WORK, not arm: the area under GZ out to a stated heel is the energy the hull
// can absorb before it gives way, which is what a gust or a wave actually spends. IMO A.749 states two of
// them this way — at least 0.055 m·rad out to 30°, and at least 0.09 m·rad out to 40° (or to the
// downflooding angle, which is not modelled here). `upTo` is which of those is being asked for.
//
// ONLY POSITIVE GZ COUNTS. Past the angle of vanishing stability the hull is no longer storing energy a gust
// has to spend to push it further — it is spending its own, and it capsizes. Netting that lobe off against
// the reserve earned below would report one number for two quite different hulls: one that never gives way,
// and one that gives way and is then credited back for how hard it goes over. So the integrand is
// max(GZ, 0), and the range closes itself at the vanishing angle whether or not φ₁ has been reached.
//
// The price is the closed form. Signed, the integral splits into a hull term and VCG·(1 − cos φ₁), and the
// VCG meeting a stated area inverts in one line. Clipping breaks the split, because the upper limit of
// integration becomes itself a function of VCG. What survives is MONOTONICITY: raising VCG lowers GZ at
// every heel, so it lowers max(GZ, 0) at every heel too, so A is non-increasing in VCG and reaches exactly
// zero once the whole range is non-positive. That is enough to invert by bisection — and the signed closed
// form still earns its keep as the bracket to start from, since max(GZ, 0) ≥ GZ makes the signed answer a
// VCG that already has at least the area asked for.
//
// What is still bought once per displacement is the KN curve itself, which is where the table lookups are;
// that part does not depend on VCG, so the whole field on the chart is one lookup pass plus arithmetic.
//
// The interpolant is the table's own heel angles, PCHIP in φ — the same curve the panel plots rather than a
// separately sampled one. Each interval integrates exactly, off the Hermite cubic's own coefficients; where
// GZ changes sign inside one, the crossing is bisected and only the positive side contributes. A curve that
// went negative and back within a single 5° interval would be missed, which no righting arm does.

/** The heels the standard's area criteria run out to, in radians: 0.055 m·rad by 30°, 0.09 m·rad by 40°. */
export const GZ_AREA_HEEL_30 = 30 * DEG;
export const GZ_AREA_HEEL_40 = 40 * DEG;

/**
 * One displacement's KN curve over 0…φ₁, prepared for integration at any VCG.
 *
 * `phi` is empty where the displacement is off the table, or where the table does not span the whole range —
 * a partial area must not be reported as a whole one.
 *
 * `from` moves the LOWER limit of integration without shortening the interpolant, which is what the
 * standard's 30°–40° criterion needs: the curve is still the one drawn out to φ₁, so the part and the whole
 * are measured off the same cubic and A(φ₀…φ₁) + A(0…φ₀) is exactly A(0…φ₁). Truncating the abscissae at φ₀
 * instead would give the interval a different interpolant and the three numbers would not add up.
 */
export interface GzAreaTerms {
  readonly phi: readonly number[]; // heel abscissae, radians, 0…φ₁
  readonly kn: readonly number[]; // KN at each
  readonly slope: readonly number[]; // dKN/dφ — the PCHIP slopes the interpolant is drawn with
  readonly from: number; // φ₀ — where integration starts, 0 for a criterion measured from upright
  readonly upTo: number; // φ₁
}

const NO_GZ_AREA: GzAreaTerms = {
  phi: [],
  kn: [],
  slope: [],
  from: 0,
  upTo: NaN,
};

export function gzAreaTerms(
  cc: CrossCurves,
  vol: number,
  upTo: number = GZ_AREA_HEEL_30,
  from = 0,
): GzAreaTerms {
  const phis: number[] = [],
    kns: number[] = [];
  for (let i = 0; i < cc.heel.length; i++) {
    const phi = cc.heel[i],
      kn = knAt(cc, i, vol);
    if (phi > upTo) {
      // φ₁ lands inside this interval: close it on the chord to the angle past it. When φ₁ IS a table
      // angle it has already been pushed, and adding it again would repeat an abscissa.
      if (
        phis.length &&
        phis[phis.length - 1] < upTo - 1e-12 &&
        Number.isFinite(kn)
      ) {
        const phi0 = phis[phis.length - 1],
          kn0 = kns[kns.length - 1],
          t = (upTo - phi0) / (phi - phi0);
        phis.push(upTo);
        kns.push(kn0 + t * (kn - kn0));
      }
      break;
    }
    if (!Number.isFinite(kn)) return NO_GZ_AREA;
    phis.push(phi);
    kns.push(kn);
  }
  // the table must actually span 0…φ₁; anything less would be a partial area reported as a whole one
  if (
    phis.length < 2 ||
    phis[0] > 1e-12 ||
    phis[phis.length - 1] < upTo - 1e-12
  )
    return NO_GZ_AREA;
  if (!(from >= 0) || from >= upTo) from = 0;
  return { phi: phis, kn: kns, slope: pchipSlopes(phis, kns), from, upTo };
}

/**
 * The area under the POSITIVE part of GZ, for one prepared displacement at one VCG (model units·radians).
 *
 * Per interval, KN is the cubic Hermite c₀ + c₁t + c₂t² + c₃t³ in the local parameter t ∈ [0, 1], so
 * GZ(t) = that − VCG·sin(φ₀ + h·t) — a cubic and a sine, both of which integrate in closed form over any
 * part of the interval. All that is needed to clip is where GZ crosses zero.
 *
 * An interval only partly inside `terms.from`…`terms.upTo` is integrated over the part that is: the range
 * is clipped in the SAME local parameter as the vanishing angle, so a criterion starting mid-interval and a
 * curve giving way mid-interval are the same piece of arithmetic.
 */
export function gzAreaOf(terms: GzAreaTerms, vcg: number): number {
  const { phi, kn, slope, from } = terms;
  if (phi.length < 2 || !Number.isFinite(vcg)) return NaN;
  let total = 0;
  for (let i = 0; i < phi.length - 1; i++) {
    const phi0 = phi[i],
      h = phi[i + 1] - phi[i],
      y0 = kn[i],
      y1 = kn[i + 1],
      m0 = slope[i] * h,
      m1 = slope[i + 1] * h,
      c0 = y0,
      c1 = m0,
      c2 = -3 * y0 + 3 * y1 - 2 * m0 - m1,
      c3 = 2 * y0 - 2 * y1 + m0 + m1;
    // where this interval enters the criterion's range; the far end is always φ₁, which is the last abscissa
    const start = h > 0 ? Math.min(1, Math.max(0, (from - phi0) / h)) : 0;
    if (start >= 1) continue;
    const gzAt = (t: number) =>
      c0 + t * (c1 + t * (c2 + t * c3)) - vcg * Math.sin(phi0 + h * t);
    // ∫ GZ dφ over t ∈ [a, b]: the cubic term by term (dφ = h·dt), the sine as the difference of cosines
    const piece = (a: number, b: number) =>
      h *
        (c0 * (b - a) +
          (c1 * (b * b - a * a)) / 2 +
          (c2 * (b * b * b - a * a * a)) / 3 +
          (c3 * (b * b * b * b - a * a * a * a)) / 4) -
      vcg * (Math.cos(phi0 + h * a) - Math.cos(phi0 + h * b));

    const g0 = gzAt(start),
      g1 = gzAt(1);
    if (g0 >= 0 && g1 >= 0) {
      total += piece(start, 1);
      continue;
    }
    if (g0 <= 0 && g1 <= 0) continue; // wholly past the vanishing angle: contributes nothing
    // one sign change inside the interval — bisect for it and keep only the positive side
    let lo = start,
      hi = 1;
    for (let k = 0; k < 48; k++) {
      const mid = (lo + hi) / 2;
      if (gzAt(mid) > 0 === g0 > 0) lo = mid;
      else hi = mid;
    }
    const cross = (lo + hi) / 2;
    total += g0 > 0 ? piece(start, cross) : piece(cross, 1);
  }
  return total;
}

/** The area under the positive part of GZ over `from`…`upTo` for one loading condition (units·radians). */
export function gzArea(
  cc: CrossCurves,
  vol: number,
  vcg: number,
  upTo: number = GZ_AREA_HEEL_30,
  from = 0,
): number {
  return gzAreaOf(gzAreaTerms(cc, vol, upTo, from), vcg);
}

/**
 * The VCG at which this displacement's positive-GZ area is exactly `area` — the inverse of `gzAreaOf`.
 *
 * A is non-increasing in VCG and falls to zero at the VCG whose curve has no positive lobe left, so every
 * area above zero has exactly one crossing to find. The bracket below it comes for free: clipping can only
 * ADD area, so the signed integral's closed-form answer already has at least `area`. Over φ₀…φ₁ that signed
 * integral is ∫KN dφ − VCG·(cos φ₀ − cos φ₁), which is where the coefficient below comes from. From there
 * the search doubles outward until it runs out of area, then bisects. An area of zero or less asks instead
 * for the vanishing point itself, which is the same search against a strictly positive lobe.
 */
export function vcgForGzArea(terms: GzAreaTerms, area: number): number {
  if (terms.phi.length < 2) return NaN;
  if (area === -Infinity) return Infinity; // every VCG clears it — the open end of a shading band
  if (area === Infinity) return -Infinity; // no VCG reaches it — the other open end
  const target = area > 0 ? area : 0;
  // A(VCG) with no clipping is ∫KN dφ − VCG·(cos φ₀ − cos φ₁), and KN ≥ 0, so A(0) is that first term
  const knArea = gzAreaOf(terms, 0),
    coefficient = Math.cos(terms.from) - Math.cos(terms.upTo);
  if (!Number.isFinite(knArea) || coefficient <= 0) return NaN;
  let lo = (knArea - target) / coefficient;
  if (!(gzAreaOf(terms, lo) > target)) return lo;
  // outward until the area is gone; the lobe vanishes at a finite VCG, so this terminates
  let span = Math.max(Math.abs(lo), knArea / coefficient, 1e-9);
  let hi = lo + span;
  for (let k = 0; gzAreaOf(terms, hi) > target; k++) {
    if (k > 60) return NaN;
    span *= 2;
    hi = lo + span;
  }
  for (let k = 0; k < 60 && hi - lo > 1e-12 * Math.max(1, Math.abs(hi)); k++) {
    const mid = (lo + hi) / 2;
    if (gzAreaOf(terms, mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------- limiting KG for intact, upright stability ----------
//
// A floating condition is initially stable when M is above G: GMt = KMt − KG > 0. Therefore the limiting
// KG curve is simply KMt at each displacement. It is deliberately a different criterion from a positive GZ
// all the way to 90°: large-angle range and area criteria can later be drawn on the same displacement/KG
// axes, but must not be allowed to change what the green "statically stable" area means here.
export interface LimitingKgPoint {
  vol: number;
  kg: number; // KMt above the keel baseline
}

/**
 * KMt along the upright sinkage march already held by the cross-curve table.
 *
 * The waterplane inertia is requested only for these upright cuts. Entries after deck-edge immersion are
 * omitted because a capped/open hull no longer has the free waterplane needed to define a valid metacenter.
 */
export function limitingKgCurve(
  geom: StationGeom,
  cc: CrossCurves,
): LimitingKgPoint[] {
  const upright = cc.heel.findIndex((heel) => Math.abs(heel) < 1e-12);
  if (upright < 0) return [];
  const out: LimitingKgPoint[] = [];
  for (const wlZ of cc.wl[upright]) {
    const condition = cut(geom, 0, wlZ, true);
    if (condition.vol <= 1e-12 || condition.deckDown || !condition.wp) continue;
    const kb = condition.zBWorld - geom.keelZ;
    out.push({
      vol: condition.vol,
      kg: kb + condition.wp.it / condition.vol,
    });
  }
  return out;
}

/** Interpolate the limiting KMt at an arbitrary displacement inside the upright curve. */
export function limitingKgAt(
  curve: readonly LimitingKgPoint[],
  vol: number,
): number {
  if (curve.length < 2) return NaN;
  const xs = curve.map((point) => point.vol),
    ys = curve.map((point) => point.kg);
  if (vol < xs[0] || vol > xs[xs.length - 1]) return NaN;
  return hermiteEval(xs, ys, pchipSlopes(xs, ys), vol);
}
