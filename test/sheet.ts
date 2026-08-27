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
    "rejected" in points,
    "a points page cannot be made yet — the kind exists, the editor does not",
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
  const meshLcg = (cx / area) * s;
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
