import assert from "node:assert/strict";
import { boxSoup } from "./support/meshShapes";
import { emptyBook } from "../src/core/sheet/book";
import { buildSheetJson } from "../src/core/sheet/json";
import {
  DEFAULT_CONFIGURATION,
  analysisSetup,
  configurationForEnvelope,
  placedReferences,
  type Configuration,
} from "../src/stl-workspace/setup";
import { inspectStl } from "../src/stl-workspace/inspect";
import {
  encodeProject,
  decodeProject,
  hasProjectMagic,
} from "../src/stl-workspace/project";
import { importAnalysisStl } from "../src/analysis/mesh/import";
import { meshImmersion } from "../src/analysis/mesh/immersion";
function binary(soup: number[]) {
  const bytes = new ArrayBuffer(84 + (soup.length / 9) * 50),
    v = new DataView(bytes);
  v.setUint32(80, soup.length / 9, true);
  soup.forEach((n, i) =>
    v.setFloat32(84 + Math.floor(i / 9) * 50 + 12 + (i % 9) * 4, n, true),
  );
  return bytes;
}
const c: Configuration = {
  ...DEFAULT_CONFIGURATION,
  metresPerUnit: 1,
  waterlineZ: 1,
};
assert.throws(
  () => analysisSetup(DEFAULT_CONFIGURATION, "unset"),
  /source units/,
);
assert.throws(
  () => analysisSetup({ ...c, axes: [1, -1, 3] }, "axes"),
  /different source axes/,
);
assert.throws(() => analysisSetup({ ...c, trimDegrees: NaN }, "nan"), /finite/);
const source = binary(boxSoup(4, 2, 2));
for (const scale of [1, 0.001, 0.3048]) {
  const config = { ...c, metresPerUnit: scale };
  const setup = analysisSetup(config, `units-${scale}`);
  const inspected = inspectStl({
    buffer: binary(boxSoup(4, 2, 2).map((v) => v / scale)),
    physical: setup.physical,
  });
  assert.ok(inspected.report?.closed);
  const b = inspected.geometry!.bounds;
  for (const [i, extent] of [4, 2, 2].entries())
    assert.ok(Math.abs(b.max[i] - b.min[i] - extent) < 1e-6);
  assert.equal(
    setup.analysis.shellScope,
    undefined,
    "Surface scope is not silently confirmed",
  );
}
assert.deepEqual(
  placedReferences([3, 4, 5], { min: [-2, -3, -1], max: [8, 5, 4] }),
  { origin: [1, 5, 4], keelZ: 0, waterlineZ: null },
);
assert.equal(
  configurationForEnvelope({ ...c, closeDeck: true }).closeDeck,
  false,
  "Setup review migrates older saved projects away from synthetic sheer caps",
);
const mapped = analysisSetup(
  { ...c, axes: [-3, 2, 1], origin: [-2, 0, 1], trimDegrees: 5, keelZ: -0.2 },
  "mapping",
);
const mappedGeometry = inspectStl({
  buffer: source,
  physical: mapped.physical,
}).geometry!;
assert.deepEqual(mappedGeometry.bounds, { min: [0, -1, -1], max: [2, 1, 3] });
assert.equal(mapped.analysis.keelZ, -0.2);
assert.equal(mapped.analysis.fixedTrim, (5 * Math.PI) / 180);
const open = binary(boxSoup(4, 2, 2, true));
const openPreview = inspectStl({
  buffer: open,
  physical: analysisSetup(c, "open").physical,
});
assert.equal(openPreview.report?.closed, false);
assert.equal(openPreview.boundaryLoops, 1);
assert.equal(openPreview.openSheer, true);
assert.equal(openPreview.report?.openHydrostatics, true);
const openConfig = { ...c, closeDeck: false, wholeSurface: true };
assert.equal(analysisSetup(openConfig, "open-rim").openSheer, true);
const envelope = importAnalysisStl(open, analysisSetup(openConfig, "open-rim"));
assert.equal(envelope.report.closed, false);
assert.equal(envelope.report.openHydrostatics, true);
assert.equal(envelope.sources.filter((s) => s.kind === "physical").length, 10);
const sealedSetup = analysisSetup(openConfig, "legacy-sealed");
delete sealedSetup.openSheer;
sealedSetup.deckClosure = { accepted: true, closureId: "explicit-test-cap" };
const sealed = importAnalysisStl(open, sealedSetup);
assert.ok(sealed.report.closed);
const plane = {
  origin: [0, 0, 1] as [number, number, number],
  u: [1, 0, 0] as [number, number, number],
  v: [0, 1, 0] as [number, number, number],
};
assert.ok(
  Math.abs(
    meshImmersion(envelope, plane).vol - meshImmersion(sealed, plane).vol,
  ) < 1e-10,
  "Open-rim and capped integration agree while the rim remains dry",
);
assert.throws(
  () =>
    meshImmersion(envelope, {
      ...plane,
      origin: [0, 0, 2.1],
    }),
  /rim immersion/,
);
assert.deepEqual(
  analysisSetup(openConfig, "scope").analysis.shellScope?.surfaces,
  ["unclassified"],
);
assert.ok(
  inspectStl({
    buffer: new TextEncoder().encode("not STL").buffer,
    physical: analysisSetup(c, "bad").physical,
  }).error,
);
const components = inspectStl({
  buffer: binary([
    ...boxSoup(4, 2, 2),
    ...boxSoup(1, 1, 1).map((v, i) => (i % 3 === 0 ? v + 10 : v)),
  ]),
  physical: analysisSetup(c, "components").physical,
});
assert.ok(components.report);
assert.equal(components.report!.closed, false);
assert.match(components.report!.envelopeError!, /Multiple components/);
assert.ok(components.geometry, "surface-only imports retain a preview");
const book = {
  ...emptyBook(),
  items: [
    {
      id: "legacy",
      name: "Legacy",
      note: "",
      facets: {},
      fields: {
        section: {
          k: "cut" as const,
          shape: "station" as const,
          pos: "2 +- 0.1",
          unit: "m",
        },
      },
    },
  ],
};
const bytes = await encodeProject(
  { name: "test.stl", bytes: open },
  openConfig,
  book,
).arrayBuffer();
assert.equal(hasProjectMagic(bytes), true);
assert.equal(hasProjectMagic(open), false);
const restored = decodeProject(bytes);
assert.deepEqual(restored.asset.bytes, open);
assert.deepEqual(restored.configuration, openConfig);
assert.equal(buildSheetJson(restored.book), buildSheetJson(book));
assert.ok(
  importAnalysisStl(
    restored.asset.bytes,
    analysisSetup(restored.configuration, "restored"),
  ).report.openHydrostatics,
);
assert.throws(() => decodeProject(bytes.slice(0, -1)), /truncated STL/);
assert.throws(() => decodeProject(bytes.slice(0, 20)), /Truncated/);
const bad = bytes.slice(0);
new Uint8Array(bad)[0] = 0;
assert.throws(() => decodeProject(bad), /Not a supported/);
const giant = bytes.slice(0);
new DataView(giant).setUint32(
  new TextEncoder().encode("CAMBER-STL-1\n").length,
  100_000_000,
  true,
);
assert.throws(() => decodeProject(giant), /oversized/);
console.log(
  "  ok: explicit units/axes/datums, geometry-only closure proposal, acceptance gate, physical scope, project/legacy-book round trip and malformed imports",
);
