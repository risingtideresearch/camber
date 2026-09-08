// Phase 2: analytic solids, hostile imports, topology, mesh/sweep independence and facade conformance.
import assert from "node:assert/strict";
import { V, type Vec2, type Vec3 } from "../src/core/math";
import { parseStl } from "../src/core/stlImport";
import { buildStl } from "../src/core/stl";
import { defaultHull } from "../src/core/hull";
import {
  assemble,
  defaultSession,
  initialSliceRevs,
} from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import { hydrostatics } from "../src/core/hydro";
import { immersedAt, stationGeometry } from "../src/core/stability";
import { meshImmersed as independentMeshIntegral } from "./support/meshIntegral";
import { camberPlaneMesh } from "../src/analysis/camber/planeMesh";
import { createCamberComputation } from "../src/analysis/camber/compute";
import {
  prepareMesh,
  METRE_SETUP,
  physicalPoints,
} from "../src/analysis/mesh/prepare";
import { meshSection } from "../src/analysis/mesh/section";
import { meshImmersion } from "../src/analysis/mesh/immersion";
import { closeDeck, proposeDeckClosure } from "../src/analysis/mesh/closure";
import {
  createMeshAnalysis,
  meshBackend,
  meshStability,
} from "../src/analysis/mesh/compute";
import { importAnalysisStl } from "../src/analysis/mesh/import";
import { symmetricAboutCentreline } from "../src/analysis/mesh/symmetry";
import {
  createStlAnalysisClient,
  type MeshWorker,
} from "../src/analysis/mesh/client";
import type { MeshRequest, MeshResponse } from "../src/analysis/mesh/protocol";
import {
  gzCurve,
  limitingKgAt,
  sheerImmersionAngle,
} from "../src/analysis/stability";
import { scaleStability } from "../src/analysis/stabilityData";
import { unavailable, type Available } from "../src/analysis/api";
import { hullPoint, type PlaneFrame } from "../src/analysis/sections";
import { boxSoup, subdivide } from "./support/meshShapes";

const value = <T>(a: Available<T>): T => {
  if (a.status !== "available") assert.fail(a.reason);
  return a.value;
};
const near = (a: number, b: number, t = 1e-9) =>
  assert.ok(Math.abs(a - b) <= t, `${a} ≠ ${b} (budget ${t})`);
const vec = (a: readonly number[], b: readonly number[], t = 1e-9) =>
  a.forEach((v, i) => near(v, b[i], t));
const horizontal = (z: number): PlaneFrame => ({
  origin: [0, 0, z],
  u: [1, 0, 0],
  v: [0, 1, 0],
});
const vertical = (x: number): PlaneFrame => ({
  origin: [x, 0, 0],
  u: [0, 1, 0],
  v: [0, 0, 1],
});
const section = (mesh: ReturnType<typeof prepareMesh>, plane: PlaneFrame) =>
  value(meshSection(mesh, { plane, envelope: "buoyancy" }));
const setup = { id: "box", fixedTrim: 0, keelZ: 0, referenceWaterlineZ: 1 };
const soup = boxSoup(),
  box = prepareMesh(soup);
assert.equal(box.report.closed, true);
assert.equal(box.vertices.length, 8);
const mid = section(box, horizontal(1));
near(value(mid.measurements.area), 8);
vec(value(mid.measurements.centroid), [2, 0]);
near(value(mid.measurements.closedPerimeter), 12);
near(value(mid.measurements.moments).uu, 8 / 3);
near(value(mid.measurements.moments).vv, 32 / 3);
near(value(mid.measurements.moments).uv, 0);
assert.equal(mid.regions.length, 1);
assert.equal(mid.openPaths.length, 0);
assert.equal(
  mid.regions[0].outer.edges.length,
  mid.regions[0].outer.points.length,
);
const immersed = meshImmersion(box, horizontal(1), true);
near(immersed.vol, 8);
vec(immersed.centroid!, [2, 0, 0.5]);
near(immersed.wettedBySurface.unclassified, 20);
near(meshImmersion(box, horizontal(3)).vol, 16);
near(meshImmersion(box, horizontal(-1)).vol, 0);
assert.equal(meshImmersion(box, horizontal(-1)).centroid, null);
const empty = section(box, horizontal(3));
assert.equal(empty.regions.length, 0);
near(value(empty.measurements.area), 0);
assert.equal(empty.measurements.centroid.status, "unavailable");
assert.equal(
  meshSection(box, { plane: horizontal(2), envelope: "buoyancy" }).status,
  "unavailable",
  "coplanar faces are explicit, not an invented empty polygon",
);
assert.throws(
  () =>
    meshSection(box, {
      plane: { ...horizontal(1), v: [1, 1, 0] },
      envelope: "buoyancy",
    }),
  /orthonormal/,
);
assert.throws(
  () =>
    meshSection(box, {
      plane: horizontal(1),
      envelope: "buoyancy",
      tolerance: 1,
    }),
  /tolerance/,
);

