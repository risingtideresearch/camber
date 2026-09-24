import assert from "node:assert/strict";
import { type WeightBook } from "../src/core/sheet/book";
import { createReferenceBinder } from "../src/core/sheet/bindings";
import {
  cellKey,
  evaluatePreparedBook,
  fieldUses,
  fieldUsers,
  prepareBook,
} from "../src/core/sheet/evaluate";
import { parseFormula } from "../src/core/sheet/formula";
import { formulaBook, target } from "./sampling-fixtures";

const base = formulaBook({
  mass: { formula: "10", unit: "kg" },
  twice: "MASS + MASS",
  qualified: "Experiment.MASS",
  bad: "missing.value",
  empty: "",
});
const book: WeightBook = {
  ...base,
  items: [
    {
      ...base.items[0],
      facets: { system: "machinery" },
      fields: {
        ...base.items[0].fields,
        mass: { k: "scalar", formula: "10", unit: "kg", role: "MASS" },
      },
    },
    {
      id: "i1",
      name: "Other",
      note: "",
      facets: {},
      fields: {
        Experiment: {
          k: "point",
          x: "1",
          y: "2",
          z: "3",
          from: "",
          unit: "m",
          role: null,
        },
        shadow: { k: "scalar", formula: "Experiment.x", unit: "m", role: null },
      },
    },
  ],
  outputs: { DISPLACEMENT: "Experiment.MASS", VCG: "", LCG: "" },
  rollups: [
    {
      id: "r0",
      name: "machinery",
      facetKey: "system",
      facetValue: "machinery",
    },
  ],
};
const prepared = prepareBook(book);
const twice = prepared.cells.get(target("twice"))!;
assert.deepEqual([...twice.references.keys()], [0, 7]);
for (const ref of twice.references.values()) {
  assert.deepEqual(ref.path, ["MASS"]);
  assert.equal(ref.binding.k, "field");
  if (ref.binding.k === "field") {
    assert.equal(ref.binding.item.id, "i0");
    assert.equal(ref.binding.key, "mass");
    assert.equal(ref.binding.leaf, undefined);
  }
}
const shadow = prepared.cells
  .get(cellKey("i1", "shadow"))!
  .references.get(0)!.binding;
assert.equal(shadow.k, "field");
if (shadow.k === "field") {
  assert.equal(shadow.item.id, "i1");
  assert.equal(shadow.key, "Experiment");
  assert.equal(shadow.leaf, "x");
}
assert.equal(
  prepared.cells.get(target("bad"))!.references.get(0)!.binding.k,
  "error",
);
assert.equal(prepared.cells.get(target("empty"))!.references.size, 0);
const first = evaluatePreparedBook(prepared, null);
const second = evaluatePreparedBook(prepared, null);
assert.equal(first.cells.get(target("twice"))!.quantity!.v, 20);
assert.equal(first.cells.get(target("twice"))!.references, twice.references);
assert.equal(second.cells.get(target("twice"))!.references, twice.references);
assert.equal(first.cells.get(cellKey("i1", "shadow"))!.quantity!.v, 1);
assert.match(first.cells.get(target("bad"))!.error!, /no item called missing/);
assert.equal(first.cells.get(target("bad"))!.errorAt, 0);
assert.deepEqual(fieldUsers(book, first, "i0").get("mass"), [
  "Experiment.twice",
  "Experiment.qualified",
  "OUT.DISPLACEMENT",
]);
assert.deepEqual(
  fieldUses(book, first, "i0", "mass").map((use) => use.address),
  ["Experiment.twice", "Experiment.qualified", "OUT.DISPLACEMENT"],
);

const bind = createReferenceBinder(book);
const binding = (text: string, owner = book.items[0]) =>
  bind(parseFormula(text), owner).get(0)!.binding;
assert.deepEqual(binding("OUT.DISPLACEMENT"), {
  k: "output",
  name: "DISPLACEMENT",
});
assert.deepEqual(binding("HULL.SHELL_CG.z"), {
  k: "hull",
  path: ["SHELL_CG", "z"],
});
assert.equal(binding("ROLLUP.machinery.MASS").k, "rollup");
for (const text of [
  "OUT.VCG",
  "OUT.unknown",
  "ROLLUP.unknown.MASS",
  "Experiment.MASS.x.y",
  "HULL.x.y.z",
  "mass.x.y",
])
  assert.equal(binding(text).k, "error", text);
assert.equal(bind(parseFormula("MASS"), null).get(0)!.binding.k, "error");
assert.equal(binding("MASS", book.items[1]).k, "error");

// Binding failures belong to occurrences, not a whole formula. Earlier runtime
// failures retain their normal precedence and errors retain the reference span.
const errors = prepareBook(
  formulaBook({
    first: "1 / 0 + missing.value",
    later: "1 + missing.value",
    good: "2",
  }),
);
const errorResults = evaluatePreparedBook(errors, null);
assert.doesNotMatch(errorResults.cells.get(target("first"))!.error!, /missing/);
assert.equal(errorResults.cells.get(target("later"))!.errorAt, 4);
assert.equal(errorResults.cells.get(target("good"))!.quantity!.v, 2);

// A new revision rebinds role ownership; the old plan remains valid and reusable.
const changed: WeightBook = {
  ...book,
  items: [
    {
      ...book.items[0],
      fields: {
        ...book.items[0].fields,
        mass: { k: "scalar", formula: "10", unit: "kg", role: null },
        replacement: { k: "scalar", formula: "15", unit: "kg", role: "MASS" },
      },
    },
    book.items[1],
  ],
};
const changedResults = evaluatePreparedBook(prepareBook(changed), null);
assert.equal(changedResults.cells.get(target("twice"))!.quantity!.v, 30);
assert.equal(
  evaluatePreparedBook(prepared, null).cells.get(target("twice"))!.quantity!.v,
  20,
);
const ambiguous = {
  ...book,
  items: [
    {
      ...changed.items[0],
      fields: { ...changed.items[0].fields, mass: book.items[0].fields.mass },
    },
    book.items[1],
  ],
};
assert.match(
  evaluatePreparedBook(prepareBook(ambiguous), null).cells.get(target("twice"))!
    .error!,
  /only one of them can be/,
);
console.log(
  "Reference binding: occurrences, shadowing, roles, errors, inspection and revision isolation passed",
);
