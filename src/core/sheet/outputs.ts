// ---------- what the book answers, as the rest of the app asks it ----------
//
// One table binding every `OUT.*` name to a dimension and a line of documentation, and one page in the book
// whose rows carry those names. It is the mirror of `hullMetrics.ts`: that one is the only place that knows
// what a sheet can ask the GEOMETRY, this one is the only place that knows what the rest of the app can ask
// the SHEET.
//
// ---------- why the answer is a row, and not a nomination ----------
//
// The obvious design points at a row: store a reference to whichever line the user says is the displacement.
// The book did that, and it was the only place in it that addressed a row by id rather than by name — which
// is what all the pruning was for, because an id can dangle when the row it names goes away.
//
// An outputs page has nothing to prune. Deleting the row deletes the answer, which is what should happen, and
// renaming a row elsewhere rewrites nothing because the outputs page refers to it by name like every other
// formula does. What is left is one page whose three lines say, in the same language as the rest of the book,
// what this estimate claims.
//
// It also puts the general case and the simple one in the same place. `DISPLACEMENT = Weights.all up weight`
// is an alias and reads like a tax; `VCG = (Weights.hull * Points.hull.z + …) / OUT.DISPLACEMENT` is the same
// row doing real work. A nomination could only express the first.
//
// ---------- closed, on purpose ----------
//
// The stability panel has to know the names it is looking for, so this list is not user-extensible. Adding an
// output is an entry here and nothing else: no schema change, no stored field, no migration. That is the
// whole reason the set of answers is a table rather than a record type on `WeightBook`, which is what it used
// to be — growing it meant touching the type, the JSON, the picker and the invariants together.

import { LENGTH, MASS, type Dim } from "./quantity";
import { isHeading, outputsSheet, type Sheet, type WeightBook } from "./book";

export interface OutputSpec {
  /** The row name on the outputs page that declares it, and the leaf after `OUT.`. */
  readonly name: string;
  /** What it has to work out to. A row that disagrees is warned about, never refused. */
  readonly dim: Dim;
  /** How the panel labels it. */
  readonly label: string;
  readonly hint: string;
}

/**
 * The catalogue, in the order the outputs page lists them: what it weighs, then where that weight is.
 */
export const OUTPUTS: readonly OutputSpec[] = [
  {
    name: "DISPLACEMENT",
    dim: MASS,
    label: "Δ",
    hint: "What the boat weighs, all up — what the stability panel reads as its displacement",
  },
  {
    name: "VCG",
    dim: LENGTH,
    label: "VCG",
    hint: "Height of the centre of gravity above the keel baseline",
  },
  {
    name: "LCG",
    dim: LENGTH,
    label: "LCG",
    hint: "Centre of gravity along the hull, from the transom",
  },
];

const BY_NAME = new Map(OUTPUTS.map((spec) => [spec.name, spec]));

export const outputSpec = (name: string): OutputSpec | undefined =>
  BY_NAME.get(name);

export const isOutputName = (name: string): boolean => BY_NAME.has(name);

/**
 * The row answering one output, or null where nothing does.
 *
 * Resolved by page KIND rather than by page name, so the page can be called Outputs or Answers or anything
 * else and every `OUT.` reference keeps working.
 */
export function outputRow(book: WeightBook, name: string) {
  const sheet = outputsSheet(book);
  if (!sheet || !isOutputName(name)) return null;
  return sheet.rows.find((row) => !isHeading(row) && row.name === name) ?? null;
}

/** The output names a page has not used yet — what the name dropdown offers. */
export function freeOutputNames(sheet: Sheet): OutputSpec[] {
  const taken = new Set(
    sheet.rows.filter((row) => !isHeading(row)).map((row) => row.name),
  );
  return OUTPUTS.filter((spec) => !taken.has(spec.name));
}
