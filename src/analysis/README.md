# Shared analysis (Phases 1–3)

This directory is the weight/stability feature boundary, not a second app or a prepared-data file format.

Phase 2 adds a constrained direct-mesh geometry backend and physical plane sections. Phase 3 connects supported STL envelopes to the shared weight/point/stability workflow, with explicit shell scope, physical cuts and generic previews. See [the geometry spike notes](mesh/README.md) for supported inputs, closure semantics, benchmarks and the remaining Camber-versus-mesh parity gate.

## Composition

```text
Camber document store + performance settings
  → editor/CamberAnalysisProvider
  → immutable HullAnalysis handle / one window-owned query client
  → worker/analysisWorker → camber/compute → existing hull routines
  → AnalysisProvider → shared weight UI / table-only StabilityPanel
```

`api.ts` is the application-facing interface. A handle identifies one geometry/setup revision. Queries are asynchronous; only requested answers are cached. `queries.ts` deduplicates concurrent requests and bounds geometry-query caches. Cancelling one subscriber does not cancel another subscriber's shared computation.

The host owns the worker client and its lifetime. Camber activates the current context before query effects run; queued old-context work is rejected, and independently requested work for the current context is preserved. `useAnalysisQuery` checks context and query identity before publishing, including during the render before effect cleanup. An in-flight calculation is allowed to finish; cancellation currently stops awaiting/publication, not an executing numerical loop.

## What is shared

- `hullMetrics.ts`: metric schema, catalogue, formula lookup, and per-name unavailability reasons. `core/hullMetrics.ts` computes Camber's values and re-exports the catalogue for existing callers.
- `stability.ts`: table interpolation, GZ/area/envelope/inverse calculations. No hull integration. `core/stability.ts` keeps the sweep-facing operations and re-exports these functions.
- `assessment.ts`: the existing six intact-stability criteria and verdict logic, with unchanged thresholds and assumptions.
- `weightBook.ts` / `weightGeometry.ts`: resolve cut positions, deduplicate requests, construct physical planes, check finite-difference derivatives and evaluate the final book with local measurement diagnostics. The backend does not parse formulas.
- `geometry.ts` / `pointViewGeometry.ts`: legacy frame compatibility plus generic projected coverage and physical section loops for point placement. Point authoring and uncertainty math remain geometry-independent in `core/sheet/points.ts`; hull-dependent outline construction moved to `core/pointGeometry.ts`.
- `ui/`: weight editor, point views, stability panel, chart frame, query hooks, and provider. The old editor panel paths remain small wrappers.

`StabilityPanel` takes only stability results, display units, density, and an already evaluated weight book. It neither queries geometry nor reads an editor/store provider. `AnalysisProvider` shares query results and weight evaluation when multiple panels are mounted under it. Hosts may specify demand explicitly; the standalone workspace disables eager stability, outlines and unused metrics. Point geometry editors request outlines when mounted. Camber retains the original provider defaults. The weight editor dispatches only `SheetCommand`; Camber maps its outcome to the unchanged document-store command path.

## Coordinates and availability

Stability query results are SI: metres, m³, radians. `stabilityData.ts` explicitly converts all table columns, including PCHIP derivatives, to the existing chart's display coordinates. Water density remains stored in t/m³; conversion from kilograms happens once.

Measured slice values and the query facade's returned curves/centroids use the weight frame in metres. The existing core slice routine still returns rendering points in model coordinates; only the Camber adapter crosses that boundary. The legacy outline DTO includes its source-to-weight mapping so existing tests and geometry routines retain the hybrid deck-x/world-z convention.

An unavailable query has a reason; a preview plane missing the hull returns an available `null`. An unavailable measured cut is not zero area. Query errors and pending states are separate UI states. Shell measurements no longer require a valid reference waterline; unavailable hydrostatic leaves fail only formulas that reference them.

## Deliberately deferred

The supported feature workflow is implemented, but this is not the entire proposed product or construction language:

