# Shared analysis (Phases 1–2)

This directory is the weight/stability feature boundary, not a second app or a prepared-data file format.

Phase 2 adds a constrained direct-mesh geometry backend and physical plane sections. See [the geometry spike notes](mesh/README.md) for supported inputs, closure semantics, benchmarks and the remaining Camber-versus-mesh parity gate.

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
- `weightBook.ts`: resolve cut positions, deduplicate requests, and evaluate the final book with measured answers. The backend does not parse formulas.
- `geometry.ts`: legacy cut/outline DTOs and explicit frame mapping. Point authoring and uncertainty math remain geometry-independent in `core/sheet/points.ts`; hull-dependent outline construction moved to `core/pointGeometry.ts`.
- `ui/`: weight editor, point views, stability panel, chart frame, query hooks, and provider. The old editor panel paths remain small wrappers.

`StabilityPanel` takes only stability results, display units, density, and an already evaluated weight book. It neither queries geometry nor reads an editor/store provider. `AnalysisProvider` shares query results and weight evaluation when multiple panels are mounted under it. The weight editor dispatches only `SheetCommand`; Camber maps its outcome to the unchanged document-store command path.

## Coordinates and availability

Stability query results are SI: metres, m³, radians. `stabilityData.ts` explicitly converts all table columns, including PCHIP derivatives, to the existing chart's display coordinates. Water density remains stored in t/m³; conversion from kilograms happens once.

Measured slice values and the query facade's returned curves/centroids use the weight frame in metres. The existing core slice routine still returns rendering points in model coordinates; only the Camber adapter crosses that boundary. The legacy outline DTO includes its source-to-weight mapping so existing tests and geometry routines retain the hybrid deck-x/world-z convention.

An unavailable query has a reason; a preview plane missing the hull returns an available `null`. An unavailable measured cut is not zero area. Query errors and pending states are separate UI states. Shell measurements no longer require a valid reference waterline; unavailable hydrostatic leaves fail only formulas that reference them.

## Deliberately deferred

This is the extracted feature plus a Phase 2 geometry spike, not the entire proposed geometry API:

- `slices()` retains authored `plane`/`station` semantics and derivatives.
- `sectionOutline()` is a preview operation for existing point placement, not an arbitrary-plane measurement.
- `outlines()` returns the current profile context, not a general projection query.
- `section()` now supplies physical plane regions, holes, open paths and boundary provenance. Both geometry adapters declare arbitrary-plane support; invalid/unsupported envelopes return local unavailability reasons. This does not convert legacy cuts or add construction/motion authoring.
- The STL spike supplies sections and stability, but deliberately leaves whole-hull metrics, projections and legacy weight geometry unavailable until Phase 3.
- No workspace migration, standalone app, project format, history change, or persistence migration is included.

The detailed target API and rollout remain in `docs/design/standalone-weight-stability.md`. The Phase 2 developer/browser harness is not the standalone product shell.

## Verification

`npm run test:analysis` checks pre-extraction fixtures, the query contract, SI conversions, criteria, independent availability, request sharing/cancellation, context replacement, transport errors/disposal, and transitive import boundaries. `test/fixtures/analysis/baseline.json` contains default and non-zero-trim hull/book baselines; expected values were captured from the pre-extraction code, not generated by the implementation under test.

Run the full existing tests as well. Browser smoke coverage should include:

1. Open weight and stability detached panels on the same scratch session.
2. Install/edit a book containing geometry references, a measured cut, and uncertain mass/CG.
3. Follow the weight sheet, edit and undo a mass, and confirm both panels update without another KN request.
4. Open the geometry inspector and confirm profile/section queries resolve.
5. Rapidly edit the hull/reference waterline; after settling, only current-context results are shown.
6. Mount both shared panels under one provider, and separately render the stability view from tables without any geometry service.
