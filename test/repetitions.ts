import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RepetitionAssumptions } from "../src/editor/weight/RepetitionAssumptions";
import { RepetitionPreview } from "../src/editor/weight/RepetitionPreview";
import {
  nearestSample,
  samplePath,
} from "../src/editor/weight/repetitionPlots";
import assert from "node:assert/strict";
import { defaultHull } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import type { Vec3 } from "../src/core/math";
import {
  blankField,
  emptyBook,
  interpretSheetCommand,
  type Field,
  type RepetitionField,
  type WeightBook,
} from "../src/core/sheet/book";
import { evaluateBook, resultAt, fieldUsers } from "../src/core/sheet/evaluate";
import { buildSheetJson, parseSheet } from "../src/core/sheet/json";
import { intersectPlane, type CutTriangle } from "../src/core/sheet/planeCuts";
import {
  measureRepetition,
  type RepetitionResult,
} from "../src/core/sheet/repetitions";
import {
  geometryValue,
  measureAt,
  zeroMeasures,
  type SectionMeasures,
} from "../src/core/sheet/sectionMeasures";
import {
  createSectionMeasurer,
  createSliceMeasurer,
  type RawSliceMeasurement,
} from "../src/core/sheet/slices";
import { completionsFor } from "../src/editor/weight/weightCompletions";
import {
  read,
  LENGTH,
  type Quantity,
  type Source,
} from "../src/core/sheet/quantity";
import { worstRegion, likelyRegion } from "../src/core/sheet/points";
import { bookViolations } from "../src/core/invariants";

