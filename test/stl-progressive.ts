import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WorkspaceEngine } from "../src/stl-workspace/engine";
import {
  DEFAULT_CONFIGURATION,
  sourceAxisLengths,
  placedReferences,
  type Configuration,
  type Inspection,
} from "../src/stl-workspace/setup";
import { encodeProject, decodeProject } from "../src/stl-workspace/project";
import { emptyBook } from "../src/core/sheet/book";
import { ProjectSession } from "../src/stl-workspace/session";
import { EMPTY_LOADING } from "../src/analysis/loading";
import type { Available, StabilityData } from "../src/analysis/api";
import type { SectionResult } from "../src/analysis/sections";
import type { HullMetrics } from "../src/analysis/hullMetrics";
import { boxSoup, boxWithSmallOpening } from "./support/meshShapes";
function binary(soup: number[]) {
  const bytes = new ArrayBuffer(84 + (soup.length / 9) * 50),
    v = new DataView(bytes);
  v.setUint32(80, soup.length / 9, true);
  soup.forEach((n, i) =>
    v.setFloat32(84 + Math.floor(i / 9) * 50 + 12 + (i % 9) * 4, n, true),
  );
  return bytes;
}
const bytes = binary(boxSoup(4, 2, 2, true));
const engine = new WorkspaceEngine(bytes);
const c: Configuration = {
  ...DEFAULT_CONFIGURATION,
  metresPerUnit: 1,
  frameConfirmed: true,
};
const query = (kind: "stability" | "measurements", envelope = false) => ({
  type: "query" as const,
  kind,
  input: null,
  envelope,
});
const preview = engine.run(DEFAULT_CONFIGURATION, {
  type: "preview",
}) as Inspection;
assert.ok(preview.geometry);
assert.deepEqual(
  sourceAxisLengths(preview.geometry.bounds, DEFAULT_CONFIGURATION),
  [4, 2, 2],
);
for (const metresPerUnit of [0.001, 1, 0.3048]) {
  const mapped: Configuration = {
    ...c,
    metresPerUnit,
    axes: [-3, 1, -2],
    origin: [1, 2, 3],
  };
  const geometry = (engine.run(mapped, { type: "preview" }) as Inspection)
    .geometry!;
  const lengths = sourceAxisLengths(geometry.bounds, mapped);
  [4, 2, 2].forEach((expected, i) =>
    assert.ok(
      Math.abs(lengths[i] - expected) < 1e-9,
      "STL lengths survive saved scale, axis mapping and translation",
    ),
  );
}

assert.equal(preview.report, undefined, "Opening doesn't validate topology");
assert.deepEqual(engine.stats, {
  parses: 1,
  surfaces: 0,
  validations: 0,
  stability: 0,
});
assert.equal(
  (
    engine.run(
      DEFAULT_CONFIGURATION,
      query("measurements"),
    ) as Available<HullMetrics>
  ).status,
  "unavailable",
);
engine.run(c, { type: "preview" });
engine.run({ ...c, origin: [1, 0, 0] }, { type: "preview" });
assert.equal(
  engine.stats.parses,
  1,
  "Calibration preview reuses parsed triangles",
);
const area = engine.run(
  { ...c, wholeSurface: true, frameConfirmed: false },
  query("measurements"),
) as Available<HullMetrics>;
assert.equal(area.status, "available");
if (area.status === "available") {
  assert.equal(area.value.shellArea, 32);
  assert.ok(
    Number.isNaN(area.value.shellLcg),
    "Area needs scale, but positions need frame confirmation",
  );
}
assert.equal(
  engine.stats.validations,
  0,
  "Shell measurements do not require envelope validation",
);
assert.equal(engine.stats.stability, 0);
const stability = engine.run(c, query("stability")) as Available<StabilityData>;
assert.equal(
  stability.status,
  "available",
  "Stability works without a reference waterline",
);
if (stability.status === "available") assert.equal(stability.value.hydro, null);
assert.equal(engine.stats.validations, 1);
assert.equal(engine.stats.stability, 1);
const referenced = engine.run(
  { ...c, waterlineZ: 1 },
  query("stability"),
) as Available<StabilityData>;
if (referenced.status === "available")
  assert.ok(Math.abs(referenced.value.hydro!.vol - 8) < 1e-10);
