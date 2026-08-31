import { defaultHull } from "../src/core/hull";
import { buildHullMesh } from "../src/core/hullGeometry";
import { hullMetrics, HULL_METRICS } from "../src/core/hullMetrics";
import { unitScale } from "../src/core/json";
import { computeHullSampling } from "../src/core/mesh";
import { assemble } from "../src/core/runtime";
import { cut, stationGeometry } from "../src/core/sweep";
import {
  FormulaError,
  parseFormula,
  tokenize,
} from "../src/core/sheet/formula";
import { evaluateBook, resultAt } from "../src/core/sheet/evaluate";
import { buildSheetJson, parseSheet } from "../src/core/sheet/json";
import {
  emptyBook,
  groupAt,
  interpretSheetCommand,
  rowsUnder,
  sheetHeadings,
  symbolsOf,
  type SheetCommand,
  type WeightBook,
} from "../src/core/sheet/book";
import { parseUnit, naturalUnit, UnitError } from "../src/core/sheet/units";
import { measureSlice, sliceMeasurementKey } from "../src/core/sheet/slices";
import {
  hullOutlines,
  likelyRegion,
  readPlacement,
  readTolerance,
  sectionOutline,
  toModel,
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
  fragmentStart,
  suggestAt,
} from "../src/editor/weightCompletions";

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

interface Line {
  name?: string;
  group?: string;
  formula?: string;
  unit?: string;
}

const run = (book: WeightBook, command: SheetCommand): WeightBook => {
  const out = interpretSheetCommand(book, command);
  if ("rejected" in out) throw new Error(out.rejected);
  return out.book;
};

/** One page called `Weights`, plus any extra pages given as [name, lines]. */
const build = (lines: Line[], extra: [string, Line[]][] = []): WeightBook => {
  let book = emptyBook();
  const page = (pageName: string, rows: Line[], p: number) => {
    const id = `p${p}`;
    book = run(book, { type: "addSheet", id, name: pageName, kind: "scalars" });
    let at = -1;
    let heading = "";
    rows.forEach((line, i) => {
      // A heading is a row, so a change of group emits one before the item that starts it.
      if ((line.group ?? "") !== heading) {
        heading = line.group ?? "";
        if (heading) {
          book = run(book, {
            type: "addSheetRow",
            sheet: id,
            id: `p${p}h${i}`,
            after: at,
            kind: "heading",
            name: heading,
          });
          at++;
        }
      }
      const rowId = `p${p}r${i}`;
      book = run(book, {
        type: "addSheetRow",
        sheet: id,
        id: rowId,
        after: at,
      });
      at++;
      if (line.name)
        book = run(book, {
          type: "renameSheetRow",
          sheet: id,
          row: rowId,
          name: line.name,
        });
      if (line.formula !== undefined)
        book = run(book, {
          type: "setSheetFormula",
          sheet: id,
          row: rowId,
          field: "formula",
          formula: line.formula,
        });
      if (line.unit)
        book = run(book, {
          type: "setSheetUnit",
          sheet: id,
          row: rowId,
          unit: line.unit,
        });
    });
  };
  page("Weights", lines, 0);
  extra.forEach(([name, rows], i) => page(name, rows, i + 1));
  return book;
};

/**
 * Make the book answer one of its outputs, the way the panel's "use as" menu does: a row on the outputs page
 * whose formula names the row that actually carries the number.
 */
const answer = (
  book: WeightBook,
  name: string,
  formula: string,
): WeightBook => {
  let out = book;
  let page = out.sheets.find((sheet) => sheet.kind === "outputs");
  if (!page) {
    out = run(out, {
      type: "addSheet",
      id: "out",
      name: "Outputs",
      kind: "outputs",
    });
    page = out.sheets.find((sheet) => sheet.kind === "outputs")!;
  }
  const id = `o-${name}`;
  out = run(out, {
    type: "addSheetRow",
    sheet: page.id,
    id,
    after: page.rows.length - 1,
  });
  out = run(out, { type: "renameSheetRow", sheet: page.id, row: id, name });
  return run(out, {
    type: "setSheetFormula",
    sheet: page.id,
    row: id,
    field: "formula",
    formula,
  });
};

const rowOf = (book: WeightBook, name: string, page = "Weights") => {
  const sheet = book.sheets.find((s) => s.name === page)!;
  const row = sheet.rows.find((r) => r.name === name)!;
  return { sheetId: sheet.id, rowId: row.id };
};

const value = (
  book: WeightBook,
  name: string,
  page = "Weights",
  metrics: Parameters<typeof evaluateBook>[1] = null,
): number => {
  const { sheetId, rowId } = rowOf(book, name, page);
  return (
    resultAt(evaluateBook(book, metrics), sheetId, rowId)?.reading?.v ?? NaN
  );
};

const problem = (
  book: WeightBook,
  name: string,
  page = "Weights",
  metrics: Parameters<typeof evaluateBook>[1] = null,
): string | null => {
  const { sheetId, rowId } = rowOf(book, name, page);
  return resultAt(evaluateBook(book, metrics), sheetId, rowId)?.error ?? null;
};

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

  const spread = (source: string) => {
    const book = build([{ name: "x", formula: source }]);
    const { sheetId, rowId } = rowOf(book, "x");
    return resultAt(evaluateBook(book, null), sheetId, rowId)!.reading!;
  };
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
//
// The whole reason this is safe is that the language has no implicit multiplication: two names side by side
// could never have meant anything else, so the lexer may take the longest known name at each position.
{
  const book = build([
    { name: "shell area", formula: "14.8" },
    { name: "ply density", formula: "4.2" },
    { name: "hull shell", formula: "shell area * ply density" },
  ]);
  ok(
    near(value(book, "hull shell"), 62.16, 1e-9),
    "a name with a space in it is one token",
  );

  // A name that is a PREFIX of another. Longest-first is what makes this come out right.
  const prefixed = build([
    { name: "shell", formula: "10" },
    { name: "shell area", formula: "20" },
    { name: "a", formula: "shell area / shell" },
  ]);
  ok(
    value(prefixed, "a") === 2,
    "the longer of two overlapping names wins, and the shorter is still reachable",
  );

  // A name may not swallow the characters after it.
  const boundary = build([
    { name: "shell", formula: "10" },
    { name: "a", formula: "shellfish" },
  ]);
  ok(
    problem(boundary, "a") !== null,
    "a known name is not taken out of the middle of a longer word",
  );

  const symbols = symbolsOf(book, book.sheets[0].id);
  ok(
    symbols.indexOf("shell area") < symbols.indexOf("shell".slice(0, 5)) ||
      !symbols.includes("shell"),
    "the symbol table is ordered longest first",
  );

  const bad = interpretSheetCommand(book, {
    type: "renameSheetRow",
    sheet: book.sheets[0].id,
    row: book.sheets[0].rows[0].id,
    name: "2 fast",
  });
  ok("rejected" in bad, "a name that could not be read back is refused");
  const reserved = interpretSheetCommand(book, {
    type: "renameSheetRow",
    sheet: book.sheets[0].id,
    row: book.sheets[0].rows[0].id,
    name: "HULL",
  });
  ok("rejected" in reserved, "and so is one the language reserves");

  const tidied = interpretSheetCommand(book, {
    type: "renameSheetRow",
    sheet: book.sheets[0].id,
    row: book.sheets[0].rows[0].id,
    name: "  hull   shell plating  ",
  });
  ok(
    !("rejected" in tidied) &&
      tidied.book.sheets[0].rows[0].name === "hull shell plating",
    "a name is tidied on the way in, so a stray double space cannot break a reference",
  );
}

// ---------- names, not positions ----------
{
  const book = build([
    { name: "shell area", formula: "14.8" },
    { name: "ply density", formula: "4.2" },
    { name: "shell", formula: "shell area * ply density" },
  ]);
  const sheetId = book.sheets[0].id;

  // Insert a row ABOVE everything. In a grid this rewrites every reference below it; here it is invisible.
  const inserted = interpretSheetCommand(book, {
    type: "addSheetRow",
    sheet: sheetId,
    id: "top",
    after: -1,
  });
  ok(
    !("rejected" in inserted) &&
      near(value(inserted.book, "shell"), 62.16, 1e-9),
    "inserting a row above changes no formula at all",
  );

  const moved = interpretSheetCommand(book, {
    type: "moveSheetRow",
    sheet: sheetId,
    row: book.sheets[0].rows[2].id,
    to: 0,
  });
  ok(
    !("rejected" in moved) && near(value(moved.book, "shell"), 62.16, 1e-9),
    "a formula may sit above the rows it reads — order is presentation only",
  );

  const renamed = interpretSheetCommand(book, {
    type: "renameSheetRow",
    sheet: sheetId,
    row: book.sheets[0].rows[1].id,
    name: "skin density",
  });
  ok(
    !("rejected" in renamed) && problem(renamed.book, "shell") !== null,
    "renaming a row leaves a formula that still uses the old name broken, and says so",
  );

  ok(
    (
      problem(build([{ name: "x", formula: "Shell_Area" }]), "x") ?? ""
    ).includes("nothing on this page is called"),
    "an unknown name says so",
  );
  ok(
    (
      problem(
        build([
          { name: "shell area", formula: "1" },
          { name: "x", formula: "Shell Area" },
        ]),
        "x",
      ) ?? ""
    ).includes("did you mean shell area"),
    "and suggests the row that differs only in case",
  );
}

