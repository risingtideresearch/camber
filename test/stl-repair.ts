import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boxSoup } from "./support/meshShapes";
import { V, type Vec3 } from "../src/core/math";
import { parseStl } from "../src/core/stlImport";
import { emptyBook } from "../src/core/sheet/book";
import { importAnalysisStl } from "../src/analysis/mesh/import";
import {
  METRE_SETUP,
  prepareMesh,
  appendMeshFaces,
} from "../src/analysis/mesh/prepare";
import {
  closeDeck,
  deckReference,
  proposeDeckClosure,
} from "../src/analysis/mesh/closure";
import { meshImmersion } from "../src/analysis/mesh/immersion";
import { meshStability } from "../src/analysis/mesh/compute";
import { meshMeasurements } from "../src/analysis/mesh/measurements";
import {
  proposeMeshRepair,
  patchPreparedMesh,
  repairMesh,
  type RepairPolicy,
} from "../src/analysis/mesh/repair";
import { symmetricAboutCentreline } from "../src/analysis/mesh/symmetry";
import {
  analysisSetup,
  DEFAULT_CONFIGURATION,
} from "../src/stl-workspace/setup";
import { inspectStl } from "../src/stl-workspace/inspect";
import { decodeProject, encodeProject } from "../src/stl-workspace/project";
const policy: RepairPolicy = {
  version: 1,
  weldRelative: 1e-8,
  fillSmallHoles: true,
};
const horizontal = (z: number) => ({
  origin: [0, 0, z] as Vec3,
  u: [1, 0, 0] as Vec3,
  v: [0, 1, 0] as Vec3,
});
function binary(soup: number[]) {
  const b = new ArrayBuffer(84 + (soup.length / 9) * 50),
    v = new DataView(b);
  v.setUint32(80, soup.length / 9, true);
  soup.forEach((n, i) =>
    v.setFloat32(84 + Math.floor(i / 9) * 50 + 12 + (i % 9) * 4, n, true),
  );
  return b;
}
const original = boxSoup(4, 2, 2),
  bad = [...original, ...original.slice(0, 9), 0, 0, 0, 0, 0, 0, 0, 0, 0];
assert.throws(() => prepareMesh(bad), /Duplicate/);
const clean = proposeMeshRepair(bad, METRE_SETUP);
assert.equal(clean.report.degenerate, 1);
assert.equal(clean.report.duplicate, 1);
assert.equal(clean.mesh.faces.length, 12);
assert.equal(clean.report.maxVertexMove, 0);
assert.ok(Math.abs(meshImmersion(clean.mesh, horizontal(1)).vol - 8) < 1e-10);
// A tiny crack requires vertex movement but does not grant looser numerical predicates.
assert.throws(
  () =>
    proposeMeshRepair(
      [...original, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6],
      METRE_SETUP,
    ),
  /No bounded repair/,
);
const cracked = original.slice();
cracked[9 * 6] += 0.000008;
const stitched = proposeMeshRepair(cracked, METRE_SETUP);
assert.ok(stitched.report.maxVertexMove > 0);
assert.ok(stitched.report.weldTolerance > stitched.mesh.report.tolerance);
assert.ok(stitched.report.maxVertexMove <= stitched.report.weldTolerance);

