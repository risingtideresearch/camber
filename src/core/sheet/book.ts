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
export interface RowBase {
  readonly id: string;
  /**
   * For an item, what formulas call it: may contain spaces, and may be empty — an unnamed item still
   * evaluates and still displays, it just cannot be referred to. That is the scratch-calculation escape hatch
   * a grid would spend a spare column on.
   *
   * For a heading, the heading itself. Free text, under no naming rules at all: a heading is not a value and
   * nothing can refer to one.
   */
  readonly name: string;
  readonly note: string;
}

/** A heading. Legal on a page of any kind — grouping is not a property of what is being grouped. */
export interface HeadingRow extends RowBase {
  readonly kind: "heading";
}

/**
 * One scalar: a mass, an areal density, a fraction, a length. What a `scalars` page — and an `outputs` page —
 * is made of.
 */
export interface ItemRow extends RowBase {
  readonly kind: "item";
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
}

/**
 * One position in the hull: three formulas, not one.
 *
 * Each coordinate takes the whole language, `±` included, and that is the point of splitting them — a tank's
 * longitudinal position is usually known well and its height badly, and per-coordinate uncertainty is what
 * lets the sensitivity ranking say which of the two is costing you. All three are lengths, so one unit covers
 * the row.
 *
 * The frame is the SHEET's, not the drawing's: x from the transom, y from the centreline (starboard
 * positive), z above the keel baseline — the same frame `hullMetrics.ts` reports `shellLcg` and `shellVcg`
 * in, so a formula never has to know the hull is authored deck-flat with rake applied as a rotation.
 */
export interface PointRow extends RowBase {
  readonly kind: "point";
  readonly unit: string;
  readonly x: string;
  readonly y: string;
  readonly z: string;
  /**
   * One expression standing for all three coordinates, or empty on a point that authors them separately.
   *
   * A centre of gravity is not three unrelated statements — it is one statement, made three times over. Held
   * as three cells it would drift: adding a fortieth item means editing `x`, `y` and `z` in step, and
   * forgetting one leaves a CG that is right along the boat and wrong up it, with nothing on screen saying
   * so. Held once, that cannot happen.
   *
   * It is read once per coordinate, and a point named in it without a coordinate means the matching one —
   * so `(Weights.engine * engine + Weights.tank * tank) / Weights.total` is the whole of a CG. See
   * `evaluate.ts`, which turns this one source into the row's three cells.
   *
   * `x`, `y` and `z` are kept while it is set rather than cleared, so turning a derivation off gives back the
   * coordinates that were there before it.
   */
  readonly from: string;
}

/** What a slice cuts with. A plane is horizontal; a station is normal to the sheer plan's heading. */
export type SliceShape = "plane" | "station";

export const SLICE_SHAPES: readonly SliceShape[] = ["plane", "station"];

export const isSliceShape = (shape: string): shape is SliceShape =>
  (SLICE_SHAPES as readonly string[]).includes(shape);

/**
 * One cut through the hull, which reports its area, open and closed perimeters, and its centroid.
 *
 * `pos` is in the sheet's frame, as a point's coordinates are: a height above the keel baseline for a plane,
 * x from the transom for a station.
 */
export interface SliceRow extends RowBase {
  readonly kind: "slice";
  readonly shape: SliceShape;
  /** Unit used to author and display `pos`; blank derives metres from a dimensioned formula. */
  readonly unit: string;
  readonly pos: string;
}

export type SheetRow = HeadingRow | ItemRow | PointRow | SliceRow;

/**
 * The addressable formula cells of a row. A scalar has one; a point has three, and a derivation besides.
 *
 * `from` is an address a command can write to, but it is NOT one of the cells a row evaluates to — see the
 * note on `fieldsOf`, which is the list of those and deliberately does not include it.
 */
export type RowField = "formula" | "x" | "y" | "z" | "pos" | "from";

