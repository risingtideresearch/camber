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
// The same KN identity that makes a second GZ curve free makes a whole FIELD of these free. Integrating
// GZ(φ) = KN(φ) − VCG·sin φ over 0…φ₁ splits into a term that depends only on the hull and the displacement
// and a term that depends only on VCG:
//
//     A(∇, VCG) = ∫₀^φ₁ KN(φ, ∇) dφ − VCG·(1 − cos φ₁)
//
// So one integration per displacement answers the criterion at EVERY VCG, and — because A is exactly linear
// and strictly decreasing in VCG — the VCG that meets a stated area inverts in closed form. A contour of
// constant area on the displacement/KG chart is therefore drawn, not searched for.
//
// The integral is taken over the table's own heel angles, PCHIP-interpolated between them, so it is the same
// curve the panel plots rather than a separately sampled one. A φ₁ that falls between two heel angles closes
// the last interval on the straight line between them.

/** The heels the standard's area criteria run out to, in radians: 0.055 m·rad by 30°, 0.09 m·rad by 40°. */
export const GZ_AREA_HEEL_30 = 30 * DEG;
export const GZ_AREA_HEEL_40 = 40 * DEG;

/** The two terms of A(∇, VCG) = kn − VCG·vcg, in MODEL units·radians. */
export interface GzAreaTerms {
  readonly kn: number; // ∫ KN dφ at this displacement; NaN where the displacement is off the table
  readonly vcg: number; // 1 − cos φ₁ — the coefficient the centre of gravity enters with
}

export function gzAreaTerms(
  cc: CrossCurves,
  vol: number,
  upTo: number = GZ_AREA_HEEL_30,
): GzAreaTerms {
  const vcg = 1 - Math.cos(upTo);
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
    if (!Number.isFinite(kn)) return { kn: NaN, vcg };
    phis.push(phi);
    kns.push(kn);
  }
  // the table must actually span 0…φ₁; anything less would be a partial area reported as a whole one
  if (
    phis.length < 2 ||
    phis[0] > 1e-12 ||
    phis[phis.length - 1] < upTo - 1e-12
  )
    return { kn: NaN, vcg };

  // integrate the interpolant exactly: over one interval the cubic Hermite has area h·(y₀+y₁)/2 +
  // h²·(m₀−m₁)/12, which is the trapezoid plus the correction the end slopes imply.
  const m = pchipSlopes(phis, kns);
  let kn = 0;
  for (let i = 0; i < phis.length - 1; i++) {
    const h = phis[i + 1] - phis[i];
    kn += (h * (kns[i] + kns[i + 1])) / 2 + (h * h * (m[i] - m[i + 1])) / 12;
  }
  return { kn, vcg };
}

/** The area under GZ out to `upTo` for one loading condition (model units·radians). */
export function gzArea(
  cc: CrossCurves,
  vol: number,
  vcg: number,
  upTo: number = GZ_AREA_HEEL_30,
): number {
  const terms = gzAreaTerms(cc, vol, upTo);
  return terms.kn - vcg * terms.vcg;
}

/** The VCG at which this displacement's area is exactly `area` — the inverse of `gzArea`, in closed form. */
export function vcgForGzArea(terms: GzAreaTerms, area: number): number {
  return (terms.kn - area) / terms.vcg;
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
