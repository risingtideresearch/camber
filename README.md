# Swept-Camber Hull Data Model

This document defines a parametric description of a boat hull built by the
**constant-camber** method: a single transverse template is **swept along the sheer**,
its shape blending from a stern template to a bow template as it runs. Every quantity is a
concrete authored number — there are no ranges and no constraints — and the
parameterization is chosen so that it is **stable under interpolation**: given two or more
valid hull designs, any blend of them is again a valid hull. Design exploration happens by
moving through the space *between* concrete designs, and optimization runs over that space
directly.

The traditional constant-camber technique builds a hull by sweeping one mould of fixed
transverse curvature along a guide, so every panel comes off the same jig. This model keeps
the sweep and generalizes the mould: instead of one fixed section it carries two — an
**aft** template and a **fore** template — and interpolates between them along the length.
A constant-camber hull in the classical sense is the special case where the two templates
are equal.

## Design philosophy

- **The sweep is primary; almost everything else is emergent.** A hull is authored as a
  small set of *generators* — one **sheer** (a plan-view guide curve plus a profile trim
  line), one raked **transom** plane, and a single transverse **section template** given at
  the two ends of the hull. The 3-D surface is the locus traced by sweeping that template
  along the sheer. The **keel, stem, and rocker are not authored** — they emerge where the
  swept sections reach the centerline. So are the waterlines, buttocks, draft, and the
  transom's cut outline. There is no separate keel curve to keep consistent with the
  sections; the bottom is wherever the sweep closes.
