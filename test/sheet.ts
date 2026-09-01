// The weight book: the item model, its evaluation, and the views over it.
//
// What is being checked, throughout, is that an ADDRESS names a thing and never where the thing is filed.
// That is the one rule the model turns on, and most of what follows is a way of asking whether it still
// holds: rename an item and formulas follow it; refile it and nothing moves; reorder the book and no value
// changes.

import { defaultHull } from "../src/core/hull";
import { buildHullMesh } from "../src/core/hullGeometry";
import { hullMetrics, HULL_METRICS } from "../src/core/hullMetrics";
import { unitScale } from "../src/core/json";
import { computeHullSampling } from "../src/core/mesh";
import { stationGeometry } from "../src/core/sweep";
import { assemble } from "../src/core/runtime";
import {
  FormulaError,
  parseFormula,
  tokenize,
} from "../src/core/sheet/formula";
import {
  evaluateBook,
  fieldUsers,
  fieldUses,
  outputResult,
  resultAt,
} from "../src/core/sheet/evaluate";
import { buildSheetJson, parseSheet } from "../src/core/sheet/json";
import {
  emptyBook,
  facetContains,
  interpretSheetCommand,
  isValidFacetValue,
  primaryFacet,
  symbolsOf,
  tidyFacetValue,
  type FieldLeaf,
  type SheetCommand,
  type WeightBook,
} from "../src/core/sheet/book";
import {
  facetView,
  fieldKeyOrder,
  groupItems,
  problemsOf,
  resolveView,
  scopeItems,
  standardViews,
  UNFILED,
  viewColumns,
  viewRows,
} from "../src/core/sheet/views";
import { parseUnit, naturalUnit, UnitError } from "../src/core/sheet/units";
import { createSliceMeasurer, measureSlice } from "../src/core/sheet/slices";
import {
  hullOutlines,
  likelyRegion,
  readPlacement,
  readTolerance,
  sectionOutline,
  toModel,
  verticalSection,
  toSheet,
  withNominal,
  withoutHandle,
  withTolerance,
  worstRegion,
} from "../src/core/sheet/points";
import { sameGesture, type DocumentCommand } from "../src/core/commands";
import { bookViolations } from "../src/core/invariants";
import {
  completionsFor,
  suggestAt,
} from "../src/editor/weight/weightCompletions";

let failures = 0;
const ok = (condition: unknown, message: string) => {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    failures++;
  }
};
const near = (a: number, b: number, tol: number): boolean =>
  Math.abs(a - b) <= tol;

// ---------- a book builder, so the tests read like the panel ----------

const run = (book: WeightBook, command: SheetCommand): WeightBook => {
  const out = interpretSheetCommand(book, command);
  if ("rejected" in out) throw new Error(out.rejected);
  return out.book;
};

interface Line {
  name?: string;
  /** The `system` facet, since that is what the tree is built from by default. */
  system?: string;
  formula?: string;
  unit?: string;
  /** The field key. `value` unless a test wants to say otherwise. */
  key?: string;
}

/** A book of scalar items, ids `i0`, `i1`, … so a test can address one without looking it up. */
function build(lines: Line[]): WeightBook {
  let book = emptyBook();
  lines.forEach((line, i) => {
    const id = `i${i}`;
    const key = line.key ?? "value";
    book = run(book, {
      type: "addItem",
      id,
      name: line.name ?? "",
      after: i - 1,
    });
    book = run(book, { type: "addField", item: id, key, kind: "scalar" });
    if (line.formula !== undefined)
      book = run(book, {
        type: "setFieldFormula",
        item: id,
        field: key,
        leaf: "formula",
        formula: line.formula,
      });
    if (line.unit !== undefined)
      book = run(book, {
        type: "setFieldUnit",
        item: id,
        field: key,
        unit: line.unit,
      });
    if (line.system !== undefined)
      book = run(book, {
        type: "setFacet",
        item: id,
        key: "system",
        value: line.system,
      });
  });
  return book;
}

const idOf = (book: WeightBook, name: string): string =>
  book.items.find((item) => item.name === name)!.id;

/** Give an existing item a point, so a test can mix kinds on one item the way the model allows. */
function point(
  book: WeightBook,
  name: string,
  cells: { x?: string; y?: string; z?: string; unit?: string; from?: string },
  key = "position",
): WeightBook {
  const item = idOf(book, name);
  let out = run(book, { type: "addField", item, key, kind: "point" });
  for (const leaf of ["x", "y", "z", "from"] as const)
    if (cells[leaf] !== undefined)
      out = run(out, {
        type: "setFieldFormula",
        item,
        field: key,
        leaf,
        formula: cells[leaf]!,
      });
  if (cells.unit !== undefined)
    out = run(out, {
      type: "setFieldUnit",
      item,
      field: key,
      unit: cells.unit,
    });
  return out;
}

function cut(
  book: WeightBook,
  name: string,
  spec: { shape?: "plane" | "station"; pos?: string; unit?: string },
  key = "section",
): WeightBook {
  const item = idOf(book, name);
  let out = run(book, { type: "addField", item, key, kind: "cut" });
  if (spec.shape)
    out = run(out, {
      type: "setCutShape",
      item,
      field: key,
      shape: spec.shape,
    });
  if (spec.pos !== undefined)
    out = run(out, {
      type: "setFieldFormula",
      item,
      field: key,
      leaf: "pos",
      formula: spec.pos,
    });
  if (spec.unit !== undefined)
    out = run(out, { type: "setFieldUnit", item, field: key, unit: spec.unit });
  return out;
}

const cellAt = (
  book: WeightBook,
  name: string,
  key = "value",
  leaf: FieldLeaf = "formula",
  metrics: Parameters<typeof evaluateBook>[1] = null,
) => resultAt(evaluateBook(book, metrics), idOf(book, name), key, leaf);

const value = (book: WeightBook, name: string, key = "value"): number =>
  cellAt(book, name, key)!.reading!.v;

const problem = (
  book: WeightBook,
  name: string,
  key = "value",
  metrics: Parameters<typeof evaluateBook>[1] = null,
): string | null => cellAt(book, name, key, "formula", metrics)!.error;

// ---------- the grammar ----------
{
  const one = (source: string): number =>
    value(build([{ name: "x", formula: source }]), "x");

  ok(one("1 + 2 * 3") === 7, "multiplication binds tighter than addition");
  ok(one("(1 + 2) * 3") === 9, "parentheses win");
  ok(one("2 ^ 3 ^ 2") === 512, "powers are right associative");
  // -(2^2), the mathematical convention. Excel answers 4 here; this is not a spreadsheet.
  ok(one("-2 ^ 2") === -4, "a leading minus applies after the power");
  ok(one("(-2) ^ 2") === 4, "and parentheses say the other thing");
  ok(one("10 / 4 / 5") === 0.5, "division is left associative");
  ok(near(one("7%"), 0.07, 1e-12), "a percentage outside a ± is just ÷100");
  ok(near(one("200 * 7%"), 14, 1e-12), "which is what a margin reads as");
  ok(one("sqrt(9) * abs(-2)") === 6, "functions and their arguments");
  ok(one("max(1, 7, 3) - min(1, 7, 3)") === 6, "min and max take any count");
  ok(near(one("sin(30)"), 0.5, 1e-12), "the trig is in degrees, not radians");
  ok(one("2 × 3") === 6, "a pasted × is read as multiplication");
  ok(one("5 − 2") === 3, "and a pasted en-dash as a minus");
  ok(one("1e3") === 1000, "exponent notation");

  const spread = (source: string) =>
    cellAt(build([{ name: "x", formula: source }]), "x")!.reading!;
  let r = spread("4.2 ± 0.3");
  ok(
    r.v === 4.2 && near(r.worst.lo, 0.3, 1e-12) && near(r.worst.hi, 0.3, 1e-12),
    "a symmetric ±",
  );
  r = spread("4.2 +- 0.3");
  ok(near(r.worst.hi, 0.3, 1e-12), "the ASCII spelling of ± means the same");
  r = spread("200 ± 5%");
  ok(near(r.worst.hi, 10, 1e-12), "a ± in percent is relative to the nominal");
  r = spread("100 ± [2, 9]");
  ok(
    near(r.worst.lo, 2, 1e-12) && near(r.worst.hi, 9, 1e-12),
    "an asymmetric ± keeps its two sides apart",
  );
  r = spread("[4.0, 4.5]");
  ok(
    near(r.v, 4.25, 1e-12) && near(r.worst.hi, 0.25, 1e-12),
    "a bare range has its nominal at the midpoint",
  );
  r = spread("2 * 3 ± 1");
  ok(
    r.v === 6 && near(r.worst.hi, 2, 1e-12),
    "a ± attaches to the number it follows, not the whole expression",
  );

  let caught: unknown = null;
  try {
    parseFormula("1 + * 2");
  } catch (error) {
    caught = error;
  }
  ok(
    caught instanceof FormulaError && caught.at === 4,
    "a parse error points at the character it failed on",
  );
  ok(tokenize("").length === 1, "an empty formula tokenizes to just the end");
}

