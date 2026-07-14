// Hump-locator verification (speed distribution → regime / coarse ∇).
//
// No real AIS data to validate against, so this is a self-consistency round-trip: build a synthetic
// speed distribution whose shape a hull of a known ∇ / regime would produce, and check locateHump reads
// it back. Three regimes plus the too-few-samples guard.
//
// Run with `npm run test:humplocator` (tsx under node). Non-zero exit on any failure, to gate CI.

import { locateHump } from "../src/resistance/humpLocator";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}  ${detail}`);
  if (!ok) failures++;
}

// n speed samples evenly spread across [c−half, c+half] (deterministic — no RNG)
const band = (c: number, half: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => c - half + (2 * half * i) / (n - 1));

const G = 9.80665,
  KN = 1.94384;
// the hump speed a hull of volume `vol` would sit at (Fn_∇ = 1.1) — the forward direction of the inverse
const humpKn = (vol: number): number =>
  1.1 * Math.sqrt(G * Math.cbrt(vol)) * KN;

// ---------- semi-displacement: bimodal loiter/cruise, trough at the hump ----------
{
  const lwl = 11.9,
    trueVol = 15.4; // NPish2-scale
  const gap = humpKn(trueVol); // ≈ 10.6 kn
  // a loiter mode and a cruise mode bracketing the hump (boats avoid loitering at the hump), so the
  // antimode of the distribution falls ≈ at the hump speed
  const samples = [...band(gap - 2.5, 1, 60), ...band(gap + 2.5, 1, 60)];
  const r = locateHump({ lwl, speedsKn: samples });
  console.log(
    `--- semi-displacement (true ∇=${trueVol}, hump≈${gap.toFixed(1)}kn) ---`,
  );
  check(
    r.regime === "semi-displacement",
    "classified semi-displacement",
    r.regime,
  );
  check(
    r.humpSpeedKn != null && Math.abs(r.humpSpeedKn - gap) < 1.5,
    "hump speed recovered",
    `got ${r.humpSpeedKn?.toFixed(1)} kn want ≈${gap.toFixed(1)}`,
  );
  check(
    r.volEstimate != null &&
      r.volEstimate > 0.5 * trueVol &&
      r.volEstimate < 2 * trueVol,
    "∇ recovered (coarse: 6th-power sensitivity)",
    `got ${r.volEstimate?.toFixed(1)} m³ want ≈${trueVol}`,
  );
  check(r.volBound === "point", "∇ reported as a point estimate");
}

// ---------- displacement: stays below hull speed, no crossing ----------
{
  const lwl = 20; // hull speed ≈ 0.4·√(gL)·KN ≈ 10.9 kn
  const samples = band(7, 2, 100); // 5–9 kn, all below hull speed
  const r = locateHump({ lwl, speedsKn: samples });
  console.log(
    `--- displacement (hull speed ${r.hullSpeedKn.toFixed(1)} kn) ---`,
  );
  check(r.regime === "displacement", "classified displacement", r.regime);
  check(r.volEstimate == null, "no ∇ refinement (barrier is length-based)");
  check(r.topSpeedKn <= r.hullSpeedKn * 1.1, "top speed at/below hull speed");
}

// ---------- planing: unimodal well above hull speed, no loiter mode ----------
{
  const lwl = 11.9; // hull speed ≈ 8.4 kn
  const samples = band(20, 2, 100); // 18–22 kn, no low mode
  const r = locateHump({ lwl, speedsKn: samples });
  console.log(`--- planing ---`);
  check(r.regime === "planing", "classified planing", r.regime);
  check(r.volBound === "upper", "∇ flagged as an upper bound");
  check(r.confidence === "low", "low confidence");
}

// ---------- guard: too few samples ----------
{
  const r = locateHump({ lwl: 12, speedsKn: band(8, 1, 10) });
  check(r.regime === "unknown", "too few samples → unknown", r.regime);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall hump-locator checks passed");