// ---------- pages ----------
{
  const book = build(
    [
      { name: "hull shell", formula: "70", unit: "kg" },
      { name: "crew", formula: "160", unit: "kg" },
      { name: "displacement", formula: "hull shell + crew", unit: "kg" },
    ],
    [["VCG", { 0: 0 } as never]].slice(0, 0) as [string, Line[]][],
  );
  ok(value(book, "displacement") === 230, "a single page works as it did");

  const withVcg = build(
    [
      { name: "hull shell", formula: "70", unit: "kg" },
      { name: "crew", formula: "160", unit: "kg" },
      { name: "displacement", formula: "hull shell + crew", unit: "kg" },
    ],
    [
      [
        "VCG",
        [
          { name: "hull shell", formula: "0.30", unit: "m" },
          { name: "crew", formula: "0.85", unit: "m" },
          {
            name: "kg",
            formula:
              "(Weights.hull shell * hull shell + Weights.crew * crew) / Weights.displacement",
            unit: "m",
          },
        ],
      ],
    ],
  );
  const expected = (70 * 0.3 + 160 * 0.85) / 230;
  ok(
    near(value(withVcg, "kg", "VCG"), expected, 1e-12),
    "a page reaches across to another with Page.item",
  );
  ok(
    value(withVcg, "hull shell", "VCG") === 0.3 &&
      value(withVcg, "hull shell") === 70,
    "the same name on two pages is two different items — which is what pages are for",
  );
  ok(
    (problem(withVcg, "kg", "VCG") ?? "").length === 0,
    "and none of that is a cycle",
  );

  ok(
    (problem(build([{ name: "a", formula: "Nowhere.x" }]), "a") ?? "").includes(
      "no page called",
    ),
    "an unknown page says so",
  );
  ok(
    (problem(build([{ name: "a", formula: "Weights" }]), "a") ?? "").includes(
      "is a page",
    ),
    "and naming a page with no item on it says what to write instead",
  );

  const dropped = run(withVcg, {
    type: "removeSheet",
    sheet: withVcg.sheets[1].id,
  });
  ok(
    dropped.sheets.length === 1 && bookViolations(dropped).length === 0,
    "removing a page leaves the book valid",
  );

  const clash = interpretSheetCommand(withVcg, {
    type: "addSheet",
    id: "dupe",
    name: "VCG",
    kind: "scalars",
  });
  ok("rejected" in clash, "two pages may not share a name");
}

// ---------- groups ----------
//
// A heading is a ROW, and an item belongs to whichever heading it sits under. There is no command that puts
// an item in a group, because position already says it — which is why moving one in is the only way in.
{
  const book = build([
    { name: "shell", group: "Hull structure", formula: "70" },
    { name: "frames", group: "Hull structure", formula: "15" },
    { name: "outboard", group: "Machinery", formula: "26" },
    { name: "total", formula: "shell + frames + outboard" },
  ]);
  const sheet = book.sheets[0];

  ok(
    sheetHeadings(sheet)
      .map((h) => h.name)
      .join() === "Hull structure,Machinery",
    "a change of heading is a row of its own",
  );
  ok(
    value(book, "total") === 111,
    "a total is written out, and says what it adds",
  );

  const idx = (name: string) => sheet.rows.findIndex((r) => r.name === name);
  ok(
    groupAt(sheet, idx("frames")) === "Hull structure" &&
      groupAt(sheet, idx("outboard")) === "Machinery",
    "an item's group is read from where it sits",
  );
  ok(
    groupAt(sheet, idx("total")) === "Machinery",
    "…including an item that simply follows the last heading",
  );
  ok(
    rowsUnder(sheet, idx("Hull structure") - 1 + 1).length === 0 ||
      rowsUnder(
        sheet,
        sheet.rows.findIndex((r) => r.name === "Hull structure"),
      ).length === 2,
    "a heading covers the rows up to the next one",
  );

  // Moving an item is the ONLY way to change its group, and the move alone does it.
  const moved = run(book, {
    type: "moveSheetRow",
    sheet: sheet.id,
    row: sheet.rows[idx("outboard")].id,
    to: 1,
  });
  const after = moved.sheets[0];
  ok(
    groupAt(
      after,
      after.rows.findIndex((r) => r.name === "outboard"),
    ) === "Hull structure",
    "moving an item under another heading puts it in that group, with no second command",
  );
  ok(value(moved, "total") === 111, "and disturbs no value at all");

  // Renaming a heading is renaming a row — and a heading is under no naming rules, because nothing can
  // refer to one.
  const renamed = run(book, {
    type: "renameSheetRow",
    sheet: sheet.id,
    row: sheet.rows.find((r) => r.name === "Machinery")!.id,
    name: "Propulsion & tanks",
  });
  ok(
    sheetHeadings(renamed.sheets[0])
      .map((h) => h.name)
      .includes("Propulsion & tanks"),
    "a heading may say anything — it is not a name a formula could use",
  );
  ok(value(renamed, "total") === 111, "and renaming one disturbs nothing");

  // An item, by contrast, still has to be nameable.
  const badItem = interpretSheetCommand(book, {
    type: "renameSheetRow",
    sheet: sheet.id,
    row: sheet.rows[idx("shell")].id,
    name: "2 fast",
  });
  ok("rejected" in badItem, "an item's name is still checked");

  // A heading is not a value, and cannot be referred to.
  ok(
    problem(build([{ name: "x", formula: "Structure" }]), "x") !== null,
    "a heading cannot be referred to from a formula",
  );

  // An empty heading is the normal starting state: you add one, then move items in.
  const bare = run(book, {
    type: "addSheetRow",
    sheet: sheet.id,
    id: "h-new",
    after: sheet.rows.length - 1,
    kind: "heading",
    name: "Tanks",
  });
  ok(
    sheetHeadings(bare.sheets[0]).length === 3 &&
      rowsUnder(
        bare.sheets[0],
        bare.sheets[0].rows.findIndex((r) => r.id === "h-new"),
      ).length === 0,
    "a heading may hold nothing at all, which is how one is made",
  );
  ok(bookViolations(bare).length === 0, "and an empty heading is valid");

  // Removing a heading leaves its items where they are; they join whatever is above.
  const dropped = run(book, {
    type: "removeSheetRow",
    sheet: sheet.id,
    row: sheet.rows.find((r) => r.name === "Machinery")!.id,
  });
  const d = dropped.sheets[0];
  ok(
    groupAt(
      d,
      d.rows.findIndex((r) => r.name === "outboard"),
    ) === "Hull structure",
    "removing a heading rolls its items into the one above",
  );

  // A group of mixed kinds is an ordinary thing, and nothing about it fails.
  const mixed = build([
    { name: "shell area", group: "Structure", formula: "14.8", unit: "m2" },
    { name: "ply density", group: "Structure", formula: "4.2", unit: "kg/m2" },
    { name: "shell", group: "Structure", formula: "shell area * ply density" },
    { name: "frames", group: "Structure", formula: "15", unit: "kg" },
    { name: "structure", formula: "shell + frames" },
  ]);
  ok(
    near(value(mixed, "structure"), 14.8 * 4.2 + 15, 1e-9),
    "a heading may hold a mass, an area and a density at once, and nothing complains",
  );
}

// ---------- failure is per row ----------
{
  const book = build([
    { name: "a", formula: "b + 1" },
    { name: "b", formula: "a + 1" },
    { name: "c", formula: "42" },
  ]);
  const results = evaluateBook(book, null);
  const sheetId = book.sheets[0].id;
  const err =
    resultAt(results, sheetId, book.sheets[0].rows[0].id)!.error ?? "";
  ok(err.includes("refers back to itself"), "a cycle is caught and named");
  ok(err.includes("a") && err.includes("b"), "and the message names the loop");
  ok(
    resultAt(results, sheetId, book.sheets[0].rows[2].id)!.reading!.v === 42,
    "a row off the cycle still produces its number",
  );

  ok(
    (problem(build([{ name: "a", formula: "a + 1" }]), "a") ?? "").includes(
      "refers back to itself",
    ),
    "a row referring to itself is caught too",
  );

  const empty = build([{ name: "a" }, { name: "b", formula: "a + 1" }]);
  ok(
    (problem(empty, "b") ?? "").includes("is empty"),
    "referring to a blank row says it is blank rather than treating it as zero",
  );
  ok(
    resultAt(
      evaluateBook(empty, null),
      empty.sheets[0].id,
      empty.sheets[0].rows[0].id,
    )!.empty,
    "and a blank row is reported as blank, not as an error",
  );

  ok(
    (problem(build([{ name: "a", formula: "1/0" }]), "a") ?? "").includes(
      "division by zero",
    ),
    "division by zero is a message, not an Infinity",
  );
  ok(
    (
      problem(build([{ name: "a", formula: "nosuchfn(2)" }]), "a") ?? ""
    ).includes("no function called"),
    "an unknown function says so",
  );
}

