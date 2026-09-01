// ---------- what the book answers, as the rest of the app asks it ----------
//
// One table binding every `OUT.*` name to a dimension and a line of documentation, and one map on the book
// holding the formula that answers each. It is the mirror of `hullMetrics.ts`: that one is the only place
// that knows what a sheet can ask the GEOMETRY, this one is the only place that knows what the rest of the
// app can ask the SHEET.
//
// ---------- why the answer is a formula, and not a reference ----------
//
// The obvious design points at a row: store a reference to whichever line the user says is the displacement.
// The book did that, and it was the only place in it that addressed a row by id rather than by name — which
// meant pruning, because an id can dangle when the row it names goes away.
//
// A formula has nothing to prune. It resolves by name at evaluation like every other formula in the book, so
// renaming an item rewrites nothing and deleting one turns the answer into an ordinary, visible error rather
// than a silent dangle.
//
// It also puts the general case and the simple one in the same place. `DISPLACEMENT = all up.mass` is an
// alias and reads like a tax; `VCG = (hull.mass * hull.cg.z + …) / OUT.DISPLACEMENT` is the same entry doing
// real work. A nomination could only express the first.
//
// ---------- closed, on purpose ----------
//
// The stability panel has to know the names it is looking for, so this list is not user-extensible. Adding an
// output is an entry here and nothing else: no schema change, no stored field, no migration.

import { LENGTH, MASS, type Dim } from "./quantity";
import type { WeightBook } from "./book";

export interface OutputSpec {
  /** The key in `book.outputs`, and the leaf after `OUT.`. */
  readonly name: string;
  /** What it has to work out to. An answer that disagrees is warned about, never refused. */
  readonly dim: Dim;
  /** How the panel labels it. */
  readonly label: string;
  readonly hint: string;
}

/**
 * The catalogue, in the order the summary lists them: what it weighs, then where that weight is.
 *
 * The two centres are stated apart, as two lengths, because that is what the rest of the app asks for — the
 * stability panel wants a KG and an LCG, not a place. A book that has built its centre of gravity as a POINT
 * answers them with `CG.place.z` and `CG.place.x`, which is the same one statement read twice and costs a
 * line each.
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

/** The formula answering one output, or "" where nothing does. */
export const outputFormula = (book: WeightBook, name: string): string =>
  (isOutputName(name) ? book.outputs[name] : "") ?? "";
