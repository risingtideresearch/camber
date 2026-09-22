import { defaultHull } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import type { Vec3 } from "../src/core/math";
import {
  createSectionMeasurer,
  type RawSliceMeasurement,
} from "../src/core/sheet/slices";
import { measureAt } from "../src/core/sheet/sectionMeasures";
import type { WeightBook } from "../src/core/sheet/book";
import { formulaBook, target } from "./sampling-fixtures";

export function syntheticSection(
  amount: number,
  x: number,
): RawSliceMeasurement {
  const centroid: Vec3 = [x, 0, 1];
  return {
    measures: {
      area: measureAt(amount, centroid),
      openLength: measureAt(amount, centroid),
      closedLength: measureAt(amount, centroid),
    },
    area: amount,
    openPerimeter: amount,
    closedPerimeter: amount,
    x,
    y: 0,
    z: 1,
    centroid,
    curve: [],
    contours: [],
    sheetContours: [],
    sheetSkinSegments: [],
  };
}
export function repetitionBook(
  start: number,
  end: number,
  count: number,
): WeightBook {
  const book = formulaBook({
    amount: { formula: "members.area", unit: "m^2" },
    cg: { formula: "members.areaCg.x", unit: "m" },
    moment: { formula: "members.area * members.areaCg.x", unit: "m^3" },
    // Equal areal density: variable panels at height 2 m, fixed ballast at 0 m.
    // The combined CG remains defined even for an empty panel layout.
    ballast: { formula: "5", unit: "m^2" },
    height: { formula: "2", unit: "m" },
    loadedCg: {
      formula: "members.area * height / (members.area + ballast)",
      unit: "m",
    },
  });
  return {
    ...book,
    items: [
      {
        ...book.items[0],
        fields: {
          ...book.items[0].fields,
          members: {
            k: "repetition",
            shape: "transverse",
            unit: "m",
            start: String(start),
            end: String(end),
            repetition: "count",
            count: String(count),
            spacing: "",
          },
        },
      },
    ],
  };
}
export const repetitionTargets = ["amount", "cg", "moment", "loadedCg"].map(
  target,
);

export function repetitionComparisonFixtures(includeHull = true) {
  const synthetic = [
    {
      name: "uniform-integer",
      start: 0,
      end: 4,
      count: 4,
      amount: (_x: number) => 2,
    },
    {
      name: "varying-dense",
      start: 0,
      end: 4,
      count: 8,
      amount: (x: number) => 1 + x * x,
    },
    {
      name: "varying-fractional",
      start: 0,
      end: 4,
      count: 2.3,
      amount: (x: number) => 1 + x * x,
    },
    {
      name: "sparse-empty",
      start: 0,
      end: 1,
      count: 0.6,
      amount: (x: number) => 1 + 3 * x,
    },
  ].map(({ name, start, end, count, amount }) => ({
    name,
    book: repetitionBook(start, end, count),
    measure: (_shape: unknown, x: number) => syntheticSection(amount(x), x),
    targets: repetitionTargets,
  }));
  if (!includeHull) return synthetic;
  const model = assemble(defaultHull());
  const sampling = computeHullSampling(model, 80, 6);
  const measure = createSectionMeasurer(model, sampling);
  return [
    ...synthetic,
    {
      name: "default-hull-fractional",
      book: repetitionBook(1, 4, 6.3),
      measure,
      targets: repetitionTargets,
    },
  ];
}
