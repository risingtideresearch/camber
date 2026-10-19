import assert from "node:assert/strict";
import Ajv from "ajv";
import { readFileSync, readdirSync } from "node:fs";
import { parseHullState } from "../src/core/json";
import { orientedHullTriangles } from "../src/core/sheet/orientedMesh";
import schema from "@risingtideresearch/chartroom/formats/marine-geometry/v1/schema.json";
import { defaultHull, withUnit, type HullState } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import { hullMetrics } from "../src/core/hullMetrics";
import { buildMarineGeometry } from "../src/core/marineGeometryExport";
import { buildExport } from "../src/export/exporters";
import { captureCurrentHull } from "../src/export/source";
import { unitScale } from "../src/core/json";
import { V, type Vec3 } from "../src/core/math";
const state = defaultHull(),
  model = assemble(state),
  before = JSON.stringify(state),
  options = {
    numSections: 80,
    girthSteps: 6,
    generatedAt: "2026-10-19T00:00:00.000Z",
    modelId: "test-hull",
  };
// Validate the released contract, not an unreleased vendored experiment.
assert.equal(
  schema.$id,
  "https://raw.githubusercontent.com/risingtideresearch/chartroom/v0.2.0/formats/marine-geometry/v1/schema.json",
);
const doc = buildMarineGeometry(model, options),
  validate = new Ajv().compile(schema);
assert.ok(validate(doc), JSON.stringify(validate.errors));
assert.equal(doc.format, "marine-geometry");
assert.equal(doc.references, undefined);
assert.equal(doc.source!.modelId, "test-hull");
assert.equal(
  doc.referenceState!.waterplaneOffsetM,
  -model.waterline * unitScale(model.unit, "m"),
);
const mesh = doc.meshes[0];
const assigned = mesh.regions.flatMap((r) => r.triangleIndices);
assert.equal(new Set(assigned).size, mesh.triangles.length);
assert.equal(assigned.length, mesh.triangles.length);
assert.equal(
  mesh.regions.find((r) => r.id === "sheer-cap")!.representation,
  "idealized",
);
assert.equal(
  mesh.regions.find((r) => r.id === "transom")!.representation,
  "physical",
);
const edges = new Map<string, { count: number; direction: number }>();
let volume = 0,
  area = 0;
const origin = mesh.verticesM[0];
for (const [i, ids] of mesh.triangles.entries()) {
  const [a, b, c] = ids.map((v) => mesh.verticesM[v]);
  volume +=
    V.dot(V.sub(a, origin), V.cross(V.sub(b, origin), V.sub(c, origin))) / 6;
  if (mesh.regions.find((r) => r.id === "shell")!.triangleIndices.includes(i))
    area += Math.hypot(...V.cross(V.sub(b, a), V.sub(c, a))) / 2;
  ids.forEach((a, j) => {
    const b = ids[(j + 1) % 3],
      key = [a, b].sort((x, y) => x - y).join(","),
      e = edges.get(key) ?? { count: 0, direction: 0 };
    e.count++;
    e.direction += a < b ? 1 : -1;
    edges.set(key, e);
  });
}
assert.ok([...edges.values()].every((e) => e.count === 2 && e.direction === 0));
assert.ok(volume > 0);
const metrics = hullMetrics(model, computeHullSampling(model, 80, 6))!;
assert.ok(
  Math.abs(area - metrics.shellArea) / area < 0.025,
  `shell area ${area} vs sweep ${metrics.shellArea}`,
);
assert.ok(
  Math.abs(volume - metrics.hullVol) / volume < 0.025,
  `volume ${volume} vs sweep ${metrics.hullVol}`,
);
const translated: HullState = {
  ...state,
  sheerPlan: state.sheerPlan.map((p) => ({ ...p, x: p.x + 1000 })),
  sheerTrim: state.sheerTrim.map((p) => ({ ...p, x: p.x + 1000 })),
  transom: state.transom.map((p) => ({ ...p, x: p.x + 1000 })),
};
const shifted = buildMarineGeometry(assemble(translated), options);
assert.ok(shifted.meshes[0].verticesM.every((p) => p.every(Number.isFinite)));
const source = captureCurrentHull(state, "Study hull");
const exportResult = buildExport({
  source,
  options: { format: "marine-geometry", fine: false },
  generatedAt: options.generatedAt,
});
assert.equal(exportResult.filename, "Study hull.marine-geometry.json");
assert.ok(validate(JSON.parse(exportResult.text)));
assert.equal(JSON.stringify(state), before);
assert.throws(() => buildMarineGeometry(model, { numSections: 1 }));
// Retain original body-fixed coordinates: only metres and y/winding conversion.
const scale = unitScale(model.unit, "m"),
  sampling = computeHullSampling(model, 80, 6);
