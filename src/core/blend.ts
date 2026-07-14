// ---------- resistance-method blend ----------
//
// One continuous resistance estimate across the whole speed range, stitched from the method that is
// physically valid in each regime and crossfaded smoothly through the transition. The regime indicator
// is the volumetric Froude number Fn_∇ = V/√(g·∇^⅓), the standard displacement↔planing marker:
//
//   Fn_∇ ≲ BLEND_LO   displacement       → Holtrop (calibrated absolute level)
//   BLEND_LO..BLEND_HI semi-displacement  → smoothstep crossfade Holtrop → Savitsky
//   Fn_∇ ≳ BLEND_HI   planing            → Savitsky (dynamic lift; Holtrop can't see planing relief)
//
//   R = (1 − w)·R_displacement + w·R_planing,   w = smoothstep(Fn_∇; BLEND_LO, BLEND_HI)
//
// smoothstep gives a C¹-continuous handoff, and the crossfade spans only the hump — the region where no
// single method is authoritative anyway. Michell is NOT in the blend (thin-ship under-reads beamy hulls
// badly); it rides along in the UI as a shape diagnostic only.
//
// The band [BLEND_LO, BLEND_HI] was located from the S38ish/NPish2 sea-trial data: Holtrop and Savitsky
// cross at Fn_∇ ≈ 1.0–1.1 there, and this band reproduced NPish2's measured brake power to ~10% across
// its planing range. A pure displacement hull never reaches BLEND_LO, so its blend is simply Holtrop.

export const BLEND_LO = 0.85;
export const BLEND_HI = 1.4;

const smoothstep = (x: number, lo: number, hi: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

// speed-based planing weight from the volumetric Froude number (smoothstep across the transition band)
export function planingSpeed(fnVol: number): number {
  return smoothstep(fnVol, BLEND_LO, BLEND_HI);
}

// planing CAPABILITY [0,1] from length/beam — a form gate. Hard-chine planing hulls run L/B ≈ 3–5;
// slender round-bilge displacement hulls (L/B ≳ 7) do not plane at any speed. Without this, Fn_∇ alone
// would wrongly ramp a light, slender hull onto the Savitsky branch simply because its small ∇ makes
// Fn_∇ large. A first-order heuristic (L/B only; deadrise/chines also matter) — full at L/B ≤ 5, off at
// L/B ≥ 7.
export function planingCapability(lengthBeam: number): number {
  return 1 - smoothstep(lengthBeam, 5, 7);
}

export interface BlendResult {
  r: number; // blended resistance (same units as the inputs)
  w: number; // planing weight actually applied (speed × capability)
}

// crossfade a displacement-regime resistance and a planing-regime resistance. The planing weight is the
// speed factor (Fn_∇) gated by the hull's planing capability, so only planing-capable hulls mix in the
// planing branch. `capability` defaults to 1 (assume planing-capable) when not supplied.
export function blendResistance(
  fnVol: number,
  rDisplacement: number,
  rPlaning: number,
  capability = 1,
): BlendResult {
  const w = planingSpeed(fnVol) * capability;
  return { r: (1 - w) * rDisplacement + w * rPlaning, w };
}