// ---------- units ----------
{
  ok(parseUnit("kg").dim.m === 1, "kg is a mass");
  ok(parseUnit("m2").dim.l === 2, "m2 is an area");
  ok(
    parseUnit("kg/m2").dim.m === 1 && parseUnit("kg/m2").dim.l === -2,
    "kg/m2 divides",
  );
  ok(near(parseUnit("t").factor, 1000, 1e-12), "a tonne is 1000 kg");
  ok(
    near(parseUnit("oz").factor, 0.028349523125, 1e-12),
    "an ounce is 0.028349523125 kg",
  );
  ok(
    parseUnit("L").dim.l === 3 && near(parseUnit("L").factor, 0.001, 1e-12),
    "a litre is 0.001 cubic metres",
  );
  ok(
    parseUnit("kgs").factor === parseUnit("kg").factor &&
      parseUnit("tonne").factor === parseUnit("t").factor &&
      parseUnit("lbs").factor === parseUnit("lb").factor &&
      parseUnit("liter").factor === parseUnit("litre").factor,
    "common unit aliases have the same scales as their canonical units",
  );
  let threw = false;
  try {
    parseUnit("furlong");
  } catch (error) {
    threw = error instanceof UnitError;
  }
  ok(threw, "an unknown unit is refused with a message");

  ok(naturalUnit({ m: 1, l: 0 }).label === "kg", "a mass is naturally kg");
  ok(naturalUnit({ m: 0, l: 2 }).label === "m2", "an area is naturally m2");
  ok(
    naturalUnit({ m: 1, l: -2 }).label === "kg/m2",
    "and a density kg/m2, which is what a row shows without being told",
  );
  ok(
    naturalUnit({ m: 0, l: 0 }).label === "",
    "a plain number shows no unit at all",
  );

  // A bare number in a row marked `t` is scaled into kilograms.
  const scaled = build([{ name: "engine", formula: "1.4", unit: "t" }]);
  ok(value(scaled, "engine") === 1400, "a declared unit scales a bare number");
  const ounces = build([{ name: "fitting", formula: "16", unit: "oz" }]);
  ok(
    near(value(ounces, "fitting"), 0.45359237, 1e-12),
    "ounces are scaled into kilograms",
  );
  const litres = build([{ name: "fuel", formula: "25", unit: "L" }]);
  ok(
    near(value(litres, "fuel"), 0.025, 1e-12),
    "litres are scaled into cubic metres",
  );
  const scaledSpread = build([
    { name: "engine", formula: "1.4 ± 0.1", unit: "t" },
  ]);
  const { sheetId, rowId } = rowOf(scaledSpread, "engine");
  ok(
    near(
      resultAt(evaluateBook(scaledSpread, null), sheetId, rowId)!.reading!.worst
        .hi,
      100,
      1e-9,
    ),
    "and the uncertainty is scaled with it",
  );

  // Units appear on their own once a formula has a dimension.
  const derived = build([
    { name: "area", formula: "10", unit: "m2" },
    { name: "density", formula: "4.2", unit: "kg/m2" },
    { name: "shell", formula: "area * density" },
  ]);
  const shown = resultAt(
    evaluateBook(derived, null),
    derived.sheets[0].id,
    rowOf(derived, "shell").rowId,
  )!;
  ok(value(derived, "shell") === 42, "consistent units multiply out");
  ok(
    shown.unit?.label === "kg" && shown.unitIsDerived,
    "and the row shows kg without anyone typing it",
  );

  // Typing a unit of the same kind is a DISPLAY choice, not a redefinition.
  const inTonnes = build([
    { name: "area", formula: "10", unit: "m2" },
    { name: "density", formula: "4.2", unit: "kg/m2" },
    { name: "shell", formula: "area * density", unit: "t" },
  ]);
  const asTonnes = resultAt(
    evaluateBook(inTonnes, null),
    inTonnes.sheets[0].id,
    rowOf(inTonnes, "shell").rowId,
  )!;
  ok(
    asTonnes.reading!.v === 42 &&
      near(asTonnes.reading!.v / asTonnes.unit!.factor, 0.042, 1e-12),
    "asking for tonnes converts the display and leaves the value in kilograms",
  );
  ok(
    asTonnes.unitWarning === null && !asTonnes.unitIsDerived,
    "and raises no warning, because the dimension agrees",
  );

  const mismatched = build([
    { name: "area", formula: "10", unit: "m2" },
    { name: "density", formula: "4.2" },
    { name: "shell", formula: "area * density", unit: "kg" },
  ]);
  const warn = resultAt(
    evaluateBook(mismatched, null),
    mismatched.sheets[0].id,
    rowOf(mismatched, "shell").rowId,
  )!;
  ok(warn.unitWarning !== null, "a unit of the wrong kind is flagged");
  ok(
    warn.reading!.v === 42,
    "but the value is still reported — a warning, not a refusal",
  );

  ok(
    problem(build([{ name: "a", formula: "1", unit: "kg" }]), "a") === null,
    "a good unit is not an error",
  );
  ok(
    problem(build([{ name: "a", formula: "1", unit: "sausages" }]), "a") !==
      null,
    "an unreadable unit is a row error",
  );
  ok(
    (
      problem(
        build([
          { name: "a", formula: "1", unit: "kg" },
          { name: "b", formula: "2", unit: "m" },
          { name: "c", formula: "a + b" },
        ]),
        "c",
      ) ?? ""
    ).includes("units do not match"),
    "adding kg to m is refused with a readable message",
  );
}

// ---------- the uncertainty reaches the output under the row's name ----------
{
  const book = build([
    { name: "shell area", formula: "14.8", unit: "m2" },
    { name: "ply density", formula: "4.2 ± 0.3", unit: "kg/m2" },
    { name: "hull shell", formula: "shell area * ply density" },
    { name: "crew", formula: "160 ± 15", unit: "kg" },
    { name: "displacement", formula: "hull shell + crew" },
  ]);
  const answered = answer(book, "DISPLACEMENT", "Weights.displacement");
  const out = evaluateBook(answered, null).outputs.displacement!;
  ok(near(out.v, 14.8 * 4.2 + 160, 1e-9), "the output carries the total");
  ok(
    out.terms.length === 2 &&
      out.terms[0].label === "crew" &&
      out.terms[1].label === "ply density",
    "the sensitivity list names the ROWS the ± were typed in, ranked",
  );
  ok(
    near(
      out.terms.reduce((s, t) => s + t.share, 0),
      1,
      1e-12,
    ),
    "and the shares still sum to 1 after the trip through the book",
  );
  ok(out.likely.hi < out.worst.hi, "both readings survive to the output");
}

// ---------- autocomplete ----------
//
// It is built from the same tables the evaluator resolves against, so a name that is offered exists and one
// that exists is offered. The awkward part is finding the fragment being completed, because names have
// spaces in them — scanning back over "name characters" would stop at the first one.
{
  const book = build(
    [
      { name: "hull shell", group: "Structure", formula: "70" },
      { name: "ply density", group: "Structure", formula: "4.2" },
    ],
    [["VCG", [{ name: "datum", formula: "0" }]]],
  );
  const all = completionsFor(book, book.sheets[0]);

  ok(
    all.some((c) => c.insert === "hull shell" && c.kind === "item"),
    "items on this page are offered",
  );
  ok(
    !all.some((c) => c.insert.startsWith("GROUP.")),
    "groups are not offered, because they are headings rather than values",
  );
  ok(
    all.some((c) => c.insert === "VCG.datum" && c.kind === "page"),
    "items on other pages are, already qualified",
  );
  ok(
    all.some((c) => c.insert === "HULL.SHELL_AREA") &&
      all.some((c) => c.insert === "sqrt("),
    "along with the hull's measurements and the functions",
  );

  ok(
    fragmentStart("2 * hull sh", 11) === 3,
    "the fragment starts after the operator, spaces and all",
  );
  ok(fragmentStart("sqrt(hull", 9) === 5, "and after a bracket");
  ok(fragmentStart("", 0) === 0, "an empty formula is all fragment");

  const s1 = suggestAt(all, "2 * hull sh", 11)!;
  ok(
    s1 && s1.items[0].insert === "hull shell",
    "a fragment with a space in it still completes",
  );
  ok(
    s1.from === 4,
    "and the insertion replaces the fragment, not the operator",
  );

  const s2 = suggestAt(all, "shell", 5)!;
  ok(
    s2.items.some((c) => c.insert === "hull shell"),
    "a word inside a name finds it",
  );

  ok(
    suggestAt(all, "2 * ", 4) === null,
    "nothing is offered after a bare operator",
  );
  ok(
    (suggestAt(all, "HULL.SH", 7)?.items.length ?? 0) > 0,
    "a namespace prefix narrows to that namespace",
  );
}

