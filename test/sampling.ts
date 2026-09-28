import assert from "node:assert/strict";
import {
  compareSampling,
  sampleStatistics,
  seededRandom,
} from "./compare-sampling";
import {
  evaluateBook,
  evaluatePreparedBook,
  prepareBook,
} from "../src/core/sheet/evaluate";
import { comparisonFixtures, formulaBook, target } from "./sampling-fixtures";

const near = (a: number, b: number, tolerance = 1e-10) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const compare = (
  formulas: Parameters<typeof formulaBook>[0],
  targets = ["result"],
  samples = 2048,
) =>
  compareSampling(formulaBook(formulas), {
    samples,
    seed: 12345,
    targets: targets.map(target),
  });

// Independent mutable state, shared parse trees; wrapper behaviour is unchanged.
const book = formulaBook({ x: "10 ± 2", result: "x * x" });
const prepared = prepareBook(book);
const nominal = evaluatePreparedBook(prepared, null);
assert.deepEqual(nominal, evaluateBook(book, null));
const source = [...nominal.sources.keys()][0];
const drawn = evaluatePreparedBook(prepared, null, undefined, undefined, {
  inputOffsets: new Map([[source, 1]]),
});
assert.equal(drawn.cells.get(target("result"))!.quantity!.v, 121);
assert.deepEqual(drawn.cells.get(target("result"))!.quantity!.d, {});
assert.deepEqual(evaluatePreparedBook(prepared, null), nominal);
assert.equal(
  drawn.cells.get(target("x"))!.tree,
  nominal.cells.get(target("x"))!.tree,
);
assert.match(
  evaluatePreparedBook(prepared, null, undefined, undefined, {
    inputOffsets: new Map(),
  }).cells.get(target("x"))!.error!,
  /Missing/,
);

const shared = compare({ x: "10 ± 2", result: "x - x", affine: "3 * x + 5" }, [
  "result",
  "affine",
]);
assert.equal(shared.sourceCount, 1);
assert.equal(shared.targets[0].direct!.standardDeviation, 0);
assert.equal(shared.targets[0].direct!.mean, 0);
near(shared.targets[1].difference!.rmsFromNominal, 0);
assert.equal(compare({ result: "(10 ± 2) - (10 ± 2)" }).sourceCount, 2);
assert.ok(
  compare({ result: "(10 ± 2) - (10 ± 2)" }).targets[0].direct!
    .standardDeviation > 1,
);

const units = compare({
  x: { formula: "100 ± 10", unit: "cm" },
  result: { formula: "2 * x", unit: "m" },
});
near(units.targets[0].nominal, 2);
near(units.targets[0].difference!.rmsFromNominal, 0);
near(units.targets[0].direct!.standardDeviation, 0.2 / Math.sqrt(3), 0.008);
const asymmetric = compare({ result: "10 ± [0, 4]" });
near(asymmetric.targets[0].direct!.mean, 12, 0.08);
assert.ok(
  asymmetric.targets[0].direct!.rmsFromNominal >
    asymmetric.targets[0].direct!.standardDeviation,
);

const nonlinear = compare({ x: "0 ± 1", result: "x * x" });
near(nonlinear.targets[0].direct!.mean, 1 / 3, 0.025);
assert.equal(nonlinear.targets[0].linear!.standardDeviation, 0);
assert.ok(nonlinear.targets[0].difference!.rmsFromNominal > 0.4);
const branch = compare({ x: "0 ± 1", result: "abs(x)" });
near(branch.targets[0].direct!.mean, 0.5, 0.025);
near(branch.targets[0].linear!.mean, 0, 0.04);
const invalid = compare({ x: "0.25 ± 1", result: "sqrt(x)" }, ["x", "result"]);
assert.equal(invalid.targets[0].invalid, 0);
assert.ok(invalid.targets[1].invalid > 500);
assert.equal(invalid.targets[1].valid + invalid.targets[1].invalid, 2048);
assert.equal(
  invalid.targets[1].direct!.count,
  invalid.targets[1].linear!.count,
);
assert.ok(
  Object.keys(invalid.targets[1].failures).some((s) =>
    s.includes("square root"),
  ),
);
const overflow = compare({ x: "700 ± 100", result: "exp(x)" });
assert.ok(overflow.targets[0].invalid > 0);
assert.ok(
  Object.keys(overflow.targets[0].failures).includes("non-finite value"),
);

assert.throws(
  () => compare({ x: { formula: "2", unit: "m" }, result: "x ^ (2 ± 1)" }),
  /Invalid nominal/,
);
assert.throws(() => compare({ result: "missing" }), /Invalid nominal/);
assert.throws(() => compare({ result: "1" }, ["missing"]), /Missing target/);
assert.throws(() => compare({ result: "1" }, ["result"], 0), /samples/);
assert.equal(compare({ result: "42" }).targets[0].direct!.standardDeviation, 0);
assert.equal(sampleStatistics([], 0), null);
assert.deepEqual(sampleStatistics([3], 1), {
  count: 1,
  mean: 3,
  standardDeviation: 0,
  rmsFromNominal: 2,
  p025: 3,
  median: 3,
  p975: 3,
});

// Sampling order is independent of formula traversal / target order.
const reordered = compare(
  { affine: "3 * x + 5", result: "x - x", x: "10 ± 2" },
  ["affine", "result"],
);
assert.deepEqual(reordered.targets[0], shared.targets[1]);
assert.deepEqual(
  compare({ x: "10 ± 2", result: "x - x", affine: "3 * x + 5" }, [
    "result",
    "affine",
  ]).targets,
  shared.targets,
);
const r1 = seededRandom(0),
  r2 = seededRandom(0);
for (let i = 0; i < 100; i++) {
  const x = r1();
  assert.equal(x, r2());
  assert.ok(x >= 0 && x < 1);
}

for (const fixture of comparisonFixtures()) {
  const result = compareSampling(fixture.book, {
    targets: fixture.targets,
    samples: 32,
    seed: 42,
  });
  assert.equal(result.targets.length, fixture.targets.length);
}
// Cross-item references and authored outputs use exactly the same trial.
const outputBook = {
  ...book,
  outputs: { DISPLACEMENT: "Experiment.result" },
  items: [
    ...book.items,
    {
      id: "i1",
      name: "Copy",
      note: "",
      facets: {},
      fields: {
        value: {
          k: "scalar" as const,
          formula: "Experiment.x - Experiment.x",
          unit: "",
          role: null,
        },
      },
    },
  ],
};
const outputComparison = compareSampling(outputBook, {
  samples: 64,
  seed: 1,
  targets: [target("result"), "OUT DISPLACEMENT formula", "i1 value formula"],
});
assert.deepEqual(
  outputComparison.targets[0].direct,
  outputComparison.targets[1].direct,
);
assert.equal(outputComparison.targets[2].direct!.standardDeviation, 0);
assert.throws(
  () =>
    compareSampling(
      {
        ...book,
        items: [
          {
            ...book.items[0],
            fields: {
              cut: { k: "cut", shape: "plane", unit: "m", pos: "1" },
            },
          },
        ],
      },
      { samples: 1, seed: 1, targets: [] },
    ),
  /cuts and repetitions/,
);
assert.ok(Number.isFinite(overflow.targets[0].direct!.standardDeviation));
console.log("Sampling comparison tests passed");
