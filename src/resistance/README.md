# `resistance` — hull resistance & power prediction

A small, self-contained TypeScript module that estimates a displacement/planing hull's **calm-water
resistance and brake power across a speed range**. It blends two classical methods according to which is
physically valid at each speed.

Pure functions, **zero runtime dependencies**, framework-agnostic. You describe a hull with a single
`HullGeometry` record — at whatever fidelity you have, from a handful of principal dimensions up to fully
measured coefficients — and get back a per-speed power curve.

```
              displacement          semi-displacement           planing
   Fn_∇: ───────────────┼──────────────────────┼────────────────────────►
                      BLEND_LO                BLEND_HI
                      (0.85)                   (1.4)
   method:      Holtrop-Mennen ── smoothstep crossfade ── Savitsky
```

---

## The two methods and the blend

No single classical method covers a hull's whole speed range, so the estimate crossfades between them by
**volumetric Froude number** `Fn_∇ = V / √(g·∇^⅓)` — the standard displacement↔planing indicator:

| Method                         | Regime                   | Basis                                                                   |
| ------------------------------ | ------------------------ | ----------------------------------------------------------------------- |
| **Holtrop-Mennen**             | displacement / low speed | statistical regression over bulk coefficients (C_P, C_B, L/B, LCB, i_E) |
| **Savitsky** (+ whisker spray) | planing / high speed     | dynamic lift on a trimmed planing bottom                                |

```
R = (1 − w)·R_holtrop + w·R_savitsky,   w = planingSpeed(Fn_∇) · planingCapability(L/B)
```

- `planingSpeed(Fn_∇)` is a C¹-continuous smoothstep from 0 at `BLEND_LO` to 1 at `BLEND_HI`.
- `planingCapability(L/B)` is a **form gate**: ~1 for planing-capable hulls (L/B ≲ 5), 0 for slender
  displacement hulls (L/B ≳ 7), so a light, slender hull is never pushed onto the planing branch just
  because its small ∇ makes `Fn_∇` large.

A pure displacement hull never reaches `BLEND_LO`, so its estimate is simply Holtrop.

The power answer needs only **coefficients**, which can be estimated from principal dimensions — so even
the worst-case scant input yields a full curve.

> **Not included:** thin-ship wave resistance (Michell) and other shape-sensitive wave methods. Those
> under-read beamy hulls and aren't part of the blended answer; if you want a shape diagnostic, compute it
> in the caller. `formFactor` is exported if you need the Holtrop `(1+k1)` viscous factor for such a
> friction term.

---

## Fidelity ladder

| You have…                           | Build a `HullGeometry` by…                          | What you get               |
| ----------------------------------- | --------------------------------------------------- | -------------------------- |
| L, B, T + displacement (worst case) | `fromDimensions(...)` — estimates the coefficients  | Holtrop + Savitsky + blend |
| measured form coefficients          | constructing the record directly (all fields given) | same, but accurate         |

Every field a constructor fills in is recorded in `provenance` (`"given"` vs `"estimated"`), and
`computeResistance` surfaces estimated inputs and out-of-envelope extrapolation in `result.warnings`.

---

## Quick start

Worst case — principal dimensions and a displacement; coefficients are estimated:

```ts
import { fromDimensions } from "./estimate";
import { computeResistance } from "./compute";

const hull = fromDimensions({
  lwl: 11.9,
  beam: 3.6,
  draft: 0.7,
  displacement: 15800, // kg  (or give a block coefficient `cb` instead)
  deadrise: 12, // used once the hull is planing-capable
});

const result = computeResistance(hull, { water: "salt", pc: 0.57 });

for (const p of result.points) {
  console.log(
    `${p.kn.toFixed(1)} kn → ${p.brakeKW.toFixed(0)} kW (${(p.planingWeight * 100).toFixed(0)}% planing)`,
  );
}
console.log(result.warnings); // e.g. ["estimated (not measured): cm, cp, cwp, …"]
```

Measured coefficients — build the record directly (nothing is estimated):

```ts
import type { HullGeometry } from "./types";

const hull: HullGeometry = {
  lwl: 11.9,
  beam: 3.6,
  draft: 0.7,
  vol: 15.4,
  cp: 0.82,
  cm: 0.63,
  cwp: 0.79,
  lcbPct: -9.2,
  halfEntrance: 26,
  wettedArea: 40,
  deadrise: 12,
  provenance: {}, // all measured
};
const result = computeResistance(hull, { water: "salt" });
```

---

## API

### `fromDimensions(input): HullGeometry`

Fills form coefficients from principal dimensions with standard regressions; any coefficient you pass
explicitly overrides its estimate and is marked `"given"`.

```ts
interface DimensionsInput {
  lwl: number;
  beam: number;
  draft: number; // m — required
  displacement?: number; // kg — provide this…
  cb?: number; // …or a block coefficient
  water?: "salt" | "fresh"; // for displacement↔volume (default "salt")
  // optional overrides (else estimated):
  cp?;
  cm?;
  cwp?;
  lcbPct?;
  halfEntrance?;
  wettedArea?;
  deadrise?;
  transomArea?;
  bulbArea?;
}
```