// An inclined plane x+z=3 stays between x=1…3 through a 4×2×2 box.
const q = Math.SQRT1_2,
  oblique: PlaneFrame = { origin: [3, 0, 0], u: [0, 1, 0], v: [-q, 0, q] };
near(value(section(box, oblique).measurements.area), 4 * Math.SQRT2);
const half = meshImmersion(box, oblique);
near(half.vol, 8);
vec(half.centroid!, [13 / 12, 0, 5 / 6]);
const changedBasis: PlaneFrame = {
  origin: [100, -30, 1],
  u: [0, 1, 0],
  v: [-1, 0, 0],
};
const alternate = section(box, changedBasis);
near(value(alternate.measurements.area), 8);
vec(hullPoint(changedBasis, value(alternate.measurements.centroid)), [2, 0, 1]);
near(value(alternate.measurements.moments).uu, 32 / 3);
const edgePlane: PlaneFrame = {
  origin: [0, -1, 0],
  u: [0, 1, 0],
  v: V.norm([2, 0, 1]),
};
near(value(section(box, edgePlane).measurements.area), 4 * Math.sqrt(5)); // through opposing box edges
console.log(
  "  ok: analytic volume/CB, moments, inclined/basis/edge/coplanar/empty cuts",
);

// SI conversion, datum translation, axis reflection and proper rotation: never fit to a design box.
const mm = prepareMesh(
  soup.map((v) => v * 1000),
  { ...METRE_SETUP, metresPerUnit: 0.001 },
);
near(meshImmersion(mm, horizontal(1)).vol, 8);
const feet = prepareMesh(
  soup.map((v) => v / 0.3048),
  { ...METRE_SETUP, metresPerUnit: 0.3048 },
);
near(meshImmersion(feet, horizontal(1)).vol, 8);
const reflected = prepareMesh(soup, { ...METRE_SETUP, axes: [1, -2, 3] });
near(meshImmersion(reflected, horizontal(1)).vol, 8);
assert.equal(reflected.report.reorientedFaces, 12);
const shifted = prepareMesh(
  soup.map((v, i) => v + [1e4, 3e3, -2e3][i % 3]),
  { ...METRE_SETUP, origin: [1e4, 3e3, -2e3] },
);
near(meshImmersion(shifted, horizontal(1)).vol, 8);
vec(physicalPoints(soup, { ...METRE_SETUP, axes: [3, 1, 2] })[0], [0, 0, -1]);
vec(
  physicalPoints(soup, {
    ...METRE_SETUP,
    rotation: { axis: [0, 0, 1], radians: Math.PI / 2 },
  })[0],
  [1, 0, 0],
);
assert.throws(
  () => prepareMesh(soup, { ...METRE_SETUP, axes: [1, -1, 3] }),
  /axis/,
);
assert.throws(
  () => prepareMesh(soup, { ...METRE_SETUP, metresPerUnit: 0 }),
  /scale/,
);
const reversed = soup.slice();
[reversed[3], reversed[6]] = [reversed[6], reversed[3]];
[reversed[4], reversed[7]] = [reversed[7], reversed[4]];
[reversed[5], reversed[8]] = [reversed[8], reversed[5]];
const repaired = prepareMesh(reversed);
near(meshImmersion(repaired, horizontal(1)).vol, 8);
assert.equal(repaired.report.reorientedFaces, 1);
assert.throws(() => prepareMesh([...soup, ...soup.slice(0, 9)]), /Duplicate/);
assert.throws(() => prepareMesh([0, 0, 0, 1, 0, 0, 2, 0, 0]), /Degenerate/);
assert.throws(
  () => prepareMesh(soup.map((v, i) => (i === 1 ? NaN : v))),
  /finite/,
);
assert.throws(
  () =>
    prepareMesh([...soup, ...soup.map((v, i) => (i % 3 === 0 ? v + 10 : v))]),
  /Multiple components/,
);
assert.throws(
  () => prepareMesh([...soup, ...soup.slice(0, 6), 2, 0, -2]),
  /Non-manifold/,
);
const crossing = soup.map((v, i) => {
  const j = i - (i % 3);
  return soup[j] === 4 && soup[j + 1] === 1 && soup[j + 2] === 2
    ? [-1, 0, 0.5][i % 3]
    : v;
});
assert.throws(() => prepareMesh(crossing), /Self-intersection/);
console.log(
  "  ok: physical setup, winding, malformed geometry, manifold and intersection rejection",
);

