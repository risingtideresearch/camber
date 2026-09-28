import assert from "node:assert/strict";
import { type PointField, type WeightBook } from "../src/core/sheet/book";
import {
  cellKey,
  evaluatePreparedBook,
  prepareBook,
} from "../src/core/sheet/evaluate";
import {
  cellNodeId,
  geometryNodeId,
  HULL_NODE,
  phaseNodeId,
} from "../src/core/sheet/dependencyGraph";
import { formulaBook, target } from "./sampling-fixtures";
import { mixedTrialBook } from "./trial-fixtures";

const point = (
  x: string,
  from = "",
  role: string | null = null,
): PointField => ({
  k: "point",
  x,
  y: "2",
  z: "3",
  from,
  unit: "m",
  role,
});
const base = formulaBook({
  mass: { formula: "10", unit: "kg" },
  scalar: "place",
  explicit: "place.z",
});
const book: WeightBook = {
  ...base,
  items: [
    {
      ...base.items[0],
      facets: { system: "crew" },
      fields: {
        ...base.items[0].fields,
        mass: { k: "scalar", formula: "10", unit: "kg", role: "MASS" },
        place: point("1", "", "CG"),
        implicit: point("", "CG"),
        hull: point("", "HULL.SHELL_CG"),
      },
    },
    {
      id: "i1",
      name: "Second",
      note: "",
      facets: { system: "crew/watch" },
      fields: {
        weight: { k: "scalar", formula: "30", unit: "kg", role: "MASS" },
        location: point("5", "", "CG"),
      },
    },
    {
      id: "report",
      name: "Report",
      note: "",
      facets: {},
      fields: {
        total: {
          k: "scalar",
          formula: "ROLLUP.crew.MASS",
          unit: "kg",
          role: null,
        },
        cg: point("", "ROLLUP.crew.CG"),
        badAxis: point("", "ROLLUP.crew.CG.MASS"),
      },
    },
  ],
  outputs: { DISPLACEMENT: "Report.total", VCG: "Report.cg.z", LCG: "" },
  rollups: [{ id: "r0", name: "crew", facetKey: "system", facetValue: "crew" }],
};
const prepared = prepareBook(book);
const op = (item: string, field: string, leaf = "formula") =>
  prepared.cells.get(cellKey(item, field, leaf))!.operations.get(0)!;
const dependencies = (key: string) =>
  prepared.graph.dependencies.get(cellNodeId(key))!;
for (const axis of ["x", "y", "z"]) {
  assert.deepEqual(op("i0", "implicit", axis), {
    k: "cell",
    itemId: "i0",
    fieldKey: "place",
    leaf: axis,
  });
  assert.deepEqual(op("i0", "hull", axis), {
    k: "hull",
    path: ["SHELL_CG", axis],
  });
  assert.deepEqual(
    dependencies(cellKey("i0", "implicit", axis)),
    new Set([cellNodeId(cellKey("i0", "place", axis))]),
  );
}
assert.equal(op("i0", "scalar").k, "error", "a bare point is not a scalar");
assert.deepEqual(op("i0", "explicit"), {
  k: "cell",
  itemId: "i0",
  fieldKey: "place",
  leaf: "z",
});
assert.deepEqual(
  dependencies(cellKey("OUT", "DISPLACEMENT")),
  new Set([cellNodeId(cellKey("report", "total"))]),
);
assert.equal(op("report", "badAxis", "x").k, "error");
const sum = op("report", "total");
assert.equal(sum.k, "sum");
if (sum.k === "sum")
  assert.deepEqual(sum.terms, [
    { k: "cell", itemId: "i0", fieldKey: "mass", leaf: "formula" },
    { k: "cell", itemId: "i1", fieldKey: "weight", leaf: "formula" },
  ]);
const aggregateId = [...dependencies(cellKey("report", "cg", "x"))][0];
assert.equal(prepared.graph.nodes.get(aggregateId)!.k, "aggregate");
assert.deepEqual(
  prepared.graph.dependencies.get(aggregateId),
  new Set([
    cellNodeId(target("mass")),
    cellNodeId(cellKey("i0", "place", "x")),
    cellNodeId(cellKey("i1", "weight")),
    cellNodeId(cellKey("i1", "location", "x")),
  ]),
);
const results = evaluatePreparedBook(prepared, null);
assert.equal(results.cells.get(cellKey("report", "total"))!.quantity!.v, 40);
assert.equal(results.cells.get(cellKey("report", "cg", "x"))!.quantity!.v, 4);
assert.equal(results.cells.get(cellKey("report", "cg", "z"))!.quantity!.v, 3);
assert.match(
  results.cells.get(cellKey("report", "badAxis", "x"))!.error!,
  /has no MASS/,
);

// Refiling changes the compiled contributors, without changing the old plan.
const refiled = prepareBook({
  ...book,
  items: book.items.map((item) =>
    item.id === "i1" ? { ...item, facets: { system: "equipment" } } : item,
  ),
});
const refiledResults = evaluatePreparedBook(refiled, null);
assert.equal(
  refiledResults.cells.get(cellKey("report", "total"))!.quantity!.v,
  10,
);
assert.equal(
  refiledResults.cells.get(cellKey("report", "cg", "x"))!.quantity!.v,
  1,
);
assert.equal(
  evaluatePreparedBook(prepared, null).cells.get(cellKey("report", "total"))!
    .quantity!.v,
  40,
);

