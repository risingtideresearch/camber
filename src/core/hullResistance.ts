// ---------- Model/Hydro → HullGeometry adapters ----------
//
// Bridges this app's hull representation to the geometry-agnostic resistance module. These are the only
// places that know both the app's Model/Hydro types AND the resistance spec, so they own the model-unit →
// metre scaling (the resistance module speaks real SI only). `fromDimensions` (the scant tier) lives in
// the resistance module itself since it needs neither.

import { L, type Model } from "./model";
import { hydrostatics, type Hydro } from "./hydro";
import type { HullGeometry, Provenance } from "resistance";
import type { Unit } from "../components/MetricsPanel";

// model-unit → metre factor: the metrics LOA over the model's reference length, times the ft→m conversion
export const linScale = (loa: number, unit: Unit): number =>
  (loa / L) * (unit === "m" ? 1 : 0.3048);

// everything hydrostatics reports is measured from the surfaces, hence "given"
const MEASURED: Provenance = {
  vol: "given",
  cp: "given",
  cm: "given",
  cwp: "given",
  lcbPct: "given",
  halfEntrance: "given",
  wettedArea: "given",
  deadrise: "given",
};

// coefficient-tier spec: measured hydrostatics scaled to metres (no Michell — the caller adds it)
export function fromHydrostatics(h: Hydro, lin: number): HullGeometry {
  const amid = (h.xAft + h.xFwd) / 2;
  return {
    lwl: h.lwl * lin,
    beam: h.bwl * lin,
    draft: h.draft * lin,
    vol: h.vol * lin ** 3,
    cp: h.cp,
    cm: h.cm,
    cwp: h.cw,
    lcbPct: (100 * (h.lcb - amid)) / h.lwl,
    halfEntrance: h.halfEntrance,
    wettedArea: h.wettedArea * lin ** 2,
    deadrise: h.deadrise,
    provenance: { ...MEASURED },
  };
}

// convenience: run hydrostatics on a model and scale to a HullGeometry in one call. Returns null when the
// waterplane is invalid or LOA is unset.
export function fromModel(
  model: Model,
  opts: { loa: number; unit: Unit },
): HullGeometry | null {
  const h = hydrostatics(model);
  if (!h || !h.validWaterplane || !(opts.loa > 0)) return null;
  return fromHydrostatics(h, linScale(opts.loa, opts.unit));
}
