import assert from "node:assert/strict";
import {
  precomputedSliceGeometry,
  type SliceInterpolationTolerance,
  type SliceSample,
} from "../src/core/sheet/precomputedSlices";
import {
  geometryValue,
  measureAt,
  zeroMeasures,
  type SectionMeasures,
} from "../src/core/sheet/sectionMeasures";
import {
  directTrialGeometry,
  evaluateTrial,
  prepareTrials,
  type SectionRequest,
} from "../src/core/sheet/trial";
import { prepareBook } from "../src/core/sheet/evaluate";
import { repetitionBook } from "./repetition-sampling-fixtures";
import { generateTrial } from "./generate-trials";
import { compareSliceBackends } from "./compare-slice-backends";
import { sliceBackendFixtures } from "./slice-backend-fixtures";
const near = (a: number, b: number, tol = 1e-10) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const tolerance: SliceInterpolationTolerance = {
  relative: 1e-8,
  area: 1e-10,
  length: 1e-10,
  momentLengthScale: 1,
};
const spec = { shape: "transverse" as const, start: 0, end: 1, intervals: 1 };
const request = (position: number): SectionRequest => ({
  shape: "transverse",
  position,
  limits: {},
});
const affine = ({ position: x, limits }: SectionRequest): SliceSample => {
  const factor = limits.topHeight ?? 1;
  const m = {
    amount: factor * (1 + x),
    moment: [factor * (1 + 3 * x), 0, factor * (2 + x)] as [
      number,
      number,
      number,
    ],
  };
  return {
    measures: { area: m, openLength: m, closedLength: m },
    topology: "one contour",
  };
};
let calls = 0;
const fast = precomputedSliceGeometry(
  (r) => {
    calls++;
    return affine(r);
  },
  [spec],
  tolerance,
);
assert.equal(calls, 5);
assert.equal(fast.tables[0].interpolatedIntervals, 1);
const interpolated = fast.geometry.section(request(0.4));
near(interpolated.area.amount, 1.4);
near(interpolated.area.moment[0], 2.2);
near(geometryValue(interpolated, "areaCg.x"), 2.2 / 1.4);
assert.notEqual(geometryValue(interpolated, "areaCg.x"), 1.4); // not lerped centroids
assert.equal(calls, 5);
assert.equal(fast.stats().interpolated, 1);
assert.deepEqual(
  fast.geometry.section(request(0.5)),
  affine(request(0.5)).measures,
);
assert.equal(fast.stats().exactHits, 1);
for (const pos of [-0.1, 1.1])
  assert.deepEqual(
    fast.geometry.section(request(pos)),
    affine(request(pos)).measures,
  );
assert.equal(fast.stats().directFallbacks, 2);
const clipped = precomputedSliceGeometry(
  affine,
  [{ ...spec, limits: { topHeight: 2, portOffset: 0 } }],
  tolerance,
);
clipped.geometry.section({
  ...request(0.4),
  limits: { portOffset: 0, topHeight: 2 },
});
assert.equal(clipped.stats().interpolated, 1);
const changed = { ...request(0.4), limits: { topHeight: 2.01, portOffset: 0 } };
assert.deepEqual(clipped.geometry.section(changed), affine(changed).measures);
assert.equal(clipped.stats().directFallbacks, 1);
clipped.geometry.section({ ...request(0.4), shape: "station" });
assert.equal(clipped.stats().directFallbacks, 2);

const curved = ({ position: x }: SectionRequest): SliceSample => {
  const m = measureAt(1 + x * x, [x, 0, 1]);
  return {
    measures: { area: m, openLength: m, closedLength: m },
    topology: "one contour",
  };
};
const coarse = precomputedSliceGeometry(curved, [spec], tolerance);
assert.equal(coarse.tables[0].fallbackIntervals, 1);
assert.deepEqual(
  coarse.geometry.section(request(0.123)),
  curved(request(0.123)).measures,
);
const fine = precomputedSliceGeometry(curved, [{ ...spec, intervals: 64 }], {
  ...tolerance,
  relative: 0.002,
});
assert.equal(fine.tables[0].interpolatedIntervals, 64);
for (let i = 0; i < 100; i++) {
  const req = request((i + 0.37) / 100),
    actual = curved(req).measures,
    estimate = fine.geometry.section(req);
  near(estimate.area.amount, actual.area.amount, 0.0001);
  near(estimate.area.moment[0], actual.area.moment[0], 0.00025);
}
const topology = precomputedSliceGeometry(
  (r) => ({ ...affine(r), topology: r.position < 0.6 ? "one" : "two" }),
  [spec],
  tolerance,
);
assert.equal(topology.tables[0].rejected["topology change"], 1);
assert.deepEqual(
  topology.geometry.section(request(0.59)),
  affine(request(0.59)).measures,
);

// All-empty probes must not hide a narrow feature between probe positions.
const narrow = (r: SectionRequest): SliceSample =>
  r.position > 0.11 && r.position < 0.12
    ? affine(r)
    : { measures: zeroMeasures(), topology: "empty" };
