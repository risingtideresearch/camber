// ---------- evaluating a weight book ----------
//
// Takes the authored pages and the hull's numbers, and produces a value, a spread and a sensitivity ranking
// for every row. Everything that can go wrong is reported PER ROW and nothing throws: a half-written formula
// is a normal state for a schedule to be in, and one bad line must not take the other thirty with it.
//
// ---------- how a name is resolved ----------
//
// A bare `hull shell` is a row on the page the formula is written on. Everything else is a dotted path:
//
//   HULL.LWL, HULL.SHELL_AREA …   the geometry, exact, in metres and kilograms (`../hullMetrics.ts`)
//   Weights.hull shell            a row on ANOTHER page — which is what pages are for
//
// Names may contain spaces, and the lexer is handed the symbol table that makes that unambiguous — see
// `symbolsOf`.
//
// ---------- groups do not add up ----------
//
// A group is a HEADING and nothing more: it collects rows under a name and folds them away. It carries no
// subtotal, and no formula can ask for one.
//
// That is not a gap. A group is not a declaration that everything under it is the same kind of thing — a real
// schedule puts the plywood density next to the shell it prices, and the fraction next to the framing it
// scales — so a group's rows routinely mix a mass, an area and a plain number, and asking them to add has no
// answer. Guessing at one, however carefully hedged, produces a number that looks authoritative and is not.
// A total that means something is written out: `hull shell + frames + bulkheads`, which says exactly what it
// adds and fails loudly if those stop being the same kind of thing.
//
// ---------- cycles ----------
//
// Resolution is depth-first with a visiting set, so a cycle is caught at the moment it closes and every row
// on it gets the same message naming the loop. There is no topological pre-pass: the graph is tiny, and doing
// it lazily means a row that references nothing is evaluated even when the rest of the book is tangled.

import { evaluate, FormulaError, parseFormula, type Node } from "./formula";
import { hullMetric, isHullMetricName, type HullMetrics } from "../hullMetrics";
import { read, type Quantity, type Reading, type Source } from "./quantity";
import {
  isHeading,
  symbolsOf,
  type Sheet,
  type SheetRef,
  type SheetRow,
  type WeightBook,
} from "./book";
import { naturalUnit, parseUnit, UnitError, type UnitSpec } from "./units";

/** One evaluated row. */
export interface RowResult {
  readonly sheetId: string;
  readonly rowId: string;
  /** A blank formula has no value and no error — it is simply empty. */
  readonly empty: boolean;
  readonly reading: Reading | null;
  /** What went wrong, in a sentence a person can act on. */
  readonly error: string | null;
  /** Where in the formula, for a caret. −1 when the message is not about a position. */
  readonly errorAt: number;
  /**
   * The unit the value is SHOWN in: what the row declares, or — where it declares nothing — the natural unit
   * of whatever the formula worked out to. That is what makes units appear on their own the moment a row
   * acquires a dimension, and lets typing `t` over a `kg` convert rather than complain.
   */
  readonly unit: UnitSpec | null;
  /** True when the shown unit was derived rather than typed, so the panel can render it as a suggestion. */
  readonly unitIsDerived: boolean;
  /**
   * The declared unit's dimension disagrees with the formula's own. Not an error: the value is reported as
   * the formula computed it, and the row is flagged so the mismatch is visible rather than silently believed.
   */
  readonly unitWarning: string | null;
}

export interface BookResults {
  /** Keyed `sheetId + " " + rowId`. */
  readonly rows: ReadonlyMap<string, RowResult>;
  readonly sources: ReadonlyMap<string, Source>;
  /** The book's declared outputs, resolved. Null where nothing is nominated or the row failed. */
  readonly outputs: {
    readonly displacement: Reading | null;
    readonly vcg: Reading | null;
    readonly lcg: Reading | null;
  };
}

export const rowKey = (sheetId: string, rowId: string): string =>
  `${sheetId} ${rowId}`;

export const resultAt = (
  results: BookResults,
  sheetId: string,
  rowId: string,
): RowResult | undefined => results.rows.get(rowKey(sheetId, rowId));

export const resultFor = (
  results: BookResults,
  ref: SheetRef | null,
): RowResult | undefined =>
  ref ? results.rows.get(rowKey(ref.sheet, ref.row)) : undefined;

// ---------- the evaluator ----------

interface Cell {
  readonly sheet: Sheet;
  readonly row: SheetRow;
  readonly source: string;
  /** Parsed once, whatever it is referenced from. */
  tree: Node | null;
  parseError: FormulaError | null;
  declared: UnitSpec | null;
  unitError: string | null;
  state: "fresh" | "running" | "done";
  value: Quantity | null;
  error: { message: string; at: number } | null;
  unitWarning: string | null;
}

