// ---------- the weight book, on disk ----------
//
// The book is persisted BESIDE the hull document, never inside it: `json.ts` writes a `HullDocument` and
// nothing else, because export, import, the library, `promote.ts` and `blend.ts` all depend on that column
// holding exactly a hull. This module is the book's own crossing, with its own version tag on its own
// clock — the two formats change for entirely unrelated reasons and should not be able to block each other.
//
// Everything here is text-in, text-out. Formulas are stored as the SOURCE the user typed and are never
// pre-parsed on the way through: a half-written formula is a normal thing to save, and a stored parse tree
// would make the format hostage to the language's grammar.

import {
  blankRow,
  emptyBook,
  isPageKind,
  isSliceShape,
  ROW_KIND_OF,
  SEAWATER_DENSITY,
  type PageKind,
  type Sheet,
  type SheetRow,
  type WeightBook,
} from "./book";

/**
 * The one weight-sheet format this build writes and reads.
 *
 * It stays at 1 through the typed-pages change, and that is a decision rather than an oversight. A version
 * field exists to stop an OLD build from reading a new file and mangling it, and there is no old build: the
 * weight book has never shipped, so nothing but this branch has ever written a `SheetDocument`. An upgrade
 * path would be dead code the day it was written.
 *
 * That expires the moment a build carrying the weight book reaches a browser that is not the author's. From
 * then on the installed base is real, and the next change to this format bumps the number and writes the
 * upgrade properly. The two reader defaults below — a page with no `kind` is `scalars`, a row whose kind
 * disagrees with its page is dropped — are what let books written earlier on the branch open with their rows
 * intact, and they are not a migration.
 */
export const SHEET_VERSION = 1;

interface StoredRow {
  id: string;
  kind: SheetRow["kind"];
  name: string;
  note: string;
  formula?: string;
  unit?: string;
  x?: string;
  y?: string;
  z?: string;
  shape?: string;
  pos?: string;
}

export interface SheetDocument {
  version: typeof SHEET_VERSION;
  sheets: {
    id: string;
    name: string;
    kind: PageKind;
    rows: StoredRow[];
  }[];
  density: number;
}

/** Only the fields the row's kind actually carries, so the file says nothing a reader would have to ignore. */
function storeRow(row: SheetRow): StoredRow {
  const base = { id: row.id, kind: row.kind, name: row.name, note: row.note };
  switch (row.kind) {
    case "heading":
      return base;
    case "item":
      return { ...base, formula: row.formula, unit: row.unit };
    case "point":
      return { ...base, unit: row.unit, x: row.x, y: row.y, z: row.z };
    case "slice":
      return { ...base, shape: row.shape, pos: row.pos };
  }
}

export function buildSheetJson(book: WeightBook): string {
  const doc: SheetDocument = {
    version: SHEET_VERSION,
    sheets: book.sheets.map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
      kind: sheet.kind,
      rows: sheet.rows.map(storeRow),
    })),
    density: book.density,
  };
  return JSON.stringify(doc, null, 2);
}

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

const dict = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/**
 * Read a stored book.
 *
 * Deliberately FORGIVING, unlike the hull parser. A hull that decodes wrongly draws a wrong boat and must be
 * refused; a weight sheet that loses a malformed row loses a line of an estimate the user can retype, and
 * refusing to open the design over it would be far worse. So anything unreadable is dropped and the rest
 * opens. A book with any other format version is the exception — its rows may mean something else — and
 * comes back empty rather than half-understood.
 */
export function parseSheet(text: string | null | undefined): WeightBook {
  if (!text) return emptyBook();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return emptyBook();
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return emptyBook();
  const raw = doc as Record<string, unknown>;
  if (raw.version !== SHEET_VERSION) return emptyBook();

  const density =
    typeof raw.density === "number" && isFinite(raw.density) && raw.density > 0
      ? raw.density
      : SEAWATER_DENSITY;

  return { ...readDocument(raw), density };
}

/**
 * One stored row, back into the shape its page holds.
 *
 * Starts from `blankRow` so that every field the kind carries is present and empty, then fills in whatever the
 * file actually had. A row missing half its fields therefore reads as a half-written row rather than as an
 * object with holes in it — which is the same forgiveness the rest of this reader extends, applied per field.
 */
function readRow(
  r: Record<string, unknown>,
  id: string,
  kind: SheetRow["kind"],
): SheetRow {
  const row = blankRow(kind, id, str(r.name));
  const note = str(r.note);
  switch (row.kind) {
    case "heading":
      return { ...row, note };
    case "item":
      return {
        ...row,
        note,
        formula: str(r.formula),
        unit: str(r.unit),
      };
    case "point":
      return {
        ...row,
        note,
        unit: str(r.unit),
        x: str(r.x),
        y: str(r.y),
        z: str(r.z),
      };
    case "slice": {
      const shape = str(r.shape);
      return {
        ...row,
        note,
        shape: isSliceShape(shape) ? shape : row.shape,
        pos: str(r.pos),
      };
    }
  }
}

function readDocument(raw: Record<string, unknown>): WeightBook {
  const sheets: Sheet[] = [];
  const seenSheets = new Set<string>();
  let haveOutputs = false;
  if (Array.isArray(raw.sheets))
    for (const entry of raw.sheets) {
      const s = dict(entry);
      const id = str(s.id);
      if (!id || seenSheets.has(id)) continue;
      seenSheets.add(id);
      // A page written before pages had kinds is a page of scalars, which is what every page was.
      const stored = str(s.kind);
      let kind: PageKind = isPageKind(stored) ? stored : "scalars";
      // Two outputs pages would make `OUT.` ambiguous, and only one can win. The later one reads as scalars,
      // which keeps its rows rather than dropping them.
      if (kind === "outputs" && haveOutputs) kind = "scalars";
      if (kind === "outputs") haveOutputs = true;
      const rows: SheetRow[] = [];
      const seenRows = new Set<string>();
      if (Array.isArray(s.rows))
        for (const rowEntry of s.rows) {
          const r = dict(rowEntry);
          const rowId = str(r.id);
          if (!rowId || seenRows.has(rowId)) continue; // no identity, not a row
          // A row whose kind disagrees with its page is dropped, per the rule that anything unreadable goes
          // and the rest opens. A row with no kind at all is whatever the page holds.
          const rowKind =
            r.kind === "heading"
              ? "heading"
              : (ROW_KIND_OF[kind] as SheetRow["kind"]);
          if (
            r.kind !== undefined &&
            r.kind !== "heading" &&
            r.kind !== rowKind
          )
            continue;
          seenRows.add(rowId);
          rows.push(readRow(r, rowId, rowKind));
        }
      sheets.push({ id, name: str(s.name), kind, rows });
    }
  return { sheets, density: SEAWATER_DENSITY };
}

/** Whether a book is worth persisting at all — an untouched one is stored as `null`, not as `{}`. */
export const sheetIsEmpty = (book: WeightBook): boolean =>
  book.sheets.every((sheet) => sheet.rows.length === 0) &&
  book.density === SEAWATER_DENSITY;
