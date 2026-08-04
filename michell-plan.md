# Michell's integral over camber hulls

Wave resistance and the Kelvin wave field, computed from a `camber-core` hull.
The proposed implementation integrates the actual parametric section numerically
in its native parameter and uses oscillation-aware Filon quadrature longitudinally.
It does **not** claim a closed-form evaluation of Michell's inner double integral.
The numerical errors are controlled by refinement and should be made smaller than
the uncertainty of thin-ship theory.

Resistance and free-surface elevation are generated from the same complex hull
spectrum `A(θ)`. The exact normalization and angular weighting of the wave-field
formula must, however, be derived from one consistent Green-function convention
before absolute wave heights are implemented.

---

## 1. Scope and conventions

**Coordinates.** camber builds deck-flat: `x` from 0 (transom) to `L` (bow), `z
≤ 0` down from the deck datum, `y` the half-breadth. The boat floats at
`model.deckRake` with the design waterline `model.waterline` below the origin.
Michell wants coordinates aligned with the free surface, so define the
_hydrodynamic_ frame

```
X =  x·cos(rake) − z·sin(rake)
Z =  x·sin(rake) + z·cos(rake) + waterline        (Z = 0 is the free surface, Z ≤ 0 wet)
```

`worldZ` in `model.ts:210` is the same rotation. The ship advances in +X; the
wake trails aft, at decreasing X.

**Thin-ship assumption.** The hull is replaced by its centerplane projection
with half-breadth `f(X,Z) ≥ 0`. The error scales with hull slenderness, but a
universal `O(beam/length)` relative-error bound should not be assumed without a
reference for the precise formulation. Numerical convergence and comparison
with benchmark hulls are required independently of this modelling uncertainty.

**What you get.** Wave-making resistance, and the far-field _free-wave_
(Kelvin) pattern. Not included: viscous resistance, the local non-wavelike
near-field disturbance, breaking, spray, sinkage and trim.

**Units.** Everything below is in model units (`L = 1000`). Scale lengths by `s
= L_real/L` before applying `ρ` and `g`, or work in real units throughout — but
pick one and say so at the boundary, because `ν = g/U²` is dimensional and
silently wrong results are the failure mode here.

---

## 2. The spectrum, and the two things it produces

With `ν = g/U²` and `θ` the wave propagation angle relative to the track,
define

```
A(θ) = ∬_S  f_X(X,Z) · exp( ν·sec²θ·Z + i·ν·secθ·X ) dX dZ            [length²]
```

`S` is the submerged centerplane projection: `Z` from the keel up to 0, `X`
over the wetted length.

### 2.1 Wave resistance

```
R_w = (4ρg² / (πU²)) · ∫₀^{π/2} sec³θ · |A(θ)|² dθ
```

Equivalently, with `λ = secθ`, this is Michell's original form `(4ρg²/πU²)∫₁^∞
λ²/√(λ²−1)·|A(λ)|²dλ`; the `θ` substitution removes the endpoint singularity at
`λ = 1`, so always integrate in `θ`.

Dimension check (worth doing once in a test): `ρg²/U²` is `M·L⁻³·T⁻²`, `|A|²`
is `L⁴`, product is `M·L·T⁻²` = force. ✓

### 2.2 Free-surface elevation — derivation required

The far-field free-wave pattern is a superposition over the hull spectrum, with
Kelvin dispersion `k(θ) = ν·sec²θ`. A schematic form is

```
ζ(X,Y) = Re ∫_{−π/2}^{π/2} W(θ)·A(θ)
             · exp[ −i·k(θ)·(X·cosθ + Y·sinθ) ] dθ
