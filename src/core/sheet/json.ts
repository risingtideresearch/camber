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
  emptyBook,
  emptyOutputs,
  findRow,
  findSheet,
  SEAWATER_DENSITY,
  type BookOutputs,
  type Sheet,
  type SheetRef,
  type SheetRow,
  type WeightBook,
} from "./book";

/** The one weight-sheet format this build writes and reads. */
export const SHEET_VERSION = 1;

export interface SheetDocument {
  version: typeof SHEET_VERSION;
  sheets: {
    id: string;
    name: string;
    rows: {
      id: string;
      kind: "item" | "heading";
      name: string;
      formula: string;
      unit: string;
      note: string;
    }[];
  }[];
  outputs: {
    displacement: SheetRef | null;
    vcg: SheetRef | null;
    lcg: SheetRef | null;
  };
  density: number;
}

export function buildSheetJson(book: WeightBook): string {
  const doc: SheetDocument = {
    version: SHEET_VERSION,
    sheets: book.sheets.map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
      rows: sheet.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        formula: row.formula,
        unit: row.unit,
        note: row.note,
      })),
    })),
    outputs: { ...book.outputs },
    density: book.density,
  };
  return JSON.stringify(doc, null, 2);
}

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

const dict = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const refOf = (v: unknown): SheetRef | null => {
  const raw = dict(v);
  const sheet = str(raw.sheet),
    row = str(raw.row);
  return sheet && row ? { sheet, row } : null;
};

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

  const book: WeightBook = { ...readDocument(raw), density };

  // An output naming something that did not survive the read is cleared, so the book still satisfies its
  // invariants rather than opening into an immediate violation.
  const live = (ref: SheetRef | null): SheetRef | null => {
    if (!ref) return null;
    const sheet = findSheet(book, ref.sheet);
    return sheet && findRow(sheet, ref.row) ? ref : null;
  };
  return {
    ...book,
    density,
    outputs: {
      ...emptyOutputs(),
      displacement: live(book.outputs.displacement),
      vcg: live(book.outputs.vcg),
      lcg: live(book.outputs.lcg),
    },
  };
}

function readDocument(raw: Record<string, unknown>): WeightBook {
  const sheets: Sheet[] = [];
  const seenSheets = new Set<string>();
  if (Array.isArray(raw.sheets))
    for (const entry of raw.sheets) {
      const s = dict(entry);
      const id = str(s.id);
      if (!id || seenSheets.has(id)) continue;
      seenSheets.add(id);
      const rows: SheetRow[] = [];
      const seenRows = new Set<string>();
      if (Array.isArray(s.rows))
        for (const rowEntry of s.rows) {
          const r = dict(rowEntry);
          const rowId = str(r.id);
          if (!rowId || seenRows.has(rowId)) continue; // no identity, not a row
          seenRows.add(rowId);
          rows.push({
            id: rowId,
            kind: r.kind === "heading" ? "heading" : "item",
            name: str(r.name),
            formula: str(r.formula),
            unit: str(r.unit),
            note: str(r.note),
          });
        }
      sheets.push({ id, name: str(s.name), rows });
    }
  const outputs = dict(raw.outputs);
  return {
    sheets,
    outputs: {
      displacement: refOf(outputs.displacement),
      vcg: refOf(outputs.vcg),
      lcg: refOf(outputs.lcg),
    },
    density: SEAWATER_DENSITY,
  };
}

/** Whether a book is worth persisting at all — an untouched one is stored as `null`, not as `{}`. */
export const sheetIsEmpty = (book: WeightBook): boolean =>
  book.sheets.every((sheet) => sheet.rows.length === 0) &&
  book.outputs.displacement === null &&
  book.outputs.vcg === null &&
  book.outputs.lcg === null &&
  book.density === SEAWATER_DENSITY;

/** Re-export for readers that only want the outputs type. */
export type { BookOutputs };
