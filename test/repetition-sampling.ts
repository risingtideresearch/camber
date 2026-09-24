import assert from "node:assert/strict";
import {
  measureRepetition,
  measureRepetitionLayout,
} from "../src/core/sheet/repetitions";
import { geometryValue } from "../src/core/sheet/sectionMeasures";
import {
  cellKey,
  evaluatePreparedBook,
  prepareBook,
} from "../src/core/sheet/evaluate";
import { sliceMeasurementKey } from "../src/core/sheet/slices";
import { compareRepetitionSampling } from "./compare-repetition-sampling";
import {
  repetitionBook,
  repetitionComparisonFixtures,
  repetitionTargets,
  syntheticSection,
} from "./repetition-sampling-fixtures";
import { target } from "./sampling-fixtures";
import { weightedSampleStatistics } from "./weighted-sampling-statistics";
const near = (a: number, b: number, tol = 1e-10) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

const options = {
  shape: "transverse" as const,
  start: 0,
  end: 2,
  pitch: 1,
  phase: 0.25,
};
const positions: number[] = [];
const layout = measureRepetitionLayout(
  (_shape, pos, limits) => {
    positions.push(pos);
    assert.equal(limits?.topHeight, 3);
    return syntheticSection(1 + pos, pos);
  },
  { ...options, limits: { topHeight: 3 } },
);
assert.deepEqual(positions, [0.25, 1.25]);
assert.equal(layout.count, 2);
near(layout.measures.area.amount, 3.5);
near(layout.measures.area.moment[0], 3.125);
near(geometryValue(layout.measures, "areaCg.x"), 3.125 / 3.5);
const constant = (_shape: unknown, pos: number) => syntheticSection(2, pos);
const atStart = measureRepetitionLayout(constant, { ...options, phase: 0 });
assert.equal(atStart.count, 2);
near(atStart.measures.area.moment[0], 2); // [0, 1], not the end at 2
const fractional = { ...options, end: 2.25 };
assert.equal(
  measureRepetitionLayout(constant, { ...fractional, phase: 0.249 }).count,
  3,
);
assert.equal(
  measureRepetitionLayout(constant, { ...fractional, phase: 0.25 }).count,
  2,
);
const empty = measureRepetitionLayout(constant, {
  ...options,
  end: 0.5,
  phase: 0.75,
});
assert.equal(empty.count, 0);
assert.equal(empty.measures.area.amount, 0);
assert.throws(() => geometryValue(empty.measures, "areaCg.x"), /undefined/);
for (const bad of [
  { pitch: 0 },
  { pitch: Infinity },
  { phase: -0.1 },
  { phase: 1 },
  { phase: NaN },
  { end: 0 },
  { maxMembers: 1 },
  { maxMembers: -1 },
])
  assert.throws(() =>
    measureRepetitionLayout(constant, { ...options, ...bad }),
  );
assert.throws(
  () =>
    measureRepetitionLayout(() => {
      throw new Error("bad contour");
    }, options),
  /bad contour/,
);

// Layout totals enter the evaluator without a second density factor or placement allowance.
const book = repetitionBook(0, 2, 2),
  prepared = prepareBook(book);
const geometryKey = sliceMeasurementKey("i0", "members");
const direct = evaluatePreparedBook(prepared, null, undefined, undefined, {
  repetitionLayouts: new Map([[geometryKey, layout]]),
});
near(direct.cells.get(target("amount"))!.quantity!.v, 3.5);
near(direct.cells.get(target("moment"))!.quantity!.v, 3.125);
assert.equal(direct.sources.size, 0);
assert.deepEqual(direct.cells.get(target("cg"))!.quantity!.d, {});
const emptyResult = evaluatePreparedBook(prepared, null, undefined, undefined, {
  repetitionLayouts: new Map([[geometryKey, empty]]),
});
assert.equal(emptyResult.cells.get(target("amount"))!.quantity!.v, 0);
assert.equal(emptyResult.cells.get(target("loadedCg"))!.quantity!.v, 0);
assert.match(emptyResult.cells.get(target("cg"))!.error!, /undefined/);

