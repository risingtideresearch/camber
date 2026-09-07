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
import { pchipSlopes } from "./pchip";
import type { CrossCurves, LimitingKgPoint } from "../analysis/stability";
export * from "../analysis/stability";

const STEPS = 32; // sinkage steps per heel angle — the table's resolution in ∇
const HEEL_STEP = 5; // default heel spacing, degrees
const HEEL_MAX = 90;

const DEG = Math.PI / 180;

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
