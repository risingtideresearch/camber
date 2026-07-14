// ---------- resistance assembly ----------
//
// Given a HullGeometry (full-scale SI) and options, sweep the speed range and blend Holtrop
// (displacement) with Savitsky (planing) by volumetric Froude number. If the geometry carries a
// wave-resistance sampler, also report a wave diagnostic curve (not part of the blended answer).
// Returns brake power per method plus the blended best estimate. Pure and framework-free.

import { holtrop, type HoltropShip } from "./holtrop";
import { savitsky, type SavitskyShip, DEFAULT_SPRAY } from "./savitsky";
import { blendResistance, planingCapability, BLEND_LO } from "./blend";
import type {
  HullGeometry,
  ResistanceOptions,
  ResistanceResult,
} from "./types";

const G = 9.80665; // m/s²
const TO_KN = 1.94384; // m/s → knots
const RHO = { salt: 1025, fresh: 1000 }; // kg/m³

// default lumped propulsive coefficient P_B = P_E / PC (fitted to NPish2 sea-trial data)
export const DEFAULT_PC = 0.57;
// default speed sweep: length-Froude 0.05 → 0.9, fine enough for a short-LWL planing hull's full range
export const FROUDES: number[] = Array.from(
  { length: 69 },
  (_, i) => 0.05 + i * 0.0125,
);

export function computeResistance(
  g: HullGeometry,
  opts: ResistanceOptions = {},
): ResistanceResult {
  const water = opts.water ?? "salt";
  const pc = opts.pc ?? DEFAULT_PC;
  const spray = opts.spray ?? DEFAULT_SPRAY;
  const froudes = opts.froudeNumbers ?? FROUDES;
  const rho = RHO[water];

  const hol: HoltropShip = {
    L: g.lwl,
    B: g.beam,
    T: g.draft,
    vol: g.vol,
    cp: g.cp,
    cm: g.cm,
    cwp: g.cwp,
    lcb: g.lcbPct,
    S: g.wettedArea,
    iE: g.halfEntrance,
    aT: g.transomArea,
    aBT: g.bulbArea,
    salt: water === "salt",
  };
  const sav: SavitskyShip = {
    weight: rho * g.vol * G,
    beam: g.beam, // waterline beam as a proxy for chine/planing beam
    beta: g.deadrise,
    lcg: g.lwl * (0.5 + g.lcbPct / 100), // LCG forward of the transom (LCB at rest)
    salt: water === "salt",
  };
  const capability = planingCapability(g.lwl / g.beam);
  const cbrtVol = Math.cbrt(g.vol);
  const tonnes = (rho * g.vol) / 1000; // displacement mass in tonnes

  const points = froudes.map((fn) => {
    const V = fn * Math.sqrt(G * g.lwl);
    const fnVol = V / Math.sqrt(G * cbrtVol);
    const toBrake = (R: number): number => (R * V) / 1000 / pc; // N·m/s → kW
    const rHol = holtrop(hol, V).rTotal;
    const rSav = savitsky(sav, V, spray).rTotal;
    const { r: rBlend, w } = blendResistance(fnVol, rHol, rSav, capability);
    const brakeKW = toBrake(rBlend);
    return {
      fn,
      kn: V * TO_KN,
      speed: V,
      fnVol,
      planingWeight: w,
      rBlend,
      brakeKW,
      specificKWperT: brakeKW / tonnes,
      brakeHoltrop: toBrake(rHol),
      brakeSavitsky:
        capability > 0.5 && fnVol >= BLEND_LO ? toBrake(rSav) : NaN,
    };
  });

  const warnings: string[] = [];
  const estimated = Object.entries(g.provenance)
    .filter(([, p]) => p === "estimated")
    .map(([k]) => k);
  if (estimated.length)
    warnings.push(`estimated (not measured): ${estimated.join(", ")}`);
  const holtropInRange = holtrop(hol, 1).inRange;
  if (!holtropInRange)
    warnings.push(
      "Holtrop extrapolated: hull outside its fitted L/B, C_P or LCB envelope",
    );

  return {
    points,
    holtropInRange,
    planingCapable: capability > 0.5,
    warnings,
  };
}
