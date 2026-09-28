import { defaultHull } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import { createSectionMeasurer } from "../src/core/sheet/slices";
import type { WeightBook } from "../src/core/sheet/book";
import { repetitionBook } from "./repetition-sampling-fixtures";
import { target } from "./sampling-fixtures";
import type { SliceComparisonFixture } from "./compare-slice-backends";

export function sliceBackendFixtures(): readonly SliceComparisonFixture[] {
  const model = assemble(defaultHull()),
    sampling = computeHullSampling(model, 80, 6);
  return [false, true].map((varyTrim) => {
    const base = repetitionBook(1, 4, 6.3);
    const members = base.items[0].fields.members;
    if (members.k !== "repetition")
      throw new Error("Missing fixture repetition");
    const boundaries = varyTrim
      ? { topHeight: "0.8 ± 0.1", boundaryEnabled: { topHeight: true } }
      : {};
    const book: WeightBook = {
      ...base,
      items: [
        {
          ...base.items[0],
          fields: {
            ...base.items[0].fields,
            members: {
              ...members,
              start: "1 ± 0.2",
              end: "4 ± 0.2",
              count: "6.3 ± 1",
              ...boundaries,
            },
            density: {
              k: "scalar",
              formula: "4 ± 1",
              unit: "kg/m^2",
              role: null,
            },
            mass: {
              k: "scalar",
              formula: "members.area * density",
              unit: "kg",
              role: null,
            },
            cut: {
              k: "cut",
              shape: "transverse",
              unit: "m",
              pos: "2.5 ± 1",
              ...boundaries,
            },
            cutMass: {
              k: "scalar",
              formula: "cut.area * density",
              unit: "kg",
              role: null,
            },
          },
        },
      ],
    };
    return {
      name: varyTrim
        ? "default-hull-variable-trim-fallback"
        : "default-hull-variable-bounds-count-materials",
      book,
      targets: ["amount", "cg", "mass", "cutMass"].map(target),
      createMeasure: () => {
        const measure = createSectionMeasurer(model, sampling);
        return ({ shape, position, limits }) => {
          const raw = measure(shape, position, limits);
          return {
            measures: raw.measures,
            topology: `contours:${raw.sheetContours.length}`,
          };
        };
      },
      table: {
        shape: "transverse",
        start: 0.75,
        end: 4.25,
        limits: varyTrim ? { topHeight: 0.8 } : {},
      },
    } satisfies SliceComparisonFixture;
  });
}