// ---------- names with spaces ----------
{
  const book = build([
    { name: "ply density", formula: "4.2" },
    { name: "shell area", formula: "30" },
    { name: "hull shell", formula: "ply density.value * shell area.value" },
  ]);
  ok(
    value(book, "hull shell") === 126,
    "two multi-word names either side of an operator read as two names",
  );
  ok(
    symbolsOf(book).includes("ply density"),
    "the symbol table carries every item name",
  );
  ok(
    symbolsOf(book)[0].length >= symbolsOf(book)[1].length,
    "longest first, so a name that is the prefix of another cannot win",
  );

  const nested = build([
    { name: "shell", formula: "2" },
    { name: "shell area", formula: "30" },
    { name: "x", formula: "shell area.value + shell.value" },
  ]);
  ok(
    value(nested, "x") === 32,
    "and `shell area` is taken whole rather than as `shell` followed by a stray `area`",
  );

  ok(
    "rejected" in
      interpretSheetCommand(build([{ name: "a" }]), {
        type: "renameItem",
        item: "i0",
        name: "2 bad",
      }),
    "a name a formula could not resolve is refused",
  );
  ok(
    "rejected" in
      interpretSheetCommand(build([{ name: "a" }]), {
        type: "renameItem",
        item: "i0",
        name: "HULL",
      }),
    "and so is a name the language reserves",
  );
  ok(
    !(
      "rejected" in
      interpretSheetCommand(build([{ name: "a" }]), {
        type: "renameItem",
        item: "i0",
        name: "",
      })
    ),
    "but an unnamed item is legal — it is the scratch line a grid spends a column on",
  );
}

// ---------- an address names a thing, never where it is filed ----------
{
  let book = build([
    { name: "shell", system: "structure/hull", formula: "12" },
    { name: "total", system: "totals", formula: "shell.value * 2" },
  ]);
  ok(value(book, "total") === 24, "a formula reads another item's field");

  const refiled = run(book, {
    type: "setFacet",
    item: idOf(book, "shell"),
    key: "system",
    value: "machinery",
  });
  ok(
    value(refiled, "total") === 24,
    "refiling the item it names changes nothing — filing is not part of the address",
  );

  const renamed = run(book, {
    type: "renameItem",
    item: idOf(book, "shell"),
    name: "hull shell",
  });
  ok(
    (problem(renamed, "total") ?? "").includes("no item called shell"),
    "renaming DOES break the formulas that named it, loudly and by name",
  );

  book = run(book, { type: "moveItem", item: idOf(book, "total"), to: 0 });
  ok(
    value(book, "total") === 24,
    "and order is presentation: a formula may name an item that comes after it",
  );
}

// ---------- what names a field, which is what removing it would break ----------
{
  let book = build([
    { name: "shell", key: "area", formula: "30" },
    { name: "total", formula: "shell.area * 2" },
    { name: "other", formula: "shell.area" },
  ]);
  book = run(book, {
    type: "addField",
    item: idOf(book, "shell"),
    key: "mass",
    kind: "scalar",
  });
  book = run(book, {
    type: "setFieldFormula",
    item: idOf(book, "shell"),
    field: "mass",
    leaf: "formula",
    formula: "area * 5",
  });
  // Two of the three coordinates name it, which is still ONE thing to go and edit.
  book = point(book, "shell", { x: "area", z: "area" }, "cg");
  book = run(book, {
    type: "setOutput",
    name: "DISPLACEMENT",
    formula: "shell.area",
  });
  // `other` carries a field of its own called `shell`, so `shell.area` written there is its own point being
  // asked for an `area` it has not got — not a reference to the item at all. A sibling shadows an item.
  book = point(book, "other", { x: "0" }, "shell");

  const named = fieldUsers(book, evaluateBook(book, null), idOf(book, "shell"));
  const users = [...(named.get("area") ?? [])].sort();
  ok(
    users.join(" | ") ===
      "OUT.DISPLACEMENT | shell.cg | shell.mass | total.value",
    `every cell that names shell.area, once each and by address (${users.join(", ")})`,
  );
  ok(
    !users.includes("other.value"),
    "and not the one where a sibling of the same name shadows the item — that names nothing here",
  );
  ok(
    (named.get("mass") ?? []).length === 0,
    "a field nothing names has no users, which is what makes removing it a one-click affair",
  );

  const occurrences = fieldUses(
    book,
    evaluateBook(book, null),
    idOf(book, "shell"),
    "area",
  );
  ok(
    occurrences
      .map((use) => use.address)
      .sort()
      .join(" | ") ===
      "OUT.DISPLACEMENT | shell.cg.x | shell.cg.z | shell.mass | total.value",
    "individual uses retain the formula cell that the inspector can navigate to",
  );
  ok(
    occurrences.find((use) => use.address === "OUT.DISPLACEMENT")?.itemId ===
      "OUT",
    "an output use retains its pseudo-item address so navigation can open the summary",
  );
}

// ---------- fields are local to their item ----------
{
  const book = build([
    { name: "shell", key: "area", formula: "30" },
    { name: "deck", key: "area", formula: "12" },
  ]);
  ok(
    value(book, "shell", "area") === 30 && value(book, "deck", "area") === 12,
    "two items may use one field key for unrelated numbers — a key means nothing outside its item",
  );

  let sibling = run(book, {
    type: "addField",
    item: idOf(book, "shell"),
    key: "density",
    kind: "scalar",
  });
  sibling = run(sibling, {
    type: "setFieldFormula",
    item: idOf(book, "shell"),
    field: "density",
    leaf: "formula",
    formula: "4.2",
  });
  sibling = run(sibling, {
    type: "addField",
    item: idOf(book, "shell"),
    key: "mass",
    kind: "scalar",
  });
  sibling = run(sibling, {
    type: "setFieldFormula",
    item: idOf(book, "shell"),
    field: "mass",
    leaf: "formula",
    formula: "area * density",
  });
  ok(
    near(value(sibling, "shell", "mass"), 126, 1e-9),
    "a bare name is a SIBLING field — the scope you are standing in wins",
  );
  ok(
    problem(sibling, "deck", "area") === null &&
      value(sibling, "deck", "area") === 12,
    "and the same bare name on another item resolves to that item's own",
  );

  const shadowed = run(sibling, {
    type: "setFieldFormula",
    item: idOf(book, "deck"),
    field: "area",
    leaf: "formula",
    formula: "shell.area / 2",
  });
  ok(
    value(shadowed, "deck", "area") === 15,
    "the other item's field is always reachable by naming the item",
  );

  ok(
    (problem(book, "shell", "area") === null) === true &&
      (
        problem(
          run(book, {
            type: "setFieldFormula",
            item: idOf(book, "deck"),
            field: "area",
            leaf: "formula",
            formula: "shell",
          }),
          "deck",
          "area",
        ) ?? ""
      ).includes("is an item — write shell.something"),
    "naming an item with no field says which fields it has rather than 'no such name'",
  );

  ok(
    "rejected" in
      interpretSheetCommand(book, {
        type: "addField",
        item: idOf(book, "shell"),
        key: "area",
        kind: "scalar",
      }),
    "one item cannot carry the same key twice",
  );

  const renamedField = run(book, {
    type: "renameField",
    item: idOf(book, "shell"),
    key: "area",
    name: "wetted area",
  });
  ok(
    Object.keys(renamedField.items[0].fields).join() === "wetted area",
    "a field renames in place rather than moving to the end — its column stays put",
  );
}

// ---------- facets ----------
{
  ok(
    isValidFacetValue("structure/hull/shell") &&
      isValidFacetValue("weighed") &&
      !isValidFacetValue("") &&
      !isValidFacetValue("a//b"),
    "a facet value is one or more path segments",
  );
  ok(
    tidyFacetValue(" structure / hull / ") === "structure/hull",
    "and commits tidied, so a stray separator is not a level",
  );
  ok(
    facetContains("structure", "structure/hull/shell") &&
      facetContains("structure", "structure") &&
      !facetContains("structure", "structures/hull"),
    "containment is by whole segment — `structures` is not under `structure`",
  );

  let book = build([
    { name: "a", system: "structure/hull" },
    { name: "b", system: "structure/deck" },
    { name: "c" },
  ]);
  ok(primaryFacet(book) === "system", "`system` is the tree's default facet");

  const unfiled = run(book, {
    type: "setFacet",
    item: idOf(book, "a"),
    key: "system",
    value: "",
  });
  ok(
    !("system" in unfiled.items[0].facets),
    "unfiling REMOVES the key rather than storing a blank, so there is one shape for 'not filed'",
  );

  book = run(book, {
    type: "setFacet",
    item: idOf(book, "a"),
    key: "status",
    value: "weighed",
  });
  ok(
    book.items[0].facets.system === "structure/hull" &&
      book.items[0].facets.status === "weighed",
    "a second facet cuts across the first — an item is in both trees at once",
  );

  ok(
    "rejected" in
      interpretSheetCommand(book, {
        type: "setFacet",
        item: idOf(book, "a"),
        key: "system",
        value: "bad-value",
      }),
    "a value the tree could not split on is refused",
  );
}