// A square annular prism has one connected boundary surface, but its section has a HOLE.
function annulus() {
  const outer: Vec2[] = [
      [0, -1],
      [4, -1],
      [4, 1],
      [0, 1],
    ],
    inner: Vec2[] = [
      [1, -0.5],
      [3, -0.5],
      [3, 0.5],
      [1, 0.5],
    ];
  const p: Vec3[] = [...outer, ...inner].flatMap(
      (v) =>
        [
          [v[0], v[1], 0],
          [v[0], v[1], 2],
        ] as Vec3[],
    ),
    tri: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) =>
    tri.push(...[a, b, c, a, c, d].flatMap((i) => p[i]));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4,
      a = i * 2,
      b = j * 2,
      c = 8 + i * 2,
      d = 8 + j * 2;
    quad(a, b, b + 1, a + 1);
    quad(c, c + 1, d + 1, d);
    quad(a + 1, b + 1, d + 1, c + 1);
    quad(a, c, d, b);
  }
  return tri;
}
const ring = prepareMesh(annulus()),
  ringCut = section(ring, horizontal(1));
assert.equal(ringCut.regions.length, 1);
assert.equal(ringCut.regions[0].holes.length, 1);
near(value(ringCut.measurements.area), 6);
near(value(ringCut.measurements.moments).uu, 2.5);
near(meshImmersion(ring, horizontal(1)).vol, 6);
// Connected U-shaped prism, cut above its connecting web: two genuinely disconnected regions.
function uPrism() {
  const p: Vec2[] = [
      [0, 0],
      [4, 0],
      [4, 2],
      [3, 2],
      [3, 1],
      [1, 1],
      [1, 2],
      [0, 2],
    ],
    tris = [
      [0, 1, 4],
      [0, 4, 5],
      [1, 2, 3],
      [1, 3, 4],
      [0, 5, 6],
      [0, 6, 7],
    ];
  const out: number[] = [];
  for (const y of [-1, 1])
    for (const f of tris) out.push(...f.flatMap((i) => [p[i][0], y, p[i][1]]));
  p.forEach((a, i) => {
    const b = p[(i + 1) % p.length];
    out.push(
      ...[
        [a[0], -1, a[1]],
        [b[0], -1, b[1]],
        [b[0], 1, b[1]],
        [a[0], -1, a[1]],
        [b[0], 1, b[1]],
        [a[0], 1, a[1]],
      ].flat(),
    );
  });
  return out;
}
const u = prepareMesh(uPrism()),
  two = section(u, horizontal(1.5));
assert.equal(two.regions.length, 2);
near(value(two.measurements.area), 4);
console.log(
  "  ok: holes and disconnected section regions are not concatenated",
);

const open = prepareMesh(boxSoup(4, 2, 2, true), METRE_SETUP, {
  allowOpen: true,
});
assert.throws(() => prepareMesh(boxSoup(4, 2, 2, true)), /Open envelope/);
assert.throws(() => meshImmersion(open, horizontal(1)), /closed/);
const openCut = section(open, vertical(2));
assert.equal(openCut.openPaths.length, 1);
assert.equal(openCut.measurements.area.status, "unavailable");
const closure = proposeDeckClosure(open);
assert.match(closure.method, /symmetric/);
const closed = closeDeck(open, { accepted: true, closureId: "test-deck" }),
  closedCut = section(closed, vertical(2));