// Non-unit pitch: totals must not be multiplied by repetition density again.
const denseBook = repetitionBook(0, 2, 4);
const denseLayout = measureRepetitionLayout(constant, {
  ...options,
  pitch: 0.5,
});
const denseResult = evaluatePreparedBook(
  prepareBook(denseBook),
  null,
  undefined,
  undefined,
  {
    repetitionLayouts: new Map([[geometryKey, denseLayout]]),
  },
);
near(denseResult.cells.get(target("amount"))!.quantity!.v, 8);
// Spacing and equivalent-count modes describe the same realized grid.
const denseMembers = denseBook.items[0].fields.members;
assert.equal(denseMembers.k, "repetition");
if (denseMembers.k !== "repetition") throw new Error("missing repetition");
const spacingBook = {
  ...denseBook,
  items: [
    {
      ...denseBook.items[0],
      fields: {
        ...denseBook.items[0].fields,
        members: {
          ...denseMembers,
          repetition: "spacing" as const,
          spacing: "0.5",
        },
      },
    },
  ],
};
const spacingReport = compareRepetitionSampling(spacingBook, constant, {
  samples: 32,
  seed: 1,
  targets: repetitionTargets,
});
const countReport = compareRepetitionSampling(denseBook, constant, {
  samples: 32,
  seed: 1,
  targets: repetitionTargets,
});
assert.deepEqual(
  spacingReport.targets.map(({ direct, linear }) => ({ direct, linear })),
  countReport.targets.map(({ direct, linear }) => ({ direct, linear })),
);

// Verify the paired linear oracle against a hand-derived centroid expansion.
const varying = (_shape: unknown, pos: number) =>
  syntheticSection(1 + pos, pos);
const integrated = measureRepetition(varying, "transverse", 0, 2);
assert.ok(integrated.value);
const linear = evaluatePreparedBook(
  prepared,
  null,
  undefined,
  new Map([
    [
      geometryKey,
      {
        value: {
          ...integrated.value,
          phaseTotals: [{ measures: layout.measures, weight: 1 }],
        },
      },
    ],
  ]),
);
const q = linear.cells.get(target("cg"))!.quantity!;
const expectedDelta =
  (layout.measures.area.moment[0] - q.v * layout.measures.area.amount) /
  integrated.value.integrals.area.amount;
near(
  Object.values(q.d).reduce((a, b) => a + b, 0),
  expectedDelta,
);
const moment = linear.cells.get(target("moment"))!.quantity!;
near(
  moment.v + Object.values(moment.d).reduce((a, b) => a + b, 0),
  layout.measures.area.moment[0],
);
assert.ok(linear.sources.size > 0);

const fixtures = repetitionComparisonFixtures();
const reports = fixtures.map(({ book, measure, targets }) =>
  compareRepetitionSampling(book, measure, {
    samples: 256,
    seed: 12345,
    targets,
  }),
);
for (const report of reports) {
  near(report.targets[0].difference!.rmsFromNominal, 0);
  near(report.targets[2].difference!.rmsFromNominal, 0);
  assert.equal(
    report.geometryCalls.sampledLayouts,
    Math.round(report.layoutCounts!.mean * 256),
  );
}
near(reports[0].targets[1].difference!.rmsFromNominal, 0);
assert.ok(
  reports[2].targets[1].difference!.rmsFromNominal >
    reports[1].targets[1].difference!.rmsFromNominal * 5,
);
assert.ok(
  reports[2].targets[1].direct!.mean <
    reports[2].targets[1].linear!.mean - 0.08,
);
const sparse = reports[3];
assert.equal(sparse.targets[0].invalid, 0);
assert.ok(sparse.targets[1].invalid > 80);
assert.equal(sparse.targets[3].invalid, 0);
assert.match(sparse.targets[1].current.error!, /empty sampled layout/);
assert.equal(sparse.targets[1].valid + sparse.targets[1].invalid, 256);
assert.equal(sparse.targets[1].direct!.count, sparse.targets[1].linear!.count);
assert.ok(reports[4].targets[1].difference!.rmsFromNominal < 0.01);
const repeat = compareRepetitionSampling(
  fixtures[2].book,
  fixtures[2].measure,
  { samples: 256, seed: 12345, targets: repetitionTargets },
);
assert.deepEqual(repeat.targets, reports[2].targets);
// Exact authored input restriction is explicit, including otherwise unrelated formulas.
const uncertainBook = {
  ...book,
  items: [
    {
      ...book.items[0],
      fields: {
        ...book.items[0].fields,
        guess: {
          k: "scalar" as const,
          role: null,
          unit: "",
          formula: "1 ± 0.1",
        },
      },
    },
  ],
};
assert.throws(
  () =>
    compareRepetitionSampling(uncertainBook, varying, {
      samples: 1,
      seed: 1,
      targets: [cellKey("i0", "amount")],
    }),
  /exact authored inputs/,
);
// A geometry failure does not suppress independent targets in that world.
let calls = 0;
const failures = compareRepetitionSampling(
  repetitionBook(0, 4, 4),
  (_shape, pos) => {
    if (++calls > 300) throw new Error("broken section");
    return syntheticSection(2, pos);
  },
  { samples: 64, seed: 12345, targets: [target("amount"), target("height")] },
);
assert.ok(failures.targets[0].invalid > 0);
assert.equal(failures.targets[1].invalid, 0);
// Weighted moments use probability mass, not the number of phase points.
const weighted = weightedSampleStatistics([0, 10], [0.9, 0.1], 0)!;
near(weighted.mean, 1);
near(weighted.standardDeviation, 3);
near(weighted.rmsFromNominal, Math.sqrt(10));
assert.equal(weighted.median, 0);
assert.equal(weighted.p975, 10);
near(weightedSampleStatistics([0, 10], [9, 1], 0)!.mean, weighted.mean);
assert.equal(weightedSampleStatistics([], [], 0), null);
assert.equal(weightedSampleStatistics([1], [0], 0), null);
assert.throws(() => weightedSampleStatistics([1], [], 0), /equal lengths/);
assert.throws(() => weightedSampleStatistics([1], [-1], 0), /non-negative/);
assert.throws(() => weightedSampleStatistics([Infinity], [1], 0), /finite/);
near(
  weightedSampleStatistics([1e200, 3e200], [1, 1], 0)!.standardDeviation /
    1e200,
  1,
);