// ---------- grouping ----------
{
  const book = build([
    { name: "shell", system: "structure/hull" },
    { name: "frames", system: "structure/hull" },
    { name: "deck", system: "structure/deck" },
    { name: "engine", system: "machinery" },
    { name: "spare" },
  ]);
  const groups = groupItems(book.items, ["system"]);
  const labels = groups.map((group) => group.label);
  ok(
    labels[0] === "structure" && labels[1] === "machinery",
    "one level per leading segment, in the order the items appear",
  );
  ok(
    labels[labels.length - 1] === UNFILED,
    "and the unfiled bucket goes last, so a half-organised book shows its own state",
  );
  ok(
    groups[0].count === 3 && groups[0].items.length === 0,
    "a node counts everything beneath it, and holds only what stops there",
  );
  const hull = groups[0].children.find((child) => child.label === "hull")!;
  ok(
    hull.items.map((item) => item.name).join() === "shell,frames" &&
      hull.value === "structure/hull",
    "a path value nests without anything storing a parent",
  );

  const flat = groupItems(book.items, []);
  ok(flat.length === 0, "no grouping keys means no groups at all");

  const two = groupItems(
    run(book, {
      type: "setFacet",
      item: idOf(book, "shell"),
      key: "status",
      value: "weighed",
    }).items,
    ["system", "status"],
  );
  ok(
    two.length > 0 && two[0].children.length > 0,
    "a second key nests inside the first",
  );
}

// ---------- views ----------
{
  let book = build([
    { name: "shell", system: "structure", key: "mass", formula: "900" },
    { name: "engine", system: "machinery", key: "mass", formula: "780" },
    { name: "ply", key: "density", formula: "4.2" },
  ]);
  book = point(book, "engine", { x: "1.8", y: "0", z: "0.4" }, "cg");
  book = cut(book, "shell", { shape: "station", pos: "2" }, "midship");

  ok(
    scopeItems(book, { k: "all" }).length === 3,
    "an `all` scope takes the whole book",
  );
  ok(
    scopeItems(book, { k: "fieldType", type: "point" })
      .map((item) => item.name)
      .join() === "engine",
    "a `fieldType` scope takes every item carrying that kind of field",
  );
  ok(
    scopeItems(book, { k: "facet", key: "system", value: "structure" })
      .map((item) => item.name)
      .join() === "shell",
    "and a `facet` scope takes a value and everything under it",
  );
  ok(
    scopeItems(book, { k: "item", item: idOf(book, "ply") }).length === 1,
    "an `item` scope is the detail view's own",
  );

  const views = standardViews(book);
  const names = views.map((view) => view.name);
  ok(
    names[0] === "Summary" && names[names.length - 1] === "Problems",
    "the standard views open on what the estimate answers and end with what is wrong",
  );
  ok(
    !names.some((name) =>
      ["Values", "Positions", "Sections", "Everything"].includes(name),
    ),
    "editing scopes are opened from the explorer rather than added as automatic tabs",
  );

  // Column derivation remains available to explorer-opened and saved views even though field-kind views are
  // no longer automatically listed in the bar.
  const valuesView = {
    id: "test-values",
    name: "Values",
    scope: { k: "fieldType", type: "scalar" },
    groupBy: ["system"],
    layout: "table",
  } as const;
  const scoped = scopeItems(book, valuesView.scope);
  const columns = viewColumns(valuesView, scoped);
  ok(
    columns.map((column) => column.label).join() === "mass,density",
    "a kind view shows that kind's keys and nothing else — the column axis is emergent",
  );
  ok(
    fieldKeyOrder(book.items).join() === "mass,midship,cg,density",
    "columns come in first-appearance order, so a second item cannot move an existing one",
  );

  const positions = {
    ...valuesView,
    id: "test-positions",
    name: "Positions",
    scope: { k: "fieldType", type: "point" },
    layout: "split",
  } as const;
  const pointColumns = viewColumns(
    positions,
    scopeItems(book, positions.scope),
  );
  ok(
    pointColumns.map((column) => column.label).join() === "x,y,z" &&
      pointColumns.every((column) => column.band === "cg"),
    "a point is three columns under one spanned header",
  );

  const sections = {
    ...valuesView,
    id: "test-sections",
    name: "Sections",
    scope: { k: "fieldType", type: "cut" },
    layout: "split",
  } as const;
  const cutColumns = viewColumns(sections, scopeItems(book, sections.scope));
  ok(
    cutColumns.map((column) => column.source.k).join() === "leaf,measure",
    "a cut is its authored position and one measured column, and the two are different shapes",
  );

  const rows = viewRows(valuesView, scoped);
  ok(
    rows.filter((row) => row.k === "group").length > 0 &&
      rows.filter((row) => row.k === "item").length === scoped.length,
    "a grouped view interleaves headers with every item it scopes",
  );
  ok(
    viewRows({ ...valuesView, groupBy: [] }, scoped).every(
      (row) => row.k === "item",
    ),
    "and an ungrouped one is a flat list",
  );

  ok(
    resolveView(book, "nope").id === views[0].id,
    "an id nothing answers to falls back to the first standard view",
  );
  ok(
    resolveView(book, `item-${idOf(book, "ply")}`).layout === "detail",
    "a per-item view is built on demand rather than listed",
  );
  const fv = facetView("system", "structure/hull");
  ok(
    resolveView(book, fv.id).scope.k === "facet" &&
      (resolveView(book, fv.id).scope as { value: string }).value ===
        "structure/hull",
    "and a facet view round-trips through its id, path and all",
  );
}

// ---------- failure is per cell ----------
{
  const book = build([
    { name: "good", formula: "2 + 2" },
    { name: "bad", formula: "1 +" },
    { name: "leans", formula: "bad.value * 2" },
    { name: "fine", formula: "good.value * 3" },
  ]);
  ok(value(book, "good") === 4, "a good cell evaluates");
  ok(problem(book, "bad") !== null, "a broken one reports");
  ok(
    (problem(book, "leans") ?? "").includes("could not be worked out"),
    "one that leans on it says whose fault it was",
  );
  ok(value(book, "fine") === 12, "and the rest of the book is untouched");

  const loop = build([
    { name: "a", formula: "b.value" },
    { name: "b", formula: "a.value" },
  ]);
  ok(
    (problem(loop, "a") ?? "").includes("refers back to itself") &&
      (problem(loop, "b") ?? "").includes("refers back to itself"),
    "every cell on a cycle names the loop, not just the one that closed it",
  );
  ok(
    (problem(loop, "a") ?? "").includes("a.value") &&
      (problem(loop, "a") ?? "").includes("b.value"),
    "and names it as item.field, which is what a reader would go and look for",
  );

  const empty = build([{ name: "a" }, { name: "b", formula: "a.value" }]);
  ok(
    cellAt(empty, "a")!.empty && cellAt(empty, "a")!.error === null,
    "an empty cell is empty rather than wrong",
  );
  ok(
    (problem(empty, "b") ?? "").includes("is empty"),
    "though naming one is an error, and says so plainly",
  );
}

// ---------- units ----------
{
  ok(parseUnit("kg").dim.m === 1, "kg is a mass");
  ok(near(parseUnit("t").factor, 1000, 1e-12), "a tonne is 1000 of them");
  ok(parseUnit("kg/m2").dim.l === -2, "an areal density divides by an area");
  ok(naturalUnit(parseUnit("kg").dim).label === "kg", "and reads back");
  let caught: unknown = null;
  try {
    parseUnit("furlong");
  } catch (error) {
    caught = error;
  }
  ok(caught instanceof UnitError, "an unknown unit is refused");

  const declared = build([{ name: "a", formula: "1.4", unit: "t" }]);
  ok(
    value(declared, "a") === 1400,
    "a dimensionless formula is READ in the declared unit: 1.4 t is 1400 kg",
  );
  ok(
    cellAt(declared, "a")!.unit?.label === "t" &&
      !cellAt(declared, "a")!.unitIsDerived,
    "and is shown in the unit it was written in",
  );

  const derivedUnit = build([
    { name: "area", formula: "30", unit: "m2" },
    { name: "density", formula: "4.2", unit: "kg/m2" },
    { name: "mass", formula: "area.value * density.value" },
  ]);
  ok(
    near(value(derivedUnit, "mass"), 126, 1e-9) &&
      cellAt(derivedUnit, "mass")!.unit?.label === "kg" &&
      cellAt(derivedUnit, "mass")!.unitIsDerived,
    "a unit appears on its own the moment a formula acquires a dimension",
  );

  const mismatch = build([
    { name: "area", formula: "30", unit: "m2" },
    { name: "wrong", formula: "area.value", unit: "kg" },
  ]);
  ok(
    cellAt(mismatch, "wrong")!.unitWarning !== null &&
      cellAt(mismatch, "wrong")!.error === null,
    "a declared unit that disagrees is a warning, not a refusal — the number is reported as computed",
  );

  const bad = build([{ name: "a", formula: "1", unit: "nope" }]);
  ok(
    problem(bad, "a") !== null,
    "but a unit that will not parse is an error on the cell",
  );
}

