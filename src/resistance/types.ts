// ---------- resistance module: geometry spec + result types ----------
//
// A hull is described by one normalized, full-scale SI record: HullGeometry. It can be built at any
// fidelity — from scant principal dimensions (estimate.ts fills the coefficients) up to fully measured
// coefficients. The physics (holtrop / savitsky / blend) consumes only this record — it has no notion of
// a hull "model".

// how each field of a HullGeometry was obtained — for honest reporting of estimated vs measured inputs
export type Provenance = Record<string, "given" | "estimated">;

export interface HullGeometry {
  // principal dimensions (m, m³) — the required floor
  lwl: number;
  beam: number; // max waterline beam
  draft: number;
  vol: number; // displaced volume ∇

  // form coefficients
  cp: number;
  cm: number;
  cwp: number;
  lcbPct: number; // LCB as % of L forward of amidships (negative = aft)

  // secondary form (may be estimated by the methods themselves when absent)
  halfEntrance: number; // deg; NaN → Holtrop estimates it
  wettedArea: number; // m²; ≤0 → Holtrop estimates it
  deadrise: number; // deg (planing); only used once a hull is planing-capable

  // planing / bulb extras (optional)
  transomArea?: number; // m²
  bulbArea?: number; // m²

  provenance: Provenance;
}

export interface ResistanceOptions {
  water?: "salt" | "fresh"; // default "salt"
  pc?: number; // lumped propulsive coefficient; default DEFAULT_PC
  spray?: number; // Savitsky whisker-spray fraction; default DEFAULT_SPRAY
  froudeNumbers?: number[]; // speed sweep (length-Froude); default FROUDES
}

export interface ResistancePoint {
  fn: number; // length Froude number
  kn: number; // speed in knots
  speed: number; // m/s
  fnVol: number; // volumetric Froude number (blend regime indicator)
  planingWeight: number; // w ∈ [0,1] applied in the blend
  rBlend: number; // blended resistance (N)
  brakeKW: number; // blended brake power (kW) — the primary estimate
  specificKWperT: number; // brake power per tonne of displacement (kW/t) — the size-robust metric
  brakeHoltrop: number; // per-method brake power (kW)
  brakeSavitsky: number; // NaN when the hull isn't planing-capable / below the band
}

export interface ResistanceResult {
  points: ResistancePoint[];
  holtropInRange: boolean; // Holtrop within its fitted envelope for this hull
  planingCapable: boolean; // form gate open (L/B low enough to plane)
  warnings: string[]; // estimated inputs, out-of-envelope extrapolation, etc.
}
