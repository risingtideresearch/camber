// Holtrop-Mennen verification against the published worked example.
//
// The canonical L = 205 m tanker from Holtrop & Mennen (1982, "An approximate power prediction method",
// ISP 29/335) carries a full set of published intermediate coefficients and component resistances. We
// feed the example's exact inputs (using the 1982 wave-resistance variant, since that is what the paper
// used) and assert every component and total reproduce the published figures within tolerance. This pins
// down both the constant/exponent set and the transcription traps (c2/c3 swap, c15 sign, seawater ν,
// lcb-% sign, the m2 oscillatory term). The half-angle of entrance i_E is left for the code to ESTIMATE,
// so the i_E regression is exercised too.
//
// Run with `npm run test:holtrop` (tsx under node). Non-zero exit on any failure, to gate CI.

import {
  holtrop,
  holtropWettedArea,
  type HoltropShip,
} from "../src/resistance/holtrop";

let failures = 0;
function near(
  got: number,
  want: number,
  tol: number,
  label: string,
  unit = "",
): void {
  const rel = Math.abs(got - want) / Math.abs(want);
  const ok = rel <= tol;
  console.log(
    `${ok ? "  ok " : "FAIL "} ${label}  got=${got.toPrecision(5)}${unit} want=${want.toPrecision(5)}${unit} rel=${(rel * 100).toFixed(2)}%`,
  );
  if (!ok) failures++;
}

// ---------- the [HM82] tanker ----------
const V = 25 * 0.514444; // 25 knots → m/s (12.861)
const ship: HoltropShip = {
  L: 205,
  B: 32,
  T: 10,
  vol: 37500,
  cp: 0.5833,
  cm: 0.98,
  cwp: 0.75,
  lcb: -0.75, // % of L, aft of amidships
  S: 7381.45, // published measured wetted surface
  aT: 16,
  aBT: 20,
  hB: 4,
  cStern: 10, // U-shaped w/ Hogner stern
  sApp: 50,
  kApp: 1.5, // single rudder behind stern
  salt: true,
};

const r = holtrop(ship, V, "1982");
const kN = (n: number): number => n / 1000;

console.log("--- coefficients ---");
near(r.cf, 0.00139, 0.01, "C_F");
near(r.formK, 1.156, 0.01, "1+k1");
near(r.iE, 12.08, 0.03, "i_E (estimated)", "°");

console.log(
  "--- wetted surface estimate (independent of the measured S above) ---",
);
near(holtropWettedArea(ship), 7381.45, 0.02, "S (Holtrop estimate)", " m²");

console.log("--- resistance components (kN) ---");
near(kN(r.rf), 869.63, 0.01, "R_F (bare)", " kN");
near(kN(r.rapp), 8.83, 0.02, "R_APP", " kN");
near(kN(r.rw), 557.11, 0.02, "R_W", " kN");
near(kN(r.rb), 0.049, 0.1, "R_B (bulb)", " kN");
near(kN(r.ra), 221.98, 0.02, "R_A", " kN");

console.log("--- transom runs dry (Fn_T ≥ 5) ---");
if (r.rtr === 0) console.log("  ok  R_TR = 0 (transom dry)");
else {
  console.log(`FAIL  R_TR should be 0, got ${kN(r.rtr).toPrecision(5)} kN`);
  failures++;
}

console.log("--- total ---");
near(kN(r.rTotal), 1793.26, 0.01, "R_total", " kN");
near(kN(r.rTotal * V), 23063, 0.02, "P_E = R·V", " kW");

// ---------- sanity: the 1984 regime is continuous through the interpolation band ----------
// evaluate P_E across the sailing range at the tanker geometry and confirm R_W stays finite/positive and
// the 0.4–0.55 blend introduces no jump (a common bug in the regime switch).
{
  const speeds = Array.from({ length: 40 }, (_, i) => 0.1 + i * 0.0125); // Fn grid
  let ok = true;
  let prev = -Infinity;
  let monotoneBreaks = 0;
  for (const fn of speeds) {
    const v = fn * Math.sqrt(9.81 * ship.L);
    const rw = holtrop(ship, v, "1984").rw;
    if (!Number.isFinite(rw) || rw < 0) ok = false;
    // R_W should not COLLAPSE across the blend band; allow non-monotonicity (humps) but flag a NaN/inf
    if (fn > 0.35 && fn < 0.6 && rw < prev * 0.5 && prev > 0) monotoneBreaks++;
    prev = rw;
  }
  console.log("--- 1984 regime continuity ---");
  console.log(
    `${ok ? "  ok " : "FAIL "} R_W finite & positive across Fn 0.10–0.59 (1984 variant)`,
  );
  if (!ok) failures++;
  console.log(
    `${monotoneBreaks === 0 ? "  ok " : "FAIL "} no collapse across the 0.4–0.55 interpolation band`,
  );
  if (monotoneBreaks !== 0) failures++;
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall holtrop checks passed");