// ---------- the uncertainty reaches the answer under the cell's own name ----------
{
  const book = build([
    { name: "crew", key: "mass", formula: "160 ± 40" },
    { name: "gear", key: "mass", formula: "80 ± 5" },
    { name: "total", key: "mass", formula: "crew.mass + gear.mass" },
  ]);
  const reading = cellAt(book, "total", "mass")!.reading!;
  ok(reading.v === 240, "two guesses add");
  ok(near(reading.worst.hi, 45, 1e-12), "and their worst cases add");
  ok(
    near(reading.likely.hi, Math.hypot(40, 5), 1e-12),
    "while the likely one is the quadrature",
  );
  ok(
    reading.terms[0].label === "crew.mass" && reading.terms[0].share > 0.9,
    "and the ranking names the CELL it was typed in, item and field both",
  );
}

// ---------- autocomplete ----------
{
  let book = build([
    { name: "hull shell", key: "mass", formula: "900" },
    { name: "ply", key: "density", formula: "4.2" },
  ]);
  book = point(book, "hull shell", { x: "1", y: "0", z: "0.5" }, "cg");

  const here = completionsFor(book, book.items[0], "formula");
  ok(
    here.some((item) => item.insert === "mass" && item.kind === "sibling"),
    "an item's own fields are offered bare, because that is what a bare name means",
  );
  ok(
    here.findIndex((item) => item.kind === "sibling") <
      here.findIndex((item) => item.kind === "item"),
    "and they come first — the scope you are standing in is the one you meant",
  );
  ok(
    here.some((item) => item.insert === "ply.density"),
    "another item's fields are offered through its name",
  );
  ok(
    !here.some((item) => item.insert === "cg"),
    "a point is NOT offered bare outside a coordinate cell, where it would not resolve",
  );
  ok(
    completionsFor(book, book.items[0], "z").some(
      (item) => item.insert === "cg",
    ),
    "and is offered bare inside one, where it means that coordinate",
  );
  ok(
    here.some((item) => item.insert.startsWith("HULL.")) &&
      here.some((item) => item.insert === "sqrt("),
    "the hull's numbers and the functions are always on the list",
  );

  const suggest = suggestAt(here, "hull sh", 7)!;
  ok(
    suggest.items[0].insert.startsWith("hull shell.") && suggest.from === 0,
    "a fragment with a space in it still completes — names have spaces",
  );
}

// ---------- a point is three cells, and may be one expression ----------
{
  let book = build([
    { name: "engine", key: "mass", formula: "780" },
    { name: "tank", key: "mass", formula: "220" },
  ]);
  book = point(
    book,
    "engine",
    { x: "1.8", y: "0", z: "0.42", unit: "m" },
    "cg",
  );
  book = point(book, "tank", { x: "3.1", y: "0", z: "0.30", unit: "m" }, "cg");

  ok(
    book.items.find((item) => item.name === "engine")?.fields.cg.unit === "m",
    "a point shows metres by default",
  );
  const clearedUnit = run(book, {
    type: "setFieldUnit",
    item: idOf(book, "engine"),
    field: "cg",
    unit: "",
  });
  ok(
    clearedUnit.items.find((item) => item.name === "engine")?.fields.cg.unit ===
      "m",
    "and clearing a point unit restores metres rather than making its coordinates plain numbers",
  );
  const dimensionedMass = run(book, {
    type: "setFieldUnit",
    item: idOf(book, "engine"),
    field: "mass",
    unit: "kg",
  });
  const massPosition = run(dimensionedMass, {
    type: "setFieldFormula",
    item: idOf(book, "engine"),
    field: "cg",
    leaf: "x",
    formula: "mass",
  });
  ok(
    (cellAt(massPosition, "engine", "cg", "x")?.error ?? "").includes(
      "must be a distance",
    ),
    "a point coordinate refuses a formula that does not produce a distance",
  );
  const massUnit = run(book, {
    type: "setFieldUnit",
    item: idOf(book, "engine"),
    field: "cg",
    unit: "kg",
  });
  ok(
    (cellAt(massUnit, "engine", "cg", "x")?.error ?? "").includes(
      "must use a distance unit",
    ),
    "a point refuses a non-distance display unit",
  );

  ok(
    cellAt(book, "engine", "cg", "x")!.reading!.v === 1.8 &&
      cellAt(book, "engine", "cg", "z")!.reading!.v === 0.42 &&
      cellAt(book, "engine", "cg", "formula") === undefined,
    "each coordinate is its own cell, and a point has no single one",
  );
  const named = run(book, {
    type: "setFieldFormula",
    item: idOf(book, "tank"),
    field: "mass",
    leaf: "formula",
    formula: "engine.cg",
  });
  ok(
    (problem(named, "tank", "mass") ?? "").includes("write engine.cg.x"),
    "and naming the point in a scalar cell says which coordinate to ask for",
  );

  let cg = run(book, {
    type: "addItem",
    id: "cg",
    name: "CG",
    after: book.items.length - 1,
  });
  cg = run(cg, { type: "addField", item: "cg", key: "place", kind: "point" });
  cg = run(cg, {
    type: "setFieldFormula",
    item: "cg",
    field: "place",
    leaf: "from",
    formula:
      "(engine.mass * engine.cg + tank.mass * tank.cg) / (engine.mass + tank.mass)",
  });
  const results = evaluateBook(cg, null);
  const x = resultAt(results, "cg", "place", "x")!.reading!.v;
  const z = resultAt(results, "cg", "place", "z")!.reading!.v;
  ok(
    near(x, (780 * 1.8 + 220 * 3.1) / 1000, 1e-9) &&
      near(z, (780 * 0.42 + 220 * 0.3) / 1000, 1e-9),
    "one expression states all three coordinates, each read in its own axis",
  );

  const off = run(cg, {
    type: "setFieldFormula",
    item: "cg",
    field: "place",
    leaf: "from",
    formula: "",
  });
  const field = off.items.find((item) => item.id === "cg")!.fields.place;
  ok(
    field.k === "point" && field.x === "" && field.z === "",
    "turning a derivation off gives back whatever the coordinates were — here, nothing",
  );

  const moved = run(book, {
    type: "setPointPosition",
    item: idOf(book, "engine"),
    field: "cg",
    x: "2.4",
    z: "0.5",
  });
  const engine = moved.items.find((item) => item.name === "engine")!.fields.cg;
  ok(
    engine.k === "point" && engine.x === "2.4" && engine.z === "0.5",
    "a drag writes every coordinate it touched",
  );
  ok(
    engine.k === "point" && engine.y === "0",
    "and leaves the one it did not exactly as it was",
  );
  ok(
    sameGesture(
      {
        type: "setPointPosition",
        item: "a",
        field: "cg",
        x: "1",
      } as DocumentCommand,
      {
        type: "setPointPosition",
        item: "a",
        field: "cg",
        z: "2",
      } as DocumentCommand,
    ),
    "two frames of one drag coalesce into one undo step",
  );
  ok(
    !sameGesture(
      {
        type: "setFieldFormula",
        item: "a",
        field: "cg",
        leaf: "x",
        formula: "1",
      } as DocumentCommand,
      {
        type: "setFieldFormula",
        item: "a",
        field: "cg",
        leaf: "z",
        formula: "2",
      } as DocumentCommand,
    ),
    "while tabbing from one cell to the next does not — undoing a height must not undo a station",
  );
}

// ---------- what the book answers ----------
{
  let book = build([
    { name: "hull", key: "mass", formula: "900 ± 50" },
    { name: "engine", key: "mass", formula: "780" },
  ]);
  book = point(book, "hull", { x: "2.0", y: "0", z: "0.5", unit: "m" }, "cg");
  book = run(book, {
    type: "setOutput",
    name: "DISPLACEMENT",
    formula: "hull.mass + engine.mass",
  });
  book = run(book, { type: "setOutput", name: "VCG", formula: "hull.cg.z" });

  const results = evaluateBook(book, null);
  ok(
    results.outputs.displacement!.v === 1680,
    "an answer is an ordinary formula over the items",
  );
  ok(
    near(results.outputs.displacement!.worst.hi, 50, 1e-12),
    "and carries the uncertainty of whatever it named",
  );
  ok(results.outputs.vcg!.v === 0.5, "a centre reads a coordinate of a point");
  ok(
    results.outputs.lcg === null,
    "an answer nothing is written for is simply absent",
  );

  const chained = run(book, {
    type: "addItem",
    id: "m",
    name: "margin",
    after: book.items.length - 1,
  });
  const withMargin = run(
    run(chained, {
      type: "addField",
      item: "m",
      key: "mass",
      kind: "scalar",
    }),
    {
      type: "setFieldFormula",
      item: "m",
      field: "mass",
      leaf: "formula",
      formula: "OUT.DISPLACEMENT * 7%",
    },
  );
  ok(
    near(value(withMargin, "margin", "mass"), 117.6, 1e-9),
    "an item may read what the book answers, so a margin is a percentage of the total",
  );

  const looped = run(withMargin, {
    type: "setOutput",
    name: "DISPLACEMENT",
    formula: "hull.mass + engine.mass + margin.mass",
  });
  ok(
    (
      outputResult(evaluateBook(looped, null), "DISPLACEMENT")!.error ?? ""
    ).includes("refers back to itself"),
    "and an answer that leans on something leaning on it is a cycle like any other",
  );

  const wrongKind = run(book, {
    type: "setOutput",
    name: "DISPLACEMENT",
    formula: "hull.cg.z",
  });
  ok(
    outputResult(evaluateBook(wrongKind, null), "DISPLACEMENT")!.unitWarning !==
      null,
    "an answer that is not the kind of thing it claims to be is flagged, not refused",
  );

  const cleared = run(book, {
    type: "setOutput",
    name: "VCG",
    formula: "",
  });
  ok(
    !("VCG" in cleared.outputs),
    "and clearing one removes it rather than leaving an empty formula behind",
  );
}