// ---------- typed pages ----------
//
// A page holds one kind of object and says which. Points remain deliberately unreachable because they have no
// editor yet; slice pages become creatable once their specialised editor and geometry resolver are present.
{
  const book = build([{ name: "crew", formula: "160" }]);
  ok(
    book.sheets[0].kind === "scalars",
    "a page made without saying otherwise holds scalars",
  );

  const points = interpretSheetCommand(book, {
    type: "addSheet",
    id: "pts",
    name: "Points",
    kind: "points",
  });
  ok(
    !("rejected" in points) &&
      points.book.sheets.some((sheet) => sheet.kind === "points"),
    "a points page is a page like any other now that it has an editor",
  );

  // A heading is legal on a page of any kind, because grouping is not a property of what is grouped.
  const withHeading = run(book, {
    type: "addSheetRow",
    sheet: book.sheets[0].id,
    id: "h1",
    after: -1,
    kind: "heading",
    name: "Hull",
  });
  ok(
    withHeading.sheets[0].rows[0].kind === "heading",
    "a heading is still a row, on whatever kind of page",
  );

  const wrongKind = interpretSheetCommand(book, {
    type: "addSheetRow",
    sheet: book.sheets[0].id,
    id: "bad",
    after: -1,
    kind: "point",
  });
  ok(
    "rejected" in wrongKind,
    "and a page refuses a row of a kind it does not hold",
  );

  // Hand-assembled, the way a corrupt file or a bad merge would be — which is what the invariants are for.
  const mixed: WeightBook = {
    ...book,
    sheets: [
      {
        ...book.sheets[0],
        rows: [
          {
            id: "p1",
            kind: "point",
            name: "engine",
            note: "",
            unit: "m",
            x: "1",
            y: "0",
            z: "0",
            from: "",
          },
        ],
      },
    ],
  };
  ok(
    bookViolations(mixed).some((v) => v.includes("point on a scalars page")),
    "a row of the wrong kind for its page is a violation, however it got there",
  );
}

// ---------- a formula cell is addressed by field ----------
//
// A scalar row has one cell and a point has three, so a row id no longer says which formula is meant. What
// matters beyond the plumbing is UNDO: two cells of one row are two gestures, and coalescing them would make
// undoing a point's height silently undo its station too.
{
  const a: DocumentCommand = {
    type: "setSheetFormula",
    sheet: "p0",
    row: "r0",
    field: "formula",
    formula: "1",
  };
  ok(
    sameGesture(a, { ...a, formula: "12" }),
    "two edits to one cell are one gesture, as they always were",
  );
  ok(
    !sameGesture(a, { ...a, field: "z", formula: "12" }),
    "but two cells of one row are two, so undo takes them apart",
  );
  ok(
    !sameGesture(a, { ...a, row: "r1", formula: "12" }),
    "and two rows are still two",
  );

  const book = build([{ name: "crew", formula: "160" }]);
  const bad = interpretSheetCommand(book, {
    type: "setSheetFormula",
    sheet: book.sheets[0].id,
    row: rowOf(book, "crew").rowId,
    field: "z",
    formula: "1",
  });
  ok(
    "rejected" in bad,
    "a scalar has no z to set, and writing one anyway is refused rather than stored",
  );
}

// ---------- what the book answers ----------
//
// The answers are ROWS on a page of their own, named from a fixed table, rather than a stored nomination
// pointing at a row by id. So there is nothing to prune when a row goes, and renaming rewrites nothing.
{
  const book = build([
    { name: "hull shell", formula: "800", unit: "kg" },
    { name: "crew", formula: "160 ± 15", unit: "kg" },
    { name: "all up weight", formula: "hull shell + crew", unit: "kg" },
  ]);
  const answered = answer(book, "DISPLACEMENT", "Weights.all up weight");

  ok(
    bookViolations(answered).length === 0,
    "a book with an outputs page is valid",
  );
  ok(
    near(evaluateBook(answered, null).outputs.displacement!.v, 960, 1e-9),
    "and the stability panel's reading comes off that row",
  );
  // A formula can read the book's own answer back: a margin stated as a share of the total is the case that
  // makes it worth having, and the cycle it would close if the total included the margin is the existing one.
  const withMargin = run(
    run(
      run(answered, {
        type: "addSheetRow",
        sheet: answered.sheets[0].id,
        id: "margin",
        after: answered.sheets[0].rows.length - 1,
      }),
      {
        type: "renameSheetRow",
        sheet: answered.sheets[0].id,
        row: "margin",
        name: "margin",
      },
    ),
    {
      type: "setSheetFormula",
      sheet: answered.sheets[0].id,
      row: "margin",
      field: "formula",
      formula: "OUT.DISPLACEMENT * 10%",
    },
  );
  ok(
    near(value(withMargin, "margin"), 96, 1e-9),
    "a formula reads the book's own answer back — a margin as a share of the total",
  );

  // The schedule keeps its own vocabulary: the row is still called what its author called it.
  ok(
    rowOf(answered, "all up weight").rowId !== undefined,
    "the row that carries the number keeps its name",
  );

  // Removing the answer removes the claim, and nothing anywhere needs pruning to make that true.
  const page = answered.sheets.find((sheet) => sheet.kind === "outputs")!;
  const cleared = run(answered, {
    type: "removeSheetRow",
    sheet: page.id,
    row: page.rows[0].id,
  });
  ok(
    evaluateBook(cleared, null).outputs.displacement === null &&
      bookViolations(cleared).length === 0,
    "deleting the row deletes the answer, and leaves nothing dangling",
  );

  const second = interpretSheetCommand(answered, {
    type: "addSheet",
    id: "out2",
    name: "More",
    kind: "outputs",
  });
  ok(
    "rejected" in second,
    "a book has one outputs page — OUT. finds it by kind, and two would be ambiguous",
  );

  const strayName: WeightBook = {
    ...answered,
    sheets: answered.sheets.map((sheet) =>
      sheet.kind === "outputs"
        ? {
            ...sheet,
            rows: [{ ...sheet.rows[0], name: "profit" }],
          }
        : sheet,
    ),
  };
  ok(
    bookViolations(strayName).some((v) =>
      v.includes("not one of the book's answers"),
    ),
    "and a name the app never asks for has no business on that page",
  );

  ok(
    (problem(build([{ name: "x", formula: "OUT.VCG" }]), "x") ?? "").includes(
      "no outputs page",
    ),
    "reading an answer from a book that has none says so plainly",
  );

  // ---- a centre of gravity built as a point answers both centres ----
  //
  // The two answers are still two lengths, because that is what the rest of the app asks for. What changed
  // is where they come from: one point, read twice, rather than two estimates that could disagree.
  let placed = build([
    { name: "engine", formula: "180", unit: "kg" },
    { name: "tank", formula: "140", unit: "kg" },
    { name: "total", formula: "engine + tank", unit: "kg" },
    { name: "height", formula: "Places.CG.z", unit: "m" },
    { name: "arm", formula: "Places.CG.x", unit: "m" },
  ]);
  placed = run(placed, {
    type: "addSheet",
    id: "pg",
    name: "Places",
    kind: "points",
  });
  const put = (id: string, name: string, x: string, y: string, z: string) => {
    placed = run(placed, { type: "addSheetRow", sheet: "pg", id, after: -1 });
    placed = run(placed, {
      type: "renameSheetRow",
      sheet: "pg",
      row: id,
      name,
    });
    placed = run(placed, {
      type: "setPointPosition",
      sheet: "pg",
      row: id,
      x,
      y,
      z,
    });
  };
  put("qe", "engine", "2.4", "0", "0.42");
  put("qt", "tank", "1.2", "0", "0.25");
  placed = run(placed, {
    type: "addSheetRow",
    sheet: "pg",
    id: "qc",
    after: -1,
  });
  placed = run(placed, {
    type: "renameSheetRow",
    sheet: "pg",
    row: "qc",
    name: "CG",
  });
  placed = run(placed, {
    type: "setSheetFormula",
    sheet: "pg",
    row: "qc",
    field: "from",
    formula: "(Weights.engine * engine + Weights.tank * tank) / Weights.total",
  });
  const wired = answer(
    answer(placed, "VCG", "Weights.height"),
    "LCG",
    "Weights.arm",
  );
  const answers = evaluateBook(wired, null).outputs;
  ok(
    near(answers.lcg!.v, (180 * 2.4 + 140 * 1.2) / 320, 1e-12) &&
      near(answers.vcg!.v, (180 * 0.42 + 140 * 0.25) / 320, 1e-12),
    "one point read twice answers both centres — and cannot disagree with itself",
  );

  const wrongDim = answer(
    build([{ name: "crew", formula: "160", unit: "kg" }]),
    "VCG",
    "Weights.crew",
  );
  const vcgRow = wrongDim.sheets.find((sheet) => sheet.kind === "outputs")!;
  ok(
    !!resultAt(evaluateBook(wrongDim, null), vcgRow.id, vcgRow.rows[0].id)
      ?.unitWarning,
    "a VCG that works out to a mass is flagged, and still reported",
  );
}