- **One template, swept and blended.** The transverse shape is a single template carried at
  the aft and fore ends; at any station it is the linear blend of the two by fore-and-aft
  fraction `f = x / L`. This *along-hull* blend is intrinsic to one design and is distinct
  from the *across-design* blend of variants below — but the two are the same affine
  operation, and they commute (see [Interpolation](#interpolation-and-blending)).
- **Everything positional is a concrete number.** A control point's position, a template
  point's depth and offset, the transom's rake — each is a single authored number. There is
  no position-solving phase; the only thing downstream code does is *evaluate* the sweep and
  fair the curves through the authored points.
- **A document is one topology and a set of variants.** The **topology** is the discrete
  structure — how many control points each generator has, and which template points are
  creases — and carries no geometry. A **variant** is the numbers laid over that structure.
  One variant resolves to one hull; several variants over the same topology form a family
  that interpolates.
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
  length:        number         // L, overall length (x of the bow); > 0, shared constant
  waterDensity?: number         // tonnes/m³; default 1.025 (seawater)
}
```

Nothing is referred to by id. There is exactly one sheer, one transom, and one section
template (carried at two ends), so all of these are implicit — there are no lists to index.
The only discrete freedom is *how many control points* each generator has and *which
template points are creases*:

```
Topology {
  sheerPlan: number      // count of sheer plan-curve control points; ≥ 2
  sheerTrim: number      // count of sheer trim-line control points; ≥ 2
  section:   boolean[]   // one flag per template point: is it a corner? length = point count, ≥ 2
                         //   index 0 is the sheer point (the deck edge); see Section template
}
```

The `section` flags are shared by the aft and fore templates, which are index-aligned so the
along-hull blend pairs point `i` with point `i`. The transom is always two points (top and
bottom of its raked plane), so it needs no count.

A variant mirrors the topology, holding the numbers — a scalar where there is one of a thing
(`transomRake`), and a vector parallel to each topology count:

```
Variant {
  name?:       string
  sheerPlan:   PlanPoint[]       // length = topology.sheerPlan; the deck-edge guide curve
  sheerTrim:   TrimPoint[]       // length = topology.sheerTrim; the real sheer, in profile
  transom:     Transom           // the raked stern plane
  aft:         SectionPoint[]    // length = topology.section.length; template at x = 0
  fore:        SectionPoint[]    // same length; template at x = L
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

```
PlanPoint    { dx: number,  y: number }      // dx > 0 (≥ 0 for point 0); y ≥ 0 (half-breadth at z = 0)
TrimPoint    { dx: number,  depth: number }  // dx > 0 (≥ 0 for point 0); depth ≥ 0 (below the flat deck)
SectionPoint { dd: number,  n: number }      // dd > 0 (= 0 for point 0, the sheer); n ∈ ℝ (n < 0 = tumblehome)
```

The valid region of a variant is thus the product of: positive orthants (every later plan/
trim `dx`, every template `dd`), a non-negative orthant (every `y`, every `depth`), free
lines (every `n`, the transom rake), and the transom's bounded box (below). Every factor is
convex and an intersection of convex sets is convex, so the valid region is convex. **Any
convex blend of valid variants is valid**, with no feasibility check.

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
  x:           number   // longitudinal position of the plane's reference point; ∈ [0, 0.45·L]
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

## The section template

The transverse shape is one template, authored at the two ends of the hull as `aft`
(`x = 0`) and `fore` (`x = L`) and index-aligned so they blend point-for-point. In the local
station frame each point is `(n, d)`: `n` inboard from the deck edge, `d` down from it.

- Point 0 is the **sheer point**, pinned at the origin — it is where the template meets the
  deck edge. It carries no numbers (`dd = 0`, `n = 0`).
- Each later point descends by `dd > 0` and sits at inboard offset `n ∈ ℝ`. A negative `n`
  is **tumblehome** (the section leaning outboard of the deck edge); large positive `n`
  carries the section in toward the centerline, where — if it gets there — the keel emerges.

The strictly-increasing depth (cumulative `dd > 0`) is what guarantees the swept section is
single-valued from deck to keel and never curls upward, under any blend — the sweep's
no-crossing invariant.

The template at an arbitrary station `x` is the affine blend of the two ends by
`f = x / L`:

```
section(x)[i] = (1 − f)·aft[i] + f·fore[i]          // componentwise in (dd, n)
```

This is a complete design with a single template (constant camber) when `aft = fore`.

### Corners

The only authored shape control on the template is the **corner** flag, held per point in
`topology.section`. Between corners the template is a smooth faired curve through its points;
a corner point is a **kink** (a `G⁰` break), and two adjacent corners bound a **straight**
segment. Corners are *topology*, shared by the aft and fore templates and fixed across the
whole family — so a hard chine cannot fade to soft within a blend (contrast a model that
makes the crease a continuous number). To change which points are creased is to change the
topology, i.e. to author a different document.

There are no authored tangents or fullness knobs: away from corners the curve is faired to a
smooth, non-overshooting shape through the authored points, and the strictly-descending depth
keeps that curve single-valued whatever its orientation. The exact spline family is a
downstream choice, not part of the model; what the model fixes is the points, the corners,
and the monotone-in-depth guarantee.

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
`depth`, the transom's fields, and each `aft`/`fore` point's `dd`/`n`. Pairwise interpolation
is the `n = 2` case, `V = (1−t)·V₁ + t·V₂`, `t ∈ [0,1]`.

Because the valid region is convex, the blend lies inside it — a valid hull with no
feasibility check:

- Every later plan/trim `dx` and every template `dd` stays positive → the guide curves stay
  single-valued in `x` and the templates stay strictly descending in depth.
- Every half-breadth `y`, trim `depth`, and transom depth stays non-negative; the transom `x`
  stays in its box; the bottom edge stays below the top via `dDepthBot > 0`.
- Free reals (`n`, rake) stay free.

**Two interpolations that commute.** The along-hull blend (`aft → fore` by `f = x/L`) and the
across-design blend (`V₁ → V₂` by weights) are the same affine operation, so they commute:
the section of a blended design equals the blend of the sectioned designs,

```
section_blend(x) = lerp( blend(aft), blend(fore), x/L ) = blend( lerp(aft, fore, x/L) )
```

so it does not matter whether you sweep then blend or blend then sweep.

**What interpolation preserves:** any quantity *affine* in the numbers — curve orderings,
template descent, half-breadth and depth signs, the transom box. A point at the same place in
two variants stays put across the blend.

**What it does not preserve:**

- *Emergent existence.* Whether a section closes on the centerline (keel emergence), or lies
  entirely above the trim (empty), is nonlinear in the numbers: two closing designs can blend
  to one that opens at some station, or vice versa. Valid, but to be checked as output.
- *Nonlinear derived quantities.* Draft, displacement, prismatic coefficient, wetted area,
  and the shape of waterlines vary nonlinearly along a blend. Expected — they are outputs.
- *Ratios and fairness.* A length/beam ratio held at two corners does not generally hold at
  an interpolant; the faired surface of a blend is not the blend of the faired surfaces.

Blending is defined only within one topology. Changing a control-point count, or which
template points are corners, is a different topology — a different document.

## Optimization

Optimization runs over the **blend weights**, not the raw numbers. Given a document's variants
`V₁…Vₙ`, a candidate hull is `Σ wᵢ·Vᵢ` for `wᵢ ≥ 0, Σwᵢ = 1` — a point in the simplex they
span. By interpolation closure every such point is a valid hull, so there is no feasibility
phase: an objective — a target draft or displacement, a fairness or stability measure, a
desired proportion — is minimized over `w`. The variants are the corners of the reachable
space; the optimizer chooses where in their convex hull the design sits. This keeps the
search low-dimensional — one weight per variant — and every iterate a guaranteed-valid blend
of known-good designs.

A constraint that the hull must *close* (no open sections) is an objective or a feasibility
filter on `w`, not an encoded invariant — openness is nonlinear, so the convex encoding
cannot promise it the way it promises ordering.

## Invariants

Guaranteed by the encoding rather than checked after a solve:

- There is exactly one sheer (plan curve + trim line), one transom, and one section template
  carried at the aft (`x = 0`) and fore (`x = L`) ends.
- Every variant is parallel to its topology: `sheerPlan`, `sheerTrim`, `aft`, and `fore` have
  the lengths the topology dictates; `aft` and `fore` are index-aligned and share the
  `section` corner flags.
- The section template's point 0 is the sheer point at the local origin; the transom is two
  points.
- **Curve ordering** holds automatically: each guide curve's first `dx ≥ 0` anchors the
  chain and every later `dx > 0` gives strictly increasing `x` — a single-valued guide.
- **Template descent** holds automatically: every template `dd > 0` gives strictly increasing
  depth, so the swept section is single-valued from deck to keel and never curls upward.
- All half-breadths, trim depths, and transom depths are `≥ 0`; the transom `x` lies in its
  interval and its bottom edge lies below its top via `dDepthBot > 0`.
- **Interpolation closure:** for any weights `wᵢ ≥ 0, Σwᵢ = 1`, the blended variant satisfies
  all of the above. This is the defining invariant and follows from the convexity of the valid
  region.

The emergent keel, draft, waterlines, buttocks, transom outline, displacement, and whether a
section is open or empty are *derived* — none is an invariant.

## Out of scope

Deliberately deferred and not modelled:

- **Appendages.** Rudders, skegs, keel fins, bulbs, daggerboards.
- **Multi-hulls.** Catamarans, trimarans — the likely path is composing several hull
  documents rather than extending one.
- **Authored longitudinals.** This model has no chines, diagonals, or chevrons; the only
  longitudinals are the sheer (authored) and the keel (emergent). A design needing
  independent authored longitudinals is a different parameterization.
- **Plating and scantlings.** The model describes a molded surface, not a shell.
- **Persistence format and versioning.** No on-disk format or migration story is specified.
- **Cross-topology morphing.** Blending designs with different control-point counts or corner
  patterns requires an explicit correspondence and is not modelled.
- **Recovering a blend's design intent.** A blend is valid but anonymous — track provenance
  outside the document if it matters.

The spline families (the sheer's plan and trim curves, the section template), their end
conditions, fairing weights, and surface-fit tolerances are downstream choices, not properties
of the model — what the model fixes is the control points, the corners, the monotonicity
guarantees, and the sweep construction.
