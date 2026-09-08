# Phase 2: direct mesh geometry feasibility spike

This is a tested geometry backend and developer harness, **not the standalone import application or full STL weight-book parity**. Camber still uses its sweep for existing hydrostatics, KN, metrics and authored station cuts.

## Entry points

- `prepare.ts`: physical setup, welding, topology/orientation/intersection validation.
- `import.ts`: hardened ASCII/binary STL parser → physical preparation → explicitly confirmed closure, if requested.
- `section.ts`: arbitrary-plane region/path query, accelerated by an AABB tree.
- `immersion.ts`: clipped signed tetrahedra for volume, centroid and physical wetted area; waterplane moments come from section loops.
- `compute.ts`: mesh implementation of shared immersed operations, KN/KMt construction, and query dispatch.
- `client.ts` / `worker/meshAnalysisWorker.ts`: install an asset once; send small subsequent queries. Original asset bytes are retained. Dispose/replace the worker to cancel executing numerical work.
- `closure.ts`: non-planar top-boundary closure prototype, with provenance and full post-closure validation.
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
  },
  // Omit for closed-envelope mode. Never infer consent to close a hole.
  // deckClosure: { accepted: true, closureId: "confirmed-sheer" },
});
const report = await client.ready;
const section = await client.hull.section({
  plane: { origin: [2, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  envelope: "buoyancy",
});
const tables = await client.hull.stability();
// client.dispose() when the project/source is replaced or the window closes.
```

The host supplies setup/confirmation here; a preview/import wizard is later work. `proposeDeckClosure()` can produce preview triangles without granting a closed integration envelope.

## Frames and datums

Physical setup applies a signed axis permutation, positive scale, optional axis-angle rotation, then subtracts the explicit origin. It never uses the overlay's fit scale or design-box centring. Winding is determined from adjacency and signed volume, not STL normals; reflections are supported and reported.

`section()` coordinates are **metres in the orthonormal body/hull frame, before fixed trim**. This is the unraked deck frame for Camber's new plane-section path. `u × v` is the normal; neither basis vector is silently normalised. Results use the requested local 2-D frame.

Stability rotates body vertices through fixed trim, then measures a heeled waterplane. `keelZ` and `referenceWaterlineZ` are explicit heights in the upright, fixed-trim frame. Mesh contexts supply `hullToWeight` and `kgDatum`; the former maps body points to upright Cartesian weight coordinates, subtracting the KG datum in z. Do not use an affine point mapping directly to transform normals.

Camber's legacy hybrid deck-x/world-z weight mapping remains in `outlines().frame`, unchanged. Its existing `HULL.WATERLINE` still means authored depth. This spike does not convert existing cuts or point formulas into the new physical plane convention.

## Supported and rejected inputs

Preparation supports one connected, orientable, edge- and vertex-manifold triangle surface. Geometry-only sections may have multiple regions or holes; neither implies permission to analyse multiple hull components. Stability additionally requires a **surface-area-verified reflection symmetry about body y=0**. Mirrored vertices alone are insufficient; different diagonals on the same planar patch are accepted.

Checks include:

- Bounded STL input (64 MiB / 200,000 triangles), complete ASCII facets and binary size/count checks, finite coordinates, and finite positive physical scale.
- Scale-aware vertex welding with neighbouring-cell searches.
- Rejection of degenerate/duplicate faces, non-manifold edges/vertices, disconnected components and non-orientable surfaces.
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

The open-deck prototype requires exactly one simple boundary projecting to a hull-xy polygon, at most 2,000 boundary vertices, with the physical vertices below and inside its footprint. Cap/skin intersections are checked separately. Side/bottom openings, projected crossings, vertices outside the supported footprint and ambiguous topology are rejected. This is not general overhang/repair support.

For a symmetric, x-monotone boundary, corresponding port/starboard shores form **transverse ruled strips**. Each strip is planar although the whole sheer is not. Otherwise, ear triangulation retains boundary-vertex heights, yielding a piecewise-planar height graph. The latter may be asymmetric and therefore unavailable for stability even when its section geometry is valid. No arbitrary centroid fan is used.

Closing requires explicit confirmation. The complete envelope is revalidated, including winding and intersections between cap and skin. Synthetic faces never become physical shell. Their seam supplies a geometric deck reference, not actual flooding knowledge. This closure is an identified approximation, **not an assertion that it equals Camber's fanning swept cap**.

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

Full shell classification/`HULL.*` metrics, authored cut construction/motion/derivatives, migrated point views and projections, an import/setup UI, arbitrary mesh repair, regulatory flooding, free trim/asymmetric stability, project persistence, and independent app packaging remain later phases. Geometry validation, a closed numerical solid and a green intact-stability criterion do not certify a boat.
