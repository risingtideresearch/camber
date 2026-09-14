// Phase 3: a real STL and weight book, with no Camber Model in the workflow.
import assert from "node:assert/strict";
import { available, type Available } from "../src/analysis/api";
import { createMeshAnalysis } from "../src/analysis/mesh/compute";
import { importAnalysisStl } from "../src/analysis/mesh/import";
import { METRE_SETUP } from "../src/analysis/mesh/prepare";
import { meshContext } from "../src/analysis/mesh/setup";
import { finishWeightBook, planWeightBook } from "../src/analysis/weightBook";
import {
  fromWeight,
  measurePlaneFamily,
  measureWeightCuts,
  planeAt,
  toWeight,
  verticalPlaneThroughLine,
  weightPlane,
} from "../src/analysis/weightGeometry";
import {
  pointSectionOutline,
  pointViewOutlines,
} from "../src/analysis/pointViewGeometry";
import { hullPoint, containsPoint } from "../src/analysis/sections";
import { emptyBook, type WeightBook } from "../src/core/sheet/book";
import { buildSheetJson, parseSheet } from "../src/core/sheet/json";
import {
  evaluateBook,
  outputResult,
  resultAt,
} from "../src/core/sheet/evaluate";
import { conditionFromSheet } from "../src/analysis/stabilityData";
import { gzCurve, limitingKgAt } from "../src/analysis/stability";
import { boxSoup } from "./support/meshShapes";
import type { Vec3 } from "../src/core/math";
const value = <T>(a: Available<T>): T => {
  if (a.status !== "available") assert.fail(a.reason);
  return a.value;
};
const near = (a: number, b: number, e = 1e-8) =>
  assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);
const vec = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, i) => near(v, b[i]));
function binary(soup: number[]) {
  const buffer = new ArrayBuffer(84 + (soup.length / 9) * 50),
    d = new DataView(buffer);
  d.setUint32(80, soup.length / 9, true);
  soup.forEach((v, i) =>
    d.setFloat32(84 + Math.floor(i / 9) * 50 + 12 + (i % 9) * 4, v, true),
  );
  return buffer;
}
const surfaceByTriangle = Array.from({ length: 12 }, (_, i) =>
  i >= 10 ? "deck" : i >= 8 ? "transom" : "skin",
);
const setup = {
  id: "classified",
  fixedTrim: 0,
  referenceWaterlineZ: 1,
  keelZ: 0,
  shellScope: {
    confirmed: true as const,
    surfaces: ["skin"],
    label: "Skin, excluding deck and transom",
  },
};
const asset = binary(boxSoup());
const mesh = importAnalysisStl(asset, {
  physical: METRE_SETUP,
  analysis: setup,
  surfaceByTriangle,
});
const hull = createMeshAnalysis(mesh, setup);
const metrics = value((await hull.measurements()).result);
near(metrics.shellArea, 28);
near(metrics.shellLcg, 16 / 7);
near(metrics.shellVcg, 5 / 7);
near(metrics.shellTcg!, 0);
near(metrics.wsa, 18);
near(metrics.hullVol, 16);
near(metrics.dispVol, 8);
near(metrics.waterplaneArea, 8);
near(metrics.lwl, 4);
near(metrics.bwl, 2);
near(metrics.draft, 1);
near(metrics.kb, 0.5);
near(metrics.bmt, 1 / 3);
assert.match(metrics.unavailable!.WATERLINE, /legacy Camber/);
assert.match(metrics.unavailable!.AM, /no defined STL equivalent/);
assert.match(metrics.provenance!.shellScope, /excluding deck and transom/);
assert.equal(hull.capabilities.authoredStations, false);
const plain = createMeshAnalysis(mesh, {
  ...setup,
  id: "unclassified",
  shellScope: undefined,
});
const noScope = value((await plain.measurements()).result);
assert.ok(Number.isNaN(noScope.shellArea) && Number.isNaN(noScope.shellTcg));
assert.match(noScope.unavailable!.SHELL_CG, /Confirm/);
near(noScope.hullVol, 16);
const whole = createMeshAnalysis(mesh, {
  ...setup,
  id: "whole",
  shellScope: {
    confirmed: true,
    surfaces: ["skin", "transom", "deck"],
    label: "All physical faces, including deck and transom",
  },
});
near(value((await whole.measurements()).result).shellArea, 40);
const badScope = createMeshAnalysis(mesh, {
  ...setup,
  id: "missing-surface",
  shellScope: { ...setup.shellScope, surfaces: ["absent"] },
});
assert.match(
  value((await badScope.measurements()).result).unavailable!.SHELL_AREA,
  /absent/,
);
assert.throws(
  () =>
    meshContext({
      ...setup,
      shellScope: { ...setup.shellScope, surfaces: [] },
    }),
  /scope/,
);