const existingReports = fixtures.map(({ book, measure, targets }) =>
  compareRepetitionSampling(book, measure, { mode: "existing", targets }),
);
for (const report of existingReports) {
  assert.equal(report.geometryCalls.sampledLayouts, 0);
  assert.equal(report.seed, null);
  assert.equal(report.layoutCounts, null); // old phase totals contain measures, not grid counts
  near(report.targets[0].difference!.rmsFromNominal, 0);
  for (const t of report.targets) {
    near(t.validProbability + t.invalidProbability, 1);
    if (t.current.reading && !t.current.error)
      near(t.linear!.rmsFromNominal, t.current.reading.likely.hi);
  }
}
near(existingReports[0].targets[1].direct!.mean, 2);
near(existingReports[0].targets[1].difference!.rmsFromNominal, 0);
assert.ok(
  existingReports[2].targets[1].direct!.mean <
    existingReports[2].targets[1].linear!.mean - 0.1,
);
near(existingReports[3].targets[1].invalidProbability, 0.4);
near(existingReports[3].targets[1].direct!.mean, 0.5);
assert.equal(existingReports[3].targets[0].invalidProbability, 0);
assert.equal(existingReports[3].targets[3].invalidProbability, 0);
// A rare extra member cannot disappear or become 50% probable just because
// the two phase strata use the same number of quadrature points.
const rare = compareRepetitionSampling(repetitionBook(0, 1, 0.001), constant, {
  mode: "existing",
  targets: [target("amount"), target("cg")],
});
near(rare.targets[0].direct!.mean, 0.002);
near(rare.targets[1].validProbability, 0.001);
near(rare.targets[1].invalidProbability, 0.999);
assert.equal(rare.targets[1].valid, rare.targets[1].invalid);
near(rare.targets[1].direct!.mean, 0.5);
assert.throws(
  () =>
    compareRepetitionSampling(repetitionBook(0, 1, 10000), constant, {
      mode: "existing",
      targets: [target("amount")],
    }),
  /Existing phase layouts unavailable/,
);
// Independent random draws validate the weighted nonlinear estimate on a
// strongly varying profile (bounds account for MC noise, not exact equality).
const reference = compareRepetitionSampling(
  fixtures[2].book,
  fixtures[2].measure,
  {
    samples: 8192,
    seed: 12345,
    targets: repetitionTargets,
  },
);
near(
  existingReports[2].targets[1].direct!.mean,
  reference.targets[1].direct!.mean,
  0.015,
);
near(
  existingReports[2].targets[1].direct!.standardDeviation,
  reference.targets[1].direct!.standardDeviation,
  0.015,
);

console.log(
  "Repetition layout, weighted phases and paired sampling tests passed",
);
