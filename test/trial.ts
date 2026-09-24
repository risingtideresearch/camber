import assert from "node:assert/strict";
import {
  cellKey,
  createPreparedBookEvaluator,
  prepareBook,
} from "../src/core/sheet/evaluate";
import {
  evaluateTrial,
  createTrialEvaluator,
  prepareTrials,
  type Trial,
  type TrialGeometry,
} from "../src/core/sheet/trial";
import { generateTrial, existingPhaseTrials } from "./generate-trials";
import { createTrialValueCache } from "../src/core/sheet/trialCache";
import { sampledFieldKeys } from "../src/editor/weight/sampledFieldKeys";
import { mixedTrialBook, mixedTrialGeometry } from "./trial-fixtures";
import { formulaBook, target } from "./sampling-fixtures";
const near = (a: number, b: number, tolerance = 1e-10) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const book = mixedTrialBook(),
  plan = prepareTrials(prepareBook(book));
const geometry = mixedTrialGeometry();
const cutKeys = sampledFieldKeys(book, "i0", "cut");
const repetitionKeys = sampledFieldKeys(book, "i0", "first");
assert.equal(cutKeys[0], cellKey("i0", "cut", "pos"));
assert.ok(cutKeys.includes(cellKey("i0", "cut", "areaCg.x")));
assert.ok(repetitionKeys.includes(cellKey("i0", "first", "equivalentCount")));
assert.ok(repetitionKeys.includes(cellKey("i0", "first", "area")));
assert.ok(repetitionKeys.includes(cellKey("i0", "first", "topHeight")));
assert.ok(repetitionKeys.length <= 32);
assert.deepEqual(
  [
    ...evaluateTrial(
      plan,
      generateTrial(plan, 12345, 0),
      geometry,
      null,
      repetitionKeys,
    ).values.keys(),
  ],
  repetitionKeys,
);
assert.equal(plan.sources.length, 5);
assert.equal(plan.repetitionIds.length, 2);
const offsets = Object.fromEntries(
  plan.sources.map((s) => [
    s.id,
    s.at === target("extent")
      ? 0.5
      : s.at === target("pitch")
        ? -0.2
        : s.at === target("height")
          ? 0.5
          : s.at === target("density")
            ? 2
            : 0,
  ]),
);
const trial: Trial = {
  index: 0,
  inputOffsets: offsets,
  repetitionPhases: { "i0 first": 0.25, "i0 second": 0.75 },
};
const result = evaluateTrial(plan, trial, geometry);
const value = (name: string) => {
  const cell = result.values.get(target(name))!;
  assert.equal(cell.error, null);
  return cell.value!;
};
assert.deepEqual(result.requests.get("i0 first"), {
  shape: "transverse",
  start: 0,
  end: 4.5,
  pitch: 0.8,
  phase: 0.25,
  limits: { topHeight: 2.5 },
});
const positions = Array.from({ length: 6 }, (_, i) => (i + 0.25) * 0.8);
const amount = positions.reduce((sum, pos) => sum + (1 + pos) * 2.5, 0);
near(value("firstMass"), amount * 12);
near(value("cutMass"), (1 + 4.5 / 2) * 2.5 * 12);
near(value("total"), value("firstMass") + value("secondMass"));
near(value("cancel"), 0);
assert.equal(result.repetitionLayouts.get("i0 first")!.count, 6);
assert.equal(result.repetitionLayouts.get("i0 second")!.count, 5);
assert.deepEqual(
  evaluateTrial(plan, JSON.parse(JSON.stringify(trial)), geometry),
  result,
);

// Demand evaluation agrees with the full-book trial, including failures and measured leaves.
for (const world of [
  trial,
  {
    ...trial,
    inputOffsets: {
      ...offsets,
      [plan.sources.find((s) => s.at === target("pitch"))!.id]: -2,
    },
  },
]) {
  const full = evaluateTrial(plan, world, geometry);
  const mapped = createTrialEvaluator(plan, world, geometry);
  for (const key of [...plan.prepared.cells.keys()].reverse()) {
    const partial = mapped([key]);
    assert.deepEqual(
      partial.values.get(key),
      full.values.get(key),
      `selected ${key}`,
    );
    assert.deepEqual(mapped([key]).values.get(key), full.values.get(key));
  }
}
let sections = 0,
  layouts = 0;
