import {
  emptyBook,
  type ScalarField,
  type WeightBook,
} from "../src/core/sheet/book";
import { cellKey } from "../src/core/sheet/evaluate";

export function formulaBook(
  formulas: Record<string, string | { formula: string; unit: string }>,
): WeightBook {
  return {
    ...emptyBook(),
    items: [
      {
        id: "i0",
        name: "Experiment",
        note: "",
        facets: {},
        fields: Object.fromEntries(
          Object.entries(formulas).map(([key, value]) => [
            key,
            {
              k: "scalar",
              role: null,
              unit: typeof value === "string" ? "" : value.unit,
              formula: typeof value === "string" ? value : value.formula,
            } satisfies ScalarField,
          ]),
        ),
      },
    ],
  };
}
export const target = (key: string) => cellKey("i0", key);

export function comparisonFixtures() {
  return [
    {
      name: "affine-shared-inputs",
      book: formulaBook({
        x: "100 ± 10",
        y: "20 ± [2, 8]",
        result: "3 * x - 2 * y + x - x",
      }),
      targets: [target("result")],
    },
    {
      name: "nonlinear-mass-and-cg",
      book: formulaBook({
        area: { formula: "15 ± 3", unit: "m^2" },
        density: { formula: "4 ± 1", unit: "kg/m^2" },
        shell: { formula: "area * density", unit: "kg" },
        equipment: { formula: "50 ± 20", unit: "kg" },
        position: { formula: "2 ± 0.5", unit: "m" },
        mass: { formula: "shell + equipment", unit: "kg" },
        cg: { formula: "equipment * position / mass", unit: "m" },
      }),
      targets: [target("mass"), target("cg")],
    },
    {
      name: "branch-crossings",
      book: formulaBook({ x: "0 ± 1", result: "abs(x)", clipped: "max(x, 0)" }),
      targets: [target("result"), target("clipped")],
    },
    {
      name: "invalid-worlds",
      book: formulaBook({ x: "0.25 ± 1", result: "sqrt(x)" }),
      targets: [target("x"), target("result")],
    },
    {
      name: "large-formula-book",
      book: formulaBook({
        density: "4 ± 1",
        ...Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [
            `part${i}`,
            `(10 ± 2) * density + ${i}`,
          ]),
        ),
        result: Array.from({ length: 100 }, (_, i) => `part${i}`).join(" + "),
      }),
      targets: [target("result")],
    },
  ];
}