/**
 * Evaluate a whole book.
 *
 * `metrics` may be null — the hull has not been measured yet, or does not float — in which case any formula
 * touching `HULL.*` reports that rather than the book failing wholesale.
 */
export function evaluateBook(
  book: WeightBook,
  metrics: HullMetrics | null,
): BookResults {
  const cells = new Map<string, Cell>();
  const sources = new Map<string, Source>();
  let sourceSeq = 0;

  // Row names are resolved PER PAGE — the same name may mean different things on the weight page and the VCG
  // page, which is the point of pages — so each gets its own index and its own symbol table.
  const rowsByName = new Map<string, Map<string, SheetRow>>();
  const sheetsByName = new Map<string, Sheet>();
  const symbols = new Map<string, string[]>();
  for (const sheet of book.sheets) {
    if (sheet.name) sheetsByName.set(sheet.name, sheet);
    const index = new Map<string, SheetRow>();
    for (const row of sheet.rows)
      if (row.name && !isHeading(row)) index.set(row.name, row);
    rowsByName.set(sheet.id, index);
    symbols.set(sheet.id, symbolsOf(book, sheet.id));
  }

  // Headings carry no formula and produce no result: they are where a group starts, and nothing more.
  for (const sheet of book.sheets)
    for (const row of sheet.rows) {
      if (isHeading(row)) continue;
      const text = row.formula.trim();
      let declared: UnitSpec | null = null;
      let unitError: string | null = null;
      if (row.unit.trim()) {
        try {
          declared = parseUnit(row.unit);
        } catch (error) {
          unitError =
            error instanceof UnitError ? error.message : String(error);
        }
      }
      let tree: Node | null = null;
      let parseError: FormulaError | null = null;
      if (text) {
        try {
          tree = parseFormula(text, symbols.get(sheet.id));
        } catch (error) {
          parseError =
            error instanceof FormulaError
              ? error
              : new FormulaError(String(error));
        }
      }
      cells.set(rowKey(sheet.id, row.id), {
        sheet,
        row,
        source: text,
        tree,
        parseError,
        declared,
        unitError,
        state: "fresh",
        value: null,
        error: null,
        unitWarning: null,
      });
    }

  // The path currently being resolved, so a cycle is reported as the loop it actually is.
  const visiting: string[] = [];
  // Rows whose message is already final because they sit ON a cycle. Without this the loop would be reported
  // by exactly one of its members — whichever closed it — and the others would each say only that a
  // neighbour failed, which tells the reader nothing about where the knot is.
  const cycled = new Set<string>();

  const fail = (message: string, at = -1): never => {
    throw new FormulaError(message, at);
  };

  const describe = (key: string): string => {
    const cell = cells.get(key);
    if (!cell) return "a missing item";
    const name = cell.row.name || "an unnamed item";
    return book.sheets.length > 1 ? `${cell.sheet.name}.${name}` : name;
  };

  const rowValue = (sheetId: string, rowId: string, at: number): Quantity => {
    const key = rowKey(sheetId, rowId);
    const cell = cells.get(key);
    if (!cell) fail("no such item", at);
    if (cell!.state === "running") {
      const loop = visiting.slice(visiting.indexOf(key));
      const text = `this refers back to itself: ${[...loop, key].map(describe).join(" → ")}`;
      for (const member of loop) {
        cycled.add(member);
        const onLoop = cells.get(member)!;
        onLoop.error = { message: text, at: -1 };
        onLoop.value = null;
      }
      fail(text, at);
    }
    if (cell!.state === "fresh") compute(cell!);
    if (cell!.error) fail(`${describe(key)} could not be worked out`, at);
    if (!cell!.value) fail(`${describe(key)} is empty`, at);
    return cell!.value!;
  };

  // Which page the row being evaluated sits on, so a bare reference means "this page".
  let currentSheet: Sheet = book.sheets[0] ?? { id: "", name: "", rows: [] };
  let currentCell: Cell | null = null;

  const resolve = (path: readonly string[], at: number): Quantity => {
    const [head, ...rest] = path;

    if (head === "HULL") {
      if (rest.length !== 1)
        fail(`HULL.${rest.join(".") || "?"} is not a hull measurement`, at);
      if (!metrics)
        fail(
          "the hull has not been measured yet — it may not float at its own waterline",
          at,
        );
      const value = hullMetric(metrics!, rest[0]);
      if (!value)
        fail(
          `the hull has no measurement called ${rest[0]}${isHullMetricName(rest[0].toUpperCase()) ? ` — did you mean HULL.${rest[0].toUpperCase()}?` : ""}`,
          at,
        );
      return value!;
    }

    // A bare name is a row on THIS page, and that is tried first: a page and a row may share a name, and the
    // page you are writing on is the one you meant.
    if (rest.length === 0) {
      const row = rowsByName.get(currentSheet.id)?.get(head);
      if (row) return rowValue(currentSheet.id, row.id, at);
      const near = [...(rowsByName.get(currentSheet.id)?.keys() ?? [])].find(
        (name) => name.toLowerCase() === head.toLowerCase(),
      );
      fail(
        `nothing on this page is called ${head}${
          near
            ? ` — did you mean ${near}?`
            : sheetsByName.has(head)
              ? ` — ${head} is a page; write ${head}.something`
              : ""
        }`,
        at,
      );
    }

    // Otherwise it names another page.
    const sheet = sheetsByName.get(head);
    if (!sheet) fail(`there is no page called ${head}`, at);
    if (rest.length > 1) fail(`${path.join(".")} is one dot too deep`, at);
    const row = rowsByName.get(sheet!.id)?.get(rest[0]);
    if (!row) fail(`${sheet!.name} has nothing called ${rest[0]}`, at);
    return rowValue(sheet!.id, row!.id, at);
  };

  const env = {
    resolve,
    source: (lo: number, hi: number): Source => {
      const cell = currentCell!;
      const base = cell.row.name || "an unnamed item";
      const label =
        book.sheets.length > 1 ? `${cell.sheet.name}.${base}` : base;
      const id = `s${sourceSeq++}`;
      const source: Source = { id, label, lo, hi };
      sources.set(id, source);
      return source;
    },
  };

  /**
   * Apply the row's unit.
   *
   * A DIMENSIONLESS formula is scaled and stamped: `26` in a row marked `t` is 26000 kg. A formula that
   * already carries a dimension — because it touched `HULL.SHELL_AREA` or another stamped row — is already in
   * base units, so a matching unit is a DISPLAY choice handled at render time, and a mismatched one is a
   * warning rather than a refusal.
   */
  const stamp = (value: Quantity, cell: Cell): Quantity => {
    const unit = cell.declared;
    if (!unit || (unit.dim.m === 0 && unit.dim.l === 0 && unit.factor === 1))
      return value;
    const bare = value.dim.m === 0 && value.dim.l === 0;
    if (bare)
      return {
        v: value.v * unit.factor,
        d: Object.fromEntries(
          Object.entries(value.d).map(([id, g]) => [id, g * unit.factor]),
        ),
        dim: unit.dim,
      };
    if (value.dim.m !== unit.dim.m || value.dim.l !== unit.dim.l)
      cell.unitWarning = `this works out to ${naturalUnit(value.dim).label || "a plain number"}, not ${unit.label}`;
    return value;
  };

  const compute = (cell: Cell): void => {
    const key = rowKey(cell.sheet.id, cell.row.id);
    cell.state = "running";
    visiting.push(key);
    const savedSheet = currentSheet;
    const savedCell = currentCell;
    currentSheet = cell.sheet;
    currentCell = cell;
    try {
      if (cell.unitError) cell.error = { message: cell.unitError, at: -1 };
      else if (cell.parseError)
        cell.error = {
          message: cell.parseError.message,
          at: cell.parseError.at,
        };
      else if (cell.tree) cell.value = stamp(evaluate(cell.tree, env), cell);
    } catch (error) {
      // A row already named by a cycle keeps that message: "x could not be worked out" is true but useless
      // next to the loop itself.
      if (!cycled.has(key)) {
        cell.error =
          error instanceof FormulaError
            ? { message: error.message, at: error.at }
            : { message: String(error), at: -1 };
        cell.value = null;
      }
    } finally {
      currentSheet = savedSheet;
      currentCell = savedCell;
      visiting.pop();
      cell.state = "done";
    }
  };

  for (const cell of cells.values()) if (cell.state === "fresh") compute(cell);

  // ---------- the reported shape ----------

  const rows = new Map<string, RowResult>();
  for (const [key, cell] of cells) {
    // With nothing declared, the unit shown is the one the formula worked out to — which is why units appear
    // on their own the moment a row acquires a dimension, and why a plain number shows none.
    const derived = cell.value ? naturalUnit(cell.value.dim) : null;
    const unit = cell.declared ?? (derived && derived.label ? derived : null);
    rows.set(key, {
      sheetId: cell.sheet.id,
      rowId: cell.row.id,
      empty: !cell.source,
      reading: cell.value ? read(cell.value, sources) : null,
      error: cell.error?.message ?? null,
      errorAt: cell.error?.at ?? -1,
      unit,
      unitIsDerived: !cell.declared && !!unit,
      unitWarning: cell.unitWarning,
    });
  }

  const outputOf = (ref: SheetRef | null): Reading | null => {
    if (!ref) return null;
    const cell = cells.get(rowKey(ref.sheet, ref.row));
    return cell?.value ? read(cell.value, sources) : null;
  };

  return {
    rows,
    sources,
    outputs: {
      displacement: outputOf(book.outputs.displacement),
      vcg: outputOf(book.outputs.vcg),
      lcg: outputOf(book.outputs.lcg),
    },
  };
}