// ---------- what must hold ----------
{
  ok(bookViolations(emptyBook()).length === 0, "an empty book is valid");
  ok(
    bookViolations(build([{ name: "a" }, { name: "b" }])).length === 0,
    "and so is an ordinary one",
  );
  const clash: WeightBook = {
    ...build([{ name: "a" }, { name: "b" }]),
    items: build([{ name: "a" }, { name: "b" }]).items.map((item) => ({
      ...item,
      name: "a",
    })),
  };
  ok(
    bookViolations(clash).some((message) =>
      message.includes("repeats the name"),
    ),
    "two items with one name is a violation — item names are the one global namespace",
  );
  const badFacet: WeightBook = {
    ...build([{ name: "a" }]),
    items: [{ ...build([{ name: "a" }]).items[0], facets: { system: "a//b" } }],
  };
  ok(
    bookViolations(badFacet).length > 0,
    "and a facet value nothing could split on is one too",
  );
}

// ---------- persistence ----------
{
  let book = build([
    {
      name: "hull shell",
      system: "structure/hull",
      key: "mass",
      formula: "900 ± 50",
    },
    { name: "ply", key: "density", formula: "4.2", unit: "kg/m2" },
  ]);
  book = point(book, "hull shell", { x: "2", y: "0", z: "0.5" }, "cg");
  book = cut(book, "hull shell", { shape: "plane", pos: "0.4" }, "waterplane");
  book = run(book, {
    type: "setOutput",
    name: "DISPLACEMENT",
    formula: "hull shell.mass",
  });
  book = run(book, { type: "setSheetDensity", density: 1.0 });

  const back = parseSheet(buildSheetJson(book));
  ok(
    JSON.stringify(back) === JSON.stringify(book),
    "a book round-trips through JSON unchanged",
  );
  ok(
    buildSheetJson(book).includes("900 ± 50"),
    "and formulas are stored as the source the user typed, never pre-parsed",
  );

  ok(
    parseSheet("not json").items.length === 0,
    "unreadable text opens as an empty book rather than taking the design down",
  );
  ok(
    parseSheet(JSON.stringify({ version: 99, items: [] })).items.length === 0,
    "and so does a version this build does not know",
  );

  const holey = parseSheet(
    JSON.stringify({
      version: 1,
      items: [
        { id: "a", name: "keep", fields: { m: { k: "scalar", formula: "1" } } },
        { name: "no id" },
        {
          id: "b",
          name: "half",
          fields: { good: { k: "scalar" }, bad: { k: "nonsense" } },
        },
      ],
      density: 1.025,
    }),
  );
  ok(
    holey.items.length === 2 &&
      Object.keys(holey.items[1].fields).join() === "good",
    "anything unreadable is dropped and the rest opens — a lost line is retyped, a lost design is not",
  );

  const positionsWithoutUnits = parseSheet(
    JSON.stringify({
      version: 1,
      items: [
        {
          id: "positions",
          name: "positions",
          fields: {
            section: { k: "cut", unit: "", pos: "2" },
            cg: { k: "point", unit: "", x: "2", y: "0", z: "1" },
          },
        },
      ],
    }),
  );
  ok(
    positionsWithoutUnits.items[0].fields.section?.unit === "m" &&
      positionsWithoutUnits.items[0].fields.cg?.unit === "m",
    "empty stored point and cut units read as the metre default rather than as a blank",
  );
}

// ---------- cuts ----------
{
  const model = assemble(defaultHull());
  const sampling = computeHullSampling(model, 240, 10);
  const metrics = hullMetrics(model, sampling)!;
  const measure = createSliceMeasurer(model, sampling);

  let book = build([{ name: "midship", key: "mass", formula: "0" }]);
  book = cut(book, "midship", { shape: "station", pos: "2" });
  ok(
    book.items[0].fields.section?.unit === "m",
    "a fresh cut authors its position in metres by default",
  );
  book = run(book, {
    type: "setFieldUnit",
    item: idOf(book, "midship"),
    field: "section",
    unit: "",
  });
  ok(
    book.items[0].fields.section?.unit === "m",
    "and clearing a cut unit restores that default rather than making its position dimensionless",
  );
  const areaPosition = run(book, {
    type: "setFieldFormula",
    item: idOf(book, "midship"),
    field: "section",
    leaf: "pos",
    formula: "HULL.SHELL_AREA",
  });
  ok(
    (
      cellAt(areaPosition, "midship", "section", "pos", metrics)?.error ?? ""
    ).includes("must be a distance"),
    "a cut position refuses a formula that does not produce a distance",
  );
  const massUnit = run(book, {
    type: "setFieldUnit",
    item: idOf(book, "midship"),
    field: "section",
    unit: "kg",
  });
  ok(
    (cellAt(massUnit, "midship", "section", "pos")?.error ?? "").includes(
      "must use a distance unit",
    ),
    "a cut refuses a non-distance display unit",
  );
  const measurement = measure("station", 2)!;
  const measurements = new Map([
    [`${idOf(book, "midship")} section`, measurement],
  ]);

  let withArea = run(book, {
    type: "addItem",
    id: "p",
    name: "panel",
    after: book.items.length - 1,
  });
  withArea = run(withArea, {
    type: "addField",
    item: "p",
    key: "mass",
    kind: "scalar",
  });
  withArea = run(withArea, {
    type: "setFieldFormula",
    item: "p",
    field: "mass",
    leaf: "formula",
    formula: "midship.section.area * 4.2",
  });
  const results = evaluateBook(withArea, metrics, measurements);
  ok(
    near(
      resultAt(results, "p", "mass")!.reading!.v,
      measurement.area * 4.2,
      1e-9,
    ),
    "a measured cut feeds a formula like any other number",
  );

  const circular = run(book, {
    type: "setFieldFormula",
    item: idOf(book, "midship"),
    field: "section",
    leaf: "pos",
    formula: "midship.section.area",
  });
  ok(
    (
      resultAt(
        evaluateBook(circular, metrics, measurements),
        idOf(book, "midship"),
        "section",
        "pos",
      )!.error ?? ""
    ).length > 0,
    "but a cut's position cannot depend on what the cut measures — that would be an implicit solve",
  );

  const bareCut = run(book, {
    type: "setFieldFormula",
    item: idOf(book, "midship"),
    field: "mass",
    leaf: "formula",
    formula: "section",
  });
  ok(
    (
      resultAt(
        evaluateBook(bareCut, metrics, measurements),
        idOf(book, "midship"),
        "mass",
      )!.error ?? ""
    ).includes("write midship.section"),
    "and naming a cut in a scalar cell says which of its numbers to ask for",
  );
}