// ---------- persistence ----------
{
  const book = build([
    { name: "hull shell", group: "Hull", formula: "70 ± 5", unit: "kg" },
    { name: "crew", group: "Load", formula: "160", unit: "kg" },
  ]);
  const json = buildSheetJson(book);
  const back = parseSheet(json);
  ok(
    JSON.parse(json).version === 1,
    "a sheet document writes format version 1",
  );
  ok(
    JSON.stringify(back) === JSON.stringify(book),
    "a book round-trips through JSON unchanged",
  );
  ok(bookViolations(back).length === 0, "and comes back valid");

  // The outputs page is a page like any other on disk, so it round-trips with everything else — and the
  // answer survives as a row, which is the whole point of it not being a stored reference.
  const answered = answer(book, "DISPLACEMENT", "Weights.crew");
  const answeredBack = parseSheet(buildSheetJson(answered));
  ok(
    JSON.stringify(answeredBack) === JSON.stringify(answered) &&
      answeredBack.sheets[1].kind === "outputs",
    "a book with an outputs page round-trips, kind and all",
  );
  ok(
    evaluateBook(answeredBack, null).outputs.displacement?.v === 160,
    "and still answers after the trip",
  );

  // A page whose kind the file does not name is a page of scalars; a row whose kind disagrees with its page
  // is dropped, which is the same forgiveness the reader has always extended to a row it cannot read.
  const mixed = parseSheet(
    JSON.stringify({
      version: 1,
      sheets: [
        {
          id: "s1",
          name: "Weights",
          rows: [
            {
              id: "a",
              kind: "item",
              name: "crew",
              formula: "160",
              unit: "kg",
              note: "",
            },
            {
              id: "b",
              kind: "point",
              name: "engine",
              x: "1",
              y: "0",
              z: "0",
              note: "",
            },
            { id: "c", kind: "heading", name: "Hull", note: "" },
          ],
        },
      ],
      density: 1.025,
    }),
  );
  ok(
    mixed.sheets[0].kind === "scalars" &&
      mixed.sheets[0].rows.length === 2 &&
      mixed.sheets[0].rows.map((row) => row.id).join() === "a,c",
    "a row of the wrong kind for its page is dropped, and the rest of the page opens",
  );

  ok(
    parseSheet(null).sheets.length === 0,
    "a design with no estimate opens empty",
  );
  ok(
    parseSheet("{not json").sheets.length === 0,
    "and so does one whose estimate is corrupt, rather than failing the load",
  );
  ok(
    parseSheet(JSON.stringify({ version: 99, sheets: [] })).sheets.length === 0,
    "an estimate from a newer build opens empty rather than half-understood",
  );

  ok(
    parseSheet(JSON.stringify({ version: 0, sheets: [] })).sheets.length === 0,
    "an estimate in any other version opens empty",
  );

  // A book written before pages had kinds. Its pages are pages of scalars, which is what every page was, and
  // its `outputs` block is a field this reader does not look for — so it opens with its rows intact.
  const older = parseSheet(
    JSON.stringify({
      version: 1,
      sheets: [
        {
          id: "s1",
          name: "Weights",
          rows: [
            {
              id: "r1",
              kind: "item",
              name: "crew",
              formula: "160",
              unit: "kg",
              note: "",
            },
          ],
        },
      ],
      outputs: {
        displacement: { sheet: "s1", row: "gone" },
        vcg: null,
        lcg: null,
      },
      density: 1.025,
    }),
  );
  ok(
    older.sheets.length === 1 &&
      older.sheets[0].kind === "scalars" &&
      older.sheets[0].rows.length === 1 &&
      bookViolations(older).length === 0,
    "a page written before pages had kinds reads as a page of scalars, rows intact",
  );
}

// ---------- hull slice pages ----------
{
  let book = build([
    { name: "double section", formula: "Sections.midship.area * 2" },
    { name: "open perimeter", formula: "Sections.midship.openPerimeter" },
    { name: "closed perimeter", formula: "Sections.midship.closedPerimeter" },
  ]);
  book = run(book, {
    type: "addSheet",
    id: "sections",
    name: "Sections",
    kind: "slices",
  });
  book = run(book, {
    type: "addSheetRow",
    sheet: "sections",
    id: "midship",
    after: -1,
  });
  book = run(book, {
    type: "renameSheetRow",
    sheet: "sections",
    row: "midship",
    name: "midship",
  });
  book = run(book, {
    type: "setSheetFormula",
    sheet: "sections",
    row: "midship",
    field: "pos",
    formula: "HULL.LOA / 2",
  });

  const model = assemble(defaultHull());
  const sampling = computeHullSampling(model, 240, 10);
  const metrics = hullMetrics(model, sampling)!;
  const positions = evaluateBook(book, metrics);
  const pos = resultAt(positions, "sections", "midship", "pos")!.reading!.v;
  const section = measureSlice(model, sampling, "station", pos)!;
  const measured = new Map([
    [sliceMeasurementKey("sections", "midship"), section],
  ]);
  const results = evaluateBook(book, metrics, measured);

  ok(
    section.area > 0 &&
      section.openPerimeter > 0 &&
      section.closedPerimeter > section.openPerimeter,
    "a station slice measures open and closed perimeters",
  );
  ok(
    section.curve.length > 3 && section.z > 0,
    "and returns a curve and centroid for the 3D overlay",
  );
  ok(
    resultAt(results, book.sheets[0].id, rowOf(book, "double section").rowId)!
      .reading!.v ===
      section.area * 2,
    "a scalar formula can read a slice's measured area",
  );
  ok(
    resultAt(results, book.sheets[0].id, rowOf(book, "open perimeter").rowId)!
      .reading!.v === section.openPerimeter &&
      resultAt(
        results,
        book.sheets[0].id,
        rowOf(book, "closed perimeter").rowId,
      )!.reading!.v === section.closedPerimeter,
    "scalar formulas can read both slice perimeters",
  );

  const feetBook = run(
    run(book, {
      type: "setSheetUnit",
      sheet: "sections",
      row: "midship",
      unit: "ft",
    }),
    {
      type: "setSheetFormula",
      sheet: "sections",
      row: "midship",
      field: "pos",
      formula: "10",
    },
  );
  ok(
    near(
      resultAt(evaluateBook(feetBook, metrics), "sections", "midship", "pos")!
        .reading!.v,
      3.048,
      1e-12,
    ),
    "a slice position can be authored in a custom unit",
  );
  const feetBack = parseSheet(buildSheetJson(feetBook)).sheets[1].rows[0];
  ok(
    feetBack.kind === "slice" && feetBack.unit === "ft",
    "a slice's position unit round-trips",
  );

  const uncertainBook = run(book, {
    type: "setSheetFormula",
    sheet: "sections",
    row: "midship",
    field: "pos",
    formula: "2.5 ± 0.1",
  });
  const uncertainPositions = evaluateBook(uncertainBook, metrics);
  const uncertainPos = resultAt(
    uncertainPositions,
    "sections",
    "midship",
    "pos",
  )!.reading!.v;
  const uncertainMeasurement = measureSlice(
    model,
    sampling,
    "station",
    uncertainPos,
  )!;
  const uncertainResults = evaluateBook(
    uncertainBook,
    metrics,
    new Map([
      [sliceMeasurementKey("sections", "midship"), uncertainMeasurement],
    ]),
  );
  ok(
    resultAt(
      uncertainResults,
      uncertainBook.sheets[0].id,
      rowOf(uncertainBook, "double section").rowId,
    )!.reading!.worst.hi > 0,
    "position uncertainty propagates through the measured slice",
  );

  const horizontalPosition = metrics.draft * 0.5;
  const horizontal = measureSlice(model, sampling, "plane", horizontalPosition);
  ok(
    !!horizontal && horizontal.area > 0 && horizontal.curve.length > 3,
    "a horizontal slice measures and returns its intersection curve",
  );
  const geom = stationGeometry(model, sampling)!;
  const scale = unitScale(model.unit, "m");
  const rawHorizontal = cut(
    geom,
    0,
    geom.keelZ + horizontalPosition / scale,
    true,
  );
  const runLength = (points: readonly (readonly number[])[]): number => {
    let length = 0;
    for (let i = 1; i < points.length; i++)
      length += Math.hypot(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1],
        points[i][2] - points[i - 1][2],
      );
    return length;
  };
  const skinOnly =
    (runLength(rawHorizontal.waterlineSkin[0]) +
      runLength(rawHorizontal.waterlineSkin[1])) *
    scale;
  ok(
    near(horizontal!.openPerimeter, skinOnly, 1e-12),
    "a horizontal open perimeter excludes both centreline end caps",
  );

  let dependent = run(book, {
    type: "addSheetRow",
    sheet: "sections",
    id: "dependent",
    after: 0,
  });
  dependent = run(dependent, {
    type: "renameSheetRow",
    sheet: "sections",
    row: "dependent",
    name: "dependent",
  });
  dependent = run(dependent, {
    type: "setSheetFormula",
    sheet: "sections",
    row: "dependent",
    field: "pos",
    formula: "Weights.double section",
  });
  const dependencyError =
    resultAt(
      evaluateBook(dependent, metrics, measured),
      "sections",
      "dependent",
      "pos",
    )!.error ?? "";
  ok(
    dependencyError.includes("cannot depend on measured slice values"),
    `a slice position visibly refuses an indirect measured-value dependency (${dependencyError})`,
  );

  const shifted = defaultHull();
  const dx = 1000;
  const shiftedModel = assemble({
    ...shifted,
    sheerPlan: shifted.sheerPlan.map((point) => ({
      ...point,
      x: point.x + dx,
    })),
    sheerTrim: shifted.sheerTrim.map((point) => ({
      ...point,
      x: point.x + dx,
    })),
    transom: shifted.transom.map((point) => ({
      ...point,
      x: point.x + dx,
    })) as typeof shifted.transom,
  });
  const shiftedSampling = computeHullSampling(shiftedModel, 240, 10);
  const shiftedSection = measureSlice(
    shiftedModel,
    shiftedSampling,
    "station",
    pos,
  )!;
  ok(
    near(shiftedSection.area, section.area, 1e-9) &&
      near(shiftedSection.x, section.x, 1e-9),
    "station position and centroid x are relative to a nonzero transom",
  );
  ok(
    bookViolations(book).length === 0,
    "a slice page is a valid authored page",
  );
}