const empty = precomputedSliceGeometry(narrow, [spec], tolerance);
assert.equal(empty.tables[0].rejected["empty measure"], 1);
assert.ok(empty.geometry.section(request(0.115)).area.amount > 0);
assert.equal(empty.geometry.section(request(0.1)).area.amount, 0);
assert.throws(
  () => geometryValue(empty.geometry.section(request(0.1)), "areaCg.x"),
  /undefined/,
);
const tiny = precomputedSliceGeometry(
  () => {
    const m = measureAt(1e-12, [1, 0, 1]);
    return { measures: { area: m, openLength: m, closedLength: m } };
  },
  [spec],
  tolerance,
);
assert.equal(tiny.tables[0].rejected["near-empty measure"], 1);
tiny.geometry.section(request(0.123));
assert.equal(tiny.stats().directFallbacks, 1);

const brokenMeasure = (r: SectionRequest) => {
  if (r.position === 0.25) throw new Error("bad contour");
  return affine(r);
};
const broken = precomputedSliceGeometry(brokenMeasure, [spec], tolerance);
assert.equal(broken.stats().precomputeFailures, 1);
assert.equal(broken.tables[0].rejected["measurement error"], 1);
assert.deepEqual(
  broken.geometry.section(request(0.3)),
  affine(request(0.3)).measures,
);
assert.throws(() => broken.geometry.section(request(0.25)), /bad contour/);
assert.throws(
  () =>
    precomputedSliceGeometry(affine, [spec], { ...tolerance, relative: -1 }),
  /tolerance/,
);
assert.throws(
  () => precomputedSliceGeometry(affine, [{ ...spec, end: 0 }], tolerance),
  /bounds/,
);
assert.throws(
  () =>
    precomputedSliceGeometry(affine, [{ ...spec, intervals: 0 }], tolerance),
  /intervals/,
);
assert.throws(
  () =>
    precomputedSliceGeometry(affine, [spec], tolerance, {
      maxPrecomputedSections: 4,
    }),
  /budget/,
);
assert.throws(
  () => precomputedSliceGeometry(affine, [spec, spec], tolerance),
  /one table/i,
);
assert.throws(
  () =>
    precomputedSliceGeometry(
      affine,
      [{ ...spec, start: 1e16, end: 1e16 + 2 }],
      tolerance,
    ),
  /coordinate scale/,
);

// Snapshot ownership and query order do not change the interpolation.
const mutable = affine(request(0)).measures as SectionMeasures;
const snapshot = precomputedSliceGeometry(
  () => ({ measures: mutable }),
  [spec],
  tolerance,
);
mutable.area.moment[0] = 123;
near(snapshot.geometry.section(request(0.1)).area.moment[0], 1);
const before = fine.geometry.section(request(0.314159));
fine.geometry.section(request(0.2));
fine.geometry.section(request(0.9));
assert.deepEqual(fine.geometry.section(request(0.314159)), before);

// Same trials, different backend: exact affine interpolation across layout shifts.
const plan = prepareTrials(prepareBook(repetitionBook(0, 1, 2.3)));
const direct = directTrialGeometry((r) => affine(r).measures);
const values = (r: ReturnType<typeof evaluateTrial>) =>
  [...r.values].map(([k, c]) => [k, c.value, c.error] as const);
for (let i = 0; i < 20; i++) {
  const trial = generateTrial(plan, 12345, i);
  const a = values(evaluateTrial(plan, trial, direct)),
    b = values(evaluateTrial(plan, trial, fast.geometry));
  assert.equal(a.length, b.length);
  a.forEach(([key, value, error], j) => {
    assert.equal(b[j][0], key);
    assert.equal(b[j][2], error);
    if (value !== null) near(value, b[j][1]!);
  });
}
const rnd = Math.random;
Math.random = () => {
  throw new Error("hidden randomness");
};
try {
  precomputedSliceGeometry(affine, [spec], tolerance).geometry.section(
    request(0.13),
  );
} finally {
  Math.random = rnd;
}
// Real sampled hull: paired trials bound observed interpolation error and verify
// that changing trims uses direct geometry instead of an incompatible table.
for (const fixture of sliceBackendFixtures()) {
  const report = compareSliceBackends(fixture, {
    samples: 32,
    seed: 12345,
    resolutions: [64],
    tolerance: {
      relative: 0.002,
      area: 1e-8,
      length: 1e-8,
      momentLengthScale: 3.5,
    },
  });
  const approximation = report.approximations[0];
  for (const output of approximation.outputs) {
    assert.equal(output.validityMismatches, 0);
    assert.equal(output.errorMismatches, 0);
    assert.equal(output.pairedValid, 32);
  }
  if (fixture.name.includes("variable-trim")) {
    assert.equal(approximation.geometry.interpolated, 0);
    assert.equal(
      approximation.geometry.directFallbacks,
      report.reference.sectionCalls,
    );
    for (const output of approximation.outputs)
      assert.equal(output.maxAbsoluteDifference, 0);
  } else {
    assert.equal(approximation.geometry.directFallbacks, 0);
    assert.ok(approximation.outputs[1].maxAbsoluteDifference < 0.001);
    assert.ok(approximation.outputs[2].maxAbsoluteDifference < 0.01);
  }
}
console.log(
  "Precomputed slices: interpolation, diagnostics, fallbacks and deterministic trials passed",
);