near(value(closedCut.measurements.area), 4);
near(closedCut.measurements.syntheticPerimeter, 2);
near(closedCut.measurements.perimeterBySurface.unclassified, 6);
near(meshImmersion(closed, horizontal(3)).vol, 16);
const warped = prepareMesh(boxSoup(4, 2, 2, true, true), METRE_SETUP, {
  allowOpen: true,
});
assert.match(proposeDeckClosure(warped).method, /ear/);
const warpedClosed = closeDeck(warped, { accepted: true, closureId: "warped" });
assert.ok(meshImmersion(warpedClosed, horizontal(4)).vol > 16);
assert.equal(symmetricAboutCentreline(warpedClosed), false);
assert.equal(meshStability(warpedClosed, setup).status, "unavailable");
const bottomOpen = prepareMesh(boxSoup().slice(18), METRE_SETUP, {
  allowOpen: true,
});
assert.throws(
  () => closeDeck(bottomOpen, { accepted: true, closureId: "not-a-deck" }),
  /top\/deck/,
);
console.log(
  "  ok: explicit open results, confirmed nonplanar closures and boundary provenance",
);

const stability = value(meshStability(box, setup));
near(stability.hydro!.vol, 8);
near(stability.hydro!.kb, 0.5);
near(limitingKgAt(stability.limit, 8), 0.5 + 1 / 3);
assert.equal(stability.availability!.sheer.status, "unavailable");
assert.equal(stability.availability!.downflooding.status, "unavailable");
assert.ok(Number.isNaN(sheerImmersionAngle(stability.curves, 8)));
assert.ok(stability.curves.deckDown.flat().every((v) => v === null));
assert.equal(gzCurve(stability.curves, 8, 0.5)[1].deckDown, null);
const backend = meshBackend(box, setup),
  small = backend.at(0.001, Math.cos(0.001));
near(small.vol, 8);
near((small.kn - 0.5 * Math.sin(0.001)) / Math.sin(0.001), 1 / 3, 1e-6);
const afterDeck = value(meshStability(closed, setup));
assert.equal(afterDeck.availability!.sheer.status, "available");
assert.ok(afterDeck.curves.deckDown.flat().some((v) => v === true));
const dry = value(meshStability(box, { ...setup, referenceWaterlineZ: 3 }));
assert.equal(dry.hydro, null);
assert.equal(dry.availability!.referenceWaterline.status, "unavailable");
assert.ok(dry.limit.length > 2);
const display = scaleStability(stability, 1000);
assert.equal(display.availability!.sheer.status, "unavailable");
assert.deepEqual(display.assumptions, stability.assumptions);
const trimmedContext = createMeshAnalysis(box, {
  ...setup,
  id: "trim-map",
  fixedTrim: 0.07,
  keelZ: 0.123,
}).context;
const mapped = trimmedContext.hullToWeight!.rows.map(
  (row, i) => V.dot(row, [2, 0, 1]) + trimmedContext.hullToWeight!.offset[i],
);
vec(mapped, [
  2 * Math.cos(0.07) - Math.sin(0.07),
  0,
  2 * Math.sin(0.07) + Math.cos(0.07) - 0.123,
]);
assert.equal(trimmedContext.kgDatum!.z, 0.123);
assert.throws(() => {
  trimmedContext.hullToWeight!.offset[2] = 99;
}, TypeError);
assert.ok(
  stability.curves.vol.every((row) => row[0] > 0),
  "Undefined dry-limit KN must not be interpolated as zero",
);
const meshApi = createMeshAnalysis(box, setup);
assert.equal((await meshApi.measurements()).result.status, "unavailable");
near(
  value(
    value(
      (await meshApi.section({ plane: horizontal(1), envelope: "buoyancy" }))
        .result,
    ).measurements.area,
  ),
  8,
);
console.log(
  "  ok: KN/KMt, small-angle GM, independent/unknown references and table consumer",
);

