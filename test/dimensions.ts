// fromDimensions (scant-geometry constructor) verification.
//
// Three checks, all self-contained (no external design data):
//   1. the coefficient estimators reproduce their documented regressions, and provenance flags which
//      fields were given vs estimated;
//   2. explicit overrides pass through and are marked "given";
//   3. end-to-end: fed NPish2's MEASURED coefficients as overrides, the scant constructor + compute()
//      reproduce the sea-trial-calibrated blend (≈262 kW at 15 kt, planing) — i.e. the scant path plumbs
//      through to the same answer as the full-surfaces path when given the same numbers.
//
// Run with `npm run test:dimensions` (tsx under node). Non-zero exit on any failure, to gate CI.

import { fromDimensions } from "../src/resistance/estimate";
import { computeResistance } from "../src/resistance/compute";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}  ${detail}`);
  if (!ok) failures++;
}
function near(got: number, want: number, tol: number, label: string): void {
  const rel = Math.abs(got - want) / Math.abs(want);
  check(
    rel <= tol,
    label,
    `got=${got.toPrecision(5)} want=${want.toPrecision(5)} (${(rel * 100).toFixed(1)}%)`,
  );
}

// ---------- 1. estimators + provenance ----------
{
  // Cb = 0.5 exactly: vol = 0.5·L·B·T
  const L = 30,
    B = 6,
    T = 2;
  const vol = 0.5 * L * B * T;
  const g = fromDimensions({
    lwl: L,
    beam: B,
    draft: T,
    displacement: 1025 * vol,
  });
  console.log("--- estimators (Cb = 0.5) ---");
  near(g.vol, vol, 0.001, "vol from displacement");
  near(g.cm, 1 / (1 + 0.5 ** 3.5), 0.001, "Cm (Benford)"); // 0.9188
  near(g.cp, 0.5 / (1 / (1 + 0.5 ** 3.5)), 0.001, "Cp = Cb/Cm"); // 0.5442
  near(g.cwp, (1 + 2 * 0.5) / 3, 0.001, "Cwp = (1+2Cb)/3"); // 0.6667
  check(g.lcbPct === -1.5, "LCB defaulted", `${g.lcbPct}%`);
  check(Number.isNaN(g.halfEntrance), "i_E left NaN (Holtrop estimates)");
  check(g.wettedArea === 0, "S left 0 (Holtrop estimates)");
  console.log("--- provenance ---");
  check(g.provenance.vol === "given", "vol given (displacement supplied)");
  check(
    g.provenance.cm === "estimated" &&
      g.provenance.cp === "estimated" &&
      g.provenance.cwp === "estimated",
    "coefficients estimated",
  );
}

// ---------- 1b. displacement estimated from dimensions (no displacement, no Cb) ----------
{
  const L = 30,
    B = 6,
    T = 2;
  const g = fromDimensions({ lwl: L, beam: B, draft: T });
  console.log("--- displacement from dimensions (Cb defaulted) ---");
  near(g.vol, 0.5 * L * B * T, 0.001, "∇ = 0.5·L·B·T");
  check(g.provenance.vol === "estimated", "∇ marked estimated");
}

// ---------- 2. overrides pass through ----------
{
  const g = fromDimensions({
    lwl: 30,
    beam: 6,
    draft: 2,
    cb: 0.55,
    cp: 0.62,
    deadrise: 18,
  });
  console.log("--- overrides ---");
  check(
    g.cp === 0.62 && g.provenance.cp === "given",
    "Cp override honored + marked given",
  );
  check(
    g.deadrise === 18 && g.provenance.deadrise === "given",
    "deadrise override honored",
  );
  check(g.provenance.cm === "estimated", "unspecified Cm still estimated");
  near(g.vol, 0.55 * 30 * 6 * 2, 0.001, "vol from Cb");
}

// ---------- 3. end-to-end: NPish2 measured coefficients → validated blend ----------
{
  // NPish2 at LOA 13 m (measured by hydrostatics on the surfaces)
  const g = fromDimensions({
    lwl: 11.91,
    beam: 3.574,
    draft: 0.6977,
    displacement: 15795, // kg, salt → ∇ ≈ 15.41 m³
    cp: 0.822,
    cm: 0.632,
    cwp: 0.793,
    lcbPct: -9.21,
    halfEntrance: 26.27,
    wettedArea: 40.18,
    deadrise: 12.2,
    water: "salt",
  });
  const res = computeResistance(g, { water: "salt", pc: 0.57 });
  const at = (kn: number) =>
    res.points.reduce((a, b) =>
      Math.abs(b.kn - kn) < Math.abs(a.kn - kn) ? b : a,
    );
  console.log("--- NPish2 end-to-end (scant constructor, measured coeffs) ---");
  check(res.planingCapable, "planing-capable (L/B ≈ 3.3)");
  check(
    !res.warnings.some((w) => w.includes("estimated")),
    "no 'estimated inputs' warning (all coefficients given)",
    res.warnings.join(" | "),
  );
  check(
    !res.holtropInRange && res.warnings.some((w) => w.includes("extrapolated")),
    "Holtrop-extrapolated warning present (L/B < 3.9)",
  );
  const p15 = at(15),
    p12 = at(12.5);
  check(
    p15.planingWeight > 0.9,
    "≈100% planing at 15 kt",
    `w=${p15.planingWeight.toFixed(2)}`,
  );
  near(p15.brakeKW, 262, 0.06, "brake ≈262 kW at 15 kt"); // sea-trial: 280 kW
  near(p12.brakeKW, 203, 0.06, "brake ≈203 kW at 12.5 kt"); // sea-trial: 220 kW
  // monotonic increasing
  const mono = res.points.every(
    (p, i, a) => i === 0 || p.brakeKW >= a[i - 1].brakeKW - 1e-6,
  );
  check(mono, "brake power increases with speed");
  // specific power = brake / displacement (tonnes)
  const tonnes = (1025 * g.vol) / 1000;
  near(
    p15.specificKWperT,
    p15.brakeKW / tonnes,
    1e-6,
    "specificKWperT = brakeKW / tonnes",
  );
}

// ---------- 4. specific power (kW/t) is size-robust under unknown draft/displacement ----------
// The battery-repowering metric. With L, B fixed and a displacement-mode speed, sweep draft × C_B (so ∇
// spans a wide range) and confirm kW/tonne varies far less than absolute kW — ∇ largely cancels.
{
  const L = 12,
    B = 3.6;
  const nearestKn = (res: ReturnType<typeof computeResistance>, kn: number) =>
    res.points.reduce((a, b) =>
      Math.abs(b.kn - kn) < Math.abs(a.kn - kn) ? b : a,
    );
  const kw: number[] = [],
    kwt: number[] = [],
    disp: number[] = [];
  for (const draft of [0.6, 0.9, 1.2])
    for (const cb of [0.45, 0.55, 0.65]) {
      const g = fromDimensions({ lwl: L, beam: B, draft, cb });
      const p = nearestKn(computeResistance(g, { water: "salt" }), 9);
      kw.push(p.brakeKW);
      kwt.push(p.specificKWperT);
      disp.push((1025 * g.vol) / 1000);
    }
  const cv = (v: number[]) => {
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m;
  };
  console.log("--- kW/tonne robustness @9 kn (draft×Cb sweep) ---");
  console.log(
    `    ∇ CV ${(cv(disp) * 100).toFixed(0)}% · kW CV ${(cv(kw) * 100).toFixed(0)}% · kW/t CV ${(cv(kwt) * 100).toFixed(0)}%`,
  );
  check(cv(kwt) < cv(kw), "kW/tonne varies less than absolute kW");
  check(cv(kwt) < 0.2, "kW/tonne pinned within ~20% despite unknown ∇");
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall dimensions checks passed");
