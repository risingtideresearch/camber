// ---------- camber hull → the `resistance` module's HullGeometry ----------
//
// The `resistance` module (Holtrop-Mennen + Savitsky, blended) knows nothing about hulls — it consumes one
// flat, full-scale SI record of principal dimensions and form coefficients. Camber has all of them measured,
// which puts it on the TOP rung of that module's fidelity ladder: nothing here goes through `fromDimensions`,
// because every field it would estimate from a regression is something hydrostatics() has already integrated
// off the actual surface. That matters more than it sounds — the module's own README warns that Benford
// predicts C_M ≈ 0.93 for a hull whose true C_M is 0.63, and a constant-camber hull is exactly the kind of
// unconventional form those regressions were not fitted to.
//
// The only conversion is of units. hydrostatics() works in MODEL units; the resistance methods are absolute
// (a 4 m hull and a 40 m hull are not the same problem at the same Froude number, because Reynolds number
// does not scale with Froude), so lengths are scaled by s = metres per model unit, areas by s² and volume
// by s³.

import type { HullGeometry, Provenance } from "resistance";
import { hydrostatics, type Hydro } from "./hydro";
import { unitScale } from "./json";
import type { Model } from "./model";

export interface HullSpec {
  geometry: HullGeometry;
  hydro: Hydro;
  lengthBeam: number; // L/B — the planing-capability gate's input, worth reporting next to the answer
}

// Every field below is measured off the hull, so the provenance record says so and `result.warnings` stays
// quiet about estimates. It is still built explicitly rather than left empty: the panel prints what was
// measured, and an empty record would read as "nothing known" rather than "everything known".
const MEASURED = [
  "draft",
  "vol",
  "cm",
  "cp",
  "cwp",
  "lcbPct",
  "wettedArea",
] as const;

export function hullGeometryOf(model: Model): HullSpec | null {
  const h = hydrostatics(model);
  if (!h || !h.validWaterplane || !(h.lwl > 0) || !(h.bwl > 0)) return null;
  const s = unitScale(model.unit, "m");
  if (!(s > 0)) return null;

  const provenance: Provenance = {};
  for (const k of MEASURED) provenance[k] = "given";
  // i_E and deadrise come off the hull too, but only when the geometry admits them — a section that never
  // closes on the centerline has no deadrise, and a bow that is already full-beam has no entrance angle.
  // Where they are NaN the methods fall back to their own internal estimates, which is exactly what an
  // "estimated" provenance is for.
  const iE = Number.isFinite(h.halfEntrance) ? h.halfEntrance : NaN;
  const deadrise = Number.isFinite(h.deadrise) ? h.deadrise : 15;
  provenance.halfEntrance = Number.isFinite(iE) ? "given" : "estimated";
  provenance.deadrise = Number.isFinite(h.deadrise) ? "given" : "estimated";

  // LCB as a percentage of LWL forward of amidships, which is the sign convention both Holtrop and the
  // Savitsky LCG use. Model units cancel, so this needs no scaling.
  const amid = (h.xAft + h.xFwd) / 2;
  const lcbPct = ((h.lcb - amid) / h.lwl) * 100;

  const geometry: HullGeometry = {
    lwl: h.lwl * s,
    beam: h.bwl * s,
    draft: h.draft * s,
    vol: h.vol * s ** 3,
    cp: h.cp,
    cm: h.cm,
    cwp: h.cw,
    lcbPct,
    halfEntrance: iE,
    wettedArea: h.wettedArea * s * s,
    // Savitsky wants the deadrise of the PLANING surface, aft. Camber measures it amidships, which is the
    // better-conditioned place to read it (the aft sections of a constant-camber hull are the flattest and
    // the least well determined by a least-squares slope) and is a fair proxy on a hull whose deadrise does
    // not warp much. Called out here because it is the one input that is a stand-in rather than a match.
    deadrise,
    // A_T drives Holtrop's transom-immersion term, and on the hulls camber draws it is not a detail: the
    // default hull's immersed transom is 0.48 m², larger than its own mean section. See hydro's
    // transomAreaOf for why this is integrated on the transom outline rather than read off the aftmost
    // station — the two are different quantities, and only this one converges.
    transomArea: h.transomArea * s * s,
    provenance,
  };
  return { geometry, hydro: h, lengthBeam: h.lwl / h.bwl };
}
