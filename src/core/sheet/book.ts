// ---------- the weight book: pages of named rows, authored, plain and serializable ----------
//
// A weight estimate is a SCHEDULE, not a grid: named line items, grouped under headings, each carrying one
// expression. So a cell is addressed by (sheet, row) — never by (row number, column letter). References in a
// formula are the names themselves, which is what makes an estimate readable a month later, and what lets the
// sensitivity readout name the input that drives the spread rather than pointing at a coordinate.
//
// Rows carry a stable `id` that nothing renames. A formula names a row by its `name`, resolved to an id when
// the book is evaluated, so renaming a row rewrites nothing and reordering means nothing at all. That is also
// what keeps an edit small: `setSheetFormula` names one row, whereas positional addressing would make an
// insert rewrite every formula below it — a terrible history entry and a worse two-window merge.
//
// ---------- pages, not columns ----------
//
// The second axis is a PAGE, not a column. A weight estimate, a VCG schedule and an LCG schedule are three
// lists of the same items answering three different questions, and they are not the same shape: a VCG page
// has rows a weight page does not (a reference datum), and skips rows it has (a density). Columns forced them
// to share a row set and a row order; pages let each be what it is, and a formula reaches across with
// `Weights.hull shell`.
//
// ---------- names with spaces ----------
//
// `hull shell` is a better name than `hull_shell`, and a schedule is full of them. It works because the
// language has no implicit multiplication: two names side by side could never have meant anything else, so
// the lexer can take the longest known name at each position without ambiguity. `formula.ts` does that,
// against the symbol table `symbolsOf` builds from here.
//
// This module is the authored shape and its reducer only. Evaluation — the formula language, the uncertainty
// algebra and the hull's own numbers — lives in `formula.ts`, `quantity.ts` and `../hullMetrics.ts`, none of
// which this file knows about. A `WeightBook` survives `structuredClone` and `JSON.stringify` unchanged.

// ---------- the authored shape ----------

/**
 * One line: an item, or a heading over the items below it.
 *
 * A heading is a ROW rather than a label attached to rows, and that is the whole design of grouping here.
 * There is one ordered list, and an item belongs to whichever heading it sits under — so dragging it under a
 * heading IS putting it there, and no command has to say so separately. It also means a heading can exist
 * with nothing under it yet, which is how you make one: add it, then move items in.
 */
export interface SheetRow {
  readonly id: string;
  readonly kind: "item" | "heading";
  /**
   * For an item, what formulas call it: may contain spaces, and may be empty — an unnamed item still
   * evaluates and still displays, it just cannot be referred to. That is the scratch-calculation escape hatch
   * a grid would spend a spare column on.
   *
   * For a heading, the heading itself. Free text, under no naming rules at all: a heading is not a value and
   * nothing can refer to one.
   */
  readonly name: string;
  /** The expression, as the user typed it. Never stored pre-parsed — see `json.ts`. */
  readonly formula: string;
  /**
   * What the number is written in: `kg`, `t`, `kg/m2`, `m`, or blank.
   *
   * Blank does NOT mean dimensionless — it means "say it in whatever the formula works out to", and the panel
   * fills the natural unit in for you. Typing one over that converts the display where the dimension agrees,
   * and is flagged where it does not. On a formula with no dimension of its own it is a declaration: `1.4` in
   * a cell marked `t` is 1400 kg. See `units.ts`.
   */
  readonly unit: string;
  readonly note: string;
}

/** One page. */
export interface Sheet {
  readonly id: string;
  readonly name: string;
  readonly rows: readonly SheetRow[];
}

/** Where a value lives: a row, on a page. */
export interface SheetRef {
  readonly sheet: string;
  readonly row: string;
}

/** Which row answers each question the rest of the app asks the estimate. */
export interface BookOutputs {
  readonly displacement: SheetRef | null;
  readonly vcg: SheetRef | null;
  readonly lcg: SheetRef | null;
}

export interface WeightBook {
  readonly sheets: readonly Sheet[];
  readonly outputs: BookOutputs;
  /**
   * Water density in t/m³, turning an estimated mass into the displaced volume the stability panel wants.
   * 1.025 is seawater, and is what the stability plane's own axis is drawn in.
   */
  readonly density: number;
}

export const SEAWATER_DENSITY = 1.025;

/** The page a fresh book opens on. Named for what it holds rather than for being first. */
export const FIRST_SHEET_NAME = "Weights";

export const emptyOutputs = (): BookOutputs => ({
  displacement: null,
  vcg: null,
  lcg: null,
});

export const emptyBook = (): WeightBook => ({
  sheets: [],
  outputs: emptyOutputs(),
  density: SEAWATER_DENSITY,
});