// ---------- what a drag may move, read off the cell ----------
//
// A drag moves ONE literal inside the expression, and adds one where the expression has none. Which literal
// that is comes off the parse, never off a mode the user picked. The panel hands over the parse the EVALUATOR
// already made, and a cell that would not parse has none — so the helper mirrors that rather than throwing
// where the panel would simply see null.
{
  const place = (text: string, v = 0, canAppend = true, symbols = ["HULL"]) => {
    let tree = null;
    try {
      if (text.trim()) tree = parseFormula(text, symbols);
    } catch {
      tree = null;
    }
    return readPlacement(text, tree, v, canAppend);
  };
  const move = (text: string, v: number, target: number) =>
    withNominal(place(text, v)!, target, 0.001);

  ok(
    place("")?.handle === null && place("")?.bare === true,
    "an unwritten coordinate has nothing to move yet — which is how dragging places it",
  );
  ok(
    place("2.1", 2.1)?.handle?.contributes === 2.1 && place("2.1", 2.1)!.bare,
    "a cell that IS its number is the simple case, and still the common one",
  );
  ok(
    place("0.35 ± 0.05", 0.35)?.handle?.tail === "± 0.05" &&
      place("160 ± 10%", 160)?.handle?.tail === "± 10%" &&
      place("900 ± [50, 200]", 900)?.handle?.tail === "± [50, 200]",
    "with its spread, in any of the three forms, kept verbatim",
  );

  const offset = place("HULL.LCB + 2", 4.05)!;
  ok(
    offset.handle?.contributes === 2 && !offset.bare,
    "a literal added to a reference is the literal a drag moves",
  );
  ok(
    move("HULL.LCB + 2", 4.05, 4.35) === "HULL.LCB + 2.3",
    "and moving the point moves that number, leaving the reference exactly as typed",
  );
  ok(
    move("HULL.LCB - 0.4", 1.65, 1.35) === "HULL.LCB - 0.7" &&
      move("HULL.LCB - 0.4", 1.65, 2.25) === "HULL.LCB + 0.2",
    "a subtracted literal moves the other way, and flips its own operator rather than going negative",
  );
  ok(
    move("HULL.LCB + 2 ± 0.15", 4.05, 4.35) === "HULL.LCB + 2.3 ± 0.15",
    "the ± rides along: moving a position does not make it better or worse known",
  );
  ok(
    place("HULL.LCB", 2.05)?.handle === null &&
      move("HULL.LCB", 2.05, 2.35) === "HULL.LCB + 0.3" &&
      move("HULL.LCB", 2.05, 1.85) === "HULL.LCB - 0.2",
    "a coordinate that is a pure reference gets an offset written for it rather than being overwritten",
  );
  ok(
    place("HULL.LCB", 2.05, false) === null,
    "but only where the field's unit would give that number a dimension — otherwise the drag breaks the cell",
  );
  ok(
    move("HULL.LOA * 0.4", 2, 2.3) === "HULL.LOA * 0.4 + 0.3",
    "and a proportion is never restated: the offset goes beside it, not into it",
  );
  ok(
    place("HULL.LCB + 2 + 3", 7.05) === null,
    "two literals in one sum is a refusal rather than a guess at which the gesture meant",
  );
  ok(
    place("2.1 + ", 0) === null,
    "and a cell that will not parse moves not at all — there is no parse to find a literal in",
  );
  ok(
    move("50%", 0.5, 0.8) === "50% + 0.3",
    "a percentage is an expression like any other: the offset goes beside it, never into it",
  );
  ok(
    move("1.2", 1.2, 2.4) === "2.4" && move("1.2", 1.2, 3.2) === "3.2",
    "every frame of a drag is computed from where the coordinate started, so the last one lands on the pointer",
  );
  ok(
    withNominal(
      place("frame 4.section.pos", 2.4, true, ["frame 4", "section"])!,
      3.2,
      0.001,
    ) === "frame 4.section.pos + 0.8",
    "re-reading a snapped cell instead would offset from the reference — right for a NEW gesture, wrong mid-drag",
  );
  ok(
    move("-2 + HULL.LCB", 0.05, 0.35) === "-1.7 + HULL.LCB",
    "a leading literal keeps its place at the front of the sum, sign and all",
  );
  ok(
    withoutHandle(place("HULL.LCB + 2", 4.05)!) === "HULL.LCB" &&
      withoutHandle(place("2.1", 2.1)!) === null,
    "dragged back onto its base, the offset goes entirely — `HULL.LCB`, not `HULL.LCB + 0`",
  );
  ok(
    readTolerance("") === 0 &&
      readTolerance("± 0.05") === 0.05 &&
      readTolerance("± 10%") === null &&
      readTolerance("± [50, 200]") === null,
    "a tolerance handle stands only where a single ± can express what is written",
  );
  ok(
    withTolerance(place("HULL.LCB + 2", 4.05)!, 0.25, 0.001) ===
      "HULL.LCB + 2 ± 0.25" &&
      withTolerance(place("2.1 ± 0.25", 2.1)!, 0.0001, 0.001) === "2.1",
    "dragging a tolerance out states one; dragging it back onto the point removes it",
  );
}

// ---------- a bare term of the outermost sum is read in the field's unit ----------
//
// Which is what lets `HULL.LCB + 2` evaluate at all. The test is what a term WORKS OUT to, not what it looks
// like, so nothing that evaluated before this rule existed evaluates differently now.
{
  const model = assemble(defaultHull());
  const sampling = computeHullSampling(model, 240, 10);
  const metrics = hullMetrics(model, sampling)!;

  const inUnits = (formula: string, unit: string): number | string => {
    const book = build([{ name: "r", formula, unit }]);
    const result = cellAt(book, "r", "value", "formula", metrics)!;
    return result.error ?? result.reading!.v;
  };
  ok(
    near(inUnits("HULL.LCB + 2", "m") as number, metrics.lcb + 2, 1e-9),
    "a plain number added to a length is read in the field's own unit",
  );
  ok(
    near(inUnits("HULL.LCB + 200", "mm") as number, metrics.lcb + 0.2, 1e-9),
    "in the field's unit, not in metres — 200 mm is 0.2 m",
  );
  ok(
    inUnits("HULL.LOA * 0.4", "m") === metrics.loa * 0.4,
    "a multiplier is left alone: 0.4 of the LOA is a proportion, not 0.4 metres",
  );
  ok(
    inUnits("250 + 12 * 3", "kg") === 286,
    "a term that works out to a plain number counts, however it was written",
  );
  ok(
    inUnits("2 + 3", "t") === 5000 &&
      inUnits("2 * 3", "t") === 6000 &&
      inUnits("1.4", "t") === 1400,
    "and a formula that was already a plain number lands exactly where it always did",
  );
  ok(
    typeof inUnits("HULL.LCB + 2", "") === "string",
    "with no unit declared there is nothing to read it in, and the refusal says where the fix is",
  );
  ok(
    typeof inUnits("HULL.SHELL_AREA + 2", "m") === "string",
    "a unit that disagrees with the formula is still a refusal, not a silent conversion",
  );
}

// ---------- the uncertainty region: a box only when the coordinates are independent ----------
{
  const independent = build([
    { name: "a", formula: "2 ± 0.5" },
    { name: "b", formula: "1 ± 0.25" },
  ]);
  const ind = evaluateBook(independent, null);
  const qa = resultAt(ind, "i0", "value")!.quantity!;
  const qb = resultAt(ind, "i1", "value")!.quantity!;
  const box = worstRegion(qa, qb, ind.sources);
  const spanOf = (poly: [number, number][], axis: 0 | 1) => {
    const values = poly.map((p) => p[axis]);
    return [Math.min(...values), Math.max(...values)] as const;
  };
  ok(
    box.length === 4 &&
      near(spanOf(box, 0)[1], 0.5, 1e-12) &&
      near(spanOf(box, 1)[1], 0.25, 1e-12) &&
      box.some(([x, y]) => near(x, 0.5, 1e-12) && near(y, 0.25, 1e-12)),
    "two independent guesses give the axis-aligned rectangle, corners and all",
  );

  // Both coordinates measured off ONE frame station: the pair is uncertain along a LINE, and a rectangle
  // would claim a whole area of positions the inputs cannot reach.
  const shared = build([
    { name: "frame", formula: "1 ± 0.1" },
    { name: "a", formula: "frame.value * 2" },
    { name: "b", formula: "frame.value * 1" },
  ]);
  const sh = evaluateBook(shared, null);
  const line = worstRegion(
    resultAt(sh, "i1", "value")!.quantity!,
    resultAt(sh, "i2", "value")!.quantity!,
    sh.sources,
  );
  ok(
    line.length === 2 &&
      near(Math.abs(line[0][0]), 0.2, 1e-12) &&
      near(Math.abs(line[0][1]), 0.1, 1e-12) &&
      near(line[0][0] / line[0][1], 2, 1e-9),
    "one shared guess collapses the region to the line the pair actually moves along",
  );

  const opposed = run(shared, {
    type: "setFieldFormula",
    item: "i2",
    field: "value",
    leaf: "formula",
    formula: "0 - frame.value",
  });
  const op = evaluateBook(opposed, null);
  const anti = worstRegion(
    resultAt(op, "i1", "value")!.quantity!,
    resultAt(op, "i2", "value")!.quantity!,
    op.sources,
  );
  ok(
    anti.length === 2 && near(anti[0][0] / anti[0][1], -2, 1e-9),
    "and a guess two coordinates lean on in opposite directions tilts the other way",
  );

  const ellipse = likelyRegion(qa, qb, ind.sources);
  ok(
    near(
      spanOf(ellipse, 0)[1],
      resultAt(ind, "i0", "value")!.reading!.likely.hi,
      1e-9,
    ) &&
      near(
        spanOf(ellipse, 1)[1],
        resultAt(ind, "i1", "value")!.reading!.likely.hi,
        1e-9,
      ),
    "the likely region is the quadrature the panel quotes, drawn",
  );

  const certain = build([
    { name: "a", formula: "2 ± 0.5" },
    { name: "b", formula: "1" },
  ]);
  const ce = evaluateBook(certain, null);
  const flat = worstRegion(
    resultAt(ce, "i0", "value")!.quantity!,
    resultAt(ce, "i1", "value")!.quantity!,
    ce.sources,
  );
  ok(
    flat.length === 2 && flat.every(([, y]) => y === 0),
    "a coordinate nothing can move leaves the region a line along the other one",
  );
}

