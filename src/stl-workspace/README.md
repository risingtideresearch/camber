# Progressive STL analysis workspace

Run `npm run dev:analysis` and open `/analysis.html`. `npm run build:analysis`
produces an independent static site in `dist/analysis/`; the regular Camber build
also includes `analysis.html`. Serve over HTTP(S), including under a subpath.
Nothing is uploaded and no Camber database or credentials are needed.

## Open first, configure when needed

- Drop an STL to open a source-coordinate preview immediately. Opening only
  parses triangles and computes display bounds: no topology validation, repair
  search or stability calculation. No import wizard or review-to-open gate.
- **Start a weight book** works without an STL. Attach geometry later without
  losing the book. Unknown scale and an absent hull are both saveable states.
- Set scale using source units or a known forward extent. The unit selector shows
  the base length in original STL units and its resulting length in metres. The
  base length follows the chosen forward axis and stays unscaled, including on
  reopened projects. STL units are never inferred. Choose signed up and bow
  directions; transverse direction follows a right-handed frame. **Apply
  calibration** sets the scale and coordinates without a confirmation checkbox.
- Applying a new scale/orientation places aft extent, bounding-box centreline and
  lowest point at zero. These are coordinate conventions, not inferred naval
  datums. Advanced origin, trim and KG-zero overrides remain available. Changing
  the frame after authoring positions or a manual condition requires explicit
  agreement to **reinterpret their unchanged coordinates**. Automatic conversion
  of arbitrary point formulas is not implemented. Cancel keeps the old frame.
- Manual weights don't require a calibrated or watertight hull. Surface area
  needs scale, not a buoyancy envelope. Surface centroid positions additionally
  need an applied coordinate frame. A shell-dependent formula offers an explicit choice to
  use all supplied physical faces, including any deck, transom, cabin or interior
  geometry. There is no default shell-scope confirmation or automatic face picking.
- Opening **Stability** requests envelope validation and tables. Only a supported
  closed envelope or conservatively validated open sheer qualifies. Defects do
  not block the project or manual weights. Review bounded repairs only if needed.
- A reference waterline is optional and initially **unset**, not 40% of hull
  height. Set it in Hull when a formula needs reference hydrostatics. Stability
  tables themselves need no design waterline. Manual displacement/KG, uncertainty
  and the weight-book link are persisted.

## Focused views and real secondary windows

**Weights**, **Stability** and **Hull** each occupy the whole work area. There is
no outer docking system, divider choreography or all-panels-closed state. The
weight editor retains its existing contextual inspector.

**Open in separate window** opens or focuses a same-origin view. Each window
loads its own UI modules, so drag/keyboard/viewport behavior uses the correct
browser document. Through the opener it shares the project's authoritative
`ProjectSession` command store, history and `WorkspaceService`; it does not
reimport the file or own another numerical worker. Changes, undo and saved-state
status propagate across views. The main project window owns their lifetime;
replacing/closing it closes the secondary views. An orphan session URL explains
how to reopen the saved project. Popup blocking leaves full-size tabs usable.

## Computation and invalidation

`engine.ts` owns parsed source geometry, independent cached surface/topology/
buoyancy variants, and cached cross-curves. `stlWorkspaceWorker.ts` hosts it.
`service.ts` transfers original bytes once and shares in-flight fixed queries.
`session.ts` owns authored snapshots and up to 100 undoable edits across the book,
calibration, repairs and loading condition. Stale calibration commits from another
view are rejected.

- Previews transform already-parsed triangles; no numerical preparation is
  discarded and repeated just to leave an import screen.
- Physical topology depends on asset, scale/frame and accepted repair policy.
  Reference-waterline, shell-scope and fixed-trim changes do not reparse the STL
  or repeat physical topology checks.
- Stability tables depend on geometry, trim and KG datum, not reference waterline
  or shell scope. Updating the reference changes the reference result only.
- Surface-only measurements do not construct a buoyancy envelope. Section paths
  can use a supported manifold surface even if its opening is not a valid sheer;
  open paths never acquire invented enclosed area.
- The standalone provider requests hull measurements for book references,
  measured cuts for active analysis views, and stability only for a stability
  view. Point outlines are requested by mounted geometry editors. Camber retains
  its existing provider defaults.
- Cancellation terminates executing worker work, rejects waiters and clears
  in-flight caches. Retry lazily reinstalls original bytes. Ordinary settings
  changes keep the worker alive. Responses from obsolete requests are not
  published as current results.

Numerical repair/manifold/intersection/symmetry policies are not relaxed by the
UI overhaul. The existing approximate-symmetry heuristic (up to 5% on its sampled
checks) remains a model-applicability assumption, not a bound on GZ error or a
safety certification. Closed-STL downflooding remains unknown. Open-rim stability
stops at first rim immersion without introducing a deck cap.

## Save, reopen and optional recovery

**Download project** / Cmd-Ctrl-S stores the original STL, calibration and optional
reference, automatic-gap opt-out, accepted repair policy, weight book and manual loading state. It also
supports projects without geometry. Reopening goes directly to the workspace,
parses the original file for viewing, and revalidates numerical capabilities only
when requested. Calculated answers and window layout are not persisted.

The binary container signature remains `CAMBER-STL-1\n`: little-endian uint32
manifest length, UTF-8 JSON, then original STL bytes. New manifests are **v3**;
readers accept v1/v2, restore their reviewed frame, and visibly mark migrated
snapshots for download. Legacy sealed-deck setup is normalized to open-rim policy
with an explicit notice. Metadata is limited to 4 MiB and STL to 64 MiB / 200,000
triangles. There is no compression, external asset reference or authenticity
claim. Existing Camber station formulas are preserved, not silently adapted.