```

where the sign shown is paired with the `+i·ν·secθ·X` source convention in the
definition of `A`. This opposite source/observation sign is required by
translation invariance; it must also be checked against the chosen ship-motion
and downstream-coordinate convention.

`W(θ)` is **not yet established**. It must be derived from the same normalized
Havelock/Kelvin Green function used to define the thin-ship source sheet. The
usual route appears to give an additional longitudinal derivative when potential
is converted to elevation, suggesting angular dependence proportional to
`ν·sec³θ` rather than `ν·sec²θ`, together with a convention-dependent constant
and possibly a factor of `i`. This must be derived, not fitted as a single real
constant: a scalar cannot repair an incorrect θ-dependent weight or phase.

Because `A(θ)` and the expected weight are even, the resulting field should be
symmetric in `Y`. That remains a useful correctness check after the derivation.
Absolute normalization should be checked by a full far-field energy-flux
calculation with the correct group-velocity and angular weighting. A single
longitudinal wave cut is not, by itself, the total three-dimensional energy flux.

Validity: downstream of the ship and away from the hull. The formula is the
free-wave part; it does not vanish upstream on its own, so restrict the
evaluation domain rather than trusting it there.

### 2.3 Consequences of the exponential kernel

Write `a = ν·sec²θ` and `b = i·ν·secθ`. Under the §1 rotation,

```
a·Z + b·X = c_x·x + c_z·z + a·waterline
c_x = a·sin r + b·cos r
c_z = a·cos r − b·sin r
```

and the rotation has unit Jacobian. The common factor
`exp(a·waterline)` must be retained; dropping it changes the spectrum
exponentially.

The linear exponent is useful, but it does not make the actual camber section
integral elementary. The mirrored keel warp and the parametric breadth/depth
functions are not, in general, one low-degree polynomial on every `st.ts`
band. The design therefore uses:

1. fixed high-order numerical quadrature in the section parameter `u`;
2. local polynomial interpolation in `x`, whose product with `exp(c_x x)` is
   integrated analytically by Filon weights; and
3. independent refinement checks for both approximations.

This is preferable to exactly integrating a coarse analytic approximation of
the hull: quadrature error is measurable and reducible, whereas geometry bias
can alter the spectral phase and high-frequency tail. The longitudinal phase is
the more oscillatory direction, which motivates Filon quadrature, but neither
direction should be described as exact for the original hull.

### 2.4 Numerical and geometry error budget

For a geometry approximation with coordinate errors `δX` and `δZ`, the kernel
changes on the scales

```
δφ_X ≈ ν·secθ·δX     = (δX/L)·secθ/Fn²
δφ_Z ≈ ν·sec²θ·δZ    = (δZ/L)·sec²θ/Fn².
```

These are diagnostics, not rigorous resistance-error bounds. They explain why
a visually small global analytic hull fit can be spectrally inaccurate,
especially at low `Fn` and near the angular cutoff. If an analytic surrogate is
used, preserve the waterline, transom, endpoint closure and longitudinal volume
distribution, and refine the surrogate independently of the quadrature.

Maintain separate convergence controls for section quadrature, longitudinal
Filon panels, θ quadrature, θ cutoff, transom representation and any geometry
surrogate. Report changes in the final `R_w` and in selected complex `A(θ)`
samples when each control is doubled. A target such as 0.1–1% numerical
stability may be reasonable for engineering use, but it is not guaranteed by
the theory; choose and document the tolerance for the application and verify
gradients separately.

---

## 3. Parameterisation: integrate in (x, u), not (x, z)

The obvious route — extract the graph `y = f(x,z)` and integrate over
a rectangle — costs a root-solve per sample (inverting the section's `d(u)`),
which is both expensive and hostile to lona. Don't invert. **Change the
variable of integration to the model's own station parameter.**

### 3.1 Remove the derivative in the hydrodynamic direction

At nonzero rake it is incorrect to replace `f_X` by `y_x`. If
`y(x,z) = f(X,Z)`, then

```
f_X = cos(r)·y_x − sin(r)·y_z.
```

Define the directional derivative
`D_X = cos(r)·∂x − sin(r)·∂z`. It satisfies

```
D_X exp(c_x·x + c_z·z) = b·exp(c_x·x + c_z·z),
b = i·ν·secθ.
```

Integration by parts over the projected wetted domain `D` therefore gives

```
A = exp(a·waterline) · [ B_T − b·∬_D y·exp(c_x x + c_z z) dx dz ],
```

assuming the non-transom boundary contributions vanish: the free surface is
tangent to the `X` direction and the bow/keel close with `y = 0`. These boundary
claims must be checked for every supported hull topology. In particular, an
open or submerged sheer requires additional treatment.

For an aft transom written `x = x_T(z)`, the boundary contribution has the
orientation-dependent measure

```
dZ = (cos r + sin r·x_T'(z)) dz.
```

With the orientation used by the zero-rake formula, this gives

```
B_T = −∫ f_T(z)·exp(c_x x_T(z) + c_z z)
          ·(cos r + sin r·x_T'(z)) dz.
```

The sign must be verified against a simple test hull and the source-sheet
convention. At `r = 0`, this reduces to the familiar `−∫f_T e^(...) dz` and the
main coefficient becomes `−c_x = −b`.

`xTransom` is affine in `z`, but `f_T(z)` from the actual swept and clipped hull
is not known to be a low-degree polynomial. Analytic integration is exact only
for a chosen polynomial approximation to `f_T`; otherwise use converged
one-dimensional quadrature. Either choice must be tested by refinement.

### 3.2 Change variables to the section parameter

Ignoring the separately measured station-fanning displacement, `frameAt` has
`d̂ = [0,0,−1]`, so `z = −d(x,u)` and
`dz = −d_u(x,u) du`. The section integral is

```
G(x,θ) := ∫_{keel}^{wl} f(x,z)·exp(c_z z) dz
        = ∫_{u_wl}^{u_keel} y(x,u)·exp(−c_z d(x,u))·d_u(x,u) du.
```

Here `y` means the actual projected world half-breadth, not merely the station's
stored inboard offset `st.n(u)`. This distinction matters in fanned stations.
The formula assumes `d_u ≥ 0` on the retained starboard span; assert and sample
that condition.

No depth-to-parameter inversion occurs at every quadrature node. A waterline
intersection is still needed to establish `u_wl` at each station.

The unwarped Hermite segments are piecewise cubic, but the implementation in
`mirrorKeelStation()` applies a smootherstep/parabolic keel warp. Consequently
`st.d(u)` is not generally one cubic on each `st.ts` band, and `d_u` is not
currently exposed by the `Station` interface. The implementation must provide a
consistent derivative (analytic or automatic) and include the keel-warp start
`z0` among the quadrature breakpoints. This requirement should be verified
against `model.ts` whenever the station construction changes.

The remaining integral is

```
∬_D y·exp(c_z z + c_x x) dx dz
    = ∫ G(x,θ)·exp(c_x x) dx,
```

provided the `(x,u)` domain includes the same bow, transom and waterline clips
as the rendered/hydrostatics hull. Numerical quadrature evaluates the actual
parametric curve without replacing it by a depth graph; parity with
`hydrostatics()` is therefore an essential domain check, not something assumed
by construction.

### 3.3 Bands and breakpoints

Start with the template segments `[ts[i], ts[i+1]]`, which isolate authored
knuckles. Also split at every implementation breakpoint that can reduce
smoothness, notably the keel-warp start `z0`, the keel, and any waterline or
transom-clipping intersection. Confirm the complete list against the station
implementation; `st.ts` alone is not sufficient today.

For a monotone retained span, intersect each band with `[u_wl,u_keel]`, for
example

```
u_lo[i] = clamp(max(ts[i], u_wl), 0, u_keel)
u_hi[i] = clamp(ts[i+1],          0, u_keel)
```

when `ts` has already been restricted to the starboard ordering. The generated
limits must satisfy `u_hi ≥ u_lo`; add a concrete build-time assertion. The
previous asymmetric clamps could produce negative-width bands beyond the keel.
Equivalent `min`/`max` expressions may be used to keep symbolic control flow
fixed.

### 3.4 Keel and waterline limits

**Keel.** For the current `mirrorKeelStation()` construction,
`u_keel = st.tmax/2` by construction. Keep a regression test because this is a
code invariant, not a general property of `Station`.

**Waterline.** Under the projected-station approximation, solve

```
d(u) = d_wl(x),
d_wl(x) = (waterline + x·sin r) / cos r.
```

The current mirrored/warped `d(u)` is not guaranteed to be a cubic on every
`st.ts` band, so Cardano is not generally applicable. Use a bracketed fixed-
iteration solve on the monotone retained span, or expose enough construction
data to invert each actual piece safely. Newton alone needs a demonstrated
nonzero derivative and an in-bracket safeguard; “five steps reaches machine
precision” must be established by tests rather than assumed.

Bands not containing the waterline do not possess an in-band root. If a
branch-free per-band formulation is required, clamp the target depth to the
band's endpoint depth range before inversion, and verify that it produces the
correct collapsed intervals. The solve occurs once per station when possible,
not once per `(x,z)` quadrature sample.

### 3.5 Behaviour at the keel

For a smoothly rounded keel, expressing breadth as a graph of depth can have a
square-root endpoint behaviour. The native parameter can regularize this when
`d_u → 0` smoothly at the keel, as intended by the fully rounded keel warp.
This is not true for every blended keel: a hard or partially blended V may have
a nonzero one-sided slope. Test the endpoint regularity for the supported
`keelV` range and choose endpoint quadrature accordingly. Do not rely on a
universal zero Jacobian.

### 3.6 The fanning approximation

Station planes fan: a surface point labelled `(x,u)` has true longitudinal
coordinate `x + δX(x,u)`, with `δX` determined by the station-frame normal,
not exactly `x`. The first implementation may project it to `x`, but geometric
smallness alone does not establish spectral smallness.

Report both

```
max|δX|/L
max_{θ in grid} |ν·secθ·δX|
```

because the second quantity is the actual longitudinal phase error. It can be
order one at low Froude number or near the angular cutoff even when `δX/L` is
small. Compare resistance and spectrum against a resampled true-`X` reference
on representative hulls before accepting the approximation. A first-order
correction is justified only where the measured phase error is small; otherwise
resample the projected hull rather than expanding it.

### 3.7 Preconditions to assert

- **Sheer above the DWL** over the wetted length. With depth positive downward,
  this requires `−zf(x) < d_wl(x)`, not `>`. Check the condition in world
  coordinates, including rake and fanning. A submerged rail changes the
  integration boundary and may represent a swamped hull.
- **`d` monotone** on the retained starboard span. Increasing template samples
  do not by themselves prove monotonicity after Hermite interpolation and keel
  warping. Sample the derivative densely at build time and, preferably, test
  the slope construction analytically.
- **Projected-domain parity.** The `(x,u)` domain must apply the actual
  `p[0] ≥ xTransom(model,p[2])` cut. A sloped transom clips only part of nearby
  stations; using the transom position at the DWL as one rectangular aft limit
  is not sufficient.
- **Bow extent.** `stationAt()` can form a tumblehome bow extension beyond the
  last plan control point. Determine the concrete wetted closure at build time;
  do not silently replace `forwardLimit()` by `L` unless a test proves they
  coincide for the hull.

---

## 4. The algorithm

### Stage 0 — establish and sample the domain

- Determine concrete aft/forward wetted bounds outside the symbolic tape. Do
  not substitute the transom-at-DWL and last plan control point unless domain
  parity tests prove that this represents the clipped hull. Include tumblehome
  bow extension where present.
- Construct longitudinal panels suitable for Filon. Uniform spacing is useful,
  but also split at known longitudinal geometry/knot breakpoints. If a strictly
  uniform implementation crosses such points, demonstrate its convergence.
- Per station: build `stationAt(model,x_i,true)`, establish the retained
  starboard span, add keel-warp and clipping breakpoints, and verify
  `u_keel = st.tmax/2` for the current implementation.
- Compute waterline and transom-clipping intersections with fixed, bracketed
  iteration counts suitable for the symbolic system.
- Per quadrature node, cache projected world breadth `y`, `d`, and a derivative
  `d_u` consistent with the warped station. These values are θ-independent.
- Sample the actual transom curve, or construct a polynomial approximation and
  retain an independent refinement level for it.

### Stage 1 — `G(x_i,θ)`: banded Gauss quadrature in `u`

For each correctly mapped Gauss panel,

```
G_i = Σ_bands Σ_nodes mapped_weight · y · exp(−c_z·d) · d_u.
```

Be explicit about whether `mapped_weight` contains the full interval length or
half of it; standard Gauss–Legendre weights on `[-1,1]` use `(u_hi-u_lo)/2`.
This stage is numerical, not analytic. Smoothness is expected only after all
true breakpoints have been included, and the necessary node count must be
established by doubling it.

As `θ → π/2`, `Re(c_z)=ν sec²θ` concentrates the integral near the waterline.
Use graded subpanels or a boundary-layer change of variable and verify the
largest retained θ directly. At nonzero rake `Im(c_z)=−ν secθ sin r`; do not
assume it is benign without checking its maximum phase variation over each
panel.

### Stage 2 — oscillation-aware X quadrature

```
∫ G(x,θ)·e^{iωx} dx ,   ω = ν·secθ·cos r  (the imaginary part of c_x)
```

`G` should be piecewise smooth in `x` after domain and geometry breakpoints are
included. Verify this numerically; clipping intersections can introduce limited
regularity. Two options:

**(a) Piecewise Filon — recommended first.** Fit a quadratic per panel through
its endpoints and midpoint and analytically integrate
`poly·exp(c_x x)`. At zero rake this is the usual oscillatory Filon kernel; at
nonzero rake `c_x` also has a real part. The panel integral is exact for the
quadratic interpolant, not for `G`. Establish the convergence order for the
actual piecewise-smooth geometry and do not assume that 60–120 panels is always
ample. Claims of frequency-uniform error should be tied to the specific Filon
formula and regularity hypotheses used.

The Filon weights have removable `0/0` forms as `ωh → 0`; derive stable series
and choose their switching threshold from an error test in the target floating-
point precision. `ωh` is build-time numeric only when `U`, θ nodes and panel
width are concrete. If differentiating with respect to speed or geometry-dependent
panel widths, use a formulation whose value and derivatives remain stable
through the small-argument region.

**(b) Chebyshev modified moments.** Interpolate `G` on Chebyshev nodes and use
closed-form `∫T_m(ξ)e^{iωξ}dξ`. Spectrally accurate, but the stable evaluation
(Piessens & Branders, as in QUADPACK's `QAWO`) branches on `m > ω`
— data-dependent control flow in the hot path. Only consider it if measured
Filon convergence is insufficient; if so, validate a fixed backward recurrence
with a conservative fixed start index. Do not assume spectral accuracy unless
`G` has the required smoothness.

Add the oriented transom boundary term from §3.1, then form

```
A(θ) = exp(a·waterline) · [B_T(θ) − b·main(θ)].
```

Check this identity at zero rake against direct integration of analytic test
hulls before enabling rake.

### Stage 3 — the θ quadrature for `R_w`

Evaluate `∫₀^{π/2} sec³θ·|A|²dθ`. Two behaviours require explicit tests:

- **Tail.** A simple asymptotic argument for a regular wetted transom meeting
  the waterline suggests `|A|² ~ λ⁻⁴` and a resistance tail `~λ⁻³`. Verify this
  on analytic examples and on the implemented transom convention. Fine-ended
  decay depends on endpoint smoothness and should likewise be measured. Use a
  tail estimate and cutoff-refinement test, not an unverified fixed `θ_max`.
- **Oscillation.** `A(θ)` carries phase `~ ν·secθ·x_c`, so the number of
  oscillations over the range scales with `νL·(secθ_max − 1)`. At `Fn = 0.3`,
  `νL = 1/Fn² ≈ 11` — modest. At `Fn = 0.15` it is ~44. Size the grid for
  a fixed number of points per phase cycle (≥ 8), graded toward `π/2`.

### Stage 4 — the wave field

Provisionally, after §2.2 has been derived,

```
ζ(X,Y) = Re Σ_θ w_θ·W(θ)·A(θ)
                   ·exp[−i·ν·sec²θ·(X cosθ + Y sinθ)].
```

Do not ship this stage until the sign, `W(θ)` and downstream convention pass
translation, Kelvin-geometry and energy tests.

This is the expensive part, and for a different reason: at a field point
a distance `R` astern the phase is `~ νR`, which can be in the hundreds, so the
θ-integrand is _highly_ oscillatory with two stationary points (transverse and
divergent waves) that merge on the Kelvin cusp.

**First implementation — direct quadrature.** After deriving `W(θ)` and the
phase convention in §2.2, precompute `A(θ)` on a fine grid and evaluate a dot
product per field point. Counts such as 2–4k θ points are starting estimates,
not guarantees. Resolution must scale with `νR_max`; check the field, cusp
region and integrated energy by doubling it.

**Upgrades, in order of payoff:** Filon/Levin in θ with the stationary points handled by
local expansion (cost becomes independent of `R` — this is what dedicated wave-pattern
codes do); or stationary-phase asymptotics, cheap and accurate away from the cusp lines
but needing uniform Airy asymptotics _on_ them.

Reuse `A(θ)` between Stages 3 and 4 — same function, different grid densities.

---

## 5. lona notes

The rule this repo already follows: **structure is numeric and fixed, only
values are symbolic** (`findSpan` on the fixed knot vector, `kernel.ts:89`;
`planBasisRows` returning pure numbers, `kernel.ts:107`; `stackPoint` as
a `selectStruct` chain, `grid-volume.ts:60`). The scheme above is built to obey
it.

**Fits naturally:**

- Gauss nodes/weights, band counts, Filon panel edges, θ nodes — all
  compile-time constants.
- Band clamping (§3.3) uses `max`/`min`, not branches.
- Waterline and clipping roots use fixed-count **bracketed** iterations. Their
  residual and gradient behaviour must be tested over the admissible model
  range; the current warped station does not have a general cubic closed form.
- Geometry samples are θ-independent once all model-dependent roots and
  clipping limits have been represented consistently. Verify the resulting
  tape size rather than assuming roots can be precomputed as pure numbers when
  differentiating with respect to hull parameters.
- With fixed iterations and panel counts, `∂R_w/∂(blend weights)` can be
  evaluated by reverse mode without differentiating through an adaptive
  tolerance. Check gradients by finite differences near roots and clamps,
  where piecewise operations may be nonsmooth.

**Shape it as columnar axes, not unrolled loops** — `grid(axis(stations),
axis(bands), axis(nodes))` reduced to `G`, then a second grid over θ. Unrolling
three nested axes into one scalar DAG is exactly the wall
`lona-scaling-issues.md` describes.

**Keep outside the tape where possible:** adaptive panel-count/tolerance loops,
the fan diagnostic, and monotonicity assertions. Compute a concrete bow closure
outside the tape when the evaluated hull is concrete. Do **not** replace it by
the last plan control point for hulls whose tumblehome extension is wetted. If
closure depends on differentiated symbolic parameters, either represent that
dependence consistently or document and test the frozen-domain approximation.

---

## 6. Validation ladder

Work up it in order; each rung isolates one layer.

1. **Volume, before any wave physics.** Run the section and longitudinal
   quadratures with zero exponent. `G_i` should be the immersed projected
   half-section area and the X integral should match half the volume of the
   same projected/clipped hull. Compare with `hydrostatics(model).vol`, while
   documenting any deliberate fanning projection difference. Refine `u` and
   `x` independently. Failure here indicates a Jacobian, breadth, root, bow or
   transom-domain mismatch.
2. **Transom term in isolation.** With zero exponent, compare the boundary
   integral—including its rake measure—with a high-resolution numerical area
   computed from `transomEdge`. Confirm sign separately using an analytic wedge
   or prismatic test hull.
3. **Wigley hull `R_w`.** `f = (B/2)(1−(2x/L)²)(1−(z/T)²)` on a rectangle
   — published to death since Wigley 1926, plus ITTC comparison data. camber
   cannot represent it exactly, so drive Stages 2–3 from an analytic `G` for
   this case. Pins the constants, the θ quadrature and the Filon machinery
   independently of the geometry.
4. **Kelvin geometry.** The computed field must show a half-angle of
   `arcsin(1/3) = 19.47°` and a transverse wavelength of `2πU²/g`. These are
   pure geometry — independent of overall amplitude normalization and of the
   hull — so they test Stage 4's phase convention.
5. **Field symmetry.** `ζ(X,Y) = ζ(X,−Y)`, since `A(θ)` is even.
6. **Energy consistency.** Integrate the complete far-field energy flux with
   the appropriate angular and group-velocity factors and compare it with
   `R_w·U`. Derive the normalization first; do not pin it from one longitudinal
   cut. This cross-checks the resistance and field conventions.

---

## 7. Known limitations

- **Wetted transom.** Classical Michell derivations normally assume closing
  ends; a transom introduces a discontinuity and may ventilate at speed. The
  sign and size of the resulting resistance bias are not asserted here—compare
  with transom benchmarks. A virtual stern extension fairing the transom to a
  point is a common modelling option and should be tested both physically and
  for its effect on the spectral tail.
- **Thin-ship accuracy degrades with beam/length**, but no universal relative
  error bound is asserted here. The direction and size of resistance error
  depend on hull and Froude number and must be assessed against experiments or
  trusted benchmarks.
- **No sinkage or trim**; `model.deckRake` is whatever you set, not an
  equilibrium.
- **Free-wave field only.** The local non-wave contribution is absent. Treat
  distances of order one wavelength from the hull as a heuristic exclusion
  region and establish the useful far-field range against a fuller solution;
  do not use the free-wave integral upstream.
- **Planing is out of scope entirely** — thin-ship theory is
  a displacement-speed model.

---

## 8. Open decisions

- **Wave-field weight and normalization `W(θ)`** in §2.2 — derive from a
  normalized Green function, including sign, θ dependence and complex phase;
  then validate via rung 6.
- **Filon vs Chebyshev** in Stage 2. Start with Filon; revisit only if the
  measured longitudinal discretization error dominates the requested
  tolerance.
- **Where this lives.** A new `camber-michell` package, or an extension of
  `camber-hull`? It needs the symbolic station machinery from `kernel.ts` but
  nothing from `tessellate` or `float-physics`.
- **Whether the fan correction (§3.6) is ever needed** — answer empirically
  from the diagnostic before building it.