- `slices()` retains authored `plane`/`station` semantics and derivatives.
- `sectionOutline()` is a preview operation for existing point placement, not an arbitrary-plane measurement.
- `outlines()` returns the current profile context, not a general projection query.
- `section()` now supplies physical plane regions, holes, open paths and boundary provenance. Both geometry adapters declare arbitrary-plane support; invalid/unsupported envelopes return local unavailability reasons. This does not reinterpret legacy cuts. New transverse cuts are explicit; more advanced construction UI remains incremental.
- STL measurements now expose supported `HULL.*` values with scope/provenance and per-name reasons. `project()` returns visual triangle-union coverage, and `displayGeometry()` supplies body-frame render buffers. The shared provider routes STL horizontal/transverse cuts and previews through physical queries; it never asks STL to fabricate Camber stations.
- The original extraction did not migrate the workspace. The subsequent [progressive standalone workspace](../stl-workspace/README.md) supplies its own project format, unified history, optional recovery and shared secondary windows without changing Camber persistence.

The detailed target API and rollout remain in `docs/design/standalone-weight-stability.md`. The Phase 2 developer/browser harness is not the standalone product shell.

## Phase 3 composition and semantics

The standalone workspace mounts the shared weight and stability panels under one `AnalysisProvider`. Its hull view consumes generic render buffers through `GeometryPreview`; a WebGL failure does not disable its 2D views or calculations.

- Import labels are `MeshImport.surfaceByTriangle`, one physical label per original STL triangle. The immutable setup's `shellScope` names the explicitly confirmed physical surfaces and a human-readable label. No scope means unavailable shell metrics, **not total STL area**. Synthetic closure faces cannot be selected as physical shell.
- The weight header shows metric scope, frame and closure provenance. Missing metrics/cut fields carry local reasons. `SHELL_CG.y` is measured for selected mesh surfaces, not automatically zero. Stability still assumes centreline G and a symmetric envelope.
- Sheet format **v2** adds `transverse`. The reader accepts v1 unchanged: `station` retains its authored Camber semantics and `plane` retains its horizontal semantics. A station-dependent STL book needs an explicit user change; station traces and snap targets are not invented. Older builds do not support v2 books.
- `measureWeightCuts()` preserves Camber's old station/horizontal numerical path. STL horizontal and all new transverse cuts use physical `section()` requests. Coordinates/centroids are transformed consistently back into the weight frame; Camber's hybrid mapping is not treated as a rigid normal transform.
- Plane translation (metres), rotation (radians), and vertical planes through a body-frame line with **explicit** hull/gravity up are shared API constructions. The current authoring dropdown exposes horizontal/transverse/authored-station conveniences only. Persisted reference-line dependencies, rotational parameters and their UI are not implemented.
- Physical derivatives use a central difference in shared orchestration (default translating-cut step: 0.0001 m), compare topology/surface attribution and one-sided slopes, and flag ill-conditioned/on-edge cases. Nominal measurements remain usable when uncertainty propagation is unavailable. This is a **local first-order** estimate, not a guarantee over an entire uncertainty interval or a geometry-error bound.
- `project()` is visual union coverage: positively wound projected triangle polygons can overlap and are rendered as a **single nonzero-filled compound path without internal strokes**. Holes/concavities remain empty if no triangle covers them. This is not a measured section or a disjoint polygon-union DTO. Point section previews use separate physical loops/paths, never concatenated mirrored runs.

## Verification

`npm run test:analysis` checks pre-extraction fixtures, the query contract, SI conversions, criteria, independent availability, request sharing/cancellation, context replacement, transport errors/disposal, and transitive import boundaries. `test/fixtures/analysis/baseline.json` contains default and non-zero-trim hull/book baselines captured before extraction. The intentional sweep transom correction is recorded separately in `transom-correction.json`; `test:transom-sweep` verifies it against analytic geometry and the independent mesh oracle. Unaffected fixture subtrees still use the original baseline.

`npm run test:stl-features` exercises an actual classified STL and weight book: shell/CG, unconfirmed/missing scopes, independent dry-reference availability, trim/datums, physical cuts/motion, derivative failures, sheet v1/v2, manual/sheet-linked tables and confirmed closures. `test:mesh-analysis` additionally checks projection holes/concavities and multi-loop previews; `test:analysis` checks new transverse cuts against the unchanged Camber frame.

Run the full existing tests as well. Browser smoke coverage should include:

1. Open weight and stability detached panels on the same scratch session.
2. Install/edit a book containing geometry references, a measured cut, and uncertain mass/CG.
3. Follow the weight sheet, edit and undo a mass, and confirm both panels update without another KN request.
4. Open the geometry inspector and confirm profile/section queries resolve.
5. Rapidly edit the hull/reference waterline; after settling, only current-context results are shown.
6. Mount both shared panels under one provider, and separately render the stability view from tables without any geometry service.