| Quantity         | Estimate                                       |
| ---------------- | ---------------------------------------------- |
| C_M              | Benford `1 / (1 + (1−C_B)^3.5)`                |
| C_P              | `C_B / C_M`                                    |
| C_WP             | Schneekluth `(1 + 2·C_B)/3`                    |
| LCB              | `−1.5%` of L (slightly aft)                    |
| i_E, wetted area | left unset → Holtrop estimates them internally |
| deadrise         | `15°`                                          |

> ⚠️ These regressions assume conventional ship forms. For unusual hulls (very full, shallow, hard-chine)
> they can be well off — e.g. Benford predicts C_M ≈ 0.93 for a hull whose true C_M is 0.63. Supply
> measured coefficients when you have them; `provenance` and `result.warnings` flag whatever was guessed.

### `computeResistance(hull, opts?): ResistanceResult`

```ts
interface ResistanceOptions {
  water?: "salt" | "fresh"; // default "salt"
  pc?: number; // lumped propulsive coefficient, P_B = P_E / PC; default DEFAULT_PC (0.57)
  spray?: number; // Savitsky whisker-spray fraction; default DEFAULT_SPRAY (0.15)
  froudeNumbers?: number[]; // length-Froude sweep; default FROUDES (0.05 … 0.9)
}

interface ResistancePoint {
  fn;
  kn;
  speed; // length-Froude number, knots, m/s
  fnVol; // volumetric Froude number (blend regime indicator)
  planingWeight; // w ∈ [0,1] applied in the blend
  rBlend; // blended resistance (N)
  brakeKW; // blended brake power (kW) — the primary estimate
  brakeHoltrop; // per-method brake power (kW)
  brakeSavitsky; // NaN when not planing-capable / below the band
}

interface ResistanceResult {
  points: ResistancePoint[];
  holtropInRange: boolean; // Holtrop within its fitted envelope for this hull
  planingCapable: boolean; // form gate open (L/B low enough to plane)
  warnings: string[]; // estimated inputs, out-of-envelope extrapolation, …
}
```

### Lower-level building blocks (all pure)

- `holtrop(ship, V, variant?)` — Holtrop-Mennen total resistance (N). `variant` `"1984"` (default) or
  `"1982"`. Clamps to its fitted envelope and reports `inRange`.
- `savitsky(ship, V, spray?)` — Savitsky planing resistance (N). `spray` defaults to 0 (pure 1964
  method); `DEFAULT_SPRAY = 0.15` adds a lumped whisker-spray allowance (Savitsky-Brown 1976).
- `blendResistance(fnVol, rDisplacement, rPlaning, capability?)` → `{ r, w }`, plus
  `planingSpeed(fnVol)`, `planingCapability(lengthBeam)`, `BLEND_LO`, `BLEND_HI`.
- `formFactor({ lwl, beam, draft, cp, lcbPct })` — Holtrop `(1+k1)` viscous form factor.

---

## Units

**Real-world SI throughout** — metres, m³, newtons, m/s; power is returned in kW and speed in knots. The
module has no notion of scale or model units; supply real dimensions.

---

## Calibration & validation

- The defaults **PC = 0.57** and the blend band **`Fn_∇ ∈ [0.85, 1.4]`** were fitted to sea-trial
  speed/power data for a ~12 m semi-displacement hull. The blend reproduced its planing range to ~10%.
  Override `pc` (and `BLEND_LO` / `BLEND_HI` in `blend.ts`) for a different vessel or propulsion package.
- Each method is validated against an external reference (see `../../test/`):
  - **Holtrop** → the published Holtrop-Mennen (1982) L = 205 m tanker worked example, every component <1%.
  - **Savitsky** → the OpenPlaning library in its base-1964 configuration (running trim, wetted-length
    ratio and mean bottom velocity within ~1–2%).
  - **`fromDimensions`** → the estimator regressions plus an end-to-end blend reproduction.

Run the suite with `npm test` (or individually, e.g. `npm run test:holtrop`).

---

## Limitations

- **Estimators** (`fromDimensions`) assume conventional ship forms — check `provenance` / `warnings`.
- **Savitsky inputs** are effectively prismatic: one deadrise and one beam stand in for a warped planing
  surface, and LCG is taken as the at-rest LCB.
- **Extrapolation:** Holtrop clamps to its fitted envelope (C_P 0.55–0.85, L/B 3.9–15, LCB −4…+2%) and
  flags `holtropInRange = false` outside it — common for beamy planing hulls.
- **Planing-capability gate** is an L/B heuristic (ignores deadrise/chines); a borderline L/B ≈ 5–6 hull
  is a judgement call.
- **Not modelled:** wave resistance / shape diagnostics, appendage drag, air/windage, added resistance in
  waves, dynamic trim devices.