/**
 * What a page holds. One kind of object per page, and the page says which.
 *
 * `outputs` is the one kind that shares a payload with another: its rows are `item` rows, identical in every
 * field. What it carries is a CONSTRAINT — the row's name comes from the `OUTPUTS` table rather than being
 * typed, and a book holds at most one such page. So the rule that a page holds one kind of object still reads
 * true (an outputs page holds scalars), while the kind gives the editor something to dispatch on and gives
 * `OUT.` something stable to resolve against.
 */
export type PageKind = "scalars" | "outputs" | "points" | "slices";

export const PAGE_KINDS: readonly PageKind[] = [
  "scalars",
  "outputs",
  "points",
  "slices",
];

export const isPageKind = (kind: string): kind is PageKind =>
  (PAGE_KINDS as readonly string[]).includes(kind);

/** The row kind a page of each kind holds, headings aside. */
export const ROW_KIND_OF: Record<PageKind, SheetRow["kind"]> = {
  scalars: "item",
  outputs: "item",
  points: "point",
  slices: "slice",
};

/** One page. */
export interface Sheet {
  readonly id: string;
  readonly name: string;
  readonly kind: PageKind;
  readonly rows: readonly SheetRow[];
}

/** Where a value lives: a row, on a page. */
export interface SheetRef {
  readonly sheet: string;
  readonly row: string;
}

export interface WeightBook {
  readonly sheets: readonly Sheet[];
  /**
   * Water density in t/m³, turning an estimated mass into the displaced volume the stability panel wants.
   * 1.025 is seawater, and is what the stability plane's own axis is drawn in.
   */
  readonly density: number;
}

export const SEAWATER_DENSITY = 1.025;

/** The page a fresh book opens on. Named for what it holds rather than for being first. */
export const FIRST_SHEET_NAME = "Weights";

export const emptyBook = (): WeightBook => ({
  sheets: [],
  density: SEAWATER_DENSITY,
});

