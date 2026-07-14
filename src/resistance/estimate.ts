// ---------- scant-geometry constructor ----------
//
// Build a full HullGeometry from the least you might have — principal dimensions and a displacement (or
// block coefficient) — filling the form coefficients with standard regressions and recording every
// filled field as "estimated". This is the worst-case tier: enough for Holtrop + Savitsky + the blend
// (the power answer), but with no wave sampler, so no Michell diagnostic. Provide any coefficient
// explicitly to override its estimate.
//
// Estimators (documented, first-order):
//   C_M  ← C_B   Benford:   C_M = 1/(1 + (1−C_B)^3.5)
//   C_P  = C_B / C_M
//   C_WP ← C_B   Schneekluth (U-form): C_WP = (1 + 2·C_B)/3
//   LCB, i_E, S, deadrise: sensible defaults (i_E and S are re-estimated inside Holtrop anyway).

import type { HullGeometry, Provenance } from "./types";

const RHO = { salt: 1025, fresh: 1000 };

export interface DimensionsInput {
  lwl: number; // m
  beam: number; // m
  draft: number; // m
  displacement?: number; // kg — provide this or `cb`
  cb?: number; // block coefficient — provide this or `displacement`
  water?: "salt" | "fresh"; // for displacement↔volume (default salt)
  // optional overrides (any measured value; otherwise estimated)
  cp?: number;
  cm?: number;
  cwp?: number;
  lcbPct?: number;
  halfEntrance?: number;
  wettedArea?: number;
  deadrise?: number;
  transomArea?: number;
  bulbArea?: number;
}

export function fromDimensions(input: DimensionsInput): HullGeometry {
  const { lwl, beam, draft } = input;
  const rho = RHO[input.water ?? "salt"];
  const provenance: Provenance = {};
  const mark = <T>(key: string, given: T | undefined, estimate: () => T): T => {
    if (given != null) {
      provenance[key] = "given";
      return given;
    }
    provenance[key] = "estimated";
    return estimate();
  };

  const hullBox = lwl * beam * draft;
  // volume + block coefficient: from displacement, or from an explicit C_B
  const vol = mark(
    "vol",
    input.displacement ? input.displacement / rho : undefined,
    () => (input.cb != null ? input.cb * hullBox : 0.5 * hullBox),
  );
  const cb = vol / hullBox;
  const cm = mark("cm", input.cm, () => 1 / (1 + (1 - cb) ** 3.5));
  const cp = mark("cp", input.cp, () => cb / cm);
  const cwp = mark("cwp", input.cwp, () => (1 + 2 * cb) / 3);

  return {
    lwl,
    beam,
    draft,
    vol,
    cp,
    cm,
    cwp,
    lcbPct: mark("lcbPct", input.lcbPct, () => -1.5),
    halfEntrance: mark("halfEntrance", input.halfEntrance, () => NaN), // Holtrop estimates
    wettedArea: mark("wettedArea", input.wettedArea, () => 0), // Holtrop estimates
    deadrise: mark("deadrise", input.deadrise, () => 15),
    transomArea: input.transomArea,
    bulbArea: input.bulbArea,
    provenance,
  };
}
