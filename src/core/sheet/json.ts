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
  blankField,
  emptyBook,
  fieldUnit,
  isFieldKind,
  isSliceShape,
  isValidFacetValue,
  SEAWATER_DENSITY,
  tidyFacetValue,
  type Field,
  type FieldKind,
  type Item,
  type View,
  type ViewLayout,
  type ViewScope,
  type WeightBook,
} from "./book";
import { isOutputName } from "./outputs";

/**
 * The one weight-sheet format this build writes and reads.
 *
 * The weight estimate has not shipped, so the item model remains version 1 rather than carrying a migration
 * from the page model used during development. Once this format ships, incompatible changes must increment
 * the version and provide an upgrade path.
 */
export const SHEET_VERSION = 1;

interface StoredField {
  k: FieldKind;
  formula?: string;
  unit?: string;
  x?: string;
  y?: string;
  z?: string;
  from?: string;
  shape?: string;
  pos?: string;
}

interface StoredItem {
  id: string;
  name: string;
  note: string;
  facets: Record<string, string>;
  fields: Record<string, StoredField>;
}

export interface SheetDocument {
  version: typeof SHEET_VERSION;
  items: StoredItem[];
  views: View[];
  outputs: Record<string, string>;
  density: number;
}

/** Only the cells the field's kind actually carries, so the file says nothing a reader would have to ignore. */
function storeField(field: Field): StoredField {
  switch (field.k) {
    case "scalar":
      return { k: field.k, formula: field.formula, unit: field.unit };
    case "point":
      return {
        k: field.k,
        unit: fieldUnit(field),
        x: field.x,
        y: field.y,
        z: field.z,
        from: field.from,
      };
    case "cut":
      return {
        k: field.k,
        shape: field.shape,
        unit: fieldUnit(field),
        pos: field.pos,
      };
  }
}

export function buildSheetJson(book: WeightBook): string {
  const doc: SheetDocument = {
    version: SHEET_VERSION,
    items: book.items.map((item) => ({
      id: item.id,
      name: item.name,
      note: item.note,
      facets: { ...item.facets },
      fields: Object.fromEntries(
        Object.entries(item.fields).map(([key, field]) => [
          key,
          storeField(field),
        ]),
      ),
    })),
    views: book.views.map((view) => ({ ...view, groupBy: [...view.groupBy] })),
    outputs: { ...book.outputs },
    density: book.density,
  };
  return JSON.stringify(doc, null, 2);
}

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

const dict = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/**
 * One stored field, back into the shape its kind carries.
 *
 * Starts from `blankField` so that every cell the kind carries is present and empty, then fills in whatever
 * the file actually had. A field missing half its cells therefore reads as a half-written field rather than
 * as an object with holes in it — the same forgiveness the rest of this reader extends, applied per cell.
 */
function readField(raw: Record<string, unknown>, kind: FieldKind): Field {
  const field = blankField(kind);
  switch (field.k) {
    case "scalar":
      return { ...field, formula: str(raw.formula), unit: str(raw.unit) };
    case "point":
      return {
        ...field,
        // Point coordinates are always lengths, so empty and omitted units both take the metre default.
        unit: str(raw.unit, field.unit) || field.unit,
        x: str(raw.x),
        y: str(raw.y),
        z: str(raw.z),
        from: str(raw.from),
      };
    case "cut": {
      const shape = str(raw.shape);
      return {
        ...field,
        shape: isSliceShape(shape) ? shape : field.shape,
        // A cut position is always a length, so empty and omitted units both take the field's metre default.
        unit: str(raw.unit, field.unit) || field.unit,
        pos: str(raw.pos),
      };
    }
  }
}

function readScope(raw: unknown): ViewScope | null {
  const s = dict(raw);
  switch (str(s.k)) {
    case "all":
      return { k: "all" };
    case "item":
      return str(s.item) ? { k: "item", item: str(s.item) } : null;
    case "fieldType":
      return isFieldKind(str(s.type))
        ? { k: "fieldType", type: str(s.type) as FieldKind }
        : null;
    case "facet":
      return str(s.key) && str(s.value)
        ? { k: "facet", key: str(s.key), value: str(s.value) }
        : null;
    default:
      return null;
  }
}

const LAYOUTS: readonly ViewLayout[] = ["table", "split", "detail"];

function readView(raw: unknown): View | null {
  const v = dict(raw);
  const id = str(v.id);
  const scope = readScope(v.scope);
  if (!id || !scope) return null;
  const layout = str(v.layout) as ViewLayout;
  return {
    id,
    name: str(v.name),
    scope,
    groupBy: Array.isArray(v.groupBy)
      ? v.groupBy.filter((key): key is string => typeof key === "string")
      : [],
    layout: LAYOUTS.includes(layout) ? layout : "table",
  };
}

/** Everything the current format holds, read forgivingly. */
export function readDocument(raw: Record<string, unknown>): WeightBook {
  const items: Item[] = [];
  const seenItems = new Set<string>();
  if (Array.isArray(raw.items))
    for (const entry of raw.items) {
      const s = dict(entry);
      const id = str(s.id);
      if (!id || seenItems.has(id)) continue; // no identity, not an item
      seenItems.add(id);

      const facets: Record<string, string> = {};
      for (const [key, value] of Object.entries(dict(s.facets))) {
        const tidied = tidyFacetValue(str(value));
        // A facet that will not read is dropped rather than kept as something the tree cannot split on.
        if (tidied && isValidFacetValue(tidied)) facets[key] = tidied;
      }

      const fields: Record<string, Field> = {};
      for (const [key, value] of Object.entries(dict(s.fields))) {
        const f = dict(value);
        const kind = str(f.k);
        // A field whose kind is unreadable is dropped, per the rule that anything unreadable goes and the
        // rest opens. There is no page to fall back on any more, so the kind has to be on the field.
        if (!isFieldKind(kind)) continue;
        fields[key] = readField(f, kind);
      }

      items.push({ id, name: str(s.name), note: str(s.note), facets, fields });
    }

  const views: View[] = [];
  if (Array.isArray(raw.views))
    for (const entry of raw.views) {
      const view = readView(entry);
      if (view) views.push(view);
    }

  const outputs: Record<string, string> = {};
  for (const [name, formula] of Object.entries(dict(raw.outputs)))
    if (isOutputName(name) && typeof formula === "string" && formula.trim())
      outputs[name] = formula;

  const density =
    typeof raw.density === "number" && isFinite(raw.density) && raw.density > 0
      ? raw.density
      : SEAWATER_DENSITY;

  return { items, views, outputs, density };
}

/**
 * Read a stored book.
 *
 * Deliberately FORGIVING, unlike the hull parser. A hull that decodes wrongly draws a wrong boat and must be
 * refused; a weight sheet that loses a malformed field loses a line of an estimate the user can retype, and
 * refusing to open the design over it would be far worse. So anything unreadable is dropped and the rest
 * opens.
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
  return readDocument(raw);
}

/** Whether a book is worth persisting at all — an untouched one is stored as `null`, not as `{}`. */
export const sheetIsEmpty = (book: WeightBook): boolean =>
  book.items.length === 0 &&
  book.views.length === 0 &&
  Object.keys(book.outputs).length === 0 &&
  book.density === SEAWATER_DENSITY;