const counted: TrialGeometry = {
  section: (request) => {
    sections++;
    return geometry.section(request);
  },
  layout: (request) => {
    layouts++;
    return geometry.layout(request);
  },
};
const reuse = createTrialValueCache(plan, counted, null);
assert.deepEqual(
  reuse(trial, [target("density")]).get(target("density")),
  result.values.get(target("density")),
);
assert.equal(sections + layouts, 0, "plain fields need no geometry");
assert.deepEqual(
  reuse(trial, [target("cutMass")]).get(target("cutMass")),
  result.values.get(target("cutMass")),
);
assert.equal(sections, 1);
reuse(trial, [target("cutMass")]);
assert.equal(sections, 1, "a repeated field reuses its trial value");
assert.deepEqual(
  reuse(trial, [target("firstMass")]).get(target("firstMass")),
  result.values.get(target("firstMass")),
);
assert.equal(layouts, 1);
reuse(trial, [target("total")]);
assert.equal(sections, 1);
assert.equal(layouts, 2, "shared geometry is measured once across targets");

// A mapped world retains the formula cell as well as its measured geometry.
const shared = formulaBook({ x: "2 ± 1", first: "x + 1", second: "x * 3" });
const sharedPlan = prepareTrials(prepareBook(shared));
const offsetsForWorld = new Map(
  sharedPlan.sources.map((source) => [source.id, 0]),
);
const originalGet = offsetsForWorld.get.bind(offsetsForWorld);
let inputReads = 0;
offsetsForWorld.get = (id) => {
  inputReads++;
  return originalGet(id);
};
const mappedWorld = createPreparedBookEvaluator(
  sharedPlan.prepared,
  null,
  undefined,
  undefined,
  {
    inputOffsets: offsetsForWorld,
    retainInputGradients: true,
    targets: [],
  },
);
assert.equal(
  mappedWorld([target("first")]).cells.get(target("first"))?.quantity?.v,
  3,
);
assert.equal(inputReads, 1);
assert.equal(
  mappedWorld([target("second")]).cells.get(target("second"))?.quantity?.v,
  6,
);
assert.equal(inputReads, 1, "the shared x cell was not re-evaluated");

// Generation is independent of evaluation order, batching and geometry caches.
const ten = generateTrial(plan, 42, 10);
generateTrial(plan, 42, 2);
assert.deepEqual(generateTrial(plan, 42, 10), ten);
const reordered = prepareTrials(
  prepareBook({
    ...book,
    items: [
      {
        ...book.items[0],
        fields: Object.fromEntries(
          Object.entries(book.items[0].fields).reverse(),
        ),
      },
    ],
  }),
);
assert.deepEqual(generateTrial(reordered, 42, 10), ten);
assert.notEqual(
  ten.repetitionPhases["i0 first"],
  ten.repetitionPhases["i0 second"],
);
const unrelated = prepareTrials(
  prepareBook({
    ...book,
    items: [
      {
        ...book.items[0],
        fields: {
          ...book.items[0].fields,
          extra: { k: "scalar", formula: "4 ± 3", unit: "", role: null },
        },
      },
    ],
  }),
);
const extended = generateTrial(unrelated, 42, 10);
for (const s of plan.sources)
  assert.equal(ten.inputOffsets[s.id], extended.inputOffsets[s.id]);
assert.deepEqual(ten.repetitionPhases, extended.repetitionPhases);
// Statistical smoke test: separate repetition phases are not implicitly tied.
let product = 0,
  a = 0,
  b = 0;
for (let i = 0; i < 4096; i++) {
  const t = generateTrial(plan, 12345, i),
    x = t.repetitionPhases["i0 first"],
    y = t.repetitionPhases["i0 second"];
  a += x / 4096;
  b += y / 4096;
  product += (x * y) / 4096;
}
near(a, 0.5, 0.02);
near(b, 0.5, 0.02);
near(product - a * b, 0, 0.005);