// ---------- the hull's own numbers ----------
{
  const model = assemble(defaultHull());
  const sampling = computeHullSampling(model, 240, 10);
  const metrics = hullMetrics(model, sampling);
  ok(metrics !== null, "the default hull can be measured");

  const missing = HULL_METRICS.filter(
    (spec) => !isFinite(spec.read(metrics!)),
  ).map((spec) => spec.name);
  ok(
    missing.length === 0,
    `every HULL.* name produces a finite number${missing.length ? ` (bad: ${missing.join(", ")})` : ""}`,
  );
  ok(near(metrics!.loa, 5, 1e-9), "LOA comes out in metres, not model units");
  ok(
    metrics!.dispVol > 0 && metrics!.dispVol < 5,
    "and the displaced volume in cubic metres",
  );

  const book = build([
    { name: "area", formula: "HULL.SHELL_AREA" },
    { name: "density", formula: "4.2 ± 0.3", unit: "kg/m2" },
    { name: "hull shell", formula: "area.value * density.value" },
  ]);
  const shell = cellAt(book, "hull shell", "value", "formula", metrics)!;
  ok(shell.error === null, "a formula reads the hull without complaint");
  ok(
    near(shell.reading!.v, metrics!.shellArea * 4.2, 1e-6),
    "and multiplies out to a shell weight",
  );
  ok(
    shell.unit?.label === "kg" && shell.unitIsDerived,
    "whose unit is derived rather than declared",
  );
  ok(
    shell.reading!.terms.length === 1 &&
      shell.reading!.terms[0].label === "density.value",
    "the hull contributes no uncertainty of its own — it is drawn, not guessed",
  );

  ok(
    (problem(book, "area") ?? "").includes("not been measured"),
    "with no hull measured, only the cells that touch it fail",
  );
  ok(problem(book, "density") === null, "and the rest of the book evaluates");
  ok(
    (
      problem(
        build([{ name: "a", formula: "HULL.NOSUCH" }]),
        "a",
        "value",
        metrics,
      ) ?? ""
    ).includes("no measurement called"),
    "an unknown hull measurement says so",
  );
  ok(
    (
      problem(
        build([{ name: "a", formula: "HULL.lwl" }]),
        "a",
        "value",
        metrics,
      ) ?? ""
    ).includes("did you mean HULL.LWL"),
    "and a lower-case one is offered the upper-case name",
  );
}

// ---------- one frame, wherever the hull happens to be drawn ----------
//
// The plan starts at whatever x its first control point was drawn at, which is 0 for most hulls and is the
// reason this went unnoticed: every position the sheet can read has to be measured from the TRANSOM, or the
// hull's own terms sit offset from the points beside them in a moment sum, silently and by exactly zero on
// the hulls anyone tests with.
{
  const base = defaultHull();
  const shift = 400;
  const moved = {
    ...base,
    sheerPlan: base.sheerPlan.map((p) => ({ ...p, x: p.x + shift })),
    sheerTrim: base.sheerTrim.map((p) => ({ ...p, x: p.x + shift })),
    transom: base.transom.map((p) => ({
      ...p,
      x: p.x + shift,
    })) as typeof base.transom,
  };
  const measure = (hull: typeof base) => {
    const m = assemble(hull);
    const hs = computeHullSampling(m, 240, 10);
    const metrics = hullMetrics(m, hs)!;
    const outlines = hullOutlines(m, hs)!;
    return {
      metrics,
      slice: measureSlice(m, hs, "station", metrics.loa / 2)!,
      // A real point on the skin, put through the frame the point editor authors in.
      skin: toSheet(
        outlines.frame,
        hs.columns[Math.floor(hs.columns.length / 2)].pts[0].pos,
      ),
    };
  };
  const here = measure(base);
  const there = measure(moved);

  ok(
    near(here.metrics.shellLcg, there.metrics.shellLcg, 1e-9) &&
      near(here.metrics.lcb, there.metrics.lcb, 1e-9) &&
      near(here.metrics.lcf, there.metrics.lcf, 1e-9),
    "moving the whole hull along x does not move where the sheet says its centres are",
  );
  ok(
    near(here.slice.x, there.slice.x, 1e-9) &&
      near(here.skin[0], there.skin[0], 1e-9),
    "and a slice's centroid and a point's coordinate hold still with them — one frame, not three",
  );
  ok(
    near(here.metrics.shellVcg, there.metrics.shellVcg, 1e-9) &&
      near(here.metrics.kb, there.metrics.kb, 1e-9) &&
      near(here.skin[2], there.skin[2], 1e-9),
    "the heights were already agreed, and stay agreed",
  );
  // The one that makes it matter: the hull's shell and a point, added in one moment sum.
  ok(
    near(
      here.metrics.shellLcg - here.slice.x,
      there.metrics.shellLcg - there.slice.x,
      1e-9,
    ),
    "so a moment arm between the hull's own shell and anything else is the same arm wherever it was drawn",
  );
}

// ---------- SHELL_AREA and its centroid, against an independent integration ----------
//
// Both come from a cut taken with the waterplane above the whole hull, relying on `cut` accumulating wsa and
// its moments over SKIN edges only. Nothing else in the codebase exercises that, so they are checked against
// a different route entirely: the triangles of the mesh the STL exporter writes. Different discretisation,
// different arithmetic, no shared code — so agreement is evidence rather than a tautology.
{
  const model = assemble(defaultHull());
  const sampling = computeHullSampling(model, 240, 12);
  const metrics = hullMetrics(model, sampling)!;
  const { hull } = buildHullMesh(sampling, true, false, false);

  let area = 0,
    cx = 0,
    cz = 0;
  for (let t = 0; t + 8 < hull.pos.length; t += 9) {
    const ax = hull.pos[t + 3] - hull.pos[t],
      ay = hull.pos[t + 4] - hull.pos[t + 1],
      az = hull.pos[t + 5] - hull.pos[t + 2],
      bx = hull.pos[t + 6] - hull.pos[t],
      by = hull.pos[t + 7] - hull.pos[t + 1],
      bz = hull.pos[t + 8] - hull.pos[t + 2];
    const tri =
      0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    area += tri;
    cx += (tri * (hull.pos[t] + hull.pos[t + 3] + hull.pos[t + 6])) / 3;
    cz += (tri * (hull.pos[t + 2] + hull.pos[t + 5] + hull.pos[t + 8])) / 3;
  }
  const s = unitScale(model.unit, "m");
  const meshArea = area * s * s;
  const rel = Math.abs(meshArea - metrics.shellArea) / meshArea;
  ok(
    rel < 0.01,
    `SHELL_AREA matches the STL mesh's own triangle areas to 1% (${(rel * 100).toFixed(3)}%)`,
  );
  ok(
    metrics.shellArea > metrics.wsa,
    "the whole shell is larger than the wetted part of it",
  );
  ok(
    metrics.hullVol > metrics.dispVol,
    "and the moulded volume larger than the displaced volume",
  );

  const geom = stationGeometry(model, sampling)!;
  // In the sheet's frame, like the metric it is checked against: x forward from the transom.
  const meshLcg = (cx / area - model.plan.at(0)[0]) * s;
  const meshVcg = (cz / area) * s - geom.keelZ * s;
  ok(
    Math.abs(meshLcg - metrics.shellLcg) < 0.01 * metrics.loa,
    `SHELL_LCG matches the mesh's own area centroid to 1% of LOA (${metrics.shellLcg.toFixed(4)} vs ${meshLcg.toFixed(4)} m)`,
  );
  ok(
    Math.abs(meshVcg - metrics.shellVcg) < 0.01 * metrics.loa,
    `SHELL_VCG matches it too (${metrics.shellVcg.toFixed(4)} vs ${meshVcg.toFixed(4)} m above the keel)`,
  );
  ok(
    metrics.shellVcg > 0 && metrics.shellVcg > metrics.kb,
    "the shell's centroid sits above the keel, and above the centre of buoyancy",
  );
}

// ---------- reordering, and what a move no longer means ----------
//
// Order is presentation — formulas resolve by name — so a move must not disturb a single value. And a move is
// no longer how an item changes group: filing is a property, set by one command, so dragging past a header
// re-orders and nothing else. That separation is the whole point of facets.
{
  const book = build([
    { name: "a", system: "one", formula: "1" },
    { name: "b", system: "one", formula: "2" },
    { name: "c", system: "two", formula: "a.value + b.value" },
  ]);
  const names = (b: WeightBook) => b.items.map((item) => item.name).join();

  const moved = run(book, { type: "moveItem", item: idOf(book, "c"), to: 0 });
  ok(names(moved) === "c,a,b", "an item moves to where it was put");
  ok(
    value(moved, "c") === 3,
    "and the formula that named the two below it still works",
  );
  ok(
    moved.items[0].facets.system === "two",
    "moving it does NOT refile it — a heading could only ever imply what a facet states",
  );

  const refiled = run(book, {
    type: "setFacet",
    item: idOf(book, "c"),
    key: "system",
    value: "one",
  });
  ok(
    names(refiled) === "a,b,c" && refiled.items[2].facets.system === "one",
    "and refiling it does not move it — the two gestures are finally separate",
  );
  ok(value(refiled, "c") === 3, "neither disturbs a value");

  const past = run(book, { type: "moveItem", item: idOf(book, "a"), to: 99 });
  ok(
    names(past) === "b,c,a",
    "a move past the end lands at the end rather than being refused",
  );
  ok(
    "rejected" in
      interpretSheetCommand(book, { type: "moveItem", item: "nope", to: 0 }),
    "moving something that is not there is refused",
  );

  const withFields = run(
    run(book, {
      type: "addField",
      item: idOf(book, "a"),
      key: "position",
      kind: "point",
    }),
    {
      type: "addField",
      item: idOf(book, "a"),
      key: "cost",
      kind: "scalar",
    },
  );
  const fieldsMoved = run(withFields, {
    type: "moveField",
    item: idOf(book, "a"),
    key: "cost",
    to: 0,
  });
  ok(
    Object.keys(fieldsMoved.items[0].fields).join() === "cost,value,position",
    "fields move within an item without changing their keys",
  );
  ok(
    value(fieldsMoved, "a") === 1,
    "and field order is presentation, so its values stay put",
  );
}

