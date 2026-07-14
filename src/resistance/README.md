# `resistance` — hull resistance & power prediction

A geometry-agnostic module that estimates a hull's **calm-water resistance and brake power across a speed
range**, by blending three classical methods according to which is physically valid at each speed. It has
**no dependency on the app** (no React, no `Model`, no rendering): you hand it a `HullGeometry` — described
at whatever fidelity you have, from a few principal dimensions up to full surfaces — and it returns a
per-speed power curve.

```
                displacement            semi-displacement            planing
   Fn_∇:  ────────────┼───────────────────────┼──────────────────────────►
                    ~0.85                    ~1.4
   method:     Holtrop-Mennen  ── smoothstep crossfade ──  Savitsky
   (Michell rides along only as a shape diagnostic; it is never in the answer)
```

---

## Why three methods

No single classical method covers a real hull's whole speed range:

| Method                         | Regime                          | Sees                                        | Blind to                       |
| ------------------------------ | ------------------------------- | ------------------------------------------- | ------------------------------ |
| **Holtrop-Mennen**             | displacement / low speed        | bulk coefficients (C_P, C_B, L/B, LCB, i_E) | planing lift                   |
| **Savitsky** (+ whisker spray) | planing / high speed            | dynamic lift on a trimmed bottom            | making waves                   |
| **Michell** (thin-ship)        | displacement, _shape-sensitive_ | the actual offsets (humps/hollows)          | absolute level for beamy hulls |

The **answer** is `Holtrop → Savitsky`, crossfaded by **volumetric Froude number** `Fn_∇ = V/√(g·∇^⅓)` with
a C¹-continuous smoothstep through the semi-displacement hump, gated by a **length/beam planing-capability
factor** so a slender displacement hull never mixes in the planing branch. Michell is computed only as a
diagnostic overlay (it under-reads beamy hulls, so it is deliberately excluded from the blend).

**Key consequence for geometry:** the power answer needs only _coefficients_ (derivable from scant
dimensions). Full surfaces improve those coefficients and add the Michell diagnostic, but are **not
required**.

---

## The fidelity ladder

| You have…                           | Build with                                      | Methods you get                                         |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| L, B, T + displacement (worst case) | `fromDimensions(...)`                           | Holtrop + Savitsky + blend (coefficients **estimated**) |
| measured form coefficients          | `fromHydrostatics(hydro, lin)` _(app adapter)_  | same, but accurate                                      |
| full surfaces                       | `fromModel(model, {loa, unit})` _(app adapter)_ | + Michell diagnostic + exact hydrostatics               |

`fromDimensions` lives in this module (needs nothing else). `fromHydrostatics` / `fromModel` live in
`src/core/hullResistance.ts` because they know the app's `Hydro`/`Model` types and own the model-unit→metre
scaling and the Michell sampler injection.

---

## Quick start

```ts
import { fromDimensions } from "./resistance/estimate";
import { computeResistance } from "./resistance/compute";

// Worst case: principal dimensions + displacement. Coefficients are estimated.
const hull = fromDimensions({
  lwl: 11.9,
  beam: 3.6,
  draft: 0.7,
  displacement: 15800, // kg  (or pass `cb` instead)
  deadrise: 12, // needed once a hull is planing-capable
});

const result = computeResistance(hull, { water: "salt", pc: 0.57 });

for (const p of result.points) {
  console.log(
    p.kn.toFixed(1),
    "kn →",
    p.brakeKW.toFixed(0),
    "kW",
    `(${(p.planingWeight * 100).toFixed(0)}% planing)`,
  );
}
console.log(result.warnings); // e.g. "estimated (not measured): cm, cp, cwp, …"
```

With full surfaces (in the app):

```ts
import { fromModel } from "./core/hullResistance";
const g = fromModel(model, { loa: 13, unit: "m" }); // includes the Michell sampler
const res = computeResistance(g!, { water: "salt" }); // res.points[i].brakeMichell now finite
```

---

## API

### `fromDimensions(input): HullGeometry` _(scant tier)_

Fills the form coefficients from principal dimensions using standard regressions, recording every filled
field in `provenance`. Any coefficient supplied explicitly overrides its estimate.

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

Estimators (first-order, documented in `estimate.ts`):

| Quantity | Estimate                                       |
| -------- | ---------------------------------------------- |
| C_M      | Benford `1 / (1 + (1−C_B)^3.5)`                |
| C_P      | `C_B / C_M`                                    |
| C_WP     | Schneekluth `(1 + 2·C_B)/3`                    |
| LCB      | `−1.5%` (slightly aft)                         |
| i_E, S   | left unset → Holtrop estimates them internally |
| deadrise | `15°`                                          |

