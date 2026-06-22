# Swept-Camber Hull Data Model

This document defines a parametric description of a boat hull inspired by Jim Brown's
[constant-camber](https://smalltridesign.com/Trimaran-Articles/Construction-Methods/Constant-Camber.html) method, and elaborated by JP Donovan. As with the traditional constant camber, a transverse section is swept along the sheer; in our version, its shape blends across a small set of templates as it runs, following an authored longitudinal path. The
parameterization is very parsimonious and well suited to optimization methods.

It is also chosen so that it is **stable under interpolation**: given two or more
valid hull designs, any blend of them is again a valid hull. Design exploration can thus also happen by
moving through the space *between* multiple authored variants.

The traditional constant-camber technique builds a hull by sweeping one mould of fixed
transverse curvature along a guide, so every panel comes off the same jig. This model keeps
the sweep and generalizes the mould: instead of one fixed section it carries a small **set of
templates** and blends between them along the length, the mix at each station chosen by an
authored **weight curve** that traces a path through the templates' blend space from stern to
bow. A constant-camber hull in the classical sense is the special case of a single template;
the earlier two-template model — an **aft** and a **fore** template blended linearly by
`x / L` — is the special case of two templates on a straight blend path.

## Demo

Try it here: [https://risingtideresearch.github.io/camber/](https://risingtideresearch.github.io/camber/).

## Design philosophy

- **The sweep is primary; almost everything else is emergent.** A hull is authored as a
  small set of *generators* — one **sheer** (a plan-view guide curve plus a profile trim
  line), one raked **transom** plane, a small set of transverse **section templates**, and a
  **weight curve** that blends them along the length. The 3-D surface is the locus traced by
  sweeping the blended template along the sheer. The **keel, stem, and rocker are not authored** — they emerge where the
  swept sections reach the centerline. So are the waterlines, buttocks, draft, and the
  transom's cut outline. There is no separate keel curve to keep consistent with the
  sections; the bottom is wherever the sweep closes.
- **Templates, swept and blended along an authored path.** The transverse shape is a small set
  of templates `T₁…T_K`; at any station it is the convex blend `Σⱼ wⱼ(x)·Tⱼ`, where the **weight
  curve** `w(x)` is an authored, faired path through the templates' blend space (the simplex),
  running stern to bow. This *along-hull* blend is intrinsic to one design and is distinct from
  the *across-design* blend of variants below. The two are no longer the same operation — the
  section is now *bilinear* in (weights, templates) rather than affine — so they commute only on
  sub-families where the weights or the templates are shared; every blend is still valid (see
  [Interpolation](#interpolation-and-blending)). The previous model is `K = 2` with
  `w = (1−x/L, x/L)`.
- **Everything positional is a concrete number.** A control point's position, a template
  point's depth and offset, the transom's rake — each is a single authored number. There is
  no position-solving phase; the only thing downstream code does is *evaluate* the sweep and
  fair the curves through the authored points.
- **A document is one topology and a set of variants.** The **topology** is the discrete
  structure — how many control points each generator has — and carries no geometry. A
  **variant** is the numbers laid over that structure (including how sharp each template point
  is — a continuous **knuckle**, not a discrete flag). One variant resolves to one hull;
  several variants over the same topology form a family that interpolates.
- **Validity is convex by construction.** The numbers are encoded so that the set of valid
  variants is a convex region — a product of intervals, half-lines, and positive-increment
  cones. A convex combination of valid variants is therefore valid; this is the property
  that makes interpolation safe, and it is the single principle that shapes the encoding
  throughout.

## Coordinate system

Right-handed, in millimeters.

- `x` — longitudinal (fore-and-aft), increasing from stern toward bow. Origin at the
  **transom reference** (`x = 0`); the bow is at `x = L`, the hull's overall length.
- `y` — transverse, increasing to starboard. Centerline at `y = 0`. The hull is symmetric
  about `y = 0`: only the starboard side is authored and the port side is mirrored, so all
  authored `y ≥ 0`.
- `z` — vertical, increasing upward. The **flat deck** is the reference plane `z = 0`; the
  hull hangs below it, so hull `z ≤ 0`. Depth is measured downward from the deck.

Authored *lengths* are millimeters. The transom's tilt is authored as a **slope** — the
tangent of the angle, a run-over-rise `dx/dz` that is `0` at the upright orientation — not
as an angle in degrees. All authored numbers are full-precision floats, since interpolation
produces in-between values. Derived geometry — curve evaluations, the swept surface, section
intersections, the emergent keel — is likewise full precision.

## The sweep frame

The geometric heart of the model is how a station is placed in space. The deck is flat
(`z = 0`), so the construction is simple and is worth stating before the data, because it is
what makes the encoding's invariants meaningful.

At a longitudinal position `x`, let `p = (x, y_sheer(x), 0)` be the point on the **sheer
plan curve** (the deck edge). Build a frame there:

- `T̂` — the unit tangent of the sheer plan curve at `x`, lying in the deck plane (`z = 0`).
- `d̂` — the **depth** axis, straight down. Because the deck is flat, `d̂ = (0, 0, −1)`
  exactly, independent of `x`.
- `n̂` — the **inboard** axis, `d̂ × T̂`: horizontal, perpendicular to the sheer in plan,
  pointing toward the centerline.

The station plane at `x` is the *vertical* plane through `p` spanned by `n̂` and `d̂`. As the
sheer's heading turns, these planes **fan out** in plan rather than staying parallel. A
template point with local coordinates `(n, d)` — `n` inboard, `d` down — lands at the world
point

```
W(n, d) = p + n·n̂ + d·d̂ = ( p_x + n·n̂_x ,  p_y + n·n̂_y ,  −d )
```

Two consequences follow from the flat deck and are used throughout:

1. **Depth is height.** Since `d̂ = (0,0,−1)`, world `z = −d`: a template point at depth `d`
   sits at `z = −d` regardless of `x`. The sheer trim at profile height `z_trim(x)`
   therefore corresponds to template depth `d = −z_trim(x)`.
2. **The keel is where the sweep reaches `y = 0`.** Half-breadth `y = p_y + n·n̂_y` falls as
   `n` runs inboard; the section's keel point is the depth at which it first reaches the
   centerline. If it never does, the section is **open** (no keel there).

## The document

A hull document is a single topology together with one or more variants:

```
HullDocument {
  topology:      Topology
  variants:      Variant[]      // ≥ 1; each is a complete set of numbers for `topology`
  length:        number         // L, overall length (x of the bow), shared by all variants
}
```

`length` is currently shared by all variants: the along-hull fraction `f = x / L` is then the
same for every variant at a given `x`, which keeps the world-`x` generators (sheer plan, sheer
trim, transom) comparable across variants and makes the along-hull and across-design blends
commute (see [Interpolation](#interpolation-and-blending)). **Note (future):** per-variant
lengths are worth supporting — length is a non-negative affine quantity, so it would blend and
stay convex; the cost is re-parameterizing the longitudinal generators in normalized `f ∈ [0,1]`
rather than world `x`, then scaling by each variant's `L`. Until then, length is one constant.

Nothing is referred to by id. There is exactly one sheer and one transom, so those are
implicit. The section shape is a *set* of `templateCount` templates and one weight curve; the
discrete freedoms are *how many control points* each generator has — including how many
templates there are and how many control points the weight curve carries:

```
Topology {
  sheerPlan:     number   // count of sheer plan-curve control points; ≥ 2
  sheerTrim:     number   // count of sheer trim-line control points; ≥ 2
  section:       number   // count of points per template; ≥ 2 (index 0 is the sheer point)
  templateCount: number   // count of section templates K; ≥ 1 (2 = the old aft/fore model)
  weightPoints:  number   // count of weight-curve control points; ≥ 2 (may be 1 when K = 1)
}
```

A point's sharpness carries no discrete structure — it is a per-point **knuckle** number on the
variant (see [the section templates](#the-section-templates)), not part of the topology. The
single `section` count applies to every template, which are index-aligned so each along-hull
blend pairs point `i` with point `i`. The transom is always two points (top and bottom of its
raked plane), so it needs no count.

A variant mirrors the topology, holding the numbers — a scalar where there is one of a thing
(`transomRake`), and a vector parallel to each topology count:

```
Variant {
  name?:       string
  sheerPlan:   PlanPoint[]       // length = topology.sheerPlan; the deck-edge guide curve
  sheerTrim:   TrimPoint[]       // length = topology.sheerTrim; the real sheer, in profile
  transom:     Transom           // the raked stern plane
  templates:   SectionPoint[][]  // topology.templateCount templates, each of length topology.section
  weights:     WeightPoint[]     // length = topology.weightPoints; the longitudinal blend path
}
```

To evaluate geometry you read a variant's numbers against the topology and run the sweep;
there is no third "resolved" form. Per-slot domains (`> 0`, `≥ 0`, or free `ℝ`) come from
the encoding described next, and are exactly what make every blend valid.

## Stable encoding: increments, not absolutes

This is the heart of the model. Two ordering invariants must survive interpolation:

1. The sheer plan curve (and the sheer trim line) are **strictly increasing in `x`**, so each
   is a single-valued guide the sweep can follow.
2. Each section template is **strictly increasing in depth `d`**, so the swept section is a
   single-valued curve from the deck downward and never curls back up on itself. This is the
   sweep's analog of "no crossings".

A convex combination of two strictly-increasing sequences is strictly increasing, so storing
absolutes would already be safe for a *pair* of designs. To make the valid region
*manifestly* convex — and to keep strict ordering under any barycentric blend of `N` designs
— ordered quantities are stored as **cumulative positive increments**:

- A plan or trim curve's first point anchors at `x₀ ≥ 0` (the transom end, normally `0`);
  every later point carries a forward step `dx > 0`. Running sums recover absolute `x`, and
  strict positivity of the steps guarantees strict ordering under any blend.
- A section template's first point is the **sheer point**, pinned at the local origin
  `(n, d) = (0, 0)` — it carries no numbers. Every later point carries a downward step
  `dd > 0` from the point above it; running sums recover absolute depth, so the template
  stays strictly descending automatically.

Quantities with a *sign* but no *ordering* are stored directly and constrained `≥ 0`: a plan
point's half-breadth `y`, a trim point's `depth` below the deck (`= −z`), the transom's two
depths. Non-negativity is preserved by convex combination. The genuinely free quantities are
stored directly over `ℝ`: a section point's inboard offset `n` (negative is allowed —
**tumblehome**, the section leaning outboard of the deck edge), and the transom rake slope.
Finally, a section point carries a **knuckle** `k ∈ [0,1]` (`0` = smooth, `1` = hard corner);
a bounded interval is convex, so it blends like everything else.

A **weight control point** adds two more convex shapes. Its station advances by the same forward
step `dx > 0` as a guide curve (the path is sampled stern-to-bow, strictly increasing in `x`),
and its barycentric weight `w` lives in the `(K−1)`-simplex — `wⱼ ≥ 0`, `Σⱼ wⱼ = 1` — itself a
convex polytope, so a blend of two simplex weights is again a simplex weight.

```
PlanPoint    { dx: number,  y: number }                 // dx > 0 (≥ 0 for point 0); y ≥ 0 (half-breadth at z = 0)
TrimPoint    { dx: number,  depth: number }             // dx > 0 (≥ 0 for point 0); depth ≥ 0 (below the flat deck)
SectionPoint { dd: number,  n: number,  k: number }     // dd > 0 (= 0 for pt 0, the sheer); n ∈ ℝ (n < 0 = tumblehome); k ∈ [0,1] (knuckle; the pinned sheer point at index 0 is left smooth)
WeightPoint  { dx: number,  w: number[] }               // dx > 0 (≥ 0 for point 0); w ∈ Δ^{K−1} (length K, wⱼ ≥ 0, Σ wⱼ = 1)
```

The valid region of a variant is thus the product of: positive orthants (every later plan/
trim/weight `dx`, every template `dd`), a non-negative orthant (every `y`, every `depth`), free
lines (every `n`, the transom rake), bounded intervals (every knuckle `k`), simplices (every
weight control point's `w`), and the transom's bounded box (below). Every factor is convex and an
intersection of convex sets is convex, so the valid region is convex. **Any convex blend of valid
variants is valid**, with no feasibility check.

## The sheer

The sheer is authored as two curves that play different roles.

### The plan curve — the sweep guide

`sheerPlan` is the deck edge seen from above: a curve of half-breadth `y(x)` lying in the
flat deck `z = 0`, running from the transom to the bow. It is the **guide the template is
swept along** — it sets `p` and, through its tangent, the fan of station planes. Its first
point is at the transom end (`x₀`, normally `0`), its last at the bow, where the half-breadth
typically returns toward the centerline. Half-breadths are `≥ 0`; forward steps are `> 0`.

The plan curve is *construction geometry*: the swept sheet originates at this deck edge, but
the deck edge itself is generally trimmed away — the hull's true top edge is the trim line
below.

### The trim line — the real sheer

`sheerTrim` is the actual sheer seen in profile: a curve of height `z(x) ≤ 0`, authored as a
`depth ≥ 0` below the flat deck. The strip of swept sheet between the deck (`z = 0`) and this
line is **trimmed off**; what remains, from the trim line down to the emergent keel, is the
hull. Storing `depth` rather than `z` keeps the quantity non-negative and so
interpolation-closed, and (via *depth is height*) the trim at `x` cuts the swept template at
exactly local depth `d = depth(x)`.

The trim line need not have the same control-point count as the plan curve — they are
independent generators with independent topology counts.

## The transom

The transom is the raked plane that closes the hull aft. It is a vertical-in-`y`, raked-in-
`x`-`z` plane: at height `z` its longitudinal position is `x = x_top + (z − z_top)·rake`,
constant across the breadth. The sweep is clipped to the forward side of this plane, and the
cut face is solid.

```
Transom {
  x:           number   // longitudinal position of the plane's reference point; in a bounded aft interval
  depthTop:    number   // depth of the top edge (near the sheer); ≥ 0
  dDepthBot:   number   // extra depth of the bottom edge below the top; > 0
  transomRake: number   // slope dx/dz; 0 = upright, positive leans the top toward the bow
}
```

`x` lives in a bounded interval in the aft region (a convex box). The plane is pinned by its
top edge `(x_top, z_top = −depthTop)` and its slope `transomRake`; the bottom edge's depth is
encoded as a positive increment `dDepthBot > 0` so the bottom stays below the top under every
blend. `rake` is a free real, matching the slope convention used for tilts. The actual
transom *outline* — where the plane meets the swept surface — is derived (see below), not
authored.

## The section templates

The transverse shape is a small set of templates `T₁…T_K` (`K ≥ 1`), index-aligned so they
blend point-for-point: every template carries the same `section` count, and point `i` of one
blends with point `i` of the others. In the local station frame each point is `(n, d, k)`: `n`
inboard from the deck edge, `d` down from it, and `k` the knuckle (how sharp the point is).

- Point 0 is the **sheer point**, pinned at the origin — it is where the template meets the
  deck edge. It carries no numbers (`dd = 0`, `n = 0`).
- Each later point descends by `dd > 0` and sits at inboard offset `n ∈ ℝ`. A negative `n`
  is **tumblehome** (the section leaning outboard of the deck edge); large positive `n`
  carries the section in toward the centerline, where — if it gets there — the keel emerges.

The strictly-increasing depth (cumulative `dd > 0`) is what guarantees each template — and any
blend of them — is single-valued from deck to keel and never curls upward, the sweep's
no-crossing invariant.

The templates are *pure shapes*; they are not pinned to longitudinal positions. Where each one
takes over along the hull is decided by the weight curve below. A single template (`K = 1`) is a
classical constant-camber hull; two templates on a straight blend path are the earlier aft/fore
model.

### Knuckles

The shape control on the template is the per-point **knuckle** `k ∈ [0,1]`, an authored number
on each `SectionPoint`. At `k = 0` the point is smooth: the template is a faired curve through
it. At `k = 1` the point is a hard **corner** (a `G⁰` kink); two adjacent `k = 1` points bound
a **straight** segment. Values in between ease the crease continuously — a fillet whose
tightness is authored. Concretely, `k` blends the point's faired tangent toward its one-sided
chords, so an isolated `k = 1` breaks the tangent and a `k = 1` pair collapses the segment
between them to a straight line.

Because `k` is just a number on the variant — carried per template and blended along the hull by
the weight curve, and across designs by the blend weights — a crease is **not** fixed by the
topology: a hard chine on one template (`k = 1`) fades to a round bilge wherever the weight curve
hands off to a `k = 0` template, within one hull, and a hard-chine design can blend continuously
into a round-bilge one. (A model that instead fixes creases as discrete topology flags can do
neither: a crease is then hard-or-soft for the whole family.)

There are still no authored tangents or fullness knobs beyond the knuckle: away from a corner
the curve is faired to a smooth, non-overshooting shape through the authored points, and the
strictly-descending depth keeps it single-valued whatever its orientation — at every `k`,
since the knuckle blend stays inside the monotonicity-safe range. The exact spline family is a
downstream choice, not part of the model; what the model fixes is the points, their knuckles,
and the monotone-in-depth guarantee.

## The weight curve — the longitudinal blend path

The mix of templates at a station is set by a **weight curve** `w(x) = (w₁(x),…,w_K(x))`: a
continuous, authored path from `x = 0` to `x = L` through the **blend space** — the `(K−1)`-
simplex `Δ^{K−1}` of barycentric weights, `wⱼ(x) ≥ 0`, `Σⱼ wⱼ(x) = 1`. The station template at
`x` is the convex combination

```
section(x)[i] = Σⱼ wⱼ(x) · Tⱼ[i]          // componentwise in (dd, n, k)
```

so `w(x) = eⱼ` (a corner of the simplex) gives pure template `j`, and an interior `w(x)` blends
several at once. Because the weights are non-negative and sum to one, every `section(x)` is a
convex combination of valid templates, hence itself a valid template — strictly descending in
depth, knuckles in `[0,1]` — **whatever path the curve takes**. The weight curve is the
multi-template generalization of the old fore-and-aft fraction `f = x / L`, which is exactly the
`K = 2` path `w = (1−f, f)`, the straight edge of the 1-simplex.

The curve is authored as a sequence of **weight control points**, each a station `x` and a
barycentric weight `w ∈ Δ^{K−1}`, faired between them so the path passes through each authored
split. Two properties must hold along the whole path: it must stay *inside* the simplex
(validity), and it must be *smooth* (fairness — no longitudinal hard spot at an interior control
station, the way a piecewise-linear blend would give). The reference implementation interpolates
each barycentric component with a shape-preserving monotone cubic (the same PCHIP fairing the
section templates use): it introduces no overshoot, so every component stays in `[0,1]`, and
renormalizing the vector to sum to one lands it back on the simplex. The curve therefore hits
every control point exactly — at a control station the components already sum to one, so the
renormalization is the identity there — yet stays valid and `C¹` between them, tracking the
control points tightly. The spline family is a downstream choice, not part of the model, and the
implementation carries two: this C¹ shape-preserving interpolation (the default — it keeps the
no-overshoot guarantee), and a **C² natural cubic** run in the softmax pre-image (logit) space
and mapped back, which is *curvature*-continuous (no curvature break at an interior control
station, which the C¹ form still has) and stays in the open simplex, at the cost of holding a
pure-template control point a hair off the boundary. (A convex, *approximating* B-spline through
in-simplex control points is a third valid option — it smooths past the interior control points
rather than interpolating them.) The model fixes the control points and the in-simplex, faired
requirement, not which of these is used.

## Derived geometry

Everything below is *computed by sweeping*, never authored. These are the model's outputs;
none is guaranteed to exist for a given variant, and where one does not, that is reported
rather than forbidden.

- **The hull surface** is the locus of swept sections `W(section(x))` over `x ∈ [0, L]`,
  clipped above by the trim line, below by the centerline, and aft by the transom plane,
  then mirrored to port.
- **The keel / stem / rocker** is the emergent curve of section keel points — where each
  swept section reaches `y = 0`. A section that never reaches the centerline is **open**: it
  contributes no keel point there, and the hull is open-bottomed at that station. Openness is
  a *derived* condition, not an invariant — it is the sweep analog of a displacement target:
  honest output, not something the convex encoding promises.
- **A knuckle line** is the locus of a creased template point (`k` near `1`) swept along the
  hull — an emergent chine. Like the keel it is read off the sweep, not authored as its own
  curve, and it fades out wherever the knuckle relaxes toward `0`. Derived.
- **Draft** at a station is the depth of its keel point; the maximum over `x` is the hull's
  draft. Derived.
- **The transom outline** is where the swept surface meets the raked transom plane, bounded
  above by the trim and below by the emergent keel. Derived.
- **Waterlines** (`z = const`) and **buttocks** (`y = const`) are contours traced across the
  swept sections. Derived.
- **The body plan** is the set of swept sections drawn on one transverse frame about a shared
  centerline. Derived.
- A section can also be **empty** at a station — when the emergent keel is shallower than the
  trim line, the whole template there lies above the trim and no hull exists at that `x`.
  Derived and reported.

An **inspection station** at an arbitrary `x` — the interpolated template and its two trims
shown for study — is a viewer affordance, not part of the geometry. It authors nothing.

## Interpolation and blending

Because every variant of a document shares the one topology, the variants *are* a family. A
**blend** of variants `V₁…Vₙ` with weights `wᵢ ≥ 0`, `Σwᵢ = 1`, is the variant `Σ wᵢ·Vᵢ`,
taken componentwise over the structure: each `sheerPlan` and `sheerTrim` point's `dx`/`y`/
`depth`, the transom's fields, each template point's `dd`/`n`/`k`, and each weight point's `w`. Pairwise
interpolation is the `n = 2` case, `V = (1−t)·V₁ + t·V₂`, `t ∈ [0,1]`.

Because the valid region is convex, the blend lies inside it — a valid hull with no
feasibility check:

- Every later plan/trim `dx` and every template `dd` stays positive → the guide curves stay
  single-valued in `x` and the templates stay strictly descending in depth.
- Every half-breadth `y`, trim `depth`, and transom depth stays non-negative; the transom `x`
  stays in its box; the bottom edge stays below the top via `dDepthBot > 0`.
- Free reals (`n`, rake) stay free.

**Two interpolations that no longer commute (and the bilinear defect).** The along-hull blend
(the weight curve mixing the templates) and the across-design blend (variants mixed by weights)
were the same affine operation in the two-template model, and there they commuted. With an
authored weight curve the station is `section(x) = Σⱼ wⱼ(x)·Tⱼ`, **bilinear** in the pair
(weights, templates), so blending *both* factors across designs differs from blending the swept
sections by a cross-term — for a pairwise blend `αA + (1−α)B`,

```
section(blend)(x) − blend(section)(x) = −α(1−α) · Σⱼ ( wⱼᴬ(x) − wⱼᴮ(x) )( Tⱼᴬ − Tⱼᴮ )
```

The defect vanishes — and the two blends commute exactly — whenever, for each template `j`, the
weight curve **or** the template is shared across the family: a family that varies only its
templates (shared weight curve), or only its weight curves (shared templates), still commutes and
still keeps "a point at the same place stays put." Only a family that moves both at once pays the
cross-term. **In every case the blend is still a valid hull** — convex combinations of simplex
weights stay in the simplex and of valid templates stay valid — so interpolation closure is
untouched; what is given up is the affine *interpretation*, the same trade the real-vector
parameterization makes below.

**What interpolation preserves:** any quantity *affine* in the numbers — curve orderings,
template descent, half-breadth and depth signs, the transom box, simplex weights. A template
point or weight control point at the same place in two variants stays put across the blend; the
swept *section*'s along-hull mix, however, is bilinear, so it moves by the cross-term above
unless one factor is shared.

**What it does not preserve:**

- *Emergent existence.* Whether a section closes on the centerline (keel emergence), or lies
  entirely above the trim (empty), is nonlinear in the numbers: two closing designs can blend
  to one that opens at some station, or vice versa. Valid, but to be checked as output.
- *Nonlinear derived quantities.* Draft, displacement, prismatic coefficient, wetted area,
  and the shape of waterlines vary nonlinearly along a blend. Expected — they are outputs.
- *Ratios and fairness.* A length/beam ratio held at two control points does not generally
  hold at an interpolant; the faired surface of a blend is not the blend of the faired
  surfaces. (The knuckle *value* `k` does blend affinely, but the sharpness it produces is a
  nonlinear shape effect, like fairness.)

Blending is defined only within one topology. Changing a control-point count is a different
topology — a different document. Changing knuckles is **not**: a knuckle is a number, so any
blend of creasing is just another valid variant.

## Optimization

Optimization runs over the **blend weights**, not the raw numbers. Given a document's variants
`V₁…Vₙ`, a candidate hull is `Σ wᵢ·Vᵢ` for `wᵢ ≥ 0, Σwᵢ = 1` — a point in the simplex they
span. By interpolation closure every such point is a valid hull, so there is no feasibility
phase: an objective — a target draft or displacement, a fairness or stability measure, a
desired proportion — is minimized over `w`. The variants are the vertices of the reachable
space; the optimizer chooses where in their convex hull the design sits. This keeps the
search low-dimensional — one weight per variant — and every iterate a guaranteed-valid blend
of known-good designs.

A constraint that the hull must *close* (no open sections) is an objective or a feasibility
filter on `w`, not an encoded invariant — openness is nonlinear, so the convex encoding
cannot promise it the way it promises ordering.

## Unconstrained parameterization: a real-vector variant

The encoding above makes the valid region a convex *subset* of the raw numbers — positive
orthants, a non-negative orthant, bounded intervals, a box. That is exactly right for blending
(convex combinations stay inside). But for gradient-based optimization, automatic
differentiation, or sampling it is often more convenient to carry **no constraints at all**: a
single flat vector — or fixed-shape tensor — `θ ∈ ℝᴹ` of unbounded full-precision reals, every
coordinate free, that *always* decodes to a valid hull. This is a second, equivalent
parameterization of the *same* variant, not a new degree of freedom.

It is obtained by a **change of variables**: each constrained slot of a variant is the image of
one real coordinate under a fixed, monotone, smooth bijection from `ℝ` onto that slot's domain.
Decoding applies the transforms slot-by-slot — the variant is `φ(θ)` — and the natural tensor
layout mirrors the topology: a `P×2` block for `sheerPlan` `(dx, y)`, a `Q×2` block for
`sheerTrim` `(dx, depth)`, a length-4 transom block, `K` `S×3` blocks for the templates
`(dd, n, k)` (the pinned sheer point at index 0 carries no coordinates, as before), and a
weight-curve block of one `dx` plus one length-`K` softmax pre-image per control point.

| slot(s) | domain | transform `φ: ℝ → domain` |
| --- | --- | --- |
| later `dx`, every `dd`, `dDepthBot` | `(0, ∞)` | `softplus(u) = log(1 + eᵘ)`  (or `eᵘ`) |
| `y`, `depth`, `depthTop`, first `dx` | `[0, ∞)` | `softplus(u)` |
| `k` (knuckle) | `[0, 1]` | `σ(u) = 1 / (1 + e⁻ᵘ)` |
| transom `x` | `(x_min, x_max)` | `x_min + (x_max − x_min)·σ(u)` |
| weight `w` (per control point) | `Δ^{K−1}` | `softmax(u₁…u_K)ⱼ = e^{uⱼ} / Σ_k e^{u_k}` |
| `n`, `transomRake` | `ℝ` | `u`  (identity) |

(The strict-vs-closed distinction — `> 0` versus `≥ 0` — collapses here: `softplus` and `eᵘ`
both map onto the *open* ray `(0, ∞)`, reaching the boundary only in the limit `u → −∞`, which
is harmless since those boundary points are limits of valid hulls anyway.)

Two consequences follow — one strengthening and one weakening the blending story of the
sections above.

**Validity becomes unconditional.** Because every transform lands in its domain for *every* real
input, *every* `θ ∈ ℝᴹ` decodes to a valid variant — not merely convex combinations of
known-good variants, but the whole of `ℝᴹ`. There is no feasible region to respect, so a
gradient step, a Newton step, or an unconstrained sampler may move anywhere and never produce an
invalid hull. This is strictly stronger than the convex encoding's "any blend of valid variants
is valid".

**Linear interpolation is no longer affine in the numbers.** The price is that a straight line
in `θ`-space is *not* the affine blend of the previous sections. On the positive slots it is a
**log-space** (geometric) blend — `softplus⁻¹` behaves like `log` for large values, so moving
linearly in `θ` interpolates the *logarithms* of the increments; on `k` and transom `x` it is a
**logit-space** blend. The interpolant is still a valid hull, but the affine facts — "a point at
the same place in two variants stays put", and the commutation of the along-hull blend with the
across-design blend — hold only on the identity slots (`n`, `transomRake`). The two
parameterizations therefore do different jobs:

- **The convex-affine numbers** (the encoding above) are for *authoring and blending*: variants
  are vertices, a design is a point in their simplex, a blend is an interpretable affine mix, and
  the along-hull and across-design blends commute.
- **The real vector `θ`** is for *unconstrained search*: hand the whole of `ℝᴹ` to an optimizer,
  an autodiff engine, or a sampler with no constraints and no projection, every iterate valid by
  construction.

**For sampling and priors.** A change of variables carries a Jacobian, so a probability density
placed on the constrained variant induces on `θ` an extra log-Jacobian term `Σⱼ log φⱼ′(θⱼ)` —
`log σ(u)` for each `softplus` slot, `log σ(u) + log(1 − σ(u))` for each `σ`-based slot (knuckle
or transom `x`, plus a constant `log(x_max − x_min)` for the latter), `0` for the identity
slots, and — for each weight control point — the softmax block's log-Jacobian over its `K − 1`
effective dimensions (softmax is over-parameterized by the global shift `uⱼ → uⱼ + c`, so fix the
gauge, e.g. `u_K = 0`, before taking the density). Carry that term whenever `θ` is the variable of
a sampler or a MAP objective; it is irrelevant to a purely deterministic optimization of a
geometric objective.

## Invariants

Guaranteed by the encoding rather than checked after a solve:

- There is exactly one sheer (plan curve + trim line) and one transom; the section shape is
  `templateCount` templates `T₁…T_K` blended by one weight curve.
- Every variant is parallel to its topology: `sheerPlan`, `sheerTrim`, `weights`, and each of the
  `templates` have the lengths the topology dictates; the templates are index-aligned (point `i`
  blends with point `i` across all of them).
- Each template's point 0 is the sheer point at the local origin; the transom is two points.
- **Curve ordering** holds automatically: each guide curve's and the weight curve's first
  `dx ≥ 0` anchors the chain and every later `dx > 0` gives strictly increasing `x`.
- **Template descent** holds automatically: every template `dd > 0` gives strictly increasing
  depth, so each template — and every blend of them — is single-valued from deck to keel and
  never curls upward.
- All half-breadths, trim depths, and transom depths are `≥ 0`; every knuckle `k` lies in
  `[0,1]`; every weight control point's `w` lies in the simplex (`wⱼ ≥ 0`, `Σ wⱼ = 1`); the
  transom `x` lies in its interval and its bottom edge lies below its top via `dDepthBot > 0`.
- **Interpolation closure:** for any weights `wᵢ ≥ 0, Σwᵢ = 1`, the blended variant satisfies
  all of the above. This is the defining invariant and follows from the convexity of the valid
  region.

The emergent keel, draft, waterlines, buttocks, transom outline, displacement, and whether a
section is open or empty are *derived* — none is an invariant.

## Persistence

The on-disk format is the `HullDocument` serialized directly to JSON — the same structures named
above, with their field names verbatim: a `length`, a `topology` (`sheerPlan` / `sheerTrim` /
`section` / `templateCount` / `weightPoints` counts), and a `variants` array. Each variant holds
`sheerPlan` (`PlanPoint`), `sheerTrim` (`TrimPoint`), `transom` (`Transom`), a `templates` array
of `templateCount` `SectionPoint` lists, and `weights` (`WeightPoint`), in the increment encoding
defined above — `dx` / `dd` steps, the transom's `depthTop` / `dDepthBot` / `transomRake`, per-
point `k`, and each weight point's barycentric `w`. A variant may carry an optional `name`. `k`
is optional on read and defaults to `0` (smooth). A document in the earlier two-template form —
`aft` / `fore` instead of `templates` / `weights` — still reads, as two templates on a straight
blend path. Absolute coordinates are recovered by running sums on load.

A complete (deliberately minimal) document — a `2 / 2 / 3`, two-template topology on a straight
blend path, with one knuckle at the chine; the fuller hulls in [`examples/`](examples/) follow the
same shape:

```json
{
  "length": 4000,
  "topology": { "sheerPlan": 2, "sheerTrim": 2, "section": 3, "templateCount": 2, "weightPoints": 2 },
  "variants": [
    {
      "name": "demo",
      "sheerPlan": [ { "dx": 0, "y": 800 }, { "dx": 4000, "y": 0 } ],
      "sheerTrim": [ { "dx": 0, "depth": 60 }, { "dx": 4000, "depth": 40 } ],
      "transom":   { "x": 150, "depthTop": 55, "dDepthBot": 665, "transomRake": -0.3459 },
      "templates": [
        [ { "dd": 0, "n": 0, "k": 0 }, { "dd": 400, "n": 250, "k": 1 }, { "dd": 600, "n": 900,  "k": 0 } ],
        [ { "dd": 0, "n": 0, "k": 0 }, { "dd": 500, "n": 300, "k": 0 }, { "dd": 700, "n": 1000, "k": 0 } ]
      ],
      "weights": [ { "dx": 0, "w": [1, 0] }, { "dx": 4000, "w": [0, 1] } ]
    }
  ]
}
```

A document carries one *or more* variants: the editor reads and writes a single-variant document
(one hull), while the interpolation viewer loads a multi-variant document — or several documents —
as one blend family. Complete examples live in [`examples/`](examples/). What is *not* fixed is
**versioning and migration**: the format carries no version tag, so a breaking change to these
structures has no migration story.

## Out of scope

Deliberately deferred and not modelled:

- **Appendages.** Rudders, skegs, keel fins, bulbs, daggerboards.
- **Multi-hulls.** Catamarans, trimarans — the likely path is composing several hull
  documents rather than extending one.
- **Authored longitudinals.** This model has no *independently authored* chines, diagonals, or
  chevrons. The authored *surface* longitudinal is the sheer; the emergent ones are the keel and
  any knuckle line (a creased template point swept along the hull — see Derived geometry). The
  weight curve is authored and runs longitudinally too, but it lives in blend space, not on the
  hull. A design needing a longitudinal authored as its own surface curve is a different
  parameterization.
- **Plating and scantlings.** The model describes a molded surface, not a shell.
- **Format versioning and migration.** The JSON format is specified (see [Persistence](#persistence)),
  but it carries no version tag and there is no migration story for breaking changes.
- **Cross-topology morphing.** Blending designs with different control-point counts requires
  an explicit correspondence and is not modelled — a different `templateCount` or `weightPoints`
  is likewise a different topology. (Differing knuckles are *not* cross-topology — they blend
  like any other number.)
- **Recovering a blend's design intent.** A blend is valid but anonymous — track provenance
  outside the document if it matters.

The spline families (the sheer's plan and trim curves, the section templates, the weight curve),
their end conditions, fairing weights, and surface-fit tolerances are downstream choices, not
properties of the model — what the model fixes is the control points, their knuckles, the
simplex-valued weight path, the monotonicity guarantees, and the sweep construction.