export const cloneBook = (book: WeightBook): WeightBook => ({
  sheets: book.sheets.map((sheet) => ({
    ...sheet,
    rows: sheet.rows.map((row) => ({ ...row })),
  })),
  outputs: {
    displacement: book.outputs.displacement && { ...book.outputs.displacement },
    vcg: book.outputs.vcg && { ...book.outputs.vcg },
    lcg: book.outputs.lcg && { ...book.outputs.lcg },
  },
  density: book.density,
});

// ---------- names ----------

/**
 * What a formula may call a row, a page or a group.
 *
 * Letters, digits, underscores and single interior spaces, starting with a letter. Everything the language
 * uses as punctuation is excluded, and so is the leading digit that would make a name look like a number.
 */
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z0-9_]+)*$/;

export const isValidName = (name: string): boolean => NAME_PATTERN.test(name);

/** Trim and collapse runs of spaces — what a name field commits, so `hull  shell` is `hull shell`. */
export const tidyName = (name: string): string =>
  name.trim().replace(/\s+/g, " ");

/** The namespaces a formula reserves. A row may not take one of these for its own. */
export const RESERVED = ["HULL"] as const;

export const isReserved = (name: string): boolean =>
  (RESERVED as readonly string[]).includes(name);

export const findSheet = (book: WeightBook, id: string): Sheet | undefined =>
  book.sheets.find((sheet) => sheet.id === id);

export const findRow = (sheet: Sheet, id: string): SheetRow | undefined =>
  sheet.rows.find((row) => row.id === id);

export function refValue(
  book: WeightBook,
  ref: SheetRef | null,
): SheetRow | null {
  if (!ref) return null;
  const sheet = findSheet(book, ref.sheet);
  return sheet ? (findRow(sheet, ref.row) ?? null) : null;
}

export const sameRef = (a: SheetRef | null, b: SheetRef | null): boolean =>
  a === b || (!!a && !!b && a.sheet === b.sheet && a.row === b.row);

export const isHeading = (row: SheetRow): boolean => row.kind === "heading";

/** Every heading on a page, in order. */
export const sheetHeadings = (sheet: Sheet): SheetRow[] =>
  sheet.rows.filter(isHeading);

/** The heading an item sits under, or "" above the first one. Derived from POSITION — never stored. */
export function groupAt(sheet: Sheet, index: number): string {
  for (let i = index - 1; i >= 0; i--)
    if (isHeading(sheet.rows[i])) return sheet.rows[i].name;
  return "";
}

/** The rows a heading covers: everything after it up to the next heading. */
export function rowsUnder(sheet: Sheet, headingIndex: number): SheetRow[] {
  const out: SheetRow[] = [];
  for (let i = headingIndex + 1; i < sheet.rows.length; i++) {
    if (isHeading(sheet.rows[i])) break;
    out.push(sheet.rows[i]);
  }
  return out;
}

/**
 * Every name a formula on `sheet` could mention, longest first.
 *
 * This is the lexer's symbol table: it is what lets `hull shell * 2` read as one name and an operator rather
 * than as a syntax error. Longest-first is the whole trick — with `shell` and `shell area` both defined, the
 * longer one has to be tried first or the shorter would always win and leave `area` dangling.
 */