// Accelerated bulk-node integrals and direct clipped tetrahedra agree on arbitrary
// halfspaces, including holes and entirely wet/dry conditions. The oracle above
// remains independent of BOTH paths.
let denseSoup = boxSoup();
for (let i = 0; i < 3; i++) denseSoup = subdivide(denseSoup);
const dense = prepareMesh(denseSoup);
let seed = 42;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
for (const mesh of [dense, ring, u])
  for (let i = 0; i < 80; i++) {
    const n = V.norm([random() - 0.5, random() - 0.5, random() - 0.5]),
      basis = V.norm(V.cross(n, Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]));
    const h = (random() - 0.5) * 6,
      plane: PlaneFrame = {
        origin: [2 + n[0] * h, n[1] * h, 1 + n[2] * h],
        u: basis,
        v: V.cross(n, basis),
      };
    const accelerated = meshImmersion(mesh, plane),
      direct = meshImmersion(mesh, plane, false, false);
    near(accelerated.vol, direct.vol, 1e-9);
    if (accelerated.centroid && direct.centroid)
      vec(accelerated.centroid, direct.centroid, 1e-8);
    for (const surface of Object.keys(direct.wettedBySurface))
      near(
        accelerated.wettedBySurface[surface],
        direct.wettedBySurface[surface],
        1e-9,
      );
  }
near(meshImmersion(box, horizontal(1e14)).vol, 16);
const half45 = backend.at(Math.PI / 4, Math.SQRT1_2);
near(half45.vol, 8);
near(half45.yB, 1 / 3);
near(half45.zB, 2 / 3);
near(half45.kn, Math.SQRT1_2);
console.log(
  "  ok: exact BVH aggregation versus direct clipping over 240 halfspaces",
);

// Strict binary/ASCII parsing, including binary headers starting with "solid".
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
function binary(soup: readonly number[]) {
  const buffer = new ArrayBuffer(84 + (soup.length / 9) * 50),
    v = new DataView(buffer);
  new Uint8Array(buffer).set(new TextEncoder().encode("solid binary"));
  v.setUint32(80, soup.length / 9, true);
  for (let i = 0; i < soup.length; i++)
    v.setFloat32(84 + Math.floor(i / 9) * 50 + 12 + (i % 9) * 4, soup[i], true);
  return buffer;
}
assert.equal(parseStl(binary(soup)).triangleCount, 12);
assert.throws(() => parseStl(binary(soup).slice(0, -1)), /Malformed|truncated/);
const bad = binary(soup);
new DataView(bad).setFloat32(96, Infinity, true);
assert.throws(() => parseStl(bad), /finite/);
assert.throws(
  () =>
    parseStl(
      bytes(
        "solid bad\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendsolid bad",
      ),
    ),
  /facet/,
);
assert.throws(() => parseStl(new ArrayBuffer(64 * 1024 * 1024 + 1)), /limit/);

// Camber comparisons never replace the independent oracle with production mesh integration.
for (const rake of [0, 0.07]) {
  const state = { ...defaultHull(), deckRake: rake },
    model = assemble(state, defaultSession(state));
  const sampling = computeHullSampling(model, 80, 6),
    geom = stationGeometry(model, sampling)!,
    hydro = hydrostatics(model, sampling)!;
  const mesh = camberPlaneMesh(model, sampling),
    ms = {
      id: `camber/${rake}`,
      fixedTrim: rake,
      keelZ: geom.keelZ * 0.001,
      referenceWaterlineZ: -model.waterline * 0.001,
    };
  const b = meshBackend(mesh, ms),
    ref = b.at(0, ms.referenceWaterlineZ, true);
  near(ref.vol, hydro.vol * 1e-9, hydro.vol * 1e-9 * 0.008);
  near(ref.zB, hydro.kb * 0.001, 0.003);
  for (const phi of [0, 0.2, 0.5]) {
    const wl = -model.waterline,
      expected = immersedAt(geom, phi, wl),
      measured = b.at(phi, wl * 0.001);
    if (expected.deckDown) continue;
    const oracle = independentMeshIntegral(
      model,
      sampling,
      geom.keelZ,
      phi,
      wl,
    );
    near(measured.vol, oracle.vol * 1e-9, 1e-7);
    near(measured.kn, oracle.kn * 0.001, 1e-7);
    near(measured.kn, expected.kn * 0.001, 0.005);
  }
  // STL itself: orientation repairs reported; deck closure never inferred without confirmation.
  const buffer = bytes(buildStl(model));
  const exportedOpen = prepareMesh(
    parseStl(buffer).positions,
    { ...METRE_SETUP, metresPerUnit: 0.001 },
    { allowOpen: true },
  );
  assert.equal(
    exportedOpen.report.reorientedFaces,
    0,
    "STL export must wind both mirrored halves outward",
  );
  assert.throws(
    () =>
      importAnalysisStl(buffer, {
        physical: { ...METRE_SETUP, metresPerUnit: 0.001 },
        analysis: ms,
      }),
    /Open envelope/,
  );
  const imported = importAnalysisStl(buffer, {
    physical: { ...METRE_SETUP, metresPerUnit: 0.001 },
    analysis: ms,
    deckClosure: { accepted: true, closureId: "confirmed-deck" },
  });
  near(
    meshBackend(imported, ms).at(0, ms.referenceWaterlineZ).vol,
    ref.vol,
    1e-6,
  );
  const query = createCamberComputation(),
    answer = query(
      {
        key: ms.id,
        state,
        session: defaultSession(state),
        sliceRevs: initialSliceRevs(),
        numSections: 80,
        girthSteps: 6,
      },
      "section",
      { plane: vertical(2), envelope: "buoyancy" },
    );
  const cut = value(answer.result);
  assert.ok(value(cut.measurements.area) > 0);
  assert.ok(cut.measurements.syntheticPerimeter > 0);
  assert.ok(cut.measurements.perimeterBySurface.skin > 0);
  console.log(`  ok: Camber/STL/sweep/independent oracle at trim ${rake}`);
}