let calls = 0;
const layoutCache = new Map<string, ReturnType<TrialGeometry["layout"]>>();
const cached: TrialGeometry = {
  ...geometry,
  layout: (request) => {
    const key = JSON.stringify(request);
    if (!layoutCache.has(key)) {
      calls++;
      layoutCache.set(key, geometry.layout(request));
    }
    return layoutCache.get(key)!;
  },
};
const cachedFirst = evaluateTrial(plan, trial, cached);
assert.deepEqual(cachedFirst, result);
assert.deepEqual(evaluateTrial(plan, trial, cached), result);
assert.equal(calls, 2);
const shifted = {
  ...trial,
  repetitionPhases: { ...trial.repetitionPhases, "i0 first": 0.5 },
};
assert.deepEqual(
  evaluateTrial(plan, shifted, cached),
  evaluateTrial(plan, shifted, geometry),
);
assert.equal(calls, 3);
// Material-only changes reuse geometry; bounds changes must miss the cache.
const materialId = plan.sources.find((s) => s.at === target("density"))!.id;
const materialTrial = {
  ...trial,
  inputOffsets: { ...offsets, [materialId]: -2 },
};
const lighter = evaluateTrial(plan, materialTrial, cached);
near(
  lighter.values.get(target("firstMass"))!.value!,
  (value("firstMass") * 8) / 12,
);
assert.equal(calls, 3);
const extentId = plan.sources.find((s) => s.at === target("extent"))!.id;
const shorter = { ...trial, inputOffsets: { ...offsets, [extentId]: -1 } };
assert.deepEqual(
  evaluateTrial(plan, shorter, cached),
  evaluateTrial(plan, shorter, geometry),
);
assert.equal(calls, 5);
const emptyTrial = { ...trial, inputOffsets: { ...offsets, [extentId]: -3.9 } };
const emptyWorld = evaluateTrial(plan, emptyTrial, geometry);
assert.equal(emptyWorld.values.get(target("total"))!.value, 0);
assert.ok(emptyWorld.values.get(target("cg"))!.error);
assert.equal(emptyWorld.values.get(target("cutMass"))!.error, null);
assert.equal(emptyWorld.geometryErrors.size, 0);

// No evaluator or direct geometry code may draw randomness.
const oldRandom = Math.random;
Math.random = () => {
  throw new Error("Hidden randomness");
};
try {
  assert.deepEqual(evaluateTrial(plan, trial, geometry), result);
} finally {
  Math.random = oldRandom;
}

assert.throws(
  () => evaluateTrial(plan, { ...trial, repetitionPhases: {} }, geometry),
  /Missing/,
);
assert.throws(
  () =>
    evaluateTrial(
      plan,
      {
        ...trial,
        repetitionPhases: { ...trial.repetitionPhases, "i0 first": 1 },
      },
      geometry,
    ),
  /phase/,
);
assert.throws(
  () => evaluateTrial(plan, { ...trial, inputOffsets: {} }, geometry),
  /Missing/,
);
assert.throws(
  () =>
    evaluateTrial(
      plan,
      { ...trial, inputOffsets: { ...offsets, unexpected: 1 } },
      geometry,
    ),
  /Unknown/,
);
assert.throws(
  () => existingPhaseTrials(plan, "i0 first", [{ phase: 0.5, weight: 1 }]),
  /one repetition/,
);
const invalid = {
  ...trial,
  inputOffsets: {
    ...offsets,
    [plan.sources.find((s) => s.at === target("pitch"))!.id]: -2,
  },
};
const failed = evaluateTrial(plan, invalid, geometry);
assert.ok(failed.values.get(target("firstMass"))!.error);
assert.equal(failed.values.get(target("cutMass"))!.error, null);
assert.equal(failed.values.get(target("density"))!.error, null);
const broken = evaluateTrial(plan, trial, {
  ...geometry,
  layout: () => {
    throw new Error("bad contour");
  },
});
assert.match(broken.values.get(target("firstMass"))!.error!, /bad contour/);
assert.equal(
  broken.values.get(cellKey("i0", "first", "equivalentCount"))!.value,
  4.5 / 0.8,
);
assert.equal(broken.values.get(target("cutMass"))!.error, null);

// Retain authored dimensional-power restrictions when literals become trial values.
const powerPlan = prepareTrials(
  prepareBook(
    formulaBook({ x: { formula: "2", unit: "m" }, result: "x ^ (2 ± 1)" }),
  ),
);
assert.match(
  evaluateTrial(powerPlan, generateTrial(powerPlan, 1, 0)).values.get(
    target("result"),
  )!.error!,
  /uncertain power/,
);
// A source after a geometry reference is present even when nominal geometry is absent.
assert.ok(plan.sources.some((s) => s.at === target("inline")));
console.log(
  "Trial generation, replay, joint geometry/material inputs and cache invariance passed",
);