// Replace one bottom triangle by an annulus around a very small missing triangle.
function smallHole(open = false) {
  const soup = boxSoup(4, 2, 2, open),
    p = [0, 3, 6].map((i) => soup.slice(i, i + 3) as Vec3);
  const center = p[0].map((_, i) => (p[0][i] + p[1][i] + p[2][i]) / 3) as Vec3;
  const q = p.map((a) => V.lerp(center, a, 0.002));
  return [
    ...soup.slice(9),
    ...p.flatMap((a, i) =>
      [a, p[(i + 1) % 3], q[(i + 1) % 3], a, q[(i + 1) % 3], q[i]].flat(),
    ),
  ];
}
const hole = proposeMeshRepair(smallHole(), METRE_SETUP);
assert.equal(hole.report.holes.length, 1);
assert.ok(hole.mesh.report.closed);
assert.equal(
  deckReference(hole.mesh).length,
  0,
  "A bottom repair patch is not a sheer reference",
);
assert.ok(Math.abs(meshImmersion(hole.mesh, horizontal(1)).vol - 8) < 1e-10);
const metrics = meshMeasurements(hole.mesh, {
  id: "patch",
  keelZ: 0,
  fixedTrim: 0,
  referenceWaterlineZ: 1,
  shellScope: {
    confirmed: true,
    surfaces: ["unclassified"],
    label: "All original physical faces",
  },
});
assert.ok(
  Math.abs(metrics.shellArea - (40 - hole.report.holes[0].area)) < 1e-9,
  "Do not weigh synthetic patches",
);
// Incremental patches retain coordinates and agree with a fully revalidated mesh.
for (const open of [false, true]) {
  const source = prepareMesh(smallHole(open), METRE_SETUP, { allowOpen: true });
  const before = structuredClone(source);
  const result = patchPreparedMesh(source);
  assert.deepEqual(source, before);
  assert.equal(result.mesh.vertices, source.vertices);
  assert.equal(result.report.maxVertexMove, 0);
  assert.equal(result.report.holes.length, 1);
  assert.deepEqual(
    result.mesh.sources.slice(0, source.faces.length),
    source.sources,
  );
  const full = prepareMesh(
    result.mesh.faces.flatMap((f) => f.flatMap((i) => result.mesh.vertices[i])),
    METRE_SETUP,
    {
      allowOpen: true,
      tolerance: source.report.tolerance,
      sources: result.mesh.sources,
    },
  );
  assert.deepEqual(full.vertices, result.mesh.vertices);
  assert.deepEqual(full.faces, result.mesh.faces);
  assert.deepEqual(full.sources, result.mesh.sources);
  assert.deepEqual(full.boundary, result.mesh.boundary);
}
// A valid skin whose inward bottom bulge crosses a proposed cap. Skipping
// old/old intersections must never skip a new patch against the existing skin.
const corners: Vec3[] = [
  [0, -1, 0],
  [0, 1, 0],
  [4, 1, 0],
  [4, -1, 0],
];
const bulged = [
  ...boxSoup(4, 2, 2, true).slice(18),
  ...corners.flatMap((p, i) => [p, corners[(i + 1) % 4], [2, 0, 3]].flat()),
];
const obstructed = prepareMesh(bulged, METRE_SETUP, { allowOpen: true });
const obstructionBefore = structuredClone(obstructed);
const cap = proposeDeckClosure(obstructed).triangles;
const tags = cap.map(() => ({
  kind: "synthetic" as const,
  closure: "test",
  purpose: "repair" as const,
}));
assert.throws(
  () => appendMeshFaces(obstructed, cap, tags),
  /Self-intersection|ambiguous contact/,
);
assert.deepEqual(
  obstructed,
  obstructionBefore,
  "A rejected patch leaves the source untouched",
);
assert.throws(
  () => appendMeshFaces(obstructed, [[0, 0, 1]], [tags[0]]),
  /Degenerate/,
);
assert.throws(
  () => appendMeshFaces(obstructed, [[0, 1, 999999]], [tags[0]]),
  /existing vertices/,
);
assert.throws(() => appendMeshFaces(obstructed, cap, []), /one repair source/);
const validOpen = prepareMesh(boxSoup(4, 2, 2, true), METRE_SETUP, {
  allowOpen: true,
});
const validCap = proposeDeckClosure(validOpen).triangles;
assert.throws(
  () =>
    appendMeshFaces(validOpen, [...validCap, validCap[0]], [...tags, tags[0]]),
  /Non-manifold/,
);
console.log(
  "  ok: incremental patch/full-revalidation agreement, new-face intersection rejection and source immutability",
);

const openSource = smallHole(true),
  open = proposeMeshRepair(openSource, METRE_SETUP);
