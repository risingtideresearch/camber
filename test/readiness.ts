import assert from "node:assert/strict";
import {
  emptyBook,
  type PointField,
  type ScalarField,
  type WeightBook,
} from "../src/core/sheet/book";
import {
  cellKey,
  createPreparedBookEvaluator,
  evaluatePreparedBook,
  prepareBook,
} from "../src/core/sheet/evaluate";
import {
  affectedCells,
  affectedNodes,
  requiredNodes,
  cellNodeId,
  geometryNodeId,
  HULL_NODE,
  phaseNodeId,
} from "../src/core/sheet/dependencyGraph";
import type { SliceMeasurement } from "../src/core/sheet/slices";
import type { RepetitionResult } from "../src/core/sheet/repetitions";
import { GEOMETRY_LEAVES } from "../src/core/sheet/sectionMeasures";
import { roleTotals } from "../src/core/sheet/rollups";
import { plotPoints } from "../src/editor/weight/pointPlots";
import { showSpread } from "../src/editor/weight/weightFormat";
import { syntheticSection } from "./repetition-sampling-fixtures";
import { formulaBook, target } from "./sampling-fixtures";

const scalar = (
  formula: string,
  unit: string,
  role: string | null = null,
): ScalarField => ({ k: "scalar", formula, unit, role });
const point = (x: string): PointField => ({
  k: "point",
  x,
  y: "2 ± 0.2",
  z: "3 ± 0.3",
  from: "",
  unit: "m",
  role: "CG",
});
const book: WeightBook = {
  ...emptyBook(),
  outputs: {
    DISPLACEMENT: "geometry.cutWeight",
    LCG: "plain.cg.x",
    VCG: "geometry.cg.z",
  },
  rollups: [
    { id: "r", name: "geometry", facetKey: "system", facetValue: "geometry" },
  ],
  items: [
    {
      id: "g",
      name: "geometry",
      note: "",
      facets: { system: "geometry" },
      fields: {
        cut: { k: "cut", shape: "transverse", pos: "1 ± 0.1", unit: "m" },
        readyCut: { k: "cut", shape: "transverse", pos: "2 ± 0.1", unit: "m" },
        rep: {
          k: "repetition",
          shape: "transverse",
          start: "0",
          end: "4",
          repetition: "count",
          count: "4 ± 1",
          spacing: "",
          unit: "m",
        },
        density: scalar("2 ± 0.1", "kg/m^2"),
        mass: scalar("10 ± 1", "kg", "MASS"),
        cutWeight: scalar("cut.area * density", "kg"),
        readyWeight: scalar("readyCut.area * density", "kg"),
        repWeight: scalar("rep.area * density", "kg"),
        cancel: scalar("cut.area - cut.area", "m^2"),
        cg: point("cut.areaCg.x"),
        meanX: scalar("ROLLUP.geometry.CG.x", "m"),
        meanY: scalar("ROLLUP.geometry.CG.y", "m"),
      },
    },
    {
      id: "p",
      name: "plain",
      note: "",
      facets: {},
      fields: {
        mass: scalar("5 ± 1", "kg", "MASS"),
        cg: point("4 ± 0.4"),
      },
    },
    {
      id: "w",
      name: "weighted",
      note: "",
      facets: {},
      fields: {
        mass: scalar("geometry.cutWeight", "kg", "MASS"),
        cg: point("5 ± 0.5"),
      },
    },
  ],
};
const plan = prepareBook(book);
// Simple fixtures isolate readiness from the numerical sensitivity computation.
const section: SliceMeasurement = {
  ...syntheticSection(2, 1),
  derivative: {
    area: 0,
    openPerimeter: 0,
    closedPerimeter: 0,
    x: 0,
    y: 0,
    z: 0,
  },
  geometryDerivative: Object.fromEntries(
    GEOMETRY_LEAVES.map((leaf) => [leaf, 0]),
  ),
};
const slices = new Map([
  ["g cut", { ...section, uncertaintyPending: true }],
  ["g readyCut", section],
]);
const repetition: RepetitionResult = {
  value: {
    uncertaintyPending: true,
    integrals: syntheticSection(8, 2).measures,
    start: section.measures,
    end: section.measures,
  },
};
const repetitions = new Map([["g rep", repetition]]);
const world = createPreparedBookEvaluator(plan, null, slices, repetitions);
const results = world();
const reading = (item: string, field: string, leaf = "formula") => {
  const result = results.cells.get(cellKey(item, field, leaf))!;
  assert.equal(result.error, null, `${item}.${field}.${leaf}: ${result.error}`);
  assert.ok(result.reading);
  return result.reading;
};
assert.equal(results.uncertaintyPending, true);
for (const [item, field, leaf] of [
  ["g", "cutWeight"],
  ["g", "repWeight"],
  ["g", "meanX"],
  ["g", "cancel"],
  ["g", "cg", "x"],
  ["w", "mass"],
])
  assert.equal(reading(item, field, leaf).uncertaintyPending, true);
for (const [item, field, leaf] of [
  ["g", "density"],
  ["g", "mass"],
  ["g", "readyWeight"],
  ["g", "meanY"],
  ["g", "cut", "pos"],
  ["g", "rep", "equivalentCount"],
  ["g", "rep", "count"],
  ["g", "cg", "y"],
  ["g", "cg", "z"],
  ["p", "mass"],
  ["p", "cg", "x"],
])
  assert.equal(reading(item, field, leaf).uncertaintyPending, undefined);
