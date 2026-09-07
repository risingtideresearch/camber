// ---------- the hull's own numbers, as a weight sheet reads them ----------
//
// Camber's computation of the sheet's hull measurements. The geometry-independent HULL.* catalogue
// now lives in `analysis/hullMetrics.ts`; the re-export below preserves existing callers. This module
// alone turns a Model/sweep into that shared schema.
//
// Three things are settled here rather than at each call site:
//
//   UNITS. A document is drawn in whatever unit its author chose — a 5 m hull in millimetres runs x from 0 to
//   5000 — while a weight sheet works in METRES and KILOGRAMS and nothing else. Every length below is scaled
//   on the way out (areas by s², volumes by s³), so `HULL.LWL` is a number of metres whatever the drawing is
//   in, and a formula never has to know or ask.
//
//   THE FRAME. Every POSITION is x forward from the transom and height above the keel baseline — the frame a
//   slice's centroid and a point's coordinates are already in. The geometry works in model coordinates where
//   neither datum sits at zero, and both are taken off at the bottom of `hullMetrics`. This is what lets one
//   moment sum mix the hull's own shell with the points beside it: `Weights.shell * HULL.SHELL_CG` and
//   `Weights.engine * engine` are measured from the same place, so adding them means something.
//
//   CERTAINTY. Every one of these is EXACT. The hull is drawn, not guessed: its wetted area is whatever the
//   geometry says it is, to the accuracy of the integration. Uncertainty enters a sheet only through the ±
//   literals the user types, which is what keeps the sensitivity list a list of the designer's own guesses.
//
// ---------- the whole shell, from a cut below the keel ----------
//
// `cut` accumulates `wsa` over SKIN edges only — the centerline, the deck cap and the transom face are
// closures of the region, not hull surface — so a cut taken with its waterplane above the highest point of
// the hull returns the area of the ENTIRE trimmed shell, and the volume of everything inside it. That is
// exactly `SHELL_AREA` (what a shell weight is estimated from: area × areal density) and `HULL_VOL` (the
// moulded volume up to the sheer), for one extra cut and no new integration code. `test/sheet.ts` pins both
// against the triangle mesh the STL exporter writes.

import { hydrostatics, type Hydro } from "./hydro";
import { unitScale } from "./lengthUnits";
import type { HullSampling } from "./mesh";
import type { Model } from "./model";
import { cut, heightSpan, stationGeometry } from "./sweep";
import { loa } from "./hull";

import { HULL_METRICS, type HullMetrics } from "../analysis/hullMetrics";
export * from "../analysis/hullMetrics";

/**
 * Measure the hull.
 *
 * `sampling` is the hull already swept, so this costs one extra `cut` on top of the hydrostatics the caller
 * wanted anyway. Whole-shell measurements remain available without reference hydrostatics;
 * unavailable hydrostatic leaves carry reasons and fail locally at the formula boundary.
 */
export function hullMetrics(
  model: Model,
  sampling: HullSampling,
  hydro: Hydro | null = null,
): HullMetrics | null {
  const geom = stationGeometry(model, sampling);
  if (!geom) return null;
  const h = hydro ?? hydrostatics(model, sampling);

  // Metres per model unit, and its powers for the area and volume integrals.
  const s = unitScale(model.unit, "m");
  const s2 = s * s;
  const s3 = s2 * s;

  // The whole shell: put the waterplane above everything and cut. `heightSpan` brackets the hull's heeled
  // heights, so `hi` plus a hair is a waterline nothing pokes through. The margin is scaled by the span so it
  // works on a hull drawn in millimetres and one drawn in feet alike.
  const [lo, hi] = heightSpan(geom, 0);
  const submerged = cut(geom, 0, hi + Math.max(1e-6, (hi - lo) * 1e-3));

  // ---------- one frame, stated once ----------
  //
  // Every POSITION below is measured from the same two datums as a slice's centroid and a point's
  // coordinates: x forward from the transom, height above the keel baseline. The hull's own arithmetic works
  // in model coordinates, where neither datum is at zero — the plan starts at whatever x its first control
  // point was drawn at, and the keel sits at some negative height under a deck-flat datum — so both are
  // taken off here, at the boundary, and nothing downstream ever sees them.
  //
  // That boundary is the whole point of this module. A sheet writes `Weights.shell * HULL.SHELL_CG` beside
  // `Weights.engine * engine` and the two land in one frame, so the moment sum means something. Reporting a
  // model x here instead would leave the hull's own terms offset from every other term by the plan's origin
  // — silently, and by exactly zero on a hull that happens to be drawn from x = 0, which is most of them.
  const x0 = model.plan.at(0)[0];
  const alongHull = (x: number): number => (x - x0) * s;
  const aboveKeel = (worldZ: number): number => (worldZ - geom.keelZ) * s;

  const values: HullMetrics = {
    loa: loa(model) * s,
    lwl: (h?.lwl ?? NaN) * s,
    bwl: (h?.bwl ?? NaN) * s,
    draft: (h?.draft ?? NaN) * s,
    waterline: model.waterline * s,
    deckRakeDeg: (model.deckRake * 180) / Math.PI,
    dispVol: (h?.vol ?? NaN) * s3,
    wsa: (h?.wettedArea ?? NaN) * s2,
    waterplaneArea: (h?.waterplaneArea ?? NaN) * s2,
    midshipArea: (h?.midshipArea ?? NaN) * s2,
    maxSectionArea: (h?.maxSectionArea ?? NaN) * s2,
    lcb: alongHull(h?.lcb ?? NaN),
    lcf: alongHull(h?.lcf ?? NaN),
    kb: (h?.kb ?? NaN) * s,
    bmt: (h?.bmt ?? NaN) * s,
    kmt: (h?.kmt ?? NaN) * s,
    cb: h?.cb ?? NaN,
    cp: h?.cp ?? NaN,
    cm: h?.cm ?? NaN,
    cw: h?.cw ?? NaN,
    deadrise: h?.deadrise ?? NaN,
    halfEntrance: h?.halfEntrance ?? NaN,
    shellArea: submerged.wsa * s2,
    hullVol: submerged.vol * s3,
    shellLcg: alongHull(submerged.wsaX),
    shellVcg: aboveKeel(submerged.wsaZWorld),
  };
  const unavailable = Object.fromEntries(
    HULL_METRICS.filter((spec) => !Number.isFinite(spec.read(values))).map(
      (spec) => [
        spec.name,
        h
          ? "not defined at this reference waterline"
          : "the hull does not float at its reference waterline",
      ],
    ),
  );
  return Object.keys(unavailable).length ? { ...values, unavailable } : values;
}