const near = (a: number, b: number, tol = 1e-8) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tolerance ${tol})`);
const identity = (p: Vec3) => p;
function box(x0 = 0, x1 = 4, y0 = -1, y1 = 1, z0 = 0, z1 = 2): CutTriangle[] {
  const out: CutTriangle[] = [];
  const face = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, skin: boolean) =>
    out.push({ points: [a, b, c], skin }, { points: [a, c, d], skin });
  face([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], true);
  face([x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0], true);
  face([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], true);
  face([x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1], false);
  face([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], false);
  face([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], false);
  return out;
}
const triangles = box();
for (const [normal, offset, area] of [
  [[1, 0, 0], 1.3, 4],
  [[0, 1, 0], 0, 8],
  [[0, 0, 1], 0.7, 8],
] as const) {
  const result = intersectPlane(triangles, [...normal], offset, identity, 1);
  near(result.measures.area.amount, area);
  assert.equal(result.contours.length, 1);
}
const section = intersectPlane(triangles, [1, 0, 0], 1.3, identity, 1).measures;
near(section.openLength.amount, 6);
near(section.closedLength.amount, 8);
near(geometryValue(section, "areaCg.z"), 1);
near(geometryValue(section, "openLengthCg.z"), 2 / 3);
near(geometryValue(section, "closedLengthCg.z"), 1);
near(geometryValue(section, "areaCg.x"), 1.3);
assert.equal(
  intersectPlane(triangles, [1, 0, 0], 10, identity, 1).measures.area.amount,
  0,
);
assert.throws(() => geometryValue(zeroMeasures(), "areaCg.z"), /undefined/);
assert.throws(
  () => intersectPlane(triangles, [1, 0, 0], 0, identity, 1),
  /coincides/,
);
assert.throws(
  () => intersectPlane(triangles.slice(2), [1, 0, 0], 1.3, identity, 1),
  /open or branched/,
);
const disconnected = intersectPlane(
  [...box(0, 4, -3, -2), ...box(0, 4, 2, 3)],
  [1, 0, 0],
  1.3,
  identity,
  1,
);
near(disconnected.measures.area.amount, 4);
assert.equal(disconnected.contours.length, 2);
near(geometryValue(disconnected.measures, "areaCg.y"), 0);
const holed = intersectPlane(
  [...box(0, 4, -2, 2, 0, 4), ...box(0, 4, -1, 1, 1, 3)],
  [1, 0, 0],
  1.3,
  identity,
  1,
);
near(holed.measures.area.amount, 12);
near(geometryValue(holed.measures, "areaCg.z"), 2);
// Scaling model coordinates must not change physical results.
const mm = triangles.map((t) => ({
  ...t,
  points: t.points.map(
    (p) => p.map((v) => v * 1000) as Vec3,
  ) as unknown as CutTriangle["points"],
}));
near(
  intersectPlane(
    mm,
    [1, 0, 0],
    1300,
    (p) => p.map((v) => v / 1000) as Vec3,
    0.001,
  ).measures.area.amount,
  4,
);
console.log(
  "Plane cuts: axes, units, selected lengths, centroids, closure, empty and multiple contours passed",
);

function raw(measures: SectionMeasures): RawSliceMeasurement {
  const area = measures.area.amount;
  const cg = area
    ? (measures.area.moment.map((v) => v / area) as Vec3)
    : ([0, 0, 0] as Vec3);
  return {
    measures,
    area,
    openPerimeter: measures.openLength.amount,
    closedPerimeter: measures.closedLength.amount,
    x: cg[0],
    y: cg[1],
    z: cg[2],
    centroid: cg,
    curve: [],
    contours: [],
    sheetContours: [],
    sheetSkinSegments: [],
  };
}
// Rectangular sections: height 2, width 1+x, bottom and sides count as skin.
const varying = (_shape: unknown, x: number) =>
  raw({
    area: measureAt(2 * (1 + x), [x, 0, 1]),
    openLength: measureAt(5 + x, [x, 0, 4 / (5 + x)]),
    closedLength: measureAt(6 + 2 * x, [x, 0, 1]),
  });
const measured = measureRepetition(varying, "transverse", 1, 3);
assert.ok(measured.value, measured.error ?? "valid integral");
near(measured.value.integrals.area.amount, 12);
near(measured.value.integrals.openLength.amount, 14);
near(geometryValue(measured.value.integrals, "areaCg.x"), 19 / 9, 1e-4);
const left = measureRepetition(varying, "transverse", 1, 2),
  right = measureRepetition(varying, "transverse", 2, 3);
near(
  left.value!.integrals.area.amount + right.value!.integrals.area.amount,
  measured.value.integrals.area.amount,
);
near(
  left.value!.integrals.area.moment[0] + right.value!.integrals.area.moment[0],
  measured.value.integrals.area.moment[0],
  3e-4,
);
assert.match(measureRepetition(varying, "transverse", 3, 1).error!, /From/);
assert.match(
  measureRepetition(
    () => {
      throw new Error("invalid geometry");
    },
    "transverse",
    1,
    3,
  ).error!,
  /invalid geometry/,
);
// Empty intersections are valid zero contributions; centroids remain undefined.
assert.equal(
  measureRepetition(() => raw(zeroMeasures()), "transverse", 1, 3).value!
    .integrals.area.amount,
  0,
);
const constant = measureRepetition(() => raw(section), "transverse", 1, 3);
near(constant.value!.integrals.area.amount, 8);
console.log(
  "Repetition quadrature: analytic variable/constant sections, split additivity and failures passed",
);

const repetition: RepetitionField = {
  k: "repetition",
  shape: "transverse",
  unit: "m",
  start: "1",
  end: "3",
  repetition: "spacing",
  spacing: "0.5 ± 0.05",
  count: "4 ± 0.4",
};
const scalar = (formula: string, unit = ""): Field => ({
  k: "scalar",
  formula,
  unit,
  role: null,
});
const makeBook = (
  f: RepetitionField = repetition,
  extra: Record<string, Field> = {},
): WeightBook => ({
  ...emptyBook(),
  items: [
    {
      id: "i",
      name: "structure",
      note: "",
      facets: {},
      fields: {
        members: f,
        density: scalar("5 ± 1", "kg/m2"),
        mass: scalar("members.area * density"),
        cg: {
          k: "point",
          unit: "m",
          x: "",
          y: "",
          z: "",
          from: "members.areaCg",
          role: "CG",
        },
        frameCg: {
          k: "point",
          unit: "m",
          x: "",
          y: "",
          z: "",
          from: "members.openLengthCg",
          role: null,
        },
        ratio: scalar("members.area / members.openLength"),
        qualified: scalar("structure.members.areaCg.x"),
        ...extra,
      },
    },
  ],
});
const evaluate = (book: WeightBook, result: RepetitionResult = measured) =>
  evaluateBook(book, null, new Map(), new Map([["i members", result]]));
const book = makeBook();
const results = evaluate(book);
const cell = (field: string, leaf = "formula") =>
  resultAt(results, "i", field, leaf)!;
assert.equal(cell("mass").error, null);
near(cell("mass").quantity!.v, 120);
near(cell("members", "equivalentCount").quantity!.v, 4);
near(cell("members", "area").quantity!.v, 24);
near(cell("members", "openLength").quantity!.v, 28);
near(cell("members", "area").reading!.worst.hi, 2.4);
near(cell("mass").reading!.worst.hi, 36);
near(cell("cg", "x").quantity!.v, 19 / 9, 1e-4);
near(cell("frameCg", "z").quantity!.v, 4 / 7);
near(cell("qualified").quantity!.v, cell("cg", "x").quantity!.v);
assert.equal(Object.keys(cell("cg", "x").quantity!.d).length, 0);
near(cell("ratio").reading!.worst.hi, 0, 1e-12);
const counted = evaluate(makeBook({ ...repetition, repetition: "count" }));
near(resultAt(counted, "i", "members", "area")!.quantity!.v, 24);
assert.equal(
  Object.keys(resultAt(counted, "i", "cg", "x")!.quantity!.d).length,
  0,
);
const shifted = evaluate(makeBook({ ...repetition, start: "1 ± 0.01" }));
const shiftedArea = resultAt(shifted, "i", "members", "area")!;
near(shiftedArea.reading!.worst.hi, 2.48);
const gradient = Object.entries(
  resultAt(shifted, "i", "cg", "x")!.quantity!.d,
)[0][1];
const cgAt = (a: number) =>
  geometryValue(
    measureRepetition(varying, "transverse", a, 3).value!.integrals,
    "areaCg.x",
  );
near(gradient, (cgAt(1.0001) - cgAt(0.9999)) / 0.0002, 1e-4);
const countBounds = evaluate(
  makeBook({
    ...repetition,
    repetition: "count",
    start: "1 ± 0.01",
    count: "4",
  }),
);
near(resultAt(countBounds, "i", "members", "area")!.reading!.worst.hi, 0.04);
for (const f of [
  { ...repetition, spacing: "0" },
  { ...repetition, repetition: "count" as const, count: "density" },
  { ...repetition, start: "3" },
])
  assert.ok(resultAt(evaluate(makeBook(f)), "i", "mass")!.error);
assert.match(
  resultAt(
    evaluate(makeBook({ ...repetition, spacing: "0.5 ± 0.6" })),
    "i",
    "members",
    "area",
  )!.unitWarning!,
  /zero/,
);
for (const leaf of ["start", "end", "spacing"] as const) {
  const bad = evaluate(makeBook({ ...repetition, [leaf]: "members.area / 1" }));
  assert.match(
    resultAt(bad, "i", "members", leaf)!.error!,
    /cannot depend on measured/,
  );
}
const indirect = evaluate(
  makeBook(
    { ...repetition, start: "bridge" },
    { bridge: scalar("members.areaCg.x") },
  ),
);
assert.ok(resultAt(indirect, "i", "members", "start")!.error);
assert.match(
  resultAt(indirect, "i", "bridge")!.error!,
  /cannot depend on measured/,
);
const firstPass = evaluateBook(book, null);
assert.equal(resultAt(firstPass, "i", "members", "start")!.error, null);
assert.ok(resultAt(firstPass, "i", "members", "area")!.error);
const emptyResult = measureRepetition(
  () => raw(zeroMeasures()),
  "transverse",
  1,
  3,
);
const empty = evaluate(book, emptyResult);
near(resultAt(empty, "i", "mass")!.quantity!.v, 0);
assert.match(resultAt(empty, "i", "cg", "x")!.error!, /undefined/);
assert.ok((fieldUsers(book, results, "i").get("members")?.length ?? 0) > 0);
console.log(
  "Repetition evaluation: formulas, moments, shared uncertainty, bounds, count and geometry dependency guards passed",
);

const phasedMeasurement = measureRepetition(varying, "transverse", 1, 3, 0.5);
assert.equal(phasedMeasurement.value!.phaseTotals?.length, 16);
const phased = evaluate(
  makeBook(
    { ...repetition, spacing: "0.5" },
    { phaseCancel: scalar("members.closedLength - 2 * members.openLength") },
  ),
  phasedMeasurement,
);
const phasedArea = resultAt(phased, "i", "members", "area")!;
assert.ok(phasedArea.reading!.likely.hi > 0);
// Normal model assumptions are not diagnostic warnings, including downstream formulas.
for (const [key, leaf] of [
  ["members", "area"],
  ["mass", undefined],
  ["cg", "x"],
] as const)
  assert.equal(resultAt(phased, "i", key, leaf)?.unitWarning, null);
const assumptions = renderToStaticMarkup(createElement(RepetitionAssumptions));
assert.match(assumptions, /class="wpreviewtoggle" aria-expanded="false"/);
assert.match(assumptions, /Estimation assumptions/);
assert.match(assumptions, /class="wexptwist"/);
assert.doesNotMatch(assumptions, /sampled envelope/);

assert.equal(phasedArea.reading!.terms.length, 1);
assert.match(phasedArea.reading!.terms[0].label, /placement uncertainty/);
assert.ok(resultAt(phased, "i", "cg", "x")!.reading!.likely.hi > 0);
// The same phase moves every measured property together. Here the varying
// parts cancel exactly, which independent per-property tolerances could not see.
near(resultAt(phased, "i", "phaseCancel")!.reading!.likely.hi, 0, 1e-12);
const phasedConstant = evaluate(
  makeBook({ ...repetition, spacing: "0.5" }),
  measureRepetition(() => raw(section), "transverse", 1, 3, 0.5),
);
near(
  resultAt(phasedConstant, "i", "members", "area")!.reading!.likely.hi,
  0,
  1e-12,
);
console.log(
  "Grid-phase approximation: discrete spread, shared covariance and constant sections passed",
);

// Stratification captures rare extra members exactly for constant sections.
for (const count of [0.01, 0.99, 1.01, 3.999, 4.001, 254.5, 255.5, 256.5]) {
  const pitch = 2 / count;
  const measurement = measureRepetition(
    () => raw(section),
    "transverse",
    1,
    3,
    pitch,
  );
  assert.ok(measurement.value, measurement.error ?? "valid phase sampling");
  const result = evaluate(
    makeBook({ ...repetition, spacing: String(pitch) }),
    measurement,
  );
  const reading = resultAt(result, "i", "members", "area")!.reading!;
  const fraction = count - Math.floor(count);
  near(
    reading.likely.hi,
    section.area.amount * Math.sqrt(fraction * (1 - fraction)),
    1e-8,
  );
  near(reading.worst.lo, section.area.amount * fraction, 1e-8);
  near(reading.worst.hi, section.area.amount * (1 - fraction), 1e-8);
  if (count < 1)
    assert.match(
      resultAt(result, "i", "cg", "x")!.error!,
      /empty sampled layout/,
    );
}
assert.match(
  measureRepetition(() => raw(section), "transverse", 1, 3, 2 / 1000).error!,
  /sampling budget/,
);
// An exact fractional equivalent count still has placement uncertainty.
const equivalent = evaluate(
  makeBook({ ...repetition, repetition: "count", count: "0.01" }),
  measureRepetition(() => raw(section), "transverse", 1, 3, 2 / 0.01),
);
near(
  resultAt(equivalent, "i", "members", "area")!.reading!.likely.hi,
  section.area.amount * Math.sqrt(0.01 * 0.99),
);
assert.match(
  resultAt(equivalent, "i", "cg", "x")!.error!,
  /empty sampled layout/,
);

// Shared amount/moment deviations reconstruct first moments under the sheet's
// product linearization, rather than mixing finite centroid and amount deltas.
const momentResult = evaluate(
  makeBook(
    { ...repetition, spacing: "0.5" },
    {
      moment: scalar("members.area * members.areaCg.x"),
    },
  ),
  phasedMeasurement,
);
const moment = resultAt(momentResult, "i", "moment")!.quantity!;
const momentSources = [...momentResult.sources.values()].filter(
  (s) => s.sample,
);
for (let i = 0; i < momentSources.length; i++)
  near(
    moment.d[momentSources[i].id] ?? 0,
    phasedMeasurement.value!.phaseTotals![i].measures.area.moment[0] - moment.v,
    1e-9,
  );
const cgX = resultAt(momentResult, "i", "cg", "x")!;
const cgZ = resultAt(momentResult, "i", "cg", "z")!;
const region = worstRegion(cgX.quantity!, cgZ.quantity!, momentResult.sources);
near(-Math.min(...region.map((p) => p[0])), cgX.reading!.worst.lo);
near(Math.max(...region.map((p) => p[0])), cgX.reading!.worst.hi);
const ellipse = likelyRegion(
  cgX.quantity!,
  cgZ.quantity!,
  momentResult.sources,
);
near(Math.max(...ellipse.map((p) => p[0])), cgX.reading!.likely.hi);
assert.ok(cgX.reading!.worst.hi > cgX.reading!.likely.hi);
console.log(
  "Placement: fractional counts, empty layouts, budget, moment consistency and plotted envelopes passed",
);

// Model groups are mutually exclusive within each group, independent between
// groups, and coexist with ordinary asymmetric input tolerances.
const mixedSources = new Map<string, Source>([
  [
    "a",
    {
      id: "a",
      label: "grid A",
      lo: 1,
      hi: 1,
      sample: { group: "A", weight: 0.25 },
    },
  ],
  [
    "b",
    {
      id: "b",
      label: "grid A",
      lo: 1,
      hi: 1,
      sample: { group: "A", weight: 0.75 },
    },
  ],
  [
    "c",
    {
      id: "c",
      label: "grid B",
      lo: 1,
      hi: 1,
      sample: { group: "B", weight: 0.5 },
    },
  ],
  [
    "d",
    {
      id: "d",
      label: "grid B",
      lo: 1,
      hi: 1,
      sample: { group: "B", weight: 0.5 },
    },
  ],
  ["input", { id: "input", label: "input", lo: 1, hi: 2 }],
]);
const mixedX: Quantity = {
  v: 0,
  dim: LENGTH,
  d: { a: -3, b: 1, c: -2, d: 2, input: 1 },
};
const mixedY: Quantity = {
  v: 0,
  dim: LENGTH,
  d: { a: 6, b: -2, c: -1, d: 1, input: -2 },
};
const mixedRegion = worstRegion(mixedX, mixedY, mixedSources);
for (const [axis, quantity] of [mixedX, mixedY].entries()) {
  const reading = read(quantity, mixedSources);
  near(-Math.min(...mixedRegion.map((p) => p[axis])), reading.worst.lo);
  near(Math.max(...mixedRegion.map((p) => p[axis])), reading.worst.hi);
  assert.equal(reading.terms.length, 3);
}
near(read(mixedX, mixedSources).likely.lo, Math.sqrt(8));
near(read(mixedX, mixedSources).likely.hi, Math.sqrt(11));
near(read(mixedX, mixedSources).worst.lo, 6);
near(read(mixedX, mixedSources).worst.hi, 5);
for (const pitch of [0, -1, Infinity, NaN])
  assert.match(
    measureRepetition(varying, "transverse", 1, 3, pitch).error!,
    /positive spacing/,
  );
// Exact count fixes mean density, not placement. Equivalent input modes must
// yield identical placement spreads for both summed geometry and centroid.
const countWithPhases = evaluate(
  makeBook({ ...repetition, repetition: "count", count: "4" }),
  phasedMeasurement,
);
for (const [key, leaf] of [
  ["members", "area"],
  ["cg", "x"],
] as const) {
  const reading = resultAt(countWithPhases, "i", key, leaf)!.reading!;
  const spacingReading = resultAt(phased, "i", key, leaf)!.reading!;
  assert.ok(reading.likely.hi > 0);
  near(reading.likely.hi, spacingReading.likely.hi);
  near(reading.worst.lo, spacingReading.worst.lo);
  near(reading.worst.hi, spacingReading.worst.hi);
}
near(
  resultAt(countWithPhases, "i", "members", "equivalentCount")!.reading!.likely
    .hi,
  0,
);

assert.deepEqual(parseSheet(buildSheetJson(book)), book);
// Old saved fields and type-filtered views migrate without changing authored
// names or formulas. New saves use only the new field-kind name.
const legacyBook = {
  ...book,
  views: [
    {
      id: "legacy-repetitions",
      name: "Members",
      scope: { k: "fieldType" as const, type: "repetition" as const },
      groupBy: [],
      layout: "table" as const,
    },
  ],
};
const legacyJson = buildSheetJson(legacyBook)
  .replace(/"k": "repetition"/g, '"k": "footprint"')
  .replace(/"type": "repetition"/g, '"type": "footprint"');
const migrated = parseSheet(legacyJson);
assert.deepEqual(migrated, legacyBook);
assert.doesNotMatch(buildSheetJson(migrated), /"(?:k|type)": "footprint"/);
const migratedArea = resultAt(evaluate(migrated), "i", "members", "area")!;
assert.ok(migratedArea.reading);
assert.deepEqual(
  migratedArea.reading,
  resultAt(evaluate(legacyBook), "i", "members", "area")!.reading,
);

assert.equal(bookViolations(book).length, 0);
assert.equal(blankField("repetition").k, "repetition");
const renamed = interpretSheetCommand(book, {
  type: "renameField",
  item: "i",
  key: "members",
  name: "repetition",
  updateReferences: true,
});
assert.ok(!("rejected" in renamed));
const renamedResults = evaluateBook(
  renamed.book,
  null,
  new Map(),
  new Map([["i repetition", measured]]),
);
assert.equal(resultAt(renamedResults, "i", "mass")!.error, null);
assert.equal(resultAt(renamedResults, "i", "qualified")!.error, null);
const countMode = interpretSheetCommand(book, {
  type: "setRepetitionMode",
  item: "i",
  field: "members",
  repetition: "count",
});
assert.ok(!("rejected" in countMode));
assert.equal(
  (countMode.book.items[0].fields.members as RepetitionField).spacing,
  repetition.spacing,
);
for (const leaf of ["formula", "x"] as const) {
  const completions = completionsFor(book, book.items[0], leaf);
  assert.ok(completions.some((c) => c.insert === "members.openLengthCg.z"));
  assert.ok(completions.some((c) => c.insert === "structure.members.areaCg.x"));
  assert.equal(
    completions.some((c) => c.insert === "members.areaCg"),
    leaf === "x",
  );
  assert.equal(
    completions.some((c) => c.insert === "members"),
    false,
  );
  assert.equal(
    completions.some((c) => c.insert === "members.count"),
    false,
  );
}
console.log(
  "Repetition persistence, commands, reference rewriting and autocomplete passed",
);

const hull = defaultHull();
const model = assemble(hull),
  sampling = computeHullSampling(model, 80, 6);
const measure = createSectionMeasurer(model, sampling),
  cut = createSliceMeasurer(model, sampling);
for (const shape of ["transverse", "longitudinal", "plane"] as const) {
  const a = shape === "transverse" ? 1 : shape === "longitudinal" ? -0.5 : 0.2,
    b = shape === "transverse" ? 4 : shape === "longitudinal" ? 0.5 : 0.8;
  const result = measureRepetition(measure, shape, a, b);
  assert.ok(result.value, result.error ?? "valid hull integral");
  assert.ok(result.value.integrals.area.amount > 0);
  const grid = measureRepetition(measure, shape, a, b, (b - a) / 6.3);
  assert.ok(grid.value, grid.error ?? "valid hull phase sampling");
  near(
    grid.value.phaseTotals!.reduce((sum, p) => sum + p.weight, 0),
    1,
  );
}
const port = measure("longitudinal", -0.4),
  starboard = measure("longitudinal", 0.4);
near(port.area, starboard.area);
near(port.y, -starboard.y);
const single = cut("transverse", 2)!;
const cutBook: WeightBook = {
  ...emptyBook(),
  items: [
    {
      id: "c",
      name: "bulkhead",
      note: "",
      facets: {},
      fields: {
        section: { k: "cut", shape: "transverse", unit: "m", pos: "2 ± 0.01" },
        area: scalar("section.area"),
        length: scalar("section.openLength - section.openPerimeter"),
        cg: scalar("section.areaCg.z - section.z"),
      },
    },
  ],
};
const cutResults = evaluateBook(
  cutBook,
  null,
  new Map([["c section", single]]),
);
near(resultAt(cutResults, "c", "length")!.quantity!.v, 0);
near(resultAt(cutResults, "c", "length")!.reading!.worst.hi, 0);
near(resultAt(cutResults, "c", "cg")!.quantity!.v, 0);
near(resultAt(cutResults, "c", "cg")!.reading!.worst.hi, 0);
assert.ok(resultAt(cutResults, "c", "area")!.reading!.worst.hi > 0);
assert.deepEqual(parseSheet(buildSheetJson(cutBook)), cutBook);
console.log(
  "Real hull: all orientations, Repetition integration, lateral symmetry and legacy aliases passed",
);

const raked = assemble({ ...hull, deckRake: 0.12 });
const rakedSampling = computeHullSampling(raked, 80, 6);
const rakedMeasure = createSectionMeasurer(raked, rakedSampling);
const transverse = rakedMeasure("transverse", 2);
assert.ok(transverse.curve.length > 2);
for (const p of transverse.curve)
  near(
    p[0] * Math.cos(0.12) - p[2] * Math.sin(0.12),
    (raked.plan.at(0)[0] + 2000) * Math.cos(0.12),
    1e-7,
  );
assert.ok(
  Math.abs(transverse.x - 2) > 0.001,
  "true vertical is not constant deck-frame x with rake",
);
const horizontal = rakedMeasure("plane", 0.6);
for (const p of horizontal.sheetContours.flat()) near(p[2], 0.6);
near(rakedMeasure("station", 2).area, measure("station", 2).area);
let sequence = 0;
assert.match(
  measureRepetition(
    () =>
      raw({
        area: measureAt(++sequence, [1, 0, 0]),
        openLength: measureAt(sequence, [1, 0, 0]),
        closedLength: measureAt(sequence, [1, 0, 0]),
      }),
    "transverse",
    1,
    3,
  ).error!,
  /did not converge/,
);
console.log(
  "Rake frame, station regression and convergence diagnostics passed",
);

// Preview geometry must follow the measure, not draw artificial closing edges.
const previewSection = measure("transverse", 2);
const previewProjection = (p: Vec3): [number, number] => [p[0], p[2]];
assert.ok(samplePath(previewSection, "area", previewProjection).endsWith("Z"));
assert.ok(
  samplePath(previewSection, "closedLength", previewProjection).endsWith("Z"),
);
assert.ok(
  !samplePath(previewSection, "openLength", previewProjection).includes("Z"),
);
near(
  previewSection.sheetSkinSegments.reduce(
    (sum, [a, b]) => sum + Math.hypot(...a.map((v, i) => v - b[i])),
    0,
  ),
  previewSection.openPerimeter,
);
const previewSamples = [1, 2, 3].map((x) => measure("transverse", x));
assert.equal(
  nearestSample(previewSamples, [2.8, 0.6], previewProjection, 0),
  2,
);
assert.equal(
  nearestSample(previewSamples, [1.1, 0.6], previewProjection, 2),
  0,
);
const levels = [0.3, 0.5, 0.7].map((z) => measure("plane", z));
assert.equal(nearestSample(levels, [2, 0.68], previewProjection, 0), 2);
assert.equal(
  nearestSample(
    [previewSection, previewSection],
    [2, 0.6],
    previewProjection,
    1,
  ),
  1,
);
assert.equal(
  nearestSample([raw(zeroMeasures())], [0, 0], previewProjection, 0),
  null,
);
console.log(
  "Preview modes, skin-only paths, profile hover and overlap tie-breaking passed",
);

// The preview section count is visualization, not the authored equivalent count.
const previewMarkup = renderToStaticMarkup(
  createElement(RepetitionPreview, {
    measurement: { ...measured.value!, samples: previewSamples },
    equivalentCount: createElement("span", null, "14 ± 2"),
  }),
);
assert.ok(previewMarkup.includes("repetition preview"));
assert.ok(previewMarkup.includes("Equivalent count"));
assert.ok(previewMarkup.includes("14 ± 2"));
assert.ok(previewMarkup.includes("3 preview sections · visualization only"));
assert.ok(previewMarkup.includes('aria-label="Preview section"'));
assert.ok(!previewMarkup.includes("Repetition preview"));
assert.ok(!previewMarkup.includes("Preview sample"));
console.log("Preview section labeling stays distinct from equivalent count");
