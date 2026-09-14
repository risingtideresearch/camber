# Direct mesh geometry (Phases 2–3)

This is a constrained geometry backend with supported STL weight-book/point/stability features and developer harnesses, **not the standalone import/project application or universal Camber/STL parity**. Camber still uses its sweep for existing hydrostatics, KN, metrics and authored station cuts.

## Entry points

- `prepare.ts`: physical setup, welding, topology/orientation/intersection validation.
- `import.ts`: hardened ASCII/binary STL parser → physical preparation → closed, validated-open-sheer, or surface-only analysis mode.
- `section.ts`: arbitrary-plane region/path query, accelerated by an AABB tree.
- `immersion.ts`: clipped signed tetrahedra for volume, centroid and physical wetted area; waterplane moments come from section loops.
- `measurements.ts`: explicitly scoped shell area/CG, closed-envelope full volume, and supported reference-waterplane measurements.
- `projection.ts`: visual projection coverage and body-frame display geometry.
- `compute.ts`: mesh implementation of shared immersed operations, KN/KMt construction, and query dispatch.
- `client.ts` / `worker/meshAnalysisWorker.ts`: install an asset once; send small subsequent queries. Original asset bytes are retained. Dispose/replace the worker to cancel executing numerical work.
- `closure.ts`: conservative top-boundary validation, open-sheer winding resolution, and a legacy explicit cap path.
- `../sections.ts`: geometry-independent plane, region, boundary-source, measurement and accuracy contracts.
- `../immersed.ts`: shared numerical march above an `ImmersedBackend`. `core/stability.ts` wraps the sweep behind these operations without changing its calculations or default sampling.

`createMeshAnalysis()` is a local/test convenience. Browser hosts should use the worker client:

```ts
const client = createStlAnalysisClient(originalBytes, {
  physical: {
    metresPerUnit: 0.001, // user-confirmed; STL contains no unit
    axes: [1, 2, 3],
    origin: [0, 0, 0],
  },
  analysis: {
    id: "asset-and-setup-revision", // host must change this when setup/source changes
    fixedTrim: 0,
    keelZ: -0.8, // explicit upright KG datum, metres
    referenceWaterlineZ: -0.2, // explicit upright height, NOT Camber waterline depth
    // Optional: ONLY after deliberate scope confirmation. Bare STL defaults to
    // physical surface "unclassified", which includes any deck/transom faces.
    // shellScope: { confirmed: true, surfaces: ["unclassified"], label: "All supplied physical faces (not Camber skin)" },
  },
  // Permit one validated open sheer. No cap faces are added; immersed
  // integration stops when any rim point reaches the waterplane.
  openSheer: true,
  // Legacy explicit sealed mode remains available to low-level callers only:
  // deckClosure: { accepted: true, closureId: "explicit-cap" },
});
const report = await client.ready;
const section = await client.hull.section({
  plane: { origin: [2, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  envelope: "buoyancy",
});
const tables = await client.hull.stability();
// client.dispose() when the project/source is replaced or the window closes.
```

The host supplies setup policy here. The standalone workspace opens with parsing only, then validates one supported open sheer when a buoyancy calculation is requested, without retaining cap faces. Its asset-owned service reuses physical preparation across analysis-setting changes. Lower-level callers must opt in with `openSheer: true`; explicit `deckClosure` remains a separate legacy/sealed assumption.

## Frames and datums

Physical setup applies a signed axis permutation, positive scale, optional axis-angle rotation, then subtracts the explicit origin. It never uses the overlay's fit scale or design-box centring. Winding is determined from adjacency and signed volume, not STL normals; reflections are supported and reported.

`section()` coordinates are **metres in the orthonormal body/hull frame, before fixed trim**. This is the unraked deck frame for Camber's new plane-section path. `u × v` is the normal; neither basis vector is silently normalised. Results use the requested local 2-D frame.

Stability rotates body vertices through fixed trim, then measures a heeled waterplane. `keelZ` and `referenceWaterlineZ` are explicit heights in the upright, fixed-trim frame. Mesh contexts supply `hullToWeight` and `kgDatum`; the former maps body points to upright Cartesian weight coordinates, subtracting the KG datum in z. Do not use an affine point mapping directly to transform normals.