for (const trim of [0, 0.17]) {
  const adjusted = {
    ...setup,
    id: `trim-${trim}`,
    fixedTrim: trim,
    keelZ: -0.4,
  };
  const h = createMeshAnalysis(mesh, adjusted),
    m = value((await h.measurements()).result),
    mapping = h.context.hullToWeight!;
  const expected = toWeight(mapping, [16 / 7, 0, 5 / 7]);
  vec([m.shellLcg, m.shellTcg!, m.shellVcg], expected);
  vec(fromWeight(mapping, expected), [16 / 7, 0, 5 / 7]);
  const plane = weightPlane(mapping, "z", 1.1);
  const section = value(
    (await h.section({ plane, envelope: "buoyancy" })).result,
  );
  for (const p of section.regions.flatMap((r) => r.outer.points))
    near(toWeight(mapping, hullPoint(plane, p))[2], 1.1);
  const cuts = value(
    (await measureWeightCuts(h, [{ shape: "plane", position: 1.1 }])).result,
  );
  near(value(cuts[0]).z, 1.1);
  near(value(cuts[0]).derivative.z, 1, 1e-6);
  const preview = value(
    (await pointSectionOutline(h, { kind: "vertical", x: 2 })).result,
  )!;
  assert.ok(preview.loops!.length > 0 && preview.starboard.length === 0);
  const profile = value((await pointViewOutlines(h)).result);
  assert.ok(profile.profile.coverage!.length > 0);
  assert.ok(profile.frame.zSpan[0] >= 0.4 - 1e-8);
}
const answers = value(
  (
    await measureWeightCuts(hull, [
      { shape: "plane", position: 1 },
      { shape: "transverse", position: 2 },
      { shape: "station", position: 2 },
    ])
  ).result,
);
const horizontal = value(answers[0]),
  transverse = value(answers[1]);
near(horizontal.area, 8);
near(horizontal.closedPerimeter, 12);
near(horizontal.openPerimeter, 10);
near(horizontal.derivative.z, 1);
near(transverse.area, 4);
near(transverse.closedPerimeter, 8);
near(transverse.openPerimeter, 6);
near(transverse.derivative.x, 1);
assert.equal(answers[2].status, "unavailable");
if (answers[2].status === "unavailable")
  assert.match(answers[2].reason, /authored Camber stations/);
const unscopedCut = value(
  value(
    (await measureWeightCuts(plain, [{ shape: "plane", position: 1 }])).result,
  )[0],
);
near(unscopedCut.area, 8);
assert.ok(Number.isNaN(unscopedCut.openPerimeter));
assert.match(unscopedCut.unavailable!.openPerimeter!, /scope/);

