# `resistance` — hull resistance & power prediction

A small, self-contained TypeScript module that estimates a displacement/planing hull's **calm-water
resistance, brake power, and specific power (kW/tonne) across a speed range**. It blends two classical
methods according to which is physically valid at each speed.

Pure functions, **zero runtime dependencies**, framework-agnostic. You describe a hull with a single
`HullGeometry` record — at whatever fidelity you have, from length and beam alone up to fully measured
coefficients — and get back a per-speed power curve.

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

> **Not included:** thin-ship wave resistance (Michell) and other shape-sensitive wave methods. They
> under-read beamy hulls and are deliberately outside the blended answer; compute one in the caller if you
> want a shape diagnostic. (`formFactor` is exported for the Holtrop `(1+k1)` viscous term such a friction
> calculation needs.)

---

## Fidelity ladder

The blended answer needs only **coefficients**, which can be estimated from principal dimensions — so even
the scantest input yields a full curve. Supply more, get more accuracy:

| You have…                       | Build a `HullGeometry` with…                       | Result                |
| ------------------------------- | -------------------------------------------------- | --------------------- |
| length + beam (scantest)        | `fromDimensions(...)` — estimates draft, ∇, coeffs | full curve, roughest  |
| + displacement or C_B (± draft) | `fromDimensions({ …, displacement })`              | ∇ pinned, not guessed |
| measured form coefficients      | the `HullGeometry` record directly                 | most accurate         |

Every field a constructor estimates is recorded in `provenance` (`"given"` vs `"estimated"`), and
`computeResistance` surfaces estimated inputs and out-of-envelope extrapolation in `result.warnings`.

---

## Quick start

Scant — length and beam only; draft, displacement and coefficients are all estimated:

```ts
import { fromDimensions } from "./estimate";
import { computeResistance } from "./compute";

const hull = fromDimensions({ lwl: 11.9, beam: 3.6, deadrise: 12 });
const result = computeResistance(hull, { water: "salt", pc: 0.57 });

for (const p of result.points) {
  console.log(
    `${p.kn.toFixed(1)} kn → ${p.brakeKW.toFixed(0)} kW · ${p.specificKWperT.toFixed(2)} kW/t (${(p.planingWeight * 100).toFixed(0)}% planing)`,
  );
}
console.log(result.warnings); // e.g. ["estimated (not measured): draft, vol, cm, cp, cwp, …"]
```

Measured — build the record directly (nothing is estimated):

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

### `HullGeometry`

The one record every method consumes — full-scale SI. Build it with `fromDimensions` (below) or construct
it directly from measured values.

```ts
interface HullGeometry {
  // principal dimensions — the required floor
  lwl: number; // m
  beam: number; // m, max waterline beam
  draft: number; // m
  vol: number; // m³, displaced volume ∇

  // form coefficients
  cp: number; // prismatic
  cm: number; // midship-section
  cwp: number; // waterplane-area
  lcbPct: number; // LCB as % of L fwd of amidships (negative = aft)

  // secondary form (methods estimate these internally if left unset)
  halfEntrance: number; // deg; NaN → Holtrop estimates it
  wettedArea: number; // m²; ≤0 → Holtrop estimates it
  deadrise: number; // deg; used once the hull is planing-capable

  // planing / bulb extras (optional)
  transomArea?: number; // m²
  bulbArea?: number; // m²

  provenance: Provenance; // per-field "given" | "estimated" (set by the constructors)
}

type Provenance = Record<string, "given" | "estimated">;
```

### `fromDimensions(input): HullGeometry`

Fills the geometry from principal dimensions using standard regressions; any value you pass explicitly
overrides its estimate and is marked `"given"`.