export const cloneBook = (book: WeightBook): WeightBook => ({
  sheets: book.sheets.map((sheet) => ({
    ...sheet,
    rows: sheet.rows.map((row) => ({ ...row })),
  })),
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

/**
 * The namespaces a formula reserves. A row may not take one of these for its own.
 *
 * They point in opposite directions. `HULL` is what the sheet READS — the geometry's own numbers, supplied to
 * it. `OUT` is what the sheet PROVIDES — the answers the rest of the app asks it for, which live as rows on
 * the outputs page (see `outputs.ts`). Both are reserved against being taken as a row name; only `OUT`
 * resolves to something the book itself authored.
 */
export const RESERVED = ["HULL", "OUT"] as const;

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

export const isHeading = (row: SheetRow): row is HeadingRow =>
  row.kind === "heading";

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

/**
 * The kinds a command may actually create, as against the kinds the types can describe.
 *
 * Every kind is reachable now: points and slices each have a specialised editor and geometry resolver, so
 * they are ordinary user-creatable pages alongside scalar calculations.
 */
export const CREATABLE_KINDS: readonly PageKind[] = [
  "scalars",
  "outputs",
  "points",
  "slices",
];

/** The book's outputs page, if it has one. At most one exists — see `invariants.ts`. */
export const outputsSheet = (book: WeightBook): Sheet | undefined =>
  book.sheets.find((sheet) => sheet.kind === "outputs");

/** The row on a page answering to `name`, ignoring headings. */
export const rowNamed = (sheet: Sheet, name: string): SheetRow | undefined =>
  sheet.rows.find((row) => !isHeading(row) && row.name === name);

/** A fresh row of the kind a page holds. Every field the kind carries, empty. */
export function blankRow(
  kind: SheetRow["kind"],
  id: string,
  name: string,
): SheetRow {
  switch (kind) {
    case "heading":
      return { id, kind, name, note: "" };
    case "item":
      return { id, kind, name, note: "", formula: "", unit: "" };
    case "point":
      // A point is the one row whose dimension is known before anything is typed: three lengths. Declaring
      // the unit up front is what makes `3.2` in a fresh cell mean 3.2 m rather than a bare number — which
      // matters because the editor AUTHORS these cells by dragging, and a dragged coordinate that came out
      // dimensionless would fail the first moment arm it was multiplied into.
      return {
        id,
        kind,
        name,
        note: "",
        unit: "m",
        x: "",
        y: "",
        z: "",
        from: "",
      };
    case "slice":
      return {
        id,
        kind,
        name,
        note: "",
        shape: "station",
        unit: "",
        pos: "",
      };
  }
}

/**
 * Read the text at one address on a row, or null where the row has no such field.
 *
 * The ADDRESSES of a row, which for a point is one more than the cells it evaluates to: `from` is written by
 * a command like any other formula, and is then the source of all three coordinates rather than a fourth
 * one. `fieldsOf` is the other list, and the two stopped mirroring each other for exactly that reason.
 */
export function fieldOf(row: SheetRow, field: RowField): string | null {
  switch (row.kind) {
    case "heading":
      return null;
    case "item":
      return field === "formula" ? row.formula : null;
    case "point":
      if (field === "from") return row.from;
      return field === "x" || field === "y" || field === "z"
        ? row[field]
        : null;
    case "slice":
      return field === "pos" ? row.pos : null;
  }
}

/** True when a point states its coordinates as one expression rather than three. */
export const isDerived = (row: SheetRow): boolean =>
  row.kind === "point" && row.from.trim() !== "";

/**
 * Every formula cell a row EVALUATES TO, in the order the editor shows them.
 *
 * A point has three whether or not it derives them: a derivation changes where their text comes from, never
 * how many there are, which is what lets `Places.CG.z`, the views and the sensitivity ranking go on working
 * without knowing the difference. So `from` is absent here and present in `fieldOf`, and that asymmetry is
 * the whole distinction between the two.
 */
export function fieldsOf(row: SheetRow): RowField[] {
  switch (row.kind) {
    case "heading":
      return [];
    case "item":
      return ["formula"];
    case "point":
      return ["x", "y", "z"];
    case "slice":
      return ["pos"];
  }
}

// ---------- commands ----------
// Every edit as a value, in the same spirit as `commands.ts`. These are interpreted against the BOOK ALONE:
// unlike a hull command, none of them needs the assembled model, which is why the reducer below takes a
// `WeightBook` rather than a `Model`.

export type SheetCommand =
  | { type: "addSheet"; id: string; name: string; kind: PageKind }
  | { type: "removeSheet"; sheet: string }
  | { type: "renameSheet"; sheet: string; name: string }
  | { type: "moveSheet"; sheet: string; to: number }
  | {
      type: "addSheetRow";
      sheet: string;
      id: string;
      after: number;
      /** Omitted means "whatever this page holds". Only `heading` is ever worth saying. */
      kind?: SheetRow["kind"];
      name?: string;
    }
  | { type: "removeSheetRow"; sheet: string; row: string }
  | { type: "moveSheetRow"; sheet: string; row: string; to: number }
  | { type: "renameSheetRow"; sheet: string; row: string; name: string }
  | {
      type: "setSheetFormula";
      sheet: string;
      row: string;
      field: RowField;
      formula: string;
    }
  | { type: "setSheetUnit"; sheet: string; row: string; unit: string }
  | { type: "setSliceShape"; sheet: string; row: string; shape: SliceShape }
  /**
   * A point moved, as ONE edit.
   *
   * Three `setSheetFormula`s would say the same thing, and they are what this replaces. A drag in the point
   * editor writes two coordinates per frame, and `sameGesture` tells two gestures apart by their FIELD — so
   * alternating x and z would coalesce into nothing and leave one undo step per pointer move. It also keeps
   * the three coordinates atomic: a point half-moved is not a position anyone authored.
   *
   * An omitted coordinate is one the gesture did not touch, and is left exactly as it was.
   */
  | {
      type: "setPointPosition";
      sheet: string;
      row: string;
      x?: string;
      y?: string;
      z?: string;
    }
  | { type: "setSheetRowNote"; sheet: string; row: string; note: string }
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
  setSliceShape: 1,
  setPointPosition: 1,
  setSheetRowNote: 1,
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
      if (!CREATABLE_KINDS.includes(command.kind))
        return { rejected: `a ${command.kind} page cannot be made yet` };
      // One outputs page, because `OUT.` resolves by kind and two would make it ambiguous.
      if (command.kind === "outputs" && outputsSheet(book))
        return { rejected: "this book already has an outputs page" };
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
          { id: command.id, name, kind: command.kind, rows: [] },
        ]),
        result: book.sheets.length,
      };
    }

    case "removeSheet": {
      const idx = book.sheets.findIndex((sheet) => sheet.id === command.sheet);
      if (idx < 0) return { rejected: `no such page: ${command.sheet}` };
      const sheets = [...book.sheets];
      sheets.splice(idx, 1);
      return { book: withSheets(book, sheets), result: idx };
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
        // A heading is legal on any page; anything else is the page's own kind, whether or not it was named.
        const kind =
          command.kind === "heading" ? "heading" : ROW_KIND_OF[sheet.kind];
        if (command.kind && command.kind !== kind)
          return {
            rejected: `a ${sheet.kind} page does not hold ${command.kind} rows`,
          };
        const at = Math.max(0, Math.min(sheet.rows.length, command.after + 1));
        const rows = [...sheet.rows];
        // Nothing to say about grouping: an item belongs to the heading it lands under, and it just landed.
        rows.splice(at, 0, blankRow(kind, command.id, command.name ?? ""));
        return { ...sheet, rows };
      });

    case "removeSheetRow":
      return editSheet(book, command.sheet, (sheet) => {
        const idx = sheet.rows.findIndex((row) => row.id === command.row);
        if (idx < 0) return { rejected: `no such item: ${command.row}` };
        const rows = [...sheet.rows];
        rows.splice(idx, 1);
        return { ...sheet, rows };
      });

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
      return editRow(book, command.sheet, command.row, (row) => {
        // The field has to be one the row actually carries: a point has no `formula` and an item has no `z`.
        // Writing it anyway would put a property on the row that nothing reads and the JSON would carry.
        if (fieldOf(row, command.field) === null)
          return {
            rejected: `a ${row.kind} row has no ${command.field} to set`,
          };
        return { ...row, [command.field]: command.formula };
      });

    case "setSheetUnit":
      return editRow(book, command.sheet, command.row, (row) => {
        if (row.kind !== "item" && row.kind !== "point" && row.kind !== "slice")
          return { rejected: `a ${row.kind} row carries no unit` };
        return { ...row, unit: command.unit.trim() };
      });

    case "setSliceShape":
      return editRow(book, command.sheet, command.row, (row) => {
        if (row.kind !== "slice")
          return { rejected: "only a slice has a shape" };
        return { ...row, shape: command.shape };
      });

    case "setPointPosition":
      return editRow(book, command.sheet, command.row, (row) => {
        if (row.kind !== "point")
          return { rejected: "only a point has a position" };
        return {
          ...row,
          x: command.x ?? row.x,
          y: command.y ?? row.y,
          z: command.z ?? row.z,
        };
      });

    case "setSheetRowNote":
      return editRow(book, command.sheet, command.row, (row) => ({
        ...row,
        note: command.note,
      }));

    case "setSheetDensity":
      if (!isFinite(command.density) || command.density <= 0)
        return { rejected: "density must be a positive number" };
      return { book: { ...book, density: command.density } };

    case "installSheet":
      return { book: cloneBook(command.book) };
  }
}