Camber's legacy hybrid deck-x/world-z weight mapping remains in `outlines().frame`, unchanged. Its existing `HULL.WATERLINE` still means authored depth. The shared weight feature preserves these legacy cuts and formulas; it resolves new transverse cuts and mesh horizontal cuts explicitly into body-frame physical planes.

## Supported and rejected inputs

A buoyancy envelope supports one connected, orientable, edge- and vertex-manifold triangle surface. Geometry-only sections may have multiple regions or holes; neither implies permission to analyse multiple hull components. The standalone workspace may retain a safely parsed and cleaned surface which fails these envelope checks so weight authoring, display, projection and explicitly scoped surface area/CG are not held hostage by hydrostatic topology. Envelope-dependent queries remain unavailable with the validation reason.

Stability prefers surface-area-verified reflection symmetry about body y=0, but practical STL tessellations rarely match at predicate tolerance. When exact coverage fails, a bounded quality check compares centreline placement, a representative transverse buoyancy centroid and immersed volumes at ±30° and ±40°. A maximum discrepancy up to 5% is accepted with a visible approximate-symmetry assumption; larger asymmetry remains unsupported. Geometry is never silently mirrored.

Checks include:

- Bounded STL input (64 MiB / 200,000 triangles), complete ASCII facets and binary size/count checks, finite coordinates, and finite positive physical scale.
- Scale-aware vertex welding with neighbouring-cell searches.
- Cleanup of degenerate/duplicate faces for a surface-only workspace; non-manifold edges/vertices, disconnected components and non-orientable surfaces still reject a buoyancy envelope.
- AABB broad phase and triangle separating-axis tests, including coplanar overlap, for self-intersections/ambiguous non-adjacent contacts.
- Consistent winding and positive signed volume for closed envelopes. Reorientations and the weld tolerance are reported.

This is floating-point validation, not exact-predicate CAD repair. The default weld tolerance is `max(1e-10 m, diagonal × 1e-8)`. User-specified tolerances must be positive, at most `diagonal × 1e-4`, and large enough for the coordinates' floating-point resolution. Shared-face contact tests inset adjacent faces by eight tolerances to exclude their permitted seam; sub-tolerance defects are not resolved. No verified geometry-error bound is claimed. Extremely thin/near-degenerate geometry should be repaired or rescaled externally, not trusted because it renders.

## Sections and topology

- Closed outer loops are CCW, holes CW, viewed along `u × v`. No duplicate closing point.
- One source tag describes each outgoing loop edge; paths have one fewer edge than points. Physical surface and synthetic closure lengths remain separate.
- Returned area, centroid and centroidal second moments are signed polygon integrals with holes subtracted, accumulated about a nearby origin.
- A miss is available with no regions/paths and zero area/perimeter. Its centroid is unavailable.
- Open intersections retain open paths. Total enclosed measurements are unavailable; no closing segment is invented.
- Cuts along mesh edges use the negative-halfspace boundary limit and carry a diagnostic. Coplanar faces, branched/touching contours and degenerate regions are explicitly unavailable. Move the plane beyond the reported tolerance; do not interpret unavailability as an empty cut.
- Requested section tolerance may be between the prepared tolerance and 100 times it. The accuracy report identifies triangle intersection and triangle count; its shape-error bound is `null`.

Camber's `section()` uses a lazily constructed, tagged mesh plus the closure below. An invalid tessellated envelope makes only this new query unavailable. Legacy station and plane measurements still use the sweep. Sampling resolution belongs to the immutable Camber context; this result is not claimed to be an exact intersection of the analytic hull surface.

## Closed and open-deck envelopes

Closed mode requires no artificial closure. Unannotated closed meshes have **unknown sheer and downflooding**, not a perpetually dry deck. KN and valid KMt remain available independently. The mesh march excludes the undefined zero-volume KN endpoint rather than interpolating from an invented dry-limit arm. Null deck-immersion entries and explicit availability reasons survive table conversion; the shared panel labels an unknown sheer as unknown and disables its overlays.

Open-sheer validation operates directly on an already manifold/intersection-validated
surface. It requires one boundary projecting to a simple hull-xy polygon (at most
2,000 vertices), a usable upright immersion interval below the lowest rim, and a
finite positive submerged-volume probe. Boundary winding determines the outward
skin orientation; if necessary all face and boundary windings are reversed without
changing vertex positions, face IDs or the spatial tree. Bottom openings with no
dry-rim interval, vertical side openings with no XY area, projected crossings and
multiple boundaries remain unsupported.