const authored: WeightBook = {
  ...emptyBook(),
  items: [
    {
      id: "shell",
      name: "Shell",
      note: "",
      facets: {},
      fields: {
        mass: {
          k: "scalar",
          formula: "HULL.SHELL_AREA * density",
          unit: "kg",
          role: "MASS",
        },
        density: { k: "scalar", formula: "10", unit: "kg/m2", role: null },
        cg: {
          k: "point",
          unit: "m",
          x: "",
          y: "",
          z: "",
          from: "HULL.SHELL_CG",
          role: "CG",
        },
      },
    },
    {
      id: "cut",
      name: "Bulkhead",
      note: "",
      facets: {},
      fields: {
        section: { k: "cut", shape: "transverse", pos: "2 +- 0.1", unit: "m" },
        area: {
          k: "scalar",
          formula: "Bulkhead.section.area",
          unit: "m2",
          role: null,
        },
      },
    },
  ],
  outputs: { DISPLACEMENT: "Shell.mass", VCG: "Shell.cg.z", LCG: "Shell.cg.x" },
};
const plan = planWeightBook(authored, metrics);
assert.equal(plan.queries[0].shape, "transverse");
const evaluated = finishWeightBook(
  authored,
  metrics,
  plan,
  value((await measureWeightCuts(hull, plan.queries)).result),
);
near(outputResult(evaluated.results, "DISPLACEMENT")!.reading!.v, 280);
near(resultAt(evaluated.results, "cut", "area")!.reading!.v, 4);
const linked = conditionFromSheet(evaluated.results, authored.density, 1);
assert.ok(linked);
near(linked!.vol, 280 / (1000 * authored.density));
const stability = value((await hull.stability()).result);
assert.ok(gzCurve(stability.curves, linked!.vol, linked!.kg!).length > 2);
assert.ok(Number.isFinite(limitingKgAt(stability.limit, 8)));
assert.equal(stability.availability!.sheer.status, "unavailable");
const encoded = buildSheetJson(authored);
assert.equal(JSON.parse(encoded).version, 2);
assert.equal(parseSheet(encoded).items[1].fields.section.k, "cut");
assert.deepEqual(parseSheet(encoded), authored);
const legacy = JSON.parse(encoded);
legacy.version = 1;
legacy.items[1].fields.section.shape = "station";
assert.equal(
  (
    parseSheet(JSON.stringify(legacy)).items[1].fields.section as {
      shape: string;
    }
  ).shape,
  "station",
);

// A deliberately non-smooth family crosses a topology change at the box's side.
const mapping = hull.context.hullToWeight!;
const edge = value(
  await measurePlaneFamily(
    hull,
    (t) => weightPlane(mapping, "x", t),
    0.00005,
    mapping,
    ["skin"],
    0.0001,
  ),
);
assert.match(edge.derivativeUnavailable!, /neighbouring section/);
const cutBook = {
  ...authored,
  items: authored.items.map((i) =>
    i.id !== "cut"
      ? i
      : {
          ...i,
          fields: {
            ...i.fields,
            section: {
              k: "cut" as const,
              shape: "transverse" as const,
              pos: "0.00005 +- 0.0001",
              unit: "m",
            },
          },
        },
  ),
};
const edgePlan = planWeightBook(cutBook, metrics),
  edgeResult = finishWeightBook(cutBook, metrics, edgePlan, [available(edge)]);
assert.match(resultAt(edgeResult.results, "cut", "area")!.error!, /derivative/);
// Plain weight/automatic role outputs and manual GZ remain independent of a broken cut.
near(outputResult(edgeResult.results, "DISPLACEMENT")!.reading!.v, 280);
const exactBook = {
  ...cutBook,
  items: cutBook.items.map((i) =>
    i.id !== "cut"
      ? i
      : {
          ...i,
          fields: {
            ...i.fields,
            section: {
              k: "cut" as const,
              shape: "transverse" as const,
              pos: "0.00005",
              unit: "m",
            },
          },
        },
  ),
};
near(
  resultAt(
    finishWeightBook(exactBook, metrics, planWeightBook(exactBook, metrics), [
      available(edge),
    ]).results,
    "cut",
    "area",
  )!.reading!.v,
  4,
);
const rejected = finishWeightBook(authored, metrics, plan, [answers[2]]);
assert.match(
  resultAt(rejected.results, "cut", "area")!.error!,
  /authored Camber stations/,
);