engine.run({ ...c, waterlineZ: 1.2, wholeSurface: true }, query("stability"));
assert.equal(
  engine.stats.validations,
  1,
  "Reference and scope edits keep prepared geometry",
);
assert.equal(
  engine.stats.stability,
  1,
  "Reference and scope edits keep cross curves",
);
engine.run({ ...c, trimDegrees: 1 }, query("stability"));
assert.equal(
  engine.stats.validations,
  1,
  "Attitude is independent of physical topology",
);
assert.equal(engine.stats.stability, 2);
const invalid = new WorkspaceEngine(
  binary([
    ...boxSoup(4, 2, 2),
    ...boxSoup(1, 1, 1).map((v, i) => (i % 3 === 0 ? v + 10 : v)),
  ]),
);
assert.ok((invalid.run(c, { type: "preview" }) as Inspection).geometry);
assert.equal(
  (
    invalid.run(
      { ...c, wholeSurface: true },
      query("measurements"),
    ) as Available<HullMetrics>
  ).status,
  "available",
);
assert.equal(
  (invalid.run(c, query("stability")) as Available<StabilityData>).status,
  "unavailable",
);
const openBottom = new WorkspaceEngine(binary(boxSoup(4, 2, 2).slice(18)));
assert.equal(
  (openBottom.run(c, query("stability")) as Available<StabilityData>).status,
  "unavailable",
);
const cut = openBottom.run(c, {
  type: "query",
  kind: "section",
  input: {
    envelope: "buoyancy",
    plane: { origin: [2, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  },
}) as Available<SectionResult>;
assert.equal(
  cut.status,
  "available",
  "Section paths don't require a valid buoyancy rim",
);
if (cut.status === "available") {
  assert.ok(cut.value.openPaths.length > 0);
  assert.equal(
    cut.value.measurements.area.status,
    "unavailable",
    "Open paths never fabricate enclosed area",
  );
}
const rawClosed = boxSoup(4, 2, 2);
const repairable = new WorkspaceEngine(
  binary([...rawClosed, ...rawClosed.slice(0, 9)]),
);
repairable.run(c, { type: "validate" });
const proposed = repairable.run(c, { type: "repair" }) as Inspection;
assert.ok(proposed.repair);
const preparedCount = repairable.stats.validations;
assert.equal(
  (
    repairable.run(
      { ...c, repair: proposed.repair.policy },
      query("stability"),
    ) as Available<StabilityData>
  ).status,
  "available",
);
assert.equal(
  repairable.stats.validations,
  preparedCount,
  "Accepting a proposal reuses prepared geometry",
);
const asset = { name: "test.stl", bytes };
const partial = decodeProject(
  await encodeProject(asset, DEFAULT_CONFIGURATION, emptyBook()).arrayBuffer(),
);
assert.deepEqual(partial.configuration, DEFAULT_CONFIGURATION);
assert.deepEqual(partial.loading, EMPTY_LOADING);
const loading = {
  condition: { vol: 8, kg: 0.7 },
  spread: null,
  linkSheet: false,
};
const complete = decodeProject(
  await encodeProject(asset, c, emptyBook(), loading).arrayBuffer(),
);
assert.deepEqual(complete.loading, loading);
const empty = { name: "Untitled", bytes: new ArrayBuffer(0) };
assert.equal(
  decodeProject(
    await encodeProject(
      empty,
      DEFAULT_CONFIGURATION,
      emptyBook(),
    ).arrayBuffer(),
  ).asset.bytes.byteLength,
  0,
);
const session = new ProjectSession(asset, {});
session.downloaded(session.getSnapshot().document);
const before = session.getSnapshot().document;
session.configure(c);
assert.throws(
  () => session.configure({ ...c, waterlineZ: 1 }, before.configuration),
  /changed in another view/,
);
await session.dispatch({
  type: "addItem",
  id: "one",
  name: "Engine",
  after: 0,
});
session.loading(() => loading);
assert.equal(session.getSnapshot().document.book.items.length, 1);
session.undo();
assert.deepEqual(session.getSnapshot().document.loading, EMPTY_LOADING);
session.undo();
assert.equal(session.getSnapshot().document.book.items.length, 0);
session.undo();
assert.equal(session.getSnapshot().document, before);
assert.equal(session.getSnapshot().dirty, false);
session.redo();
assert.deepEqual(session.getSnapshot().document.configuration, c);
session.dispose();
console.log(
  "  ok: parse-only opening, demand-driven geometry, independent caches, partial projects, loading persistence and unified history",
);

// Tiny holes are capped only in the envelope; original geometry/weight surfaces survive.
for (const open of [false, true]) {
  const holeBytes = binary(boxWithSmallOpening(open));
  const originalBytes = holeBytes.slice(0);
  const automatic = new WorkspaceEngine(holeBytes);
  const rawPreview = automatic.run(c, { type: "preview" }) as Inspection;
  assert.equal(automatic.stats.validations, 0);
  const areaBefore = automatic.run(
    { ...c, wholeSurface: true },
    query("measurements"),
  );
  const inspection = automatic.run(c, { type: "validate" }) as Inspection;
  assert.equal(inspection.automaticPatches?.holes.length, 1);
  assert.equal(inspection.automaticPatches?.maxVertexMove, 0);
  assert.equal(inspection.report?.envelopeError, undefined);
  assert.equal(!!inspection.report?.openHydrostatics, open);
  assert.equal(
    (automatic.run(c, query("stability")) as Available<StabilityData>).status,
    "available",
  );
  assert.deepEqual(automatic.run(c, { type: "preview" }), rawPreview);
  assert.deepEqual(
    automatic.run({ ...c, wholeSurface: true }, query("measurements")),
    areaBefore,
  );
  assert.deepEqual(holeBytes, originalBytes);
  assert.equal(automatic.stats.parses, 1);
  assert.equal(
    automatic.stats.validations,
    1,
    "Automatic envelope is cached across consumers",
  );
  const disabled = { ...c, autoPatchSmallHoles: false };
  assert.ok(
    (automatic.run(disabled, { type: "validate" }) as Inspection).report
      ?.envelopeError,
  );
  assert.equal(
    (automatic.run(disabled, query("stability")) as Available<StabilityData>)
      .status,
    "unavailable",
  );
  assert.equal(
    (automatic.run(c, { type: "validate" }) as Inspection).automaticPatches
      ?.holes.length,
    1,
  );
  assert.equal(
    (
      automatic.run(
        {
          ...disabled,
          repair: { version: 2, weldRelative: 1e-8, fillSmallHoles: false },
        },
        { type: "validate" },
      ) as Inspection
    ).automaticPatches,
    undefined,
  );
  const persisted = decodeProject(
    await encodeProject(
      { name: "hole.stl", bytes: holeBytes },
      disabled,
      emptyBook(),
    ).arrayBuffer(),
  );
  assert.equal(persisted.configuration.autoPatchSmallHoles, false);
  const reloaded = new WorkspaceEngine(persisted.asset.bytes);
  assert.equal(
    (
      reloaded.run(
        persisted.configuration,
        query("stability"),
      ) as Available<StabilityData>
    ).status,
    "unavailable",
  );
}
const largeOpening = new WorkspaceEngine(
  binary(boxWithSmallOpening(false, 0.1)),
);
const largeInspection = largeOpening.run(c, { type: "validate" }) as Inspection;
assert.equal(largeInspection.automaticPatches, undefined);
assert.ok(largeInspection.report?.envelopeError);
assert.equal(
  (largeOpening.run(c, query("stability")) as Available<StabilityData>).status,
  "unavailable",
);
console.log(
  "  ok: automatic bounded gap caps, unmodified originals, opt-out, persistence and larger-opening rejection",
);

// STL rounding at shared vertices must not discard an otherwise valid automatic
// patch and force the same expensive repair to run again (cg40 regression).
const roundedGap = boxWithSmallOpening();
roundedGap[roundedGap.findIndex((value) => value === 0)] += 1e-9;
const roundedEngine = new WorkspaceEngine(binary(roundedGap));
const roundedInspection = roundedEngine.run(c, {
  type: "validate",
}) as Inspection;
assert.equal(roundedInspection.automaticPatches?.holes.length, 1);
assert.equal(
  roundedInspection.automaticPatches!.maxVertexMove,
  0,
  "Patching reuses the native welded vertices without additional movement",
);
assert.ok(
  roundedInspection.automaticPatches!.maxVertexMove <=
    roundedInspection.report!.tolerance,
);
assert.equal(
  (roundedEngine.run(c, query("stability")) as Available<StabilityData>).status,
  "available",
);
console.log(
  "  ok: tiny STL vertex-rounding differences retain automatic patches",
);

if (process.argv.includes("--examples")) {
  const data = readFileSync("examples/stls/cg40.stl");
  const actual = new WorkspaceEngine(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  );
  const scaled = { ...c, metresPerUnit: 0.001 };
  const preview = actual.run(scaled, { type: "preview" }) as Inspection;
  const config = {
    ...scaled,
    ...placedReferences([0, 0, 0], preview.geometry!.bounds),
  };
  const inspection = actual.run(config, { type: "validate" }) as Inspection;
  assert.equal(
    inspection.automaticPatches?.holes.length,
    2,
    "cg40 needs no manual repair step",
  );
  assert.equal(inspection.report?.envelopeError, undefined);
  assert.equal(
    (actual.run(config, query("stability")) as Available<StabilityData>).status,
    "available",
  );
  console.log(
    "  ok: cg40 automatically seals two gaps and computes stability without manual repair",
  );
}