export function symbolsOf(book: WeightBook, sheetId: string): string[] {
  const names = new Set<string>(RESERVED);
  for (const sheet of book.sheets) {
    if (sheet.name) names.add(sheet.name);
    if (sheet.id !== sheetId) continue;
    for (const row of sheet.rows)
      if (row.name && !isHeading(row)) names.add(row.name);
  }
  // Rows of OTHER pages are reachable only as `Page.row`, so their names go in too: the lexer has to be able
  // to take `Weights.hull shell` as three tokens rather than stopping after `hull`.
  for (const sheet of book.sheets)
    if (sheet.id !== sheetId)
      for (const row of sheet.rows)
        if (row.name && !isHeading(row)) names.add(row.name);
  return [...names].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * A fresh id. Generated by the WINDOW rather than the server, because the window that asked for the row needs
 * to know which row it got in order to put the caret in it, and because two windows adding one at once must
 * not collide.
 */
export function newId(prefix = "r"): string {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}${rand}`;
}

/** A page name nothing else on the book is using. */
export function freeSheetName(book: WeightBook, wanted: string): string {
  const taken = new Set(book.sheets.map((sheet) => sheet.name));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++)
    if (!taken.has(`${wanted} ${n}`)) return `${wanted} ${n}`;
}

// ---------- commands ----------
// Every edit as a value, in the same spirit as `commands.ts`. These are interpreted against the BOOK ALONE:
// unlike a hull command, none of them needs the assembled model, which is why the reducer below takes a
// `WeightBook` rather than a `Model`.

export type SheetCommand =
  | { type: "addSheet"; id: string; name: string }
  | { type: "removeSheet"; sheet: string }
  | { type: "renameSheet"; sheet: string; name: string }
  | { type: "moveSheet"; sheet: string; to: number }
  | {
      type: "addSheetRow";
      sheet: string;
      id: string;
      after: number;
      kind?: "item" | "heading";
      name?: string;
    }
  | { type: "removeSheetRow"; sheet: string; row: string }
  | { type: "moveSheetRow"; sheet: string; row: string; to: number }
  | { type: "renameSheetRow"; sheet: string; row: string; name: string }
  | { type: "setSheetFormula"; sheet: string; row: string; formula: string }
  | { type: "setSheetUnit"; sheet: string; row: string; unit: string }
  | { type: "setSheetRowNote"; sheet: string; row: string; note: string }
  | { type: "setSheetOutput"; output: keyof BookOutputs; ref: SheetRef | null }
  | { type: "setSheetDensity"; density: number }
  | { type: "installSheet"; book: WeightBook };

/**
 * The command types above, as a value the compiler checks for completeness. This is what lets `commands.ts`
 * keep ONE flat union and still route each command to the reducer that owns it: adding a member to
 * `SheetCommand` without listing it here stops compiling.
 */
export const SHEET_COMMAND_TYPES = {
  addSheet: 1,
  removeSheet: 1,
  renameSheet: 1,
  moveSheet: 1,
  addSheetRow: 1,
  removeSheetRow: 1,
  moveSheetRow: 1,
  renameSheetRow: 1,
  setSheetFormula: 1,
  setSheetUnit: 1,
  setSheetRowNote: 1,
  setSheetOutput: 1,
  setSheetDensity: 1,
  installSheet: 1,
} as const satisfies Record<SheetCommand["type"], 1>;

export const isSheetCommand = (command: {
  type: string;
}): command is SheetCommand => command.type in SHEET_COMMAND_TYPES;

/** A rejection reads the same as a hull command's, so one outcome type covers both families. */
export type SheetOutcome =
  { book: WeightBook; result?: number | boolean } | { rejected: string };

const withSheets = (
  book: WeightBook,
  sheets: readonly Sheet[],
): WeightBook => ({ ...book, sheets });

const editSheet = (
  book: WeightBook,
  id: string,
  change: (sheet: Sheet) => Sheet | { rejected: string },
): SheetOutcome => {
  const idx = book.sheets.findIndex((sheet) => sheet.id === id);
  if (idx < 0) return { rejected: `no such page: ${id}` };
  const next = change(book.sheets[idx]);
  if ("rejected" in next) return next;
  const sheets = [...book.sheets];
  sheets[idx] = next;
  return { book: withSheets(book, sheets) };
};

const editRow = (
  book: WeightBook,
  sheetId: string,
  rowId: string,
  change: (row: SheetRow, sheet: Sheet) => SheetRow | { rejected: string },
): SheetOutcome =>
  editSheet(book, sheetId, (sheet) => {
    const idx = sheet.rows.findIndex((row) => row.id === rowId);
    if (idx < 0) return { rejected: `no such item: ${rowId}` };
    const next = change(sheet.rows[idx], sheet);
    if ("rejected" in next) return next;
    const rows = [...sheet.rows];
    rows[idx] = next;
    return { ...sheet, rows };
  });

/** Outputs naming something that has gone are cleared rather than left dangling. */
const pruneOutputs = (book: WeightBook): WeightBook => {
  const live = (ref: SheetRef | null): SheetRef | null =>
    ref && refValue(book, ref) ? ref : null;
  return {
    ...book,
    outputs: {
      displacement: live(book.outputs.displacement),
      vcg: live(book.outputs.vcg),
      lcg: live(book.outputs.lcg),
    },
  };
};

/**
 * Interpret one command. Pure: it returns the next book or a refusal, and never mutates the one it was given.
 * Structural validity — unique names, resolvable outputs — is checked by `invariants.ts` after the fact, in
 * the same two-stage way a hull command is.
 */
export function interpretSheetCommand(
  book: WeightBook,
  command: SheetCommand,
): SheetOutcome {
  switch (command.type) {
    case "addSheet": {
      if (book.sheets.some((sheet) => sheet.id === command.id))
        return { rejected: `page ${command.id} already exists` };
      const name = tidyName(command.name);
      if (!isValidName(name))
        return {
          rejected: `"${command.name}" is not a name a formula can use`,
        };
      if (book.sheets.some((sheet) => sheet.name === name))
        return { rejected: `there is already a page called ${name}` };
      return {
        book: withSheets(book, [
          ...book.sheets,
          { id: command.id, name, rows: [] },
        ]),
        result: book.sheets.length,
      };
    }

    case "removeSheet": {
      const idx = book.sheets.findIndex((sheet) => sheet.id === command.sheet);
      if (idx < 0) return { rejected: `no such page: ${command.sheet}` };
      const sheets = [...book.sheets];
      sheets.splice(idx, 1);
      return { book: pruneOutputs(withSheets(book, sheets)), result: idx };
    }

    case "renameSheet": {
      const name = tidyName(command.name);
      if (!isValidName(name))
        return {
          rejected: `"${command.name}" is not a name a formula can use`,
        };
      if (
        book.sheets.some(
          (sheet) => sheet.name === name && sheet.id !== command.sheet,
        )
      )
        return { rejected: `there is already a page called ${name}` };
      return editSheet(book, command.sheet, (sheet) => ({ ...sheet, name }));
    }

    case "moveSheet": {
      const from = book.sheets.findIndex((sheet) => sheet.id === command.sheet);
      if (from < 0) return { rejected: `no such page: ${command.sheet}` };
      const to = Math.max(0, Math.min(book.sheets.length - 1, command.to));
      if (to === from) return { book, result: false };
      const sheets = [...book.sheets];
      const [moved] = sheets.splice(from, 1);
      sheets.splice(to, 0, moved);
      return { book: withSheets(book, sheets), result: to };
    }

    case "addSheetRow":
      return editSheet(book, command.sheet, (sheet) => {
        if (sheet.rows.some((row) => row.id === command.id))
          return { rejected: `item ${command.id} already exists` };
        const at = Math.max(0, Math.min(sheet.rows.length, command.after + 1));
        const rows = [...sheet.rows];
        // Nothing to say about grouping: an item belongs to the heading it lands under, and it just landed.
        rows.splice(at, 0, {
          id: command.id,
          kind: command.kind ?? "item",
          name: command.name ?? "",
          formula: "",
          unit: "",
          note: "",
        });
        return { ...sheet, rows };
      });

    case "removeSheetRow": {
      const outcome = editSheet(book, command.sheet, (sheet) => {
        const idx = sheet.rows.findIndex((row) => row.id === command.row);
        if (idx < 0) return { rejected: `no such item: ${command.row}` };
        const rows = [...sheet.rows];
        rows.splice(idx, 1);
        return { ...sheet, rows };
      });
      return "rejected" in outcome
        ? outcome
        : { ...outcome, book: pruneOutputs(outcome.book) };
    }

    case "moveSheetRow":
      return editSheet(book, command.sheet, (sheet) => {
        const from = sheet.rows.findIndex((row) => row.id === command.row);
        if (from < 0) return { rejected: `no such item: ${command.row}` };
        const to = Math.max(0, Math.min(sheet.rows.length - 1, command.to));
        const rows = [...sheet.rows];
        const [moved] = rows.splice(from, 1);
        rows.splice(to, 0, moved);
        return { ...sheet, rows };
      });

    case "renameSheetRow": {
      const name = tidyName(command.name);
      return editRow(book, command.sheet, command.row, (row) => {
        // A heading is not a value and nothing can refer to one, so its text is under no naming rules.
        if (isHeading(row)) return { ...row, name };
        if (name && !isValidName(name))
          return {
            rejected: `"${command.name}" is not a name a formula can use — letters, digits, _ and spaces, starting with a letter`,
          };
        if (name && isReserved(name))
          return {
            rejected: `${name} is a name the formula language reserves`,
          };
        return { ...row, name };
      });
    }

    case "setSheetFormula":
      return editRow(book, command.sheet, command.row, (row) => ({
        ...row,
        formula: command.formula,
      }));

    case "setSheetUnit":
      return editRow(book, command.sheet, command.row, (row) => ({
        ...row,
        unit: command.unit.trim(),
      }));

    case "setSheetRowNote":
      return editRow(book, command.sheet, command.row, (row) => ({
        ...row,
        note: command.note,
      }));

    case "setSheetOutput": {
      if (command.ref && !refValue(book, command.ref))
        return { rejected: "no such item" };
      return {
        book: {
          ...book,
          outputs: { ...book.outputs, [command.output]: command.ref },
        },
      };
    }

    case "setSheetDensity":
      if (!isFinite(command.density) || command.density <= 0)
        return { rejected: "density must be a positive number" };
      return { book: { ...book, density: command.density } };

    case "installSheet":
      return { book: cloneBook(command.book) };
  }
}