```ts
interface DimensionsInput {
  lwl: number; // m — required
  beam: number; // m — required
  draft?: number; // m — optional; estimated from beam (B/T ≈ 3.5) when omitted
  displacement?: number; // kg — provide this…
  cb?: number; // …or a block coefficient; else ∇ is estimated (C_B = 0.5)
  water?: "salt" | "fresh"; // for displacement↔volume (default "salt")
  // optional coefficient overrides (all number; estimated when omitted):
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

| Quantity         | Estimate when not supplied                     |
| ---------------- | ---------------------------------------------- |
| T (draft)        | `B / 3.5` (beam/draft ≈ 3.5)                   |
| ∇ (displacement) | `C_B·L·B·T`, with `C_B` from `cb` else `0.5`   |
| C_M              | Benford `1 / (1 + (1−C_B)^3.5)`                |
| C_P              | `C_B / C_M`                                    |
| C_WP             | Schneekluth `(1 + 2·C_B)/3`                    |
| LCB              | `−1.5%` of L (slightly aft)                    |
| i_E, wetted area | left unset → Holtrop estimates them internally |
| deadrise         | `15°`                                          |

> ⚠️ These regressions assume conventional ship forms. For unusual hulls (very full, shallow, hard-chine)
> they can be well off — e.g. Benford predicts C_M ≈ 0.93 for a hull whose true C_M is 0.63. Supply
> measured values when you have them; `provenance` and `result.warnings` flag whatever was guessed.

### `computeResistance(hull, opts?): ResistanceResult`

```ts
interface ResistanceOptions {
  water?: "salt" | "fresh"; // default "salt"
  pc?: number; // lumped propulsive coefficient, P_B = P_E / PC; default DEFAULT_PC (0.57)
  spray?: number; // Savitsky whisker-spray fraction; default DEFAULT_SPRAY (0.15)
  froudeNumbers?: number[]; // length-Froude sweep; default FROUDES (0.05 … 0.9)
}

interface ResistancePoint {
  fn: number; // length-Froude number
  kn: number; // speed (knots)
  speed: number; // speed (m/s)
  fnVol: number; // volumetric Froude number (blend regime indicator)
  planingWeight: number; // w ∈ [0,1] applied in the blend
  rBlend: number; // blended resistance (N)
  brakeKW: number; // blended brake power (kW) — the primary estimate
  specificKWperT: number; // brake power per tonne of displacement (kW/t)
  brakeHoltrop: number; // Holtrop-only brake power (kW)
  brakeSavitsky: number; // Savitsky-only brake power (kW); NaN below the planing band
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

## Specific power (kW/tonne) & battery repowering

Every result point carries `specificKWperT` — brake power **per tonne of displacement**. For feasibility
questions like "could this boat be repowered battery-electric?", this is the metric that matters: usable
range at a given speed is governed by the battery _mass fraction_ of displacement,

```
battery mass fraction ≈ specificKWperT · hours / (batterySpecificEnergy_kWh_per_t · η)
```

so absolute displacement cancels out. It also **survives unknown size far better than absolute kW** —
displacement appears in both the power and the divisor and largely cancels (exactly in the wave term). In
a sweep where draft and C_B are unknown across a ~3× spread in ∇, absolute brake kW varied ~34% but
kW/tonne only ~11% (`test/dimensions.ts`). So a useful kW/tonne figure needs only **length, beam, speed,
and a hull-type guess** — no measured draft or displacement — and is tightest in displacement mode.

---

## Inferring regime / ∇ from a speed distribution (AIS)

The forward model can be run backwards: because the resistance curve shapes how a vessel is operated, a
distribution of observed speeds (e.g. AIS speed-over-ground) plus the waterline length reveals the
operating regime — and, for semi-displacement hulls, a coarse displacement.

```ts
import { locateHump } from "./humpLocator";

const r = locateHump({ lwl: 11.9, speedsKn: aisSamples });
// → { regime, hullSpeedKn, topSpeedKn, humpSpeedKn?, volEstimate?, volBound?, confidence, note }
```

It reads two features:

- **Displacement ceiling** at length-Froude ≈ 0.40 ("hull speed"). A distribution that stays at/below it
  ⇒ `regime: "displacement"`. This barrier is length-based (already known), so it classifies but does
  **not** refine ∇.
- **Semi-displacement hump** at volumetric-Froude ≈ 1.1. A hull that loiters below it and cruises above
  leaves a bimodal trough at the hump speed ⇒ `regime: "semi-displacement"`, and the trough speed inverts
  to a `volEstimate`. A hull always running above it ⇒ `regime: "planing"`, with ∇ only bounded from above.

> ⚠️ ∇ from a hump speed is **coarse**: `∇ ∝ V_hump⁶`, so a 10% speed error is ~80% in ∇. Use it as an
> order-of-magnitude cross-check on `C_B·L·B·T`, not a measurement — the dependable output is the regime.
> Operating speed is also confounded (schedules, sea state, limits), so treat a bare speed distribution as
> a weak prior. Feed `volEstimate` (or the regime) into `fromDimensions` to sharpen a scant spec.

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
  - **`fromDimensions`** → the estimator regressions, an end-to-end blend reproduction, and the kW/tonne
    size-robustness sweep.
  - **`locateHump`** → a synthetic-distribution round-trip across all three regimes.

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

```

```