assert.equal(open.mesh.boundary.length, 1, "Preserve the large sheer opening");
assert.equal(open.mesh.report.validatedOpenSheer, true);
assert.equal(
  open.mesh.report.openHydrostatics,
  undefined,
  "Repair validation alone does not grant analysis policy",
);
assert.equal(open.report.holes.length, 1);
assert.equal(deckReference(open.mesh).length, 0);
const unpatched = repairMesh(openSource, METRE_SETUP, {
  version: 2,
  weldRelative: open.report.policy.weldRelative,
  fillSmallHoles: false,
});
assert.equal(unpatched.report.holes.length, 0);
assert.equal(unpatched.report.skippedHoles.length, 1);
assert.equal(
  unpatched.mesh.boundary.length,
  2,
  "Keep a possible intentional small opening when the user declines its patch",
);
const closed = closeDeck(open.mesh, { accepted: true, closureId: "deck" });
assert.ok(closed.report.closed);
assert.ok(deckReference(closed).every((p) => p[2] === 2));
assert.equal(closed.report.repair?.holes.length, 1);

// Narrower deck above wider sides is valid tumblehome, not a forbidden XY overhang.
const tumble = boxSoup(4, 2, 2, true).map((v, i, a) =>
  i % 3 === 1 && a[i + 1] === 2 ? v * 0.7 : v,
);
assert.ok(
  closeDeck(prepareMesh(tumble, METRE_SETUP, { allowOpen: true }), {
    accepted: true,
    closureId: "tumblehome",
  }).report.closed,
);
// A missing bottom, genuine crossing, or a second hull must not be repaired into approval.
assert.throws(
  () => proposeMeshRepair([...original.slice(18)], METRE_SETUP),
  /No bounded repair/,
);
assert.throws(
  () =>
    proposeMeshRepair(
      [...original, ...original.map((v, i) => (i % 3 === 0 ? v + 20 : v))],
      METRE_SETUP,
    ),
  /Multiple components/,
);
assert.throws(
  () =>
    proposeMeshRepair(
      [...original, ...original.slice(0, 6), 2, 0, -2],
      METRE_SETUP,
    ),
  /Non-manifold edge/,
);
const crossing = original.map((v, i, a) => {
  const j = i - (i % 3);
  return a[j] === 4 && a[j + 1] === 1 && a[j + 2] === 2
    ? [-1, 0, 0.5][i % 3]
    : v;
});
assert.throws(
  () => proposeMeshRepair(crossing, METRE_SETUP),
  /No bounded repair/,
);
assert.throws(
  () => repairMesh(original, METRE_SETUP, { ...policy, weldRelative: 0.1 }),
  /Unsupported/,
);
assert.throws(
  () =>
    repairMesh(
      bad,
      METRE_SETUP,
      policy,
      Array.from({ length: 14 }, (_, i) => ({
        kind: "physical",
        surface: i === 12 ? "deck" : "skin",
      })),
    ),
  /conflicting surface/,
);

const bytes = binary(smallHole(true)),
  inspection = inspectStl({
    buffer: bytes,
    physical: METRE_SETUP,
    repair: true,
  });
assert.ok(inspection.repair);
assert.equal(inspection.report?.closed, false);
assert.equal(inspection.openSheer, true);
assert.equal(inspection.report?.openHydrostatics, true);
const config = {
  ...DEFAULT_CONFIGURATION,
  metresPerUnit: 1,
  repair: inspection.repair.policy,
  closeDeck: true,
};
const stored = await encodeProject(
    { name: "holes.stl", bytes },
    config,
    emptyBook(),
  ).arrayBuffer(),
  loaded = decodeProject(stored);
assert.deepEqual(loaded.asset.bytes, bytes);
assert.equal(loaded.configuration.closeDeck, false);
assert.match(loaded.migration!, /Legacy deck closure removed/);
const legacyWithRepairs = new Uint8Array(stored.slice(0));
const metaStart = new TextEncoder().encode("CAMBER-STL-1\n").length + 4;
const metaSize = new DataView(stored).getUint32(metaStart - 4, true);
const legacyMeta = new TextDecoder()
  .decode(legacyWithRepairs.subarray(metaStart, metaStart + metaSize))
  .replace('"version":3', '"version":1');
