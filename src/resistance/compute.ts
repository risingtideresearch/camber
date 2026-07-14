// ---------- resistance assembly ----------
//
// Given a HullGeometry (full-scale SI) and options, sweep the speed range and blend Holtrop
// (displacement) with Savitsky (planing) by volumetric Froude number. If the geometry carries a
// wave-resistance sampler, also report a wave diagnostic curve (not part of the blended answer).
// Returns brake power per method plus the blended best estimate. Pure and framework-free.

import { holtrop, type HoltropShip } from "./holtrop";
import { savitsky, type SavitskyShip, DEFAULT_SPRAY } from "./savitsky";
import { blendResistance, planingCapability, BLEND_LO } from "./blend";
import { formFactor } from "./formFactor";
import type {
  HullGeometry,
  ResistanceOptions,
  ResistanceResult,
} from "./types";

const G = 9.80665; // m/s²
const TO_KN = 1.94384; // m/s → knots
const RHO = { salt: 1025, fresh: 1000 }; // kg/m³
const NU = { salt: 1.18831e-6, fresh: 1.13902e-6 }; // m²/s at 15 °C (ITTC)

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
  const rho = RHO[water],
    nu = NU[water];

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
  const formK = formFactor({
    lwl: g.lwl,
    beam: g.beam,
    draft: g.draft,
    cp: g.cp,
    lcbPct: g.lcbPct,
  });
  const cbrtVol = Math.cbrt(g.vol);

  const points = froudes.map((fn) => {
    const V = fn * Math.sqrt(G * g.lwl);
    const fnVol = V / Math.sqrt(G * cbrtVol);
    const toBrake = (R: number): number => (R * V) / 1000 / pc; // N·m/s → kW
    const rHol = holtrop(hol, V).rTotal;
    const rSav = savitsky(sav, V, spray).rTotal;
    const { r: rBlend, w } = blendResistance(fnVol, rHol, rSav, capability);
    // wave-resistance diagnostic: injected C_w + ITTC-57 friction (with the form factor), if supplied
    let brakeWave = NaN;
    const cw = g.waveCoefficient?.(fn);
    if (cw != null && Number.isFinite(cw)) {
      const re = (V * g.lwl) / nu,
        cf = 0.075 / (Math.log10(re) - 2) ** 2,
        q = 0.5 * rho * V * V * g.wettedArea;
      brakeWave = toBrake((cw + formK * cf) * q);
    }
    return {
      fn,
      kn: V * TO_KN,
      speed: V,
      fnVol,
      planingWeight: w,
      rBlend,
      brakeKW: toBrake(rBlend),
      brakeHoltrop: toBrake(rHol),
      brakeSavitsky:
        capability > 0.5 && fnVol >= BLEND_LO ? toBrake(rSav) : NaN,
      brakeWave,
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
    hasWaveDiagnostic: !!g.waveCoefficient,
    warnings,
  };
}