// Inclined and constructed vertical planes use the SAME section API and explicit
// motion units. No special backend method and no affine point transform of normals.
const motion = {
  kind: "rotation" as const,
  reference: weightPlane(mapping, "x", 2),
  pivot: [2, 0, 1] as Vec3,
  axis: [0, 1, 0] as Vec3,
};
const inclined = planeAt(motion, 0.2);
near(
  value(
    value(
      (await hull.section({ plane: inclined, envelope: "buoyancy" })).result,
    ).measurements.area,
  ),
  4 / Math.cos(0.2),
);
const rotation = value(
  await measurePlaneFamily(
    hull,
    (t) => planeAt(motion, t),
    0.2,
    mapping,
    ["skin"],
    1e-5,
  ),
);
near(rotation.derivative.area, (4 * Math.sin(0.2)) / Math.cos(0.2) ** 2, 1e-6);
const vertical = verticalPlaneThroughLine([1, -1, 0], [3, 1, 0], [0, 0, 1]);
near(
  value(
    value(
      (await hull.section({ plane: vertical, envelope: "buoyancy" })).result,
    ).measurements.area,
  ),
  4 * Math.SQRT2,
);
assert.throws(
  () => verticalPlaneThroughLine([0, 0, 0], [0, 0, 1], [0, 0, 1]),
  /unique/,
);
assert.throws(() => planeAt({ ...motion, axis: [0, 2, 0] }, 0), /unit/);

const openBytes = binary(boxSoup(4, 2, 2, true));
assert.throws(
  () =>
    importAnalysisStl(openBytes, { physical: METRE_SETUP, analysis: setup }),
  /open|boundary|closed/i,
);
const closed = importAnalysisStl(openBytes, {
  physical: METRE_SETUP,
  analysis: setup,
  surfaceByTriangle: surfaceByTriangle.slice(0, 10),
  deckClosure: { accepted: true, closureId: "confirmed-deck" },
});
assert.ok(closed.sources.some((s) => s.kind === "synthetic"));
const openHull = createMeshAnalysis(closed, { ...setup, id: "open-deck" }),
  openMetrics = value((await openHull.measurements()).result);
near(openMetrics.hullVol, 16);
near(openMetrics.shellArea, 28);
const openTables = value((await openHull.stability()).result);
assert.equal(openTables.availability!.sheer.status, "available");
assert.equal(openTables.availability!.downflooding.status, "unavailable");
assert.ok(openTables.assumptions!.some((s) => s.includes("hypothetical")));
const dry = createMeshAnalysis(mesh, {
  ...setup,
  id: "dry",
  referenceWaterlineZ: -1,
});
near(value((await dry.measurements()).result).shellArea, 28);
assert.ok(value((await dry.stability()).result).hydro === null);
const display = value((await hull.displayGeometry()).result);
assert.equal(display.positions.length, mesh.faces.length * 9);
assert.equal(display.sources.length, mesh.faces.length);
const projection = value(
  (
    await hull.project({
      view: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1] },
    })
  ).result,
);
assert.ok(
  projection.coverage.some((poly) => containsPoint(poly, [1.37, 0.78])),
);
assert.ok(
  !projection.coverage.some((poly) => containsPoint(poly, [4.5, 0.78])),
);
assert.equal(
  (
    await hull.project({
      view: { origin: [0, 0, 0], u: [1, 0, 0], v: [1, 0, 0] },
    })
  ).result.status,
  "unavailable",
);
// An unavailable shell point is not fabricated as y=0 at the formula boundary.
const checkY = {
  ...emptyBook(),
  items: [
    {
      id: "p",
      name: "P",
      note: "",
      facets: {},
      fields: {
        cg: {
          k: "point" as const,
          unit: "m",
          x: "",
          y: "HULL.SHELL_CG.y",
          z: "",
          from: "",
          role: null,
        },
      },
    },
  ],
};
assert.match(
  resultAt(evaluateBook(checkY, noScope), "p", "cg", "y")!.error!,
  /Confirm/,
);
console.log(
  "  ok: STL shell scope/CG, frame and trim, cuts/motion/uncertainty, book codec/link, local diagnostics, generic previews and confirmed open deck",
);
