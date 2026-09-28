import { formulaBook } from "./sampling-fixtures";
import { syntheticSection } from "./repetition-sampling-fixtures";
import { directTrialGeometry } from "../src/core/sheet/trial";
import type { RepetitionField } from "../src/core/sheet/book";

/** Two independent layouts with shared sampled materials, extent, pitch and trim. */
export function mixedTrialBook() {
  const book = formulaBook({
    extent: { formula: "4 ± 1", unit: "m" },
    pitch: { formula: "1 ± 0.2", unit: "m" },
    height: { formula: "2 ± 0.5", unit: "m" },
    density: { formula: "10 ± 2", unit: "kg/m^2" },
    firstMass: { formula: "first.area * density", unit: "kg" },
    secondMass: { formula: "second.area * density", unit: "kg" },
    total: { formula: "firstMass + secondMass", unit: "kg" },
    cg: {
      formula:
        "(firstMass * first.areaCg.x + secondMass * second.areaCg.x) / total",
      unit: "m",
    },
    cutMass: { formula: "cut.area * density", unit: "kg" },
    cancel: { formula: "firstMass - firstMass", unit: "kg" },
    // Source discovery must not depend on nominal geometry being available.
    inline: { formula: "first.area * (1 ± 0.1)", unit: "m^2" },
  });
  const repetition: RepetitionField = {
    k: "repetition",
    shape: "transverse",
    start: "0",
    end: "extent",
    unit: "m",
    repetition: "spacing",
    spacing: "pitch",
    count: "",
    topHeight: "height",
    boundaryEnabled: { topHeight: true },
  };
  return {
    ...book,
    items: [
      {
        ...book.items[0],
        fields: {
          ...book.items[0].fields,
          first: repetition,
          second: { ...repetition },
          cut: {
            k: "cut" as const,
            shape: "transverse" as const,
            pos: "extent / 2",
            unit: "m",
            topHeight: "height",
            boundaryEnabled: { topHeight: true },
          },
        },
      },
    ],
  };
}
export const mixedTrialGeometry = () =>
  directTrialGeometry(
    ({ position, limits }) =>
      syntheticSection((1 + position) * (limits.topHeight ?? 2), position)
        .measures,
  );