// Asset-once worker lifecycle: independent queries, retained source bytes, failures and disposal.
class FakeWorker implements MeshWorker {
  onmessage: MeshWorker["onmessage"] = null;
  onerror: MeshWorker["onerror"] = null;
  sent: MeshRequest[] = [];
  terminated = false;
  postMessage(message: MeshRequest, transfer?: Transferable[]) {
    this.sent.push(structuredClone(message, { transfer }));
  }
  terminate() {
    this.terminated = true;
  }
  answer(data: MeshResponse) {
    this.onmessage?.({ data } as MessageEvent<MeshResponse>);
  }
}
const worker = new FakeWorker(),
  asset = binary(soup),
  client = createStlAnalysisClient(
    asset,
    { physical: METRE_SETUP, analysis: setup },
    () => worker,
  );
assert.equal(asset.byteLength, 684);
assert.equal(worker.sent.length, 1);
worker.answer({ type: "ready", contextId: setup.id, report: box.report });
await client.ready;
const pendingSection = client.hull.section({
    plane: horizontal(1),
    envelope: "buoyancy",
  }),
  pendingStability = client.hull.stability();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(worker.sent.length, 3);
for (const request of worker.sent.slice(1)) {
  assert.equal(request.type, "query");
  if (request.type === "query")
    worker.answer({
      type: "answer",
      id: request.id,
      contextId: setup.id,
      result: unavailable("test"),
    });
}
await pendingSection;
await pendingStability;
assert.equal(worker.sent.filter((m) => m.type === "install").length, 1);
const dying = client.hull.section({
  plane: horizontal(0.5),
  envelope: "buoyancy",
});
const rejection = assert.rejects(dying, { name: "AbortError" });
await new Promise((resolve) => setTimeout(resolve, 0));
client.dispose();
await rejection;
assert.equal(worker.terminated, true);
const failWorker = new FakeWorker(),
  failure = createStlAnalysisClient(
    asset,
    { physical: METRE_SETUP, analysis: setup },
    () => failWorker,
  );
failWorker.answer({
  type: "ready",
  contextId: setup.id,
  error: "Invalid mesh",
});
await assert.rejects(failure.ready, /Invalid mesh/);
await assert.rejects(failure.hull.stability(), /Invalid mesh/);
const mismatchWorker = new FakeWorker(),
  mismatch = createStlAnalysisClient(
    asset,
    { physical: METRE_SETUP, analysis: setup },
    () => mismatchWorker,
  );
mismatchWorker.answer({
  type: "ready",
  contextId: "stale",
  report: box.report,
});
await assert.rejects(mismatch.ready, /mismatch/);
console.log(
  "  ok: asset-once worker transport, independent queries, import failure, mismatch and disposal",
);
console.log("\nmesh analysis passed");