No temporary sheer cap is triangulated, validated or stripped. The skin is no
longer required to fit beneath a hypothetical triangulated roof: only the real
surface must be non-self-intersecting, and the actual rim must stay dry at every
queried heel/waterplane. The waterplane closure is implicit in the volume integral.
Legacy explicit `deckClosure` still constructs and validates an actual numerical
cap, with its separate sealed-deck assumption.

Immersion integrates the wetted physical/repair surface against the instantaneous waterplane. No sheer/deck cap faces enter the prepared analysis mesh, display geometry, shell measurements or volume integral. For each heel, the sinkage march ends at the lowest projected rim point; states at and beyond that point are unavailable rather than hypothetical sealed-deck results.

The low-level API opts into this behavior with `openSheer: true`. `deckClosure` remains available only as an explicit sealed-envelope assumption for callers that genuinely need post-rim-immersion calculations.

The spike also found and fixed outward STL winding: the renderer's port mesh mirrored vertices and stored normals but not vertex order. Export now writes outward vertex order on both halves. Import still validates winding independently and never trusts supplied normals.

## Numerical checks and performance

Commands:

```sh
npm run test:mesh-analysis   # also included in npm test
npm run bench:mesh-analysis  # timings + Camber resolution comparisons
npm run dev                 # open /test/mesh-browser.html
npm run build:mesh-spike    # separate developer artifact in dist/mesh-spike/
```

The browser harness runs actual asset-once workers, independent queries, cached stability, in-flight disposal, and table-only rendering with an unknown sheer. It has also been exercised from a production build hosted beneath `/spike/`, including worker and CSS URLs. It is not a new product app/deployment entry.

Regression budgets on the analytic fixtures are `1e-9` absolute for ordinary metre-scale volumes, areas and moments; `1e-8 m` for acceleration/direct centroid comparisons. Tests include inclined/edge/basis-change cuts, an annular prism, a connected U-prism with disconnected sections, non-planar closures, units/reflections/datums, small- and large-angle box results, malformed inputs and worker lifecycle. 240 deterministic arbitrary halfspaces compare accelerated and direct tetrahedral integration.

`test/support/meshIntegral.ts` stays independent and unchanged. On the tested default/non-zero-trim Camber hulls below deck immersion, the new backend agrees with that separate theorem to `1e-7 m³` / `1e-7 m` (volume / KN). These are comparison budgets, not error guarantees for arbitrary STL files.

Observed ARM64 VM / Node timings (single run; not portable performance guarantees):

| Triangles | Preparation | Section p95, 100 requests | KN/KMt before acceleration | KN/KMt after acceleration |
| --------- | ----------: | ------------------------: | -------------------------: | ------------------------: |
| 12,288    |      0.49 s |                   1.06 ms |                     1.43 s |                    0.47 s |
| 49,152    |      1.67 s |                   1.25 ms |                     5.42 s |                    1.57 s |
| 196,608   |      6.77 s |                   5.29 ms |                    21.97 s |                    6.16 s |

The initially slow dense-mesh sinkage march prompted **exact BVH bulk integration**: fully submerged nodes cache moving-apex tetrahedral coefficients; only straddling leaves are clipped. This changes no tessellation and introduces no sectional sampling approximation. For the constrained spike this is preferable to a second, approximate sectional backend. Dense imports still need progress reporting and more memory/browser profiling before broad support.

Production Chromium worker timings after acceleration: the 12,288-triangle box prepared in 0.73 s, section p95 was 1.8 ms, and KN/KMt took 1.19 s. The 5,176-triangle closed Camber export prepared in 0.49 s, section p95 was 0.7 ms, and KN/KMt took 0.61 s. Repeated cached stability queries were below the displayed timer resolution. The near-200k case has Node coverage, **not equivalent browser performance coverage**.

### Historical parity finding

Before the transom correction, at 80 sections / 6 girth steps, reference-volume differences from the sweep were approximately **0.37% at zero trim and 0.54% at 0.07 rad trim**. At 160/10 they are **0.55% and 0.72%**, respectively: they do **not** monotonically converge away. At 1.2 rad heel after deck immersion, volume differences improve from up to 3.11% at 40/3 to 0.39% at 160/10; KN differences fall below 0.34 mm in that tested high-resolution pair.