const sample = sampling.hullQuads[0][0].pos;
const expected: Vec3 = [
  sample[0] * scale,
  -sample[1] * scale,
  sample[2] * scale,
];
assert.ok(mesh.verticesM.some((p) => p.every((v, i) => v === expected[i])));
console.log(
  "Marine geometry exporter: schema, winding, regions, measures and export integration passed",
);

const inMetres = buildMarineGeometry(
  assemble(withUnit(state, "m", unitScale(state.unit, "m"))),
  options,
);
const signature = (points: readonly Vec3[]) =>
  points.map((p) => p.map((v) => Math.round(v * 1e6)).join(",")).sort();
assert.deepEqual(
  signature(inMetres.meshes[0].verticesM),
  signature(mesh.verticesM),
  "physical geometry is invariant under authored unit conversion",
);

// A transom plane aft of the swept sheet has no marched contour. The natural
// aft section still needs a disclosed analysis closure, not a physical transom.
for (const filename of readdirSync(new URL("../examples/", import.meta.url))) {
  if (!filename.endsWith(".json")) continue;
  const state = parseHullState(
    readFileSync(new URL(`../examples/${filename}`, import.meta.url), "utf8"),
  );
  for (const fine of [false, true]) {
    const result = buildExport({
      source: captureCurrentHull(state, filename),
      options: { format: "marine-geometry", fine },
      generatedAt: options.generatedAt,
    });
    const geometry = JSON.parse(result.text) as typeof doc;
    const label = `${filename}, ${fine ? "Fine" : "Standard"}`;
    assert.ok(
      validate(geometry),
      `${label}: ${JSON.stringify(validate.errors)}`,
    );
    const mesh = geometry.meshes[0];
    const assigned = mesh.regions.flatMap((r) => r.triangleIndices);
    assert.equal(assigned.length, mesh.triangles.length, label);
    assert.equal(new Set(assigned).size, mesh.triangles.length, label);
    const edges = new Map<string, { count: number; direction: number }>();
    let volume = 0;
    const origin = mesh.verticesM[0];
    for (const ids of mesh.triangles) {
      const [a, b, c] = ids.map((id) => mesh.verticesM[id]);
      assert.ok(Math.hypot(...V.cross(V.sub(b, a), V.sub(c, a))) > 0, label);
      volume +=
        V.dot(V.sub(a, origin), V.cross(V.sub(b, origin), V.sub(c, origin))) /
        6;
      ids.forEach((a, j) => {
        const b = ids[(j + 1) % 3];
        const key = [a, b].sort((x, y) => x - y).join(",");
        const edge = edges.get(key) ?? { count: 0, direction: 0 };
        edge.count++;
        edge.direction += a < b ? 1 : -1;
        edges.set(key, edge);
      });
    }
    assert.ok(
      [...edges.values()].every((e) => e.count === 2 && e.direction === 0),
      label,
    );
    assert.ok(Number.isFinite(volume) && volume > 0, label);
    const aftCap = mesh.regions.find((r) => r.id === "aft-cap");
    if (
      [
        "flat-bottom.json",
        "flat-bottom-fade.json",
        "narrow-transom.json",
      ].includes(filename)
    ) {
      assert.equal(aftCap?.representation, "idealized", label);
      assert.ok(
        aftCap?.description?.includes("not an authored physical transom"),
        label,
      );
      assert.equal(
        mesh.regions.some((r) => r.id === "transom"),
        false,
        label,
      );
    } else {
      assert.equal(aftCap, undefined, label);
    }
  }
}
// The aft-boundary fix must not silently patch unrelated holes in the shell.
assert.throws(
  () =>
    orientedHullTriangles({
      ...sampling,
      hullQuads: sampling.hullQuads.slice(1),
    }),
  /Oriented mesh requires two oppositely directed faces/,
);
console.log(
  "All bundled hulls export closed outward envelopes at Standard and Fine resolution",
);