**Project → Keep local recovery copy** optionally writes a debounced authored
snapshot to IndexedDB. Original asset bytes are stored once per project, not
copied on every keystroke. The welcome screen offers **Recover** and **Forget
recovery copy**. Recovery does not clear the unsaved flag: browser storage may be
unavailable, full, evicted or cleared, and it is not a backup/downloaded file.
The latest opted-in project wins if several project windows write recovery. The
last 800 ms of changes may not reach recovery before a crash; unsaved-close
warnings remain enabled. Disabling recovery stops updates but doesn't erase the
last copy; use Forget on the welcome screen to remove it.

## Repairs

Buoyancy calculations first try the original envelope. If otherwise valid topology
has tiny gaps preventing analysis, the worker automatically caps them in the
calculation mesh and reports “N small gaps sealed for calculation.” Weights using
buoyancy formulas show the same assumption. Original preview triangles and physical
shell measurements remain unchanged. These gaps are assumed to be mesh defects,
not flooding openings; hole size is not a stability-error or flooding-risk bound.

Automatic caps use the existing limits (span ≤0.5% of mesh diagonal, total patch
area ≤0.01% of original surface area, at most 16 openings and 32 vertices per loop).
They reuse the already-validated, natively welded source: **no additional vertex
movement or face removal** occurs while patching, and all
real-surface manifold/intersection and direct open-rim checks must still pass. No escalating repair search
runs automatically. Already supported open sheers stay unpatched. Larger, ambiguous
or otherwise invalid geometry still needs explicit repair or external editing.

**Leave small openings unsealed** disables the automatic treatment; it can be
re-enabled under Hull → Small openings. The setting is saved with the project and
participates in shared undo/redo and geometry-cache invalidation. Explicit repair
policies take precedence, including a choice to leave small holes open. Automatic
results are derived on demand and cached, not written over the source asset.

Repair search is explicit and off the import path. Dense/defective meshes can still take minutes to repair in a browser; this does not hold manual weights or initial viewing hostage. Proposals show removed faces,
maximum vertex movement, removed area and individual opening spans/areas. Violet
highlights changed triangles. In explicit repair proposals, small-hole patching is a separate choice; **Apply
repairs** applies the displayed proposal directly, without an attestation checkbox.
Intentional vents/drains should be left unpatched; flooding is not modelled.
Calibration changes invalidate the repair selection. Applying a proposal
reuses its prepared geometry; persisted policies are reproduced strictly on reuse.
Original bytes are never overwritten, synthetic patches do not add shell weight,
and no repair proposal automatically grants permission to seal a deck.

The existing bounded policies remain: weld budgets through 0.005% of diagonal,
small-hole span at most 0.5%, bounded patch/changed area, and unchanged strict
intersection/manifold checks. Unsupported components, intersections and large or
ambiguous openings remain unavailable for buoyancy. See
[`analysis/mesh/README.md`](../analysis/mesh/README.md) for numerical limits.

## Verification

- `npm run test:stl-progressive`: parse-only opening, independent prerequisites,
  surface/section availability, cache invalidation, reference-free stability,
  partial/assetless project round trips, loading persistence and unified history.
- `npm run test:stl-workspace`, `test:stl-features`, `test:stl-repair`: codecs,
  physical frames, original geometry algorithms and repair acceptance semantics.
  The default test suite and CI remain Node-only. Browser checks are an optional,
  isolated harness: run `npm install --prefix tools/analysis`, then either set
  `CHROMIUM_PATH=/usr/bin/chromium` or run
  `npm exec --prefix tools/analysis playwright install chromium`.

- `npm run test:browser`: production build under `/analysis/`, real workers, no
  eager numerical requests, full-size tabs, shared detached editing, undo, direct
  project reopen, manual-condition persistence, failed-import recovery, automatic
  gap treatment/opt-out, explicit repairs, optional IndexedDB recovery and
  phone-width calibration.
- `npm run test:browser:examples`: additionally imports and repairs the original
  `canvas-back.stl`, `cg40.stl` and `dev-boat.stl` under `examples/stls/` using an
  explicitly declared test scale. Filenames do not establish physical units.
- `npm run test:examples`: runs the corresponding real-STL Node checks without a
  browser.

The test VM has no usable WebGL: SVG fallback and numerical workflow are verified,
not GPU rendering. General mesh decimation, automatic
formula-frame transformation, independently surviving detached sessions and
arbitrary repair remain out of scope.

### Profiling a supplied STL

Run `npx tsx tools/analysis/profile.ts examples/stls/cg40.stl 0.001` to separate
parse, preview, envelope preparation, stability-table construction and cached
lookup. The last argument is metres per STL unit, not an inferred scale.
These are Node CPU timings, not browser/GPU or comparative Camber benchmarks.

For the 60,578-triangle cg40 export in the development VM, removing temporary
sheer-cap validation and the subsequent open-mesh rebuild reduced preparation
from about 12–13 s to about 6.5 s. Reusing that validated mesh and checking only
new-face intersection pairs during patching reduced preparation further to about
2 s. Stability table construction remains about 1 s, and cached lookup is below
1 ms. These are illustrative Node timings;
browser performance depends on the machine.

Its two thin gaps patch automatically without additional welding. Only the small
boundary loops are projected for triangulation, not the entire hull. Adding patches
retains all existing coordinates and face IDs, rechecks connectivity/manifoldness
and winding, and builds a combined spatial index. Intersection checks cover new/old
and new/new pairs; unchanged old/old pairs retain their original validation. Repairs
that move vertices or remove faces still perform full validation of the changed
skin, but reuse their weld result instead of converting it back into triangle soup.
Original STL bytes remain unchanged; no decimation or numerical-tolerance relaxation
is involved.