The dry residual was traced to the sweep's transom closure and is now corrected in production, as described below. These historical results do not establish general Camber-export parity or a universal error bound; post-deck-immersion closure differences remain a separate question.

### Dry-volume investigation

Reproduce the current comparison with `npm run investigate:mesh-volume` (`test/mesh-discrepancy.ts`). It holds girth resolution at 10 and varies only the longitudinal resolution, comparing the production sweep with the unchanged independent mesh oracle and archived pre-fix values. The deck is dry, so neither synthetic deck closure nor post-immersion behaviour explains this discrepancy.

**Original cause:** `stationGeometry()` in `src/core/sweep.ts` closed a transom-ended section horizontally from its last skin point to the centreline:

```ts
if (!c.keel) poly.push([aC, pts[pts.length - 1][2], 0]);
```

A fanning station has `x = px + nx × a`. For a raked transom, its intersection in that station is therefore inclined, not horizontal. If the skin endpoint is `(aEnd, zEnd)`, the transom's centreline height is:

```text
zCentre = zEnd + (aC − aEnd) × nx × (ΔzTransom / ΔxTransom)
```

On the tested hull, the horizontal closure leaves out a small aft wedge. For example, at `u=0.06875`, its centreline closure is at −1026.72 mm instead of −1117.75 mm. Increasing section count converges more accurately to the wrong, truncated solid; it cannot remove this geometric error.

The initial investigation adjusted only these lower endpoints in a **copy** of the sweep geometry:

| Trim     | Sections / girth |     Original volume gap | Gap after diagnostic adjustment |
| -------- | ---------------- | ----------------------: | ------------------------------: |
| 0 rad    | 160 / 10         | 0.546817% (8.86 litres) |                      −0.002429% |
| 0.07 rad | 160 / 10         | 0.715848% (7.08 litres) |                      −0.010071% |
| 0 rad    | 640 / 10         |               0.549528% |                      −0.000135% |
| 0.07 rad | 640 / 10         |               0.774695% |                      +0.000051% |

Percentages are `(mesh / sweep − 1) × 100`, substituting the diagnostic sweep in the last column. The remaining difference now converges with refinement, strongly isolating the lower transom closure as the cause of this dry-volume residual.

**Why the diagnostic alone was not a production fix:** correcting polygon volume alone leaves waterplane area and moments inconsistent. The old waterplane code integrated from a _skin_ crossing to the centreline and misses strips bounded by the transom instead. At zero trim / 160 sections:

- Old reported waterplane area: 4.882257 m².
- Derivative of the diagnostically corrected volume: 4.945869 m².
- Direct mesh waterplane area: 4.944899 m².

The original volume derivative agreed with the original reported area: those two calculations were internally consistent, but represented the same incorrectly closed solid.

### Production correction

`src/core/sweep.ts` now closes each section **before** transom trimming, then clips that solid by `x >= xTransom(z)`. This handles lower and upper transom cuts, vertical and reversed rake, and interior columns whose skin was entirely trimmed away. Empty columns remain zero quadrature endpoints rather than being skipped. Transom/deck/centreline edges remain excluded from skin area.

Waterplane crossings are taken from the entire clipped polygon and paired into interior intervals. Area, first moments and second moments use those intervals and the same longitudinal quadrature as volume. The sampled waterline includes transom-boundary points, while its skin-only runs remain separate. Unsupported disconnected/multi-interval drawings, longitudinal gaps, and interior holes return no legacy single-loop outline instead of an invented join; numerical moments are still integrated.

At 160 sections / 10 girth steps, the production dry-volume gap is −0.002416% at zero trim and −0.010051% at 0.07 rad trim. At 640/10 these become −0.000122% and +0.000072%. The zero-trim waterplane area is now **4.945869084 m²**, agreeing with `dV/d(waterline)` to numerical precision and with the independently tessellated area to its sampling accuracy.

`npm run test:transom-sweep` is included in the full suite. It covers analytic clipped sections, skin provenance, transom-only waterplanes, re-entrant intervals, closure-only/empty columns, forward/reversed/vertical/nearly vertical transoms, non-zero trim, volume/CB/KN comparisons, both waterplane moments, and fixed-volume small-angle agreement with KMt. Existing stability tests now require 0.1% mesh agreement rather than 1%, with a tighter refinement check.