assert.equal(results.outputs.displacement!.uncertaintyPending, true);
assert.equal(results.outputs.lcg!.uncertaintyPending, undefined);
assert.equal(results.outputs.vcg!.uncertaintyPending, undefined);
assert.equal(showSpread(reading("g", "cutWeight"), 1, "worst"), "…");
assert.notEqual(showSpread(reading("p", "mass"), 1, "worst"), "…");
assert.equal(
  reading("g", "cancel").v,
  0,
  "cancellation does not remove a dependency's readiness requirement",
);

// Targeted results summarize only their returned readings, regardless of earlier
// requests against the same retained world.
const independent = world([cellKey("p", "mass")]);
assert.equal(independent.uncertaintyPending, undefined);
assert.equal(world([]).uncertaintyPending, undefined);
assert.equal(world([cellKey("g", "cutWeight")]).uncertaintyPending, true);

// Presentation rollups and plot regions honor the actual contributors/axis pair.
const local = roleTotals([book.items[0]], results);
assert.equal(local.get("MASS")!.readings.value!.uncertaintyPending, undefined);
assert.equal(local.get("CG")!.readings.x!.uncertaintyPending, true);
assert.equal(local.get("CG")!.readings.y!.uncertaintyPending, undefined);
assert.equal(local.get("CG")!.readings.z!.uncertaintyPending, undefined);
const plain = roleTotals([book.items[1]], results);
assert.equal(plain.get("MASS")!.readings.value!.uncertaintyPending, undefined);
assert.equal(plain.get("CG")!.readings.x!.uncertaintyPending, undefined);
const weighted = roleTotals([book.items[2]], results);
for (const axis of ["x", "y", "z"] as const)
  assert.equal(weighted.get("CG")!.readings[axis]!.uncertaintyPending, true);
const plots = plotPoints(book.items, results, "worst");
assert.equal(plots.find((p) => p.itemId === "g")!.xz.length, 0);
assert.ok(plots.find((p) => p.itemId === "g")!.yz.length > 0);
assert.ok(plots.find((p) => p.itemId === "p")!.xz.length > 0);

// Completion uses a fresh immutable world. Pending snapshots remain unchanged.
const completed = evaluatePreparedBook(
  plan,
  null,
  new Map([
    ["g cut", section],
    ["g readyCut", section],
  ]),
  new Map([
    ["g rep", { value: { ...repetition.value!, uncertaintyPending: false } }],
  ]),
);
assert.equal(completed.uncertaintyPending, undefined);
assert.equal(completed.outputs.displacement!.uncertaintyPending, undefined);
assert.equal(results.outputs.displacement!.uncertaintyPending, true);
assert.equal(
  completed.outputs.displacement!.v,
  results.outputs.displacement!.v,
);
// Irrelevant stale measurement entries cannot suppress a book's readings.
assert.equal(
  evaluatePreparedBook(
    prepareBook(formulaBook({ value: "2 ± 1" })),
    null,
    slices,
    repetitions,
  ).uncertaintyPending,
  undefined,
);
// Exact supplied geometry supersedes the pending derivative backend for that cut.
assert.equal(
  evaluatePreparedBook(plan, null, slices, repetitions, {
    targets: [cellKey("g", "cutWeight")],
    cutMeasures: new Map([["g cut", section.measures]]),
  }).uncertaintyPending,
  undefined,
);

// The same graph traversal supplies conservative cache-invalidation impact.
const cutImpact = affectedCells(plan.graph, [geometryNodeId("g", "cut")]);
assert.ok(cutImpact.has(cellKey("g", "cutWeight")));
assert.ok(
  cutImpact.has(cellKey("g", "meanX")),
  "propagates through aggregate nodes",
);
assert.ok(cutImpact.has(cellKey("OUT", "DISPLACEMENT")));
assert.ok(!cutImpact.has(cellKey("g", "cut", "pos")));
assert.ok(!cutImpact.has(cellKey("g", "meanY")));
assert.ok(!cutImpact.has(cellKey("p", "mass")));
const inputs = requiredNodes(plan.graph, [
  cellNodeId(cellKey("OUT", "DISPLACEMENT")),
]);
assert.ok(inputs.has(geometryNodeId("g", "cut")));
assert.ok(inputs.has(HULL_NODE));
assert.ok(inputs.has(cellNodeId(cellKey("g", "cut", "pos"))));
assert.ok(!inputs.has(geometryNodeId("g", "rep")));
const phaseImpact = affectedCells(plan.graph, [phaseNodeId("g", "rep")]);
assert.ok(phaseImpact.has(cellKey("g", "repWeight")));
assert.ok(!phaseImpact.has(cellKey("g", "rep", "equivalentCount")));
const densityImpact = affectedCells(plan.graph, [
  cellNodeId(cellKey("g", "density")),
]);
assert.ok(
  densityImpact.has(cellKey("g", "density")),
  "changed roots are included",
);
assert.ok(densityImpact.has(cellKey("g", "cutWeight")));
assert.ok(
  !densityImpact.has(cellKey("g", "cut", "area")),
  "material changes do not invalidate geometry",
);
assert.equal(affectedNodes(plan.graph, []).size, 0);
assert.throws(
  () => affectedCells(plan.graph, ["unknown"]),
  /Unknown dependency node/,
);
assert.throws(
  () => requiredNodes(plan.graph, ["unknown"]),
  /Unknown dependency node/,
);
const cyclic = prepareBook(formulaBook({ a: "b", b: "a", other: "2" }));
assert.deepEqual(
  affectedCells(cyclic.graph, [cellNodeId(target("a"))]),
  new Set([target("a"), target("b")]),
);
assert.equal(requiredNodes(cyclic.graph, [cellNodeId(target("a"))]).size, 2);
console.log(
  "Dependency-local readiness, scoped rollups/plots and cycle-safe invalidation queries passed",
);
