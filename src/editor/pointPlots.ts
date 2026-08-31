// ---------- a points page, as the two projections need it ----------
//
// The views (`PointViews.tsx`) know about pixels and pointers and nothing about the book; the book knows
// about formulas and nothing about pixels. This is the one place that reads both — it turns evaluated rows
// into plottable points, and it decides where a drag is allowed to land exactly.

import {
  fieldsOf,
  isDerived,
  isHeading,
  type RowField,
  type Sheet,
  type SheetRow,
  type WeightBook,
} from "../core/sheet/book";
import {
  resultAt,
  type BookResults,
  type RowResult,
} from "../core/sheet/evaluate";
import {
  readPlacement,
  spreadRegion,
  type Placement,
} from "../core/sheet/points";
import { isDimless, sameDim } from "../core/sheet/quantity";
import type { PlottedPoint, SnapTarget } from "./PointViews";

const AXES = ["x", "y", "z"] as const;

/**
 * What a drag may do to one cell, or null where it may do nothing.
 *
 * The unit test is what decides whether a drag may ADD a literal to a cell that has none. A number appended
 * to `HULL.LCB` is only a distance because the row declared one — without a declared unit of the value's own
 * kind it would be a plain number added to a length, and the drag would trade a working cell for an error.
 * A point row declares `m` when it is made, so this is satisfied unless someone clears it.
 */
export function placementFor(
  source: string,
  result: ReturnType<typeof resultAt>,
): Placement | null {
  const factor = result?.unit?.factor ?? 1;
  const declared = result && !result.unitIsDerived ? result.unit : null;
  const dim = result?.quantity?.dim;
  const canAppend =
    !!declared &&
    !isDimless(declared.dim) &&
    (!dim || isDimless(dim) || sameDim(dim, declared.dim));
  const value = result?.reading ? result.reading.v / factor : 0;
  return readPlacement(source, result?.tree ?? null, value, canAppend);
}

/**
 * The rows of a points page, ready to draw.
 *
 * A coordinate that ERRORED is NaN, and the views draw such a point nowhere rather than at the origin — a
 * point at zero because its formula is broken is a lie the drawing would tell convincingly. An EMPTY one is
 * zero, and marked: it has not been placed yet, which is the ordinary state of a row you just added and the
 * reason dragging exists.
 */
export function plotPoints(
  sheet: Sheet,
  results: BookResults,
  reading: "worst" | "likely",
): PlottedPoint[] {
  const out: PlottedPoint[] = [];
  for (const row of sheet.rows) {
    if (row.kind !== "point") continue;
    const derived = isDerived(row);
    const cells = AXES.map((axis) => {
      const result = resultAt(results, sheet.id, row.id, axis);
      const empty = result?.empty ?? true;
      return {
        axis,
        result,
        value: result?.reading ? result.reading.v : empty ? 0 : NaN,
        // The unit is the ROW's, shared by all three coordinates, so a drag writes the number the row is
        // authored in: a point in `mm` stays in `mm`.
        factor: result?.unit?.factor ?? 1,
        // A derivation states all three coordinates at once, so there is nothing in it a drag could move:
        // appending an offset would shift x, y AND z by the same distance, which is never what a pointer
        // meant. A derived point is drawn where it computes to and left alone.
        placement: derived ? null : placementFor(row[axis], result),
        empty,
      };
    });
    const [x, y, z] = cells;
    out.push({
      id: row.id,
      name: row.name,
      axes: { x, y, z },
      // Each region is the joint spread of the PAIR the view shows, not two independent bars: coordinates
      // that share an uncertain input are correlated, and the polygon leans to say so. See `points.ts`.
      xz:
        x.result?.quantity && z.result?.quantity
          ? spreadRegion(
              x.result.quantity,
              z.result.quantity,
              results.sources,
              reading,
            )
          : [],
      yz:
        y.result?.quantity && z.result?.quantity
          ? spreadRegion(
              y.result.quantity,
              z.result.quantity,
              results.sources,
              reading,
            )
          : [],
    });
  }
  return out;
}

/**
 * Where a drag can land exactly, and what it writes when it does.
 *
 * All of these write a REFERENCE rather than the number it currently works out to, which is the whole reason
 * to have them. A tank dropped on a slice's plane says `Slices.tank flat.pos`, and it then follows that
 * plane when the hull changes — where the number it happened to equal today would quietly stop being true.
 * The two datums are the same idea: `0` on the centreline and on the keel baseline are exact statements, not
 * roundings of 0.003.
 */
export function snapTargets(
  book: WeightBook,
  results: BookResults,
): SnapTarget[] {
  const out: SnapTarget[] = [
    { axis: "y", at: 0, formula: "0", label: "the centreline" },
    { axis: "z", at: 0, formula: "0", label: "the keel baseline" },
  ];
  for (const page of book.sheets) {
    if (page.kind !== "slices" || !page.name) continue;
    for (const row of page.rows) {
      if (isHeading(row) || row.kind !== "slice" || !row.name) continue;
      const position = resultAt(results, page.id, row.id, "pos");
      if (!position?.reading || position.error) continue;
      // A slice's `pos` is a height for a horizontal cut and a station for a plane-normal one, so which axis
      // it offers is which kind of cut it is. That is the same reading `slices.ts` gives the number.
      out.push({
        axis: row.shape === "plane" ? "z" : "x",
        at: position.reading.v,
        formula: `${page.name}.${row.name}.pos`,
        label: `${page.name}.${row.name}`,
      });
    }
  }
  return out;
}

/**
 * The cell of a multi-cell row whose spread is worth ranking, for the footer.
 *
 * A point has no single value to be uncertain about — it has three — and a slice has its position. So the
 * footer shows whichever cell carries the widest spread, which is the one worth going and improving. Null
 * for a row with one cell, leaving the footer's ordinary path exactly as it was.
 */
export function widestCell(
  sheet: Sheet,
  row: SheetRow,
  results: BookResults,
): { readonly field: RowField; readonly result: RowResult } | null {
  const fields = fieldsOf(row);
  if (fields.length < 2 && fields[0] === "formula") return null;
  let best: { field: RowField; result: RowResult } | null = null;
  let widest = -1;
  for (const field of fields) {
    const result = resultAt(results, sheet.id, row.id, field);
    if (!result?.reading) continue;
    const width = result.reading.worst.lo + result.reading.worst.hi;
    if (width > widest) {
      widest = width;
      best = { field, result };
    }
  }
  return best;
}