> ⚠️ These regressions assume conventional ship forms. For unusual hulls (very full, shallow, hard-chine)
> they can be well off — e.g. Benford predicts C_M ≈ 0.93 for a hull whose real C_M is 0.63. Supply
> measured coefficients when you have them; the `provenance` map and `result.warnings` flag what was
> guessed.

### `computeResistance(g, opts?): ResistanceResult`

```ts
interface ResistanceOptions {
  water?: "salt" | "fresh"; // default "salt"
  pc?: number; // lumped propulsive coefficient P_B = P_E/PC; default DEFAULT_PC (0.57)
  spray?: number; // Savitsky whisker-spray fraction; default DEFAULT_SPRAY (0.15)
  froudeNumbers?: number[]; // length-Froude sweep; default FROUDES (0.05…0.9)
}

interface ResistancePoint {
  fn;
  kn;
  speed; // Froude no., knots, m/s
  fnVol; // volumetric Froude number (blend regime indicator)
  planingWeight; // w ∈ [0,1] applied in the blend
  rBlend; // blended resistance (N)
  brakeKW; // blended brake power (kW) — the primary estimate
  brakeHoltrop;
  brakeSavitsky;
  brakeMichell; // per-method (kW); NaN where unavailable
}

interface ResistanceResult {
  points: ResistancePoint[];
  holtropInRange: boolean; // Holtrop within its fitted envelope for this hull
  planingCapable: boolean; // form gate open (L/B low enough to plane)
  hasMichell: boolean; // a Michell diagnostic was available
  warnings: string[]; // estimated inputs, out-of-envelope extrapolation, …
}
```

### Lower-level building blocks (pure)

- `holtrop(ship, V, variant?)` — Holtrop-Mennen total resistance (N). `variant` `"1984"` (default) or
  `"1982"`. Clamps to its fitted envelope and reports `inRange`.
- `savitsky(ship, V, spray?)` — Savitsky planing resistance (N). `spray` fraction defaults to 0 (the pure
  '64 method); `DEFAULT_SPRAY = 0.15` adds a lumped whisker-spray allowance.
- `blendResistance(fnVol, rDisp, rPlan, capability?)` → `{ r, w }`; `planingSpeed(fnVol)`,
  `planingCapability(lengthBeam)`, `BLEND_LO`, `BLEND_HI`.
- `formFactor({lwl, beam, draft, cp, lcbPct})` — Holtrop `(1+k1)` viscous form factor.

---

## Units & scale

The module speaks **real-world SI only** — metres, m³, newtons, m/s; power out in kW; speed reported in
knots. It has no notion of "model units" or display scale. All scaling from the app's unitless model space
lives in the `fromModel` / `fromHydrostatics` adapters.

---

## Calibration & validation

- **PC = 0.57** and the **blend band `Fn_∇ ∈ [0.85, 1.4]`** were fitted to NPish2 sea-trial data (7 speed
  points). The blend reproduces its planing range to ~10%; low-speed predictions fall _under_ the quoted
  brake power, consistent with engine-RPM headroom at low load.
- Each method is validated against a reference (`test/`):
  - **Holtrop** → the published Holtrop-Mennen (1982) L=205 m tanker worked example, every component <1%.
  - **Savitsky** → the OpenPlaning library in its base '64 configuration (τ, λ, V_m within ~1–2%).
  - **Michell** → an independent Wigley-hull evaluation of the integral.
  - **fromDimensions** → estimator regressions + an end-to-end reproduction of the NPish2 blend.

Run `npm test` (or `npm run test:holtrop` etc.).

---

## Limitations (be honest with the output)

- **Estimators** (scant tier) assume conventional ship forms; check `provenance` / `warnings`.
- **Savitsky inputs are approximated** by the app adapter: amidships deadrise for the planing area, LCB at
  rest for LCG, waterline beam for chine beam.
- **Extrapolation:** Holtrop clamps to its fitted envelope (C_P 0.55–0.85, L/B 3.9–15, LCB −4…+2%) and
  flags `holtropInRange = false` outside it — common for beamy planing hulls.
- **Planing-capability gate** is an L/B heuristic (ignores deadrise/chines); a borderline L/B ≈ 5–6 hull is
  a judgement call.
- **Not modelled:** appendage drag, air/windage, added resistance in waves, dynamic trim tabs.