// ---------- what is worth going back to ----------
{
  const book = run(
    build([
      { name: "good", formula: "2" },
      { name: "bad", formula: "1 +" },
      { name: "blank" },
    ]),
    {
      type: "setFieldFormula",
      item: "i2",
      field: "value",
      leaf: "formula",
      formula: "",
    },
  );
  const problems = problemsOf(
    book,
    evaluateBook(book, null),
    (i, f, l) => `${i} ${f} ${l}`,
  );
  const named = problems.map((entry) => entry.item.name);
  ok(
    named.includes("bad") && named.includes("blank") && !named.includes("good"),
    "a broken cell and an empty one are both worth going back to; a working one is not",
  );
  ok(
    problems.find((entry) => entry.item.name === "blank")!.message ===
      "nothing written yet",
    "and an empty cell says so rather than pretending to be an error",
  );
}

// ---------- the frame, and the two outlines a point is placed against ----------
{
  const model = assemble(defaultHull());
  const sampling = computeHullSampling(model, 240, 10);
  const metrics = hullMetrics(model, sampling)!;
  const outlines = hullOutlines(model, sampling)!;
  ok(
    outlines !== null && outlines.profile.upper.length > 4,
    "a swept hull yields a side-view silhouette to place a point against",
  );
  const metres = unitScale(model.unit, "m");
  ok(
    near(outlines.frame.xSpan[0], 0, 1e-9) &&
      near(outlines.frame.zSpan[0], 0, 1e-9),
    "stated in the sheet's frame: x from the transom, z above the keel baseline",
  );
  ok(
    near(Math.min(...outlines.profile.lower.map(([, z]) => z)), 0, 1e-6),
    "so the lowest point of the silhouette sits on the datum it is measured from",
  );
  ok(
    near(outlines.frame.xSpan[1], metrics.loa, 1e-6),
    "and the silhouette spans the LOA the sheet reads from HULL.LOA",
  );

  const there: [number, number, number] = [1.2, 0.3, 0.8];
  const back = toSheet(outlines.frame, toModel(outlines.frame, there));
  ok(
    near(back[0], there[0], 1e-9) &&
      near(back[1], there[1], 1e-9) &&
      near(back[2], there[2], 1e-9),
    "the sheet frame and the model frame convert back and forth exactly",
  );

  const amidships = sectionOutline(model, outlines.frame, {
    k: "at",
    x: outlines.frame.xSpan[1] / 2,
  })!;
  ok(
    amidships.starboard.length > 2 &&
      !amidships.clamped &&
      amidships.starboard.every(([, z]) => z >= -1e-6),
    "the section at a point's x is a real cut, above the keel datum",
  );
  ok(
    amidships.port.every(([y], i) =>
      near(y, -amidships.starboard[i][0], 1e-12),
    ),
    "and carries both halves, because a point may sit on either side",
  );
  const beyond = sectionOutline(model, outlines.frame, {
    k: "at",
    x: outlines.frame.xSpan[1] * 2,
  })!;
  ok(
    beyond !== null && beyond.clamped,
    "an x past the bow is clamped to the nearest real section rather than refused",
  );

  // A station is normal to the plan heading, and the plan is the sheer — a metre off the centreline — so the
  // plane AT a place's x is not the plane THROUGH it. A point has to be judged against the one it is in.
  {
    const at = outlines.frame.xSpan[1] * 0.75;
    const through = sectionOutline(model, outlines.frame, {
      k: "through",
      x: at,
      y: 0,
    })!;
    const byX = sectionOutline(model, outlines.frame, { k: "at", x: at })!;
    ok(
      through.starboard.length > 2 && byX.starboard.length > 2,
      "both ways of naming a station produce a real cut",
    );
    ok(
      Math.abs(through.x - byX.x) > 1e-3,
      `and they are different stations (${through.x.toFixed(3)} vs ${byX.x.toFixed(3)} m)`,
    );
    // The plane through a place contains it: at the centreline the trace's own keel end is that place's x.
    const keel = through.trace[through.trace.length - 1];
    ok(
      near(keel[0], at, 5e-3),
      "the plane THROUGH a centreline place meets the centreline at that place's own x",
    );
    ok(
      through.trace.some(([x]) => Math.abs(x - at) > 1e-3),
      "and still leans, because the plane is normal to the plan heading rather than square across",
    );
  }

  // The vertical slice: the plane x = const, which is the one a POINT is in. It is what the section pane
  // shows for a point, because only this plane lets "outside the outline" mean "outside the boat".
  {
    const at = outlines.frame.xSpan[1] * 0.5;
    const slice = verticalSection(sampling, outlines.frame, at)!;
    ok(
      slice !== null && slice.kind === "vertical" && slice.starboard.length > 2,
      "a vertical slice through the hull is a real outline",
    );
    ok(
      slice.trace.every(([x]) => near(x, at, 1e-9)),
      "every point of it is at exactly the x asked for — so the profile marks it with a plain rule",
    );
    ok(
      slice.port.every(([y], i) => near(y, -slice.starboard[i][0], 1e-12)),
      "and it carries both halves, as a station does",
    );
    // Close to the station where the plan runs straight, and further from it where the plan turns — the
    // difference IS the fan-out, so a slice identical to the station everywhere would mean one of them wrong.
    const beamOf = (o: { starboard: readonly (readonly number[])[] }) =>
      Math.max(...o.starboard.map(([y]) => y));
    const station = sectionOutline(model, outlines.frame, { k: "at", x: at })!;
    ok(
      Math.abs(beamOf(slice) - beamOf(station)) < 0.02,
      "amidships it is close to the station, where the plan is nearly straight",
    );
    const bow = outlines.frame.xSpan[1] * 0.92;
    const bowSlice = verticalSection(sampling, outlines.frame, bow);
    const bowStation = sectionOutline(model, outlines.frame, {
      k: "at",
      x: bow,
    });
    ok(
      !!bowSlice &&
        !!bowStation &&
        Math.abs(beamOf(bowSlice) - beamOf(bowStation)) >
          Math.abs(beamOf(slice) - beamOf(station)),
      "and departs from it toward the bow, where the plan turns and the stations fan out",
    );
    ok(
      verticalSection(sampling, outlines.frame, outlines.frame.xSpan[1] * 3) ===
        null,
      "a plane past the bow cuts nothing, and says so rather than drawing a stray outline",
    );

    // Both ENDS come off the hull's own trims, which are longitudinal curves like any row but land on
    // fractional ones — so they have to be crossed explicitly. Without them the slice stopped a whole row
    // short of the sheer and never reached the centreline, leaving the two halves apart at the keel.
    for (const x of [1, 2, 3].map((f) => outlines.frame.xSpan[1] * (f / 5))) {
      const cut = verticalSection(sampling, outlines.frame, x)!;
      const station = sectionOutline(model, outlines.frame, { k: "at", x })!;
      ok(
        near(cut.starboard[0][1], station.starboard[0][1], 0.02),
        `the slice at x=${x.toFixed(2)} reaches the sheer, as its station does`,
      );
      ok(
        near(cut.starboard[cut.starboard.length - 1][0], 0, 1e-9),
        `and closes on the centreline at x=${x.toFixed(2)}, so the two halves meet`,
      );
    }
    // Except where the TRANSOM ends the section rather than the keel. There the bottom is a transom edge
    // well off the centreline, and a slice that closed anyway would be drawing hull that is not there.
    const aft = verticalSection(sampling, outlines.frame, 0.5)!;
    ok(
      aft.starboard[aft.starboard.length - 1][0] > 0.1,
      "a slice through the transom ends on it, off the centreline, rather than closing",
    );
  }
  ok(
    near(
      (outlines.frame.x1 - outlines.frame.x0) * metres,
      outlines.frame.xSpan[1],
      1e-9,
    ),
    "and the frame's model span and its sheet span are the same length",
  );
}

if (failures) process.exitCode = 1;
else console.log("\nall passed");