This is an intentional correction to Camber's derived numbers: hydrostatics, KN/KMt, fixed hull metrics and dependent weight/horizontal-cut results can change. `test/fixtures/analysis/baseline.json` remains the original pre-extraction capture. Only the affected metric/plane/stability/book subtrees are overlaid from the explicitly labelled `transom-correction.json`; unchanged authored-station and point-view fixtures still use their original expectations. Saved hull/book formats and authored point frames are unchanged. The separate legacy authored-station measurement/construction API is not migrated by this sweep correction.

This fix does not establish general post-deck-immersion closure parity.

## Still deferred

Interactive face selection, advanced persisted cut constructions/reference dependencies, repair beyond the bounded policy below, regulatory flooding and free trim/materially asymmetric stability remain later work. The progressive workspace includes optional local recovery, not a guaranteed backup. The local STL workspace now provides import/setup, portable project download/reopen and an independent build. The supported Phase 3 API and shared-feature workflow are described in [the shared feature notes](../README.md#phase-3-composition-and-semantics). Geometry validation, a closed numerical solid and a green intact-stability criterion do not certify a boat.

## Phase 3 verification and limits

`npm run test:stl-features` is included in `npm test`. A 4 × 2 × 2 m classified prism has 28 m² of selected skin (excluding the 4 m² aft transom and 8 m² deck), shell CG (16/7, 0, 5/7) m, 16 m³ envelope volume and 18 m² selected wetted area at z=1. Tests also confirm explicit all-physical scope, unconfirmed scope, missing tags, nonzero trim/KG datum, non-differentiable cuts, v1/v2 books and the sheet-linked condition. Generic projections preserve a ring's projected hole and a U-profile's concavity, independently of section topology.

Optional Chromium smoke checks exercise the standalone workspace's progressive import, setup, shared panels, detached editing, repairs, persistence and recovery; they are kept outside the default test suite and CI. WebGL may be unavailable in headless environments, so the 2D preview and calculations remain independently usable.

Missing metadata remains local: `WATERLINE` is unavailable because the imported setup has no Camber depth-below-deck datum; `AM`, `AMAX`, `CP`, `CM`, `DEADRISE` and `HALF_ENTRANCE` have no defined authored-station equivalent here. LOA is the upright longitudinal envelope extent; LCB/LCF and shell positions use the confirmed weight origin and KG datum. Whole-envelope volume and scoped shell properties do not require a valid reference waterplane. This release does not infer skin from normals/names or certify arbitrary hull shapes from prism tests.

## Bounded repair and overhanging hull sides

The STL workspace offers on-demand, explicit, previewed repairs via `repair.ts`: a versioned snap/cleanup policy and tightly bounded small-hole patches, followed by the unchanged strict manifold, intersection and volume checks. Snapping is separate from numerical predicate tolerance. `MeshImport.repair` requires `accepted: true`; permission to close a remaining deck is still separate. Original bytes plus policy are saved, not rewritten STL or cached geometry.

Synthetic faces can carry `purpose: "repair"` or `"deck"`. Repair patches are excluded from shell measurements and deck/sheer references. Legacy synthetic tags without a purpose retain their existing deck-reference semantics. The deck validation also permits skin outside its XY footprint when below the nearest rim (tumblehome/overhang), without bypassing cap/skin intersection checks.

See [the workspace's repair limits and actual-file results](../../stl-workspace/README.md#repairing-real-stl-exports). This is not an arbitrary remesher, a flooding model, or automatic symmetrisation.

### Incremental small-hole preparation

Automatic patches consume the existing validated indexed mesh. Only boundary-loop
vertices are projected for triangulation. Patch triangles must use existing vertex
IDs and pass the original degeneracy tolerance. Their source tags remain synthetic
repair faces, excluded from physical shell measurements.

The append path rechecks full connectivity, vertex/edge manifoldness, boundary
loops and winding, and builds a combined spatial tree. It checks all new/old and
new/new triangle pairs that overlap in the broad phase. Only old/old intersection
checks are reused, since their vertices and tolerance are unchanged. No geometry
or report of the source mesh is mutated, including when a patch fails validation.

General cleanup/stitching still fully validates its changed skin, but preparation
continues directly from the weld result without another triangle-soup expansion
and welding pass. Both paths share the indexed topology validator and the same
triangle-conflict predicate. `test:stl-repair` compares incremental results with
full revalidation and tests patch/skin intersections, invalid additions and source
immutability.
