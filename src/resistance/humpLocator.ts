// ---------- speed-distribution → regime / coarse displacement ----------
//
// Infer a hull's operating regime — and, for semi-displacement/planing hulls, a coarse displacement ∇ —
// from a distribution of observed speeds (e.g. AIS speed-over-ground) plus the known waterline length.
// This is an inverse use of the resistance curve: the curve shapes how a vessel is operated, so the
// speed distribution carries a (noisy, confounded) imprint of it.
//
// Two features are read:
//   • the DISPLACEMENT CEILING at length-Froude ≈ 0.40 (classic "hull speed"): a displacement hull can't
//     practically exceed it, so a distribution that stays at/below it marks the hull as displacement.
//     That barrier is length-based (already known), so it classifies but does not refine ∇.
//   • the SEMI-DISPLACEMENT HUMP at volumetric-Froude ≈ 1.1: a semi-displacement hull loiters below it
//     and cruises above it, leaving a trough (anti-mode) in the histogram at the hump speed. Its speed
//     inverts to ∇ via Fn_∇ = V/√(g·∇^⅓).
//
// ⚠️ Precision: ∇^⅓ ∝ V², so ∇ ∝ V_hump⁶ — a 10% error in the located hump speed is ~80% in ∇. Treat
// the ∇ estimate as order-of-magnitude / a cross-check on C_B·L·B·T, not a measurement; the reliable
// output is the regime classification. And operating speed is confounded (schedules, sea state, limits),
// so a bare speed distribution is a weak prior at best.

const G = 9.80665; // m/s²
const KN = 1.94384; // m/s → knots

// tunable regime thresholds (length-/volumetric-Froude of the two barriers)
const HULL_SPEED_FNL = 0.4; // displacement ceiling
const HUMP_FNVOL = 1.1; // semi-displacement hump
const UNDERWAY_MIN_KN = 0.5; // ignore moored/anchored samples below this
const CEILING_MARGIN = 0.1; // how far above hull speed still counts as "displacement"

export interface HumpInput {
  lwl: number; // waterline length (m)
  speedsKn: number[]; // observed speed-over-ground samples (knots)
}

export interface HumpResult {
  regime: "displacement" | "semi-displacement" | "planing" | "unknown";
  hullSpeedKn: number; // the length-Froude 0.40 ceiling, for reference
  topSpeedKn: number; // robust high percentile of the underway samples
  humpSpeedKn?: number; // located hump speed (semi-displacement only)
  volEstimate?: number; // m³ — COARSE (6th-power-sensitive); cross-check only
  volBound?: "point" | "upper"; // "upper" when the hull already planes past the hump (∇ only bounded)
  confidence: "low" | "medium";
  note: string;
}

const percentile = (sorted: number[], p: number): number => {
  if (!sorted.length) return NaN;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(p * (sorted.length - 1))),
  );
  return sorted[i];
};

// ∇ from a hump speed (knots): Fn_∇ = V/√(g·∇^⅓) ⇒ ∇ = [ (V/Fn)² / g ]³
const volFromHumpKn = (kn: number): number =>
  ((kn / KN / HUMP_FNVOL) ** 2 / G) ** 3;

export function locateHump(input: HumpInput): HumpResult {
  const { lwl } = input;
  const hullSpeedKn = HULL_SPEED_FNL * Math.sqrt(G * lwl) * KN;
  const underway = input.speedsKn
    .filter((v) => v >= UNDERWAY_MIN_KN && Number.isFinite(v))
    .sort((a, b) => a - b);
  const base = { hullSpeedKn, topSpeedKn: NaN as number };
  if (underway.length < 20)
    return {
      ...base,
      regime: "unknown",
      confidence: "low",
      note: "too few underway samples to classify",
    };

  const topSpeedKn = percentile(underway, 0.95);

  // stays at/below hull speed → displacement (the ceiling is length-based, so ∇ is not refined)
  if (topSpeedKn <= hullSpeedKn * (1 + CEILING_MARGIN))
    return {
      hullSpeedKn,
      topSpeedKn,
      regime: "displacement",
      confidence: "medium",
      note: `top speed ${topSpeedKn.toFixed(1)} kn ≈ hull speed ${hullSpeedKn.toFixed(1)} kn (Fn_L 0.40) — stays below the hump`,
    };

  // exceeds hull speed → look for a bimodal trough (loiter vs cruise) above hull speed = the hump
  const hi = topSpeedKn * 1.05;
  const nbins = 40;
  const bw = hi / nbins;
  const counts = new Array(nbins).fill(0);
  for (const v of underway) {
    const b = Math.min(nbins - 1, Math.floor(v / bw));
    counts[b]++;
  }
  // light 3-bin smoothing
  const sm = counts.map(
    (_, i) =>
      (counts[Math.max(0, i - 1)] +
        counts[i] +
        counts[Math.min(nbins - 1, i + 1)]) /
      3,
  );
  // local maxima (modes)
  const peaks: number[] = [];
  for (let i = 1; i < nbins - 1; i++)
    if (sm[i] > sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] > 0) peaks.push(i);
  peaks.sort((a, b) => sm[b] - sm[a]);

  const humpFloorBin = Math.floor((hullSpeedKn * 0.9) / bw);
  if (peaks.length >= 2) {
    // trough between the two tallest peaks (and above the hump floor). The low-density region can be a
    // flat plateau (an empty gap between a loiter and a cruise mode), so take the CENTRE of the
    // near-minimum run rather than an edge — that centre is the antimode ≈ hump speed.
    const [p, q] = [peaks[0], peaks[1]].sort((a, b) => a - b);
    const lo = Math.max(p + 1, humpFloorBin + 1),
      hiB = q - 1;
    if (hiB >= lo) {
      let minV = Infinity;
      for (let i = lo; i <= hiB; i++) minV = Math.min(minV, sm[i]);
      const tol = 0.1 * sm[peaks[0]]; // group bins within 10% of the taller peak's height
      const near: number[] = [];
      for (let i = lo; i <= hiB; i++) if (sm[i] <= minV + tol) near.push(i);
      const troughBin = near[Math.floor((near.length - 1) / 2)];
      const humpSpeedKn = (troughBin + 0.5) * bw;
      return {
        hullSpeedKn,
        topSpeedKn,
        regime: "semi-displacement",
        humpSpeedKn,
        volEstimate: volFromHumpKn(humpSpeedKn),
        volBound: "point",
        confidence: "medium",
        note: `bimodal: loiter/cruise trough at ${humpSpeedKn.toFixed(1)} kn ≈ hump — ∇ is coarse (6th-power sensitive)`,
      };
    }
  }

  // unimodal above hull speed → already planing; the hump sits below the operating cluster, so its speed
  // (and ∇) are only bounded from above by the low edge of that cluster
  const lowEdgeKn = percentile(underway, 0.1);
  return {
    hullSpeedKn,
    topSpeedKn,
    regime: "planing",
    humpSpeedKn: lowEdgeKn,
    volEstimate: volFromHumpKn(lowEdgeKn),
    volBound: "upper",
    confidence: "low",
    note: `runs above hull speed with no loiter mode — hump is below the operating range; ∇ from the low edge (${lowEdgeKn.toFixed(1)} kn) is an upper bound`,
  };
}