// Geometry projections share one operation, with active input cells and external
// world dependencies. Equivalent count has no layout/phase/hull dependency.
const mixed = mixedTrialBook();
const geometryBook: WeightBook = {
  ...mixed,
  items: [
    {
      ...mixed.items[0],
      fields: {
        ...mixed.items[0].fields,
        cut: {
          ...mixed.items[0].fields.cut,
          bottomHeight: "missing",
          boundaryEnabled: { topHeight: true, bottomHeight: false },
        },
        position: point("", "cut"),
        perimeter: {
          k: "scalar",
          formula: "cut.openPerimeter",
          unit: "m",
          role: null,
        },
      },
    },
  ],
};
const geometryPlan = prepareBook(geometryBook);
const cutArea = geometryPlan.cells.get(
  cellKey("i0", "cut", "area"),
)!.measurement!;
const cutCg = geometryPlan.cells.get(
  cellKey("i0", "cut", "areaCg.x"),
)!.measurement!;
assert.equal(cutArea.geometry, cutCg.geometry);
assert.deepEqual(
  cutArea.geometry.inputs.map((input) => input.leaf),
  ["pos", "topHeight"],
);
const perimeter = geometryPlan.cells
  .get(target("perimeter"))!
  .operations.get(0)!;
assert.equal(perimeter.k, "measure");
if (perimeter.k === "measure") {
  assert.equal(perimeter.leaf, "openLength");
  assert.equal(perimeter.geometry, cutArea.geometry);
}
for (const axis of ["x", "y", "z"]) {
  const operation = geometryPlan.cells
    .get(cellKey("i0", "position", axis))!
    .operations.get(0)!;
  assert.equal(operation.k, "measure");
  if (operation.k === "measure") assert.equal(operation.leaf, `areaCg.${axis}`);
}
const graph = geometryPlan.graph;
assert.deepEqual(
  graph.dependencies.get(geometryNodeId("i0", "cut")),
  new Set([
    cellNodeId(cellKey("i0", "cut", "pos")),
    cellNodeId(cellKey("i0", "cut", "topHeight")),
    HULL_NODE,
  ]),
);
assert.deepEqual(
  graph.dependencies.get(cellNodeId(target("cutMass"))),
  new Set([
    cellNodeId(cellKey("i0", "cut", "area")),
    cellNodeId(target("density")),
  ]),
);
assert.deepEqual(
  graph.dependencies.get(cellNodeId(cellKey("i0", "cut", "area"))),
  new Set([geometryNodeId("i0", "cut")]),
);
assert.ok(
  graph.dependencies
    .get(geometryNodeId("i0", "first"))!
    .has(phaseNodeId("i0", "first")),
);
assert.deepEqual(
  graph.dependencies.get(cellNodeId(cellKey("i0", "first", "equivalentCount"))),
  new Set(
    ["start", "end", "spacing", "topHeight"].map((leaf) =>
      cellNodeId(cellKey("i0", "first", leaf)),
    ),
  ),
);
assert.equal(
  graph.nodes.has(cellNodeId(cellKey("i0", "cut", "bottomHeight"))),
  false,
);
for (const plan of [prepared, refiled, geometryPlan]) {
  for (const [id, inputs] of plan.graph.dependencies) {
    assert.ok(plan.graph.nodes.has(id));
    for (const input of inputs) {
      assert.ok(plan.graph.nodes.has(input));
      assert.ok(plan.graph.dependents.get(input)!.has(id), `${input} → ${id}`);
    }
  }
  for (const [id, consumers] of plan.graph.dependents)
    for (const consumer of consumers)
      assert.ok(plan.graph.dependencies.get(consumer)!.has(id));
}

// Invalid/cyclic authoring produces an inspectable graph, not a failed plan.
const cycle = prepareBook(
  formulaBook({ a: "b", b: "a", good: "2", unknown: "missing" }),
);
assert.deepEqual(
  cycle.graph.dependencies.get(cellNodeId(target("a"))),
  new Set([cellNodeId(target("b"))]),
);
assert.deepEqual(
  cycle.graph.dependencies.get(cellNodeId(target("b"))),
  new Set([cellNodeId(target("a"))]),
);
assert.equal(
  cycle.graph.dependencies.get(cellNodeId(target("unknown")))!.size,
  0,
);
assert.equal(
  evaluatePreparedBook(cycle, null).cells.get(target("good"))!.quantity!.v,
  2,
);

// Forbidden geometry chaining is explicit in the graph but remains a runtime
// authoring error. Building the plan does not silently enable this language change.
const chained = prepareBook({
  ...geometryBook,
  items: [
    {
      ...geometryBook.items[0],
      fields: {
        ...geometryBook.items[0].fields,
        dependent: { ...mixed.items[0].fields.cut, pos: "cut.areaCg.x" },
      },
    },
  ],
});
assert.deepEqual(
  chained.graph.dependencies.get(cellNodeId(cellKey("i0", "dependent", "pos"))),
  new Set([cellNodeId(cellKey("i0", "cut", "areaCg.x"))]),
);
assert.match(
  evaluatePreparedBook(chained, null).cells.get(
    cellKey("i0", "dependent", "pos"),
  )!.error!,
  /cannot depend on measured/,
);

// An early runtime contributor error must still win over a later missing CG.
const invalid = prepareBook({
  ...book,
  items: book.items.map((item) =>
    item.id === "i0"
      ? {
          ...item,
          fields: {
            ...item.fields,
            mass: {
              k: "scalar" as const,
              formula: "1 / 0",
              unit: "kg",
              role: "MASS",
            },
          },
        }
      : item.id === "i1"
        ? { ...item, fields: { weight: item.fields.weight } }
        : item,
  ),
});
assert.match(
  evaluatePreparedBook(invalid, null).cells.get(cellKey("report", "cg", "x"))!
    .error!,
  /Experiment.mass could not be worked out/,
);
console.log(
  "Compiled operations: coordinates, aliases, aggregates, geometry edges, reverse dependencies and cycles passed",
);