legacyWithRepairs.set(new TextEncoder().encode(legacyMeta), metaStart);
assert.throws(
  () => decodeProject(legacyWithRepairs.buffer),
  /Invalid or unsupported/,
);

assert.deepEqual(loaded.configuration.repair, config.repair);
const installed = importAnalysisStl(
  loaded.asset.bytes,
  analysisSetup(loaded.configuration, "restored"),
);
assert.equal(installed.report.closed, false);
assert.equal(installed.report.openHydrostatics, true);
assert.equal(installed.report.repair!.holes.length, 1);
assert.throws(
  () =>
    importAnalysisStl(bytes, {
      ...analysisSetup(config, "unaccepted"),
      repair: { ...policy, accepted: false as never },
    }),
  /confirmation/,
);
const surfaceSetup = analysisSetup(
  { ...config, closeDeck: false },
  "surface-only",
);
delete surfaceSetup.openSheer;
const repairedSurfaceOnly = importAnalysisStl(bytes, surfaceSetup);
assert.equal(repairedSurfaceOnly.report.closed, false);
assert.equal(repairedSurfaceOnly.report.openHydrostatics, undefined);
assert.ok(repairedSurfaceOnly.report.repair);
assert.match(repairedSurfaceOnly.report.envelopeError!, /open-sheer/);
console.log(
  "  ok: bounded cleanup/stitching, local hole patches, provenance, tumblehome, rejection gates, preview consent and reproducible project repair policy",
);

if (process.argv.includes("--examples")) {
  for (const [name, relative, removed, holes] of [
    // Without the artificial sheer cap, canvas-back no longer needs
    // aggressive stitching/face removal merely to make that cap validate.
    ["canvas-back", 1e-7, 0, 0],
    ["cg40", 1e-8, 0, 2],
    ["dev-boat", 1e-5, 15, 0],
  ] as const) {
    const file = readFileSync(
        new URL(`../examples/stls/${name}.stl`, import.meta.url),
      ),
      data = file.buffer.slice(
        file.byteOffset,
        file.byteOffset + file.byteLength,
      ),
      raw = parseStl(data);
    const physical = { ...METRE_SETUP, metresPerUnit: 0.0254 }; // Test scale only; the importer never guesses units.
    const result = proposeMeshRepair(raw.positions, physical);
    assert.equal(result.report.policy.weldRelative, relative);
    assert.equal(result.report.degenerate, removed);
    assert.equal(result.report.holes.length, holes);
    const again = importAnalysisStl(data, {
      physical,
      analysis: { id: name, keelZ: 0, fixedTrim: 0, referenceWaterlineZ: 1 },
      repair: { ...result.report.policy, accepted: true },
      openSheer: true,
    });
    assert.equal(again.report.closed, false);
    assert.equal(again.report.openHydrostatics, true);
    assert.deepEqual(again.faces, result.mesh.faces);
    assert.deepEqual(again.vertices, result.mesh.vertices);
    const stability = meshStability(again, {
      id: name,
      keelZ: 0,
      fixedTrim: 0,
      referenceWaterlineZ: 0.2,
      sinkageSteps: 4,
    });
    assert.equal(stability.status, "available");
    assert.ok(
      stability.status === "available" &&
        stability.value.assumptions?.some((text) =>
          text.includes("Approximately symmetric STL accepted"),
        ) &&
        stability.value.assumptions?.some((text) =>
          text.includes("No deck cap is added"),
        ),
    );
    console.log(
      `  ok: ${name}: ${removed} collapsed triangles, ${holes} small holes, max move ${(result.report.maxVertexMove * 1000).toPrecision(3)} mm; validated open sheer; exact symmetry=${symmetricAboutCentreline(again)}; pre-immersion stability available`,
    );
  }
}