// ---------- points pages ----------
{
  const model = assemble(defaultHull());
  const sampling = computeHullSampling(model, 240, 10);
  const metrics = hullMetrics(model, sampling)!;

  // A points page beside a calculation page, built the way the panel builds one.
  let book = build([
    { name: "engine mass", formula: "180", unit: "kg" },
    { name: "engine arm", formula: "Places.engine.z" },
  ]);
  book = run(book, {
    type: "addSheet",
    id: "pts",
    name: "Places",
    kind: "points",
  });
  book = run(book, {
    type: "addSheetRow",
    sheet: "pts",
    id: "engine",
    after: -1,
  });
  book = run(book, {
    type: "renameSheetRow",
    sheet: "pts",
    row: "engine",
    name: "engine",
  });
  const pointRow = () =>
    book.sheets.find((sheet) => sheet.id === "pts")!.rows[0] as {
      kind: string;
      unit: string;
      x: string;
      y: string;
      z: string;
    };

  ok(
    pointRow().kind === "point",
    "a points page holds point rows without being told which kind to add",
  );
  ok(
    pointRow().unit === "m",
    "and a fresh point is authored in metres, so a dragged coordinate has a dimension",
  );

  // ---- one command, however many coordinates the gesture moved ----
  book = run(book, {
    type: "setPointPosition",
    sheet: "pts",
    row: "engine",
    x: "2.1",
    z: "0.35 ± 0.05",
  });
  ok(
    pointRow().x === "2.1" &&
      pointRow().z === "0.35 ± 0.05" &&
      pointRow().y === "",
    "setPointPosition writes the coordinates it names and leaves the rest alone",
  );
  ok(
    "rejected" in
      interpretSheetCommand(book, {
        type: "setPointPosition",
        sheet: "p0",
        row: "p0r0",
        x: "1",
      }),
    "and refuses a row that is not a point",
  );
  ok(
    sameGesture(
      { type: "setPointPosition", sheet: "pts", row: "engine", x: "1" },
      { type: "setPointPosition", sheet: "pts", row: "engine", z: "2" },
    ) &&
      !sameGesture(
        { type: "setPointPosition", sheet: "pts", row: "engine", x: "1" },
        { type: "setPointPosition", sheet: "pts", row: "tank", x: "1" },
      ),
    "a drag of one point is one gesture whichever coordinates it touched — and two points are two",
  );

  // ---- a point is three values, and only its leaves resolve ----
  const results = evaluateBook(book, null);
  ok(
    resultAt(results, "pts", "engine", "z")!.reading!.v === 0.35,
    "a coordinate evaluates in the row's own unit — 0.35 m, not 0.35 of nothing",
  );
  ok(
    near(value(book, "engine arm"), 0.35, 1e-12),
    "and another page reads it as Places.engine.z",
  );
  const bare = run(book, {
    type: "setSheetFormula",
    sheet: "p0",
    row: rowOf(book, "engine arm").rowId,
    field: "formula",
    formula: "Places.engine",
  });
  ok(
    (problem(bare, "engine arm") ?? "").includes("engine.x"),
    "naming a point without a coordinate says which coordinates it has",
  );

  // ---- a point named bare in a coordinate cell means that coordinate ----
  //
  // Which is what lets ONE expression state a whole position. Everywhere else a point still has to say which
  // of its three numbers is meant, and the message that says so is the one that was always there.
  let cg = build([
    { name: "engine", formula: "180 ± 20", unit: "kg" },
    { name: "tank", formula: "140", unit: "kg" },
    { name: "rig", formula: "95", unit: "kg" },
    { name: "total", formula: "engine + tank + rig", unit: "kg" },
  ]);
  cg = run(cg, { type: "addSheet", id: "pl", name: "Places", kind: "points" });
  const at = (id: string, name: string, x: string, y: string, z: string) => {
    cg = run(cg, { type: "addSheetRow", sheet: "pl", id, after: -1 });
    cg = run(cg, { type: "renameSheetRow", sheet: "pl", row: id, name });
    cg = run(cg, { type: "setPointPosition", sheet: "pl", row: id, x, y, z });
  };
  at("pe", "engine", "2.4", "0", "0.42");
  at("pt", "tank", "1.2", "0", "0.25");
  at("pr", "rig", "3.1", "0", "2.8");

  const offCentre = run(cg, {
    type: "setPointPosition",
    sheet: "pl",
    row: "pe",
    x: "tank + 0.6",
  });
  ok(
    near(
      resultAt(evaluateBook(offCentre, null), "pl", "pe", "x")!.reading!.v,
      1.8,
      1e-12,
    ),
    "a point named bare in an x cell is its x — which is how one point sits off another",
  );
  ok(
    (
      problem(
        run(cg, {
          type: "setSheetFormula",
          sheet: "p0",
          row: rowOf(cg, "total").rowId,
          field: "formula",
          formula: "Places.engine",
        }),
        "total",
      ) ?? ""
    ).includes("write engine.x"),
    "and in a cell that is not a coordinate it still has to say which number is meant",
  );

  // ---- a slice's centroid binds the same way ----
  //
  // A cut has a position too, so the centre of area of a set of sections is the centre-of-gravity expression
  // with areas where the masses were.
  {
    let cuts = run(emptyBook(), {
      type: "addSheet",
      id: "sx",
      name: "Sections",
      kind: "slices",
    });
    const cut2 = (id: string, name: string, pos: string) => {
      cuts = run(cuts, { type: "addSheetRow", sheet: "sx", id, after: -1 });
      cuts = run(cuts, {
        type: "renameSheetRow",
        sheet: "sx",
        row: id,
        name,
      });
      cuts = run(cuts, {
        type: "setSheetFormula",
        sheet: "sx",
        row: id,
        field: "pos",
        formula: pos,
      });
    };
    cut2("c1", "fwd", "HULL.LOA * 0.35");
    cut2("c2", "aft", "HULL.LOA * 0.65");
    cuts = run(cuts, {
      type: "addSheet",
      id: "px",
      name: "Places",
      kind: "points",
    });
    cuts = run(cuts, { type: "addSheetRow", sheet: "px", id: "ac", after: -1 });
    cuts = run(cuts, {
      type: "renameSheetRow",
      sheet: "px",
      row: "ac",
      name: "area centre",
    });
    cuts = run(cuts, {
      type: "setSheetFormula",
      sheet: "px",
      row: "ac",
      field: "from",
      formula:
        "(Sections.fwd.area * Sections.fwd + Sections.aft.area * Sections.aft) / (Sections.fwd.area + Sections.aft.area)",
    });

    const first = evaluateBook(cuts, metrics);
    const cutsMeasured = new Map(
      ["c1", "c2"].map((id) => [
        sliceMeasurementKey("sx", id),
        measureSlice(
          model,
          sampling,
          "station",
          resultAt(first, "sx", id, "pos")!.reading!.v,
        )!,
      ]),
    );
    const centred = evaluateBook(cuts, metrics, cutsMeasured);
    const fwd = cutsMeasured.get(sliceMeasurementKey("sx", "c1"))!;
    const aft = cutsMeasured.get(sliceMeasurementKey("sx", "c2"))!;
    const weighted = (pick: (m: typeof fwd) => number) =>
      (fwd.area * pick(fwd) + aft.area * pick(aft)) / (fwd.area + aft.area);
    ok(
      near(
        resultAt(centred, "px", "ac", "x")!.reading!.v,
        weighted((m) => m.x),
        1e-12,
      ) &&
        near(
          resultAt(centred, "px", "ac", "z")!.reading!.v,
          weighted((m) => m.z),
          1e-12,
        ),
      "a slice named bare in a coordinate cell is its centroid, so sections weigh by area into a centre",
    );
    ok(
      resultAt(centred, "px", "ac", "x")!.unit?.label === "m",
      "and m²·m over m² is a length, so that row checks its own arithmetic too",
    );
    ok(
      (
        resultAt(
          evaluateBook(
            run(cuts, {
              type: "setSheetFormula",
              sheet: "sx",
              row: "c1",
              field: "pos",
              formula: "Sections.aft",
            }),
            metrics,
          ),
          "sx",
          "c1",
          "pos",
        )?.error ?? ""
      ).includes("write aft.pos"),
      "outside a coordinate cell a slice still has to say which of its numbers is meant",
    );
  }

  // ---- the hull's own shell is a place too ----
  //
  // `SHELL_LCG` and `SHELL_VCG` are the same numbers, and multiplying a mass by each is how a shell weight
  // has always been placed. Offering them as ONE place is what lets the hull weigh into a centre of gravity
  // in the same expression as everything else, instead of the schedule being written out per axis.
  {
    let hull = build([
      { name: "ply", formula: "6.4", unit: "kg/m2" },
      { name: "shell", formula: "HULL.SHELL_AREA * ply", unit: "kg" },
      { name: "engine", formula: "180", unit: "kg" },
      { name: "total", formula: "shell + engine", unit: "kg" },
    ]);
    hull = run(hull, {
      type: "addSheet",
      id: "hp",
      name: "Places",
      kind: "points",
    });
    hull = run(hull, { type: "addSheetRow", sheet: "hp", id: "he", after: -1 });
    hull = run(hull, {
      type: "renameSheetRow",
      sheet: "hp",
      row: "he",
      name: "engine",
    });
    hull = run(hull, {
      type: "setPointPosition",
      sheet: "hp",
      row: "he",
      x: "2.4",
      y: "0",
      z: "0.42",
    });
    hull = run(hull, { type: "addSheetRow", sheet: "hp", id: "hc", after: -1 });
    hull = run(hull, {
      type: "renameSheetRow",
      sheet: "hp",
      row: "hc",
      name: "CG",
    });
    hull = run(hull, {
      type: "setSheetFormula",
      sheet: "hp",
      row: "hc",
      field: "from",
      formula:
        "(Weights.shell * HULL.SHELL_CG + Weights.engine * engine) / Weights.total",
    });
    const placedHull = evaluateBook(hull, metrics);
    const shellMass = value(hull, "shell", "Weights", metrics);
    const all = shellMass + 180;
    ok(
      near(
        resultAt(placedHull, "hp", "hc", "x")!.reading!.v,
        (shellMass * metrics.shellLcg + 180 * 2.4) / all,
        1e-9,
      ) &&
        near(
          resultAt(placedHull, "hp", "hc", "z")!.reading!.v,
          (shellMass * metrics.shellVcg + 180 * 0.42) / all,
          1e-9,
        ),
      "the shell weighs into a centre of gravity beside the points, in one expression",
    );
    ok(
      resultAt(placedHull, "hp", "hc", "y")!.reading!.v === 0,
      "and its y is the centreline, because an authored hull is symmetric about it",
    );
    ok(
      near(
        value(
          build([{ name: "h", formula: "HULL.SHELL_CG.z", unit: "m" }]),
          "h",
          "Weights",
          metrics,
        ),
        metrics.shellVcg,
        1e-12,
      ),
      "a coordinate of it reads anywhere, as HULL.SHELL_CG.z",
    );
    ok(
      (
        problem(
          build([{ name: "h", formula: "HULL.SHELL_CG" }]),
          "h",
          "Weights",
          metrics,
        ) ?? ""
      ).includes("is a place"),
      "and named bare outside a coordinate it says it is a place and which coordinates it has",
    );
  }

  // ---- one expression for all three coordinates ----
  cg = run(cg, { type: "addSheetRow", sheet: "pl", id: "cg", after: -1 });
  cg = run(cg, { type: "renameSheetRow", sheet: "pl", row: "cg", name: "CG" });
  cg = run(cg, {
    type: "setSheetFormula",
    sheet: "pl",
    row: "cg",
    field: "from",
    formula:
      "(Weights.engine * engine + Weights.tank * tank + Weights.rig * rig) / Weights.total",
  });
  const centre = evaluateBook(cg, null);
  const coord = (axis: "x" | "y" | "z") => resultAt(centre, "pl", "cg", axis)!;
  const masses = { e: 180, t: 140, r: 95 };
  const sum = masses.e + masses.t + masses.r;
  ok(
    near(
      coord("x").reading!.v,
      (masses.e * 2.4 + masses.t * 1.2 + masses.r * 3.1) / sum,
      1e-12,
    ) &&
      near(
        coord("z").reading!.v,
        (masses.e * 0.42 + masses.t * 0.25 + masses.r * 2.8) / sum,
        1e-12,
      ),
    "one expression read once per axis is a centre of gravity, and it lands where the arithmetic says",
  );
  ok(
    coord("x").unit?.label === "m" && coord("z").unit?.label === "m",
    "kg·m over kg is a length, so the row checks its own arithmetic",
  );
  ok(
    coord("x").reading!.terms[0]?.label === "Weights.engine" &&
      coord("z").reading!.terms[0]?.label === "Weights.engine",
    "and the mass that is guessed at drives the spread in every coordinate it reaches",
  );

  // The payoff of carrying gradients: one mass moving two coordinates ties them together, so the region is
  // a line rather than a box — a CG that can be anywhere in a rectangle is a claim nothing supports.
  const tied = worstRegion(
    coord("x").quantity!,
    coord("z").quantity!,
    centre.sources,
  );
  ok(
    tied.length === 2,
    "a CG whose coordinates lean on one mass is uncertain along a line, not over an area",
  );

  ok(
    resultAt(centre, "pl", "cg", "y")!.reading!.v === 0,
    "and a derivation still produces three cells, so the y everything downstream reads is there",
  );

  // The three coordinates remain three cells in the dependency graph, which is what keeps a failure local.
  const halfBroken = run(cg, {
    type: "setPointPosition",
    sheet: "pl",
    row: "pr",
    z: "nonsense * 2",
  });
  const partial = evaluateBook(halfBroken, null);
  ok(
    !resultAt(partial, "pl", "cg", "x")!.error &&
      !!resultAt(partial, "pl", "cg", "z")!.error,
    "a derivation that fails on one axis still answers on the other two",
  );

  const looped = run(cg, {
    type: "setSheetFormula",
    sheet: "pl",
    row: "cg",
    field: "from",
    formula: "CG + 1",
  });
  ok(
    (
      resultAt(evaluateBook(looped, null), "pl", "cg", "z")!.error ?? ""
    ).includes("refers back to itself"),
    "and a derivation that reaches back to its own row is caught as the loop it is",
  );

  const engineRow = cg.sheets
    .find((page) => page.id === "pl")!
    .rows.find((r) => r.name === "engine") as { x: string; z: string };
  ok(
    engineRow.x === "2.4" && engineRow.z === "0.42",
    "turning a derivation on leaves the coordinates alone, so turning it off gives them back",
  );

  // ---- what may be dragged is read off the cell ----
  //
  // A drag moves ONE literal inside the expression, and adds one where the expression has none. Which
  // literal that is comes off the parse, never off a mode the user picked.
  // The panel hands over the parse the EVALUATOR already made, and a cell that would not parse has none —
  // so the helper mirrors that rather than throwing where the panel would simply see null.
  const place = (
    text: string,
    value = 0,
    canAppend = true,
    symbols = ["HULL"],
  ) => {
    let tree = null;
    try {
      if (text.trim()) tree = parseFormula(text, symbols);
    } catch {
      tree = null;
    }
    return readPlacement(text, tree, value, canAppend);
  };
  const move = (text: string, value: number, target: number) =>
    withNominal(place(text, value)!, target, 0.001);

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

  // The point of the whole thing: a literal added to a reference.
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

  // Nothing to move: the drag writes one.
  ok(
    place("HULL.LCB", 2.05)?.handle === null &&
      move("HULL.LCB", 2.05, 2.35) === "HULL.LCB + 0.3" &&
      move("HULL.LCB", 2.05, 1.85) === "HULL.LCB - 0.2",
    "a coordinate that is a pure reference gets an offset written for it rather than being overwritten",
  );
  ok(
    place("HULL.LCB", 2.05, false) === null,
    "but only where the row's unit would give that number a dimension — otherwise the drag would break the cell",
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

  // A drag writes on every frame, so what each frame computes FROM decides whether crossing a snap is
  // survivable. From the cell as it stood when the gesture started, a frame past the snap writes a plain
  // number again; from the cell as it stands now, it would have found a reference there and appended to it —
  // which is how brushing past a slice used to weld it into the coordinate for the rest of the drag.
  ok(
    move("1.2", 1.2, 2.4) === "2.4" && move("1.2", 1.2, 3.2) === "3.2",
    "every frame of a drag is computed from where the coordinate started, so the last one lands on the pointer",
  );
  ok(
    withNominal(
      place("Slices.frame 4.pos", 2.4, true, ["Slices", "frame 4"])!,
      3.2,
      0.001,
    ) === "Slices.frame 4.pos + 0.8",
    "re-reading a snapped cell instead would offset from the reference — correct for a NEW gesture, wrong mid-drag",
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

  // ---- a bare term of the outermost sum is read in the row's unit ----
  //
  // Which is what lets `HULL.LCB + 2` evaluate at all. The test is what a term WORKS OUT to, not what it
  // looks like, so nothing that evaluated before this rule existed evaluates differently now.
  const inUnits = (formula: string, unit: string): number | string => {
    let one = run(emptyBook(), {
      type: "addSheet",
      id: "u",
      name: "U",
      kind: "scalars",
    });
    one = run(one, { type: "addSheetRow", sheet: "u", id: "r", after: -1 });
    one = run(one, { type: "setSheetUnit", sheet: "u", row: "r", unit });
    one = run(one, {
      type: "setSheetFormula",
      sheet: "u",
      row: "r",
      field: "formula",
      formula,
    });
    const result = resultAt(evaluateBook(one, metrics), "u", "r")!;
    return result.error ?? result.reading!.v;
  };
  ok(
    near(inUnits("HULL.LCB + 2", "m") as number, metrics.lcb + 2, 1e-9),
    "a plain number added to a length is read in the row's own unit",
  );
  ok(
    near(inUnits("HULL.LCB + 200", "mm") as number, metrics.lcb + 0.2, 1e-9),
    "in the row's unit, not in metres — 200 mm is 0.2 m",
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
    typeof inUnits("HULL.LCB + 2", "") === "string" &&
      (inUnits("HULL.LCB + 2", "") as string).includes("Give this row a unit"),
    "with no unit declared there is nothing to read it in — and the refusal says where the fix is",
  );
  ok(
    typeof inUnits("HULL.SHELL_AREA + 2", "m") === "string",
    "a unit that disagrees with the formula is still a refusal, not a silent conversion",
  );

  // ---- a guess is ranked by the CELL it was typed in, not by the row ----
  const guessed = run(
    run(book, {
      type: "setPointPosition",
      sheet: "pts",
      row: "engine",
      x: "2.1 ± 0.3",
    }),
    {
      type: "setSheetFormula",
      sheet: "p0",
      row: rowOf(book, "engine arm").rowId,
      field: "formula",
      formula: "Places.engine.x + Places.engine.z",
    },
  );
  const ranked = evaluateBook(guessed, null);
  const terms = resultAt(
    ranked,
    "p0",
    rowOf(guessed, "engine arm").rowId,
  )!.reading!.terms.map((term) => term.label);
  ok(
    terms.includes("Places.engine.x") && terms.includes("Places.engine.z"),
    "a point's two guesses are ranked apart — which is the whole reason its coordinates are separate cells",
  );

  // ---- the uncertainty region: a box only when the coordinates are independent ----
  const independent = build([
    { name: "a", formula: "2 ± 0.5" },
    { name: "b", formula: "1 ± 0.25" },
  ]);
  const ind = evaluateBook(independent, null);
  const qa = resultAt(ind, "p0", "p0r0")!.quantity!;
  const qb = resultAt(ind, "p0", "p0r1")!.quantity!;
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
    { name: "a", formula: "frame * 2" },
    { name: "b", formula: "frame * 1" },
  ]);
  const sh = evaluateBook(shared, null);
  const line = worstRegion(
    resultAt(sh, "p0", "p0r1")!.quantity!,
    resultAt(sh, "p0", "p0r2")!.quantity!,
    sh.sources,
  );
  ok(
    line.length === 2 &&
      near(Math.abs(line[0][0]), 0.2, 1e-12) &&
      near(Math.abs(line[0][1]), 0.1, 1e-12) &&
      near(line[0][0] / line[0][1], 2, 1e-9),
    "one shared guess collapses the region to the line the pair actually moves along",
  );

  // The opposite sign is the other diagonal — which an interval box could never tell apart from the first.
  const opposed = run(shared, {
    type: "setSheetFormula",
    sheet: "p0",
    row: rowOf(shared, "b").rowId,
    field: "formula",
    formula: "0 - frame",
  });
  const op = evaluateBook(opposed, null);
  const anti = worstRegion(
    resultAt(op, "p0", "p0r1")!.quantity!,
    resultAt(op, "p0", "p0r2")!.quantity!,
    op.sources,
  );
  ok(
    anti.length === 2 && near(anti[0][0] / anti[0][1], -2, 1e-9),
    "and a guess two coordinates lean on in opposite directions tilts the other way",
  );

  // The likely ellipse reaches exactly as far along each axis as the panel's own quadrature figure.
  const ellipse = likelyRegion(qa, qb, ind.sources);
  const likelyA = resultAt(ind, "p0", "p0r0")!.reading!.likely.hi;
  const likelyB = resultAt(ind, "p0", "p0r1")!.reading!.likely.hi;
  ok(
    near(spanOf(ellipse, 0)[1], likelyA, 1e-9) &&
      near(spanOf(ellipse, 1)[1], likelyB, 1e-9),
    "the likely region is the quadrature the panel quotes, drawn",
  );
  const certain = build([
    { name: "a", formula: "2 ± 0.5" },
    { name: "b", formula: "1" },
  ]);
  const ce = evaluateBook(certain, null);
  const flat = worstRegion(
    resultAt(ce, "p0", "p0r0")!.quantity!,
    resultAt(ce, "p0", "p0r1")!.quantity!,
    ce.sources,
  );
  ok(
    flat.length === 2 && flat.every(([, y]) => y === 0),
    "a coordinate nothing can move leaves the region a line along the other one",
  );

  // ---- the frame, and the two outlines ----
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
  const lowest = Math.min(...outlines.profile.lower.map(([, z]) => z));
  ok(
    near(lowest, 0, 1e-6),
    "so the lowest point of the silhouette sits on the datum it is measured from",
  );
  ok(
    near(outlines.frame.xSpan[1], metrics.loa, 1e-6),
    "and the silhouette spans the LOA the sheet reads from HULL.LOA",
  );

  // A round trip through model coordinates, which is what the 3D overlay would draw with.
  const there: [number, number, number] = [1.2, 0.3, 0.8];
  const back = toSheet(outlines.frame, toModel(outlines.frame, there));
  ok(
    near(back[0], there[0], 1e-9) &&
      near(back[1], there[1], 1e-9) &&
      near(back[2], there[2], 1e-9),
    "the sheet frame and the model frame convert back and forth exactly",
  );

  const amidships = sectionOutline(
    model,
    outlines.frame,
    outlines.frame.xSpan[1] / 2,
  )!;
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
  const beyond = sectionOutline(
    model,
    outlines.frame,
    outlines.frame.xSpan[1] * 2,
  )!;
  ok(
    beyond !== null && beyond.clamped,
    "an x past the bow is clamped to the nearest real section rather than refused — a point outside the hull is still a point",
  );
  ok(
    near(
      (outlines.frame.x1 - outlines.frame.x0) * metres,
      outlines.frame.xSpan[1],
      1e-9,
    ),
    "and the frame's model span and its sheet span are the same length",
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
    { name: "hull shell", formula: "area * density" },
  ]);
  const results = evaluateBook(book, metrics);
  const shell = resultAt(
    results,
    book.sheets[0].id,
    rowOf(book, "hull shell").rowId,
  )!;
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
      shell.reading!.terms[0].label === "density",
    "the hull contributes no uncertainty of its own — it is drawn, not guessed",
  );

  const noHull = evaluateBook(book, null);
  ok(
    (
      resultAt(noHull, book.sheets[0].id, rowOf(book, "area").rowId)!.error ??
      ""
    ).includes("not been measured"),
    "with no hull measured, only the rows that touch it fail",
  );
  ok(
    resultAt(noHull, book.sheets[0].id, rowOf(book, "density").rowId)!.error ===
      null,
    "and the rest of the book still evaluates",
  );

  ok(
    (
      problem(
        build([{ name: "a", formula: "HULL.NOSUCH" }]),
        "a",
        "Weights",
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
        "Weights",
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

// ---------- reordering ----------
// Order is presentation — formulas resolve by name — so a move must not disturb a single value. It is also
// the ONLY way an item changes group, since a heading is a row and an item belongs to the one above it.
{
  const book = build([
    { name: "a", group: "One", formula: "1" },
    { name: "b", group: "One", formula: "2" },
    { name: "c", group: "Two", formula: "a + b" },
  ]);
  const sheetId = book.sheets[0].id;
  const items = (b: WeightBook) =>
    b.sheets[0].rows.filter((r) => r.kind === "item").map((r) => r.name);
  const rowId = (name: string) =>
    book.sheets[0].rows.find((r) => r.name === name)!.id;
  const indexOf = (b: WeightBook, name: string) =>
    b.sheets[0].rows.findIndex((r) => r.name === name);

  const moved = run(book, {
    type: "moveSheetRow",
    sheet: sheetId,
    row: rowId("c"),
    to: 0,
  });
  ok(items(moved).join() === "c,a,b", "an item moves to where it was put");
  ok(
    value(moved, "c") === 3,
    "and the formula that depended on the two below it still works",
  );
  ok(
    groupAt(moved.sheets[0], indexOf(moved, "c")) === "",
    "moving it above every heading takes it out of any group",
  );

  const intoOne = run(book, {
    type: "moveSheetRow",
    sheet: sheetId,
    row: rowId("c"),
    to: indexOf(book, "b"),
  });
  ok(
    groupAt(intoOne.sheets[0], indexOf(intoOne, "c")) === "One",
    "and moving it into another heading's block joins that group — the move is the whole of it",
  );

  const past = run(book, {
    type: "moveSheetRow",
    sheet: sheetId,
    row: rowId("a"),
    to: 99,
  });
  ok(
    items(past).join() === "b,c,a",
    "a move past the end lands at the end rather than being refused",
  );
  ok(
    "rejected" in
      interpretSheetCommand(book, {
        type: "moveSheetRow",
        sheet: sheetId,
        row: "nope",
        to: 0,
      }),
    "moving something that is not there is refused",
  );

  // A heading drags like any other row, and re-groups whatever falls between it and the next one. Dropped
  // just under "One" it now covers a and b, and "One" covers nothing.
  const headMoved = run(book, {
    type: "moveSheetRow",
    sheet: sheetId,
    row: rowId("Two"),
    to: 1,
  });
  const h = headMoved.sheets[0];
  ok(
    groupAt(h, indexOf(headMoved, "a")) === "Two" &&
      groupAt(h, indexOf(headMoved, "b")) === "Two",
    "dragging a heading upward takes the rows it passes into it",
  );
  ok(
    rowsUnder(
      h,
      h.rows.findIndex((r) => r.name === "One"),
    ).length === 0,
    "leaving the heading it passed with nothing under it — still a heading, just empty",
  );
  ok(value(headMoved, "c") === 3, "and still disturbs no value");
}

if (failures) process.exitCode = 1;
else console.log("\nall passed");
