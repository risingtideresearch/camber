// ---------- point fields, as the two projections need them ----------
//
// The views (`PointViews.tsx`) know about pixels and pointers and nothing about the book; the book knows
// about formulas and nothing about pixels. This is the one place that reads both — it turns evaluated cells
// into plottable points, and it decides where a drag is allowed to land exactly.

import {
  isDerived,
  leavesOf,
  type Field,
  type FieldLeaf,
  type Item,
  type WeightBook,
} from "../../core/sheet/book";
import {
  resultAt,
  type BookResults,
  type CellResult,
} from "../../core/sheet/evaluate";
import {
  readPlacement,
  spreadRegion,
  toSheet,
  type Placement,
  type PointFrame,
} from "../../core/sheet/points";
import {
  sliceMeasurementKey,
  type SliceMeasurements,
} from "../../core/sheet/slices";
import type { Vec2, Vec3 } from "../../core/math";
import { isDimless, sameDim } from "../../core/sheet/quantity";
import type { PlottedCut, PlottedPoint, SnapTarget } from "./PointViews";

const AXES = ["x", "y", "z"] as const;

/** One opaque handle for a point cell, so a drag can name what it landed in. */
export const pointId = (itemId: string, fieldKey: string): string =>
  `${itemId} ${fieldKey}`;

/**
 * What a drag may do to one cell, or null where it may do nothing.
 *
 * The unit test is what decides whether a drag may ADD a literal to a cell that has none. A number appended
 * to `HULL.LCB` is only a distance because the field declared one — without a declared unit of the value's
 * own kind it would be a plain number added to a length, and the drag would trade a working cell for an
 * error. A point field declares `m` when it is made, so this is satisfied unless someone clears it.
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
 * Every point field of the items in view, ready to draw.
 *
 * A coordinate that ERRORED is NaN, and the views draw such a point nowhere rather than at the origin — a
 * point at zero because its formula is broken is a lie the drawing would tell convincingly. An EMPTY one is
 * zero, and marked: it has not been placed yet, which is the ordinary state of a field you just added and
 * the reason dragging exists.
 *
 * An item may carry more than one point — a bracket and the motor hanging off it — so the label says which
 * field it is whenever there is a choice, and stays the plain item name when there is not.
 */
export function plotPoints(
  items: readonly Item[],
  results: BookResults,
  reading: "worst" | "likely",
): PlottedPoint[] {
  const out: PlottedPoint[] = [];
  for (const item of items) {
    const pointKeys = Object.entries(item.fields).filter(
      ([, field]) => field.k === "point",
    );
    for (const [fieldKey, field] of pointKeys) {
      if (field.k !== "point") continue;
      const derived = isDerived(field);
      const cells = AXES.map((axis) => {
        const result = resultAt(results, item.id, fieldKey, axis);
        const empty = result?.empty ?? true;
        return {
          axis,
          result,
          value: result?.reading ? result.reading.v : empty ? 0 : NaN,
          // The unit is the FIELD's, shared by all three coordinates, so a drag writes the number the field
          // is authored in: a point in `mm` stays in `mm`.
          factor: result?.unit?.factor ?? 1,
          // A derivation states all three coordinates at once, so there is nothing in it a drag could move:
          // appending an offset would shift x, y AND z by the same distance, which is never what a pointer
          // meant. A derived point is drawn where it computes to and left alone.
          placement: derived ? null : placementFor(field[axis], result),
          empty,
        };
      });
      const [x, y, z] = cells;
      out.push({
        id: pointId(item.id, fieldKey),
        itemId: item.id,
        fieldKey,
        name:
          pointKeys.length > 1
            ? `${item.name || "unnamed"}.${fieldKey}`
            : item.name,
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
  }
  return out;
}

/**
 * Every cut of the items in view, drawn as the surface it actually is.
 *
 * ---------- a station is not a vertical line ----------
 *
 * The obvious drawing — a vertical rule at the cut's own x — is wrong, and wrong by more than a line width.
 * A station is cut NORMAL TO THE PLAN HEADING (`slices.ts`), and an authored plan curves, so the plane is
 * yawed: on the stock hull the heading is 2° off the x axis at the first metre and 13° off by the third, and
 * the cut sweeps 38 mm and 198 mm of x across its own beam as it does. It is not even one plane — the two
 * halves are mirrored, so it closes as a shallow V, which is exactly why `slices.ts` doubles a half-area
 * rather than shoelacing "across a fictitious common plane". Seen from the side that is a leaning lens.
 *
 * So the profile draws the cut's OWN measured outline, projected — a leaning CURVE, not a closed shape: the
 * two mirrored halves carry the same x, so from the side they lie on top of each other. `pos` still says
 * where the cut was taken —
 * it is the plan's centreline x, and the number the cell holds — but nothing here pretends that is the whole
 * of where the cut is. The gap is visible in the schedule too: a station at `pos = 3` measures its centroid
 * at x = 2.854.
 *
 * A HORIZONTAL cut needs none of this. It is a plane of constant world height, and the sheet's z is a world
 * height, so it really is a level line in both views and is drawn as one.
 *
 * ---------- and it is a band, not a line ----------
 *
 * A station known to ±5 cm could be anywhere in 10 cm of hull, so the outline is swept over the position's
 * own spread. Drawing a bare line would claim a precision the cell does not have.
 */
export function plotCuts(
  items: readonly Item[],
  results: BookResults,
  reading: "worst" | "likely",
  measurements: SliceMeasurements,
  frame: PointFrame | null,
): PlottedCut[] {
  const out: PlottedCut[] = [];
  for (const item of items) {
    const cutKeys = Object.entries(item.fields).filter(
      ([, field]) => field.k === "cut",
    );
    for (const [fieldKey, field] of cutKeys) {
      if (field.k !== "cut") continue;
      const result = resultAt(results, item.id, fieldKey, "pos");
      const empty = result?.empty ?? true;
      const spread = result?.reading?.[reading];
      const lo = spread?.lo ?? 0;
      const hi = spread?.hi ?? 0;
      // Only a station has an attitude worth drawing, and only a measured one has it to draw FROM: the curve
      // is the cut the hull actually produced, so nothing here re-derives what the plan is doing.
      const measurement =
        field.shape === "station" && frame
          ? measurements.get(sliceMeasurementKey(item.id, fieldKey))
          : undefined;
      // One half of the curve. The two are mirrored in y and carry the SAME x, so they project onto exactly
      // the same line here — tracing both would draw the leaning curve out and back over itself.
      //
      // Taken as the RUN up to where the curve first crosses the centreline, not as every point with y ≥ 0.
      // The mirrored half ends back at the keel, and −0 passes a `>= 0` test, so filtering would collect that
      // last point too and close the curve with a straight line from the sheer to the keel.
      const trace: Vec2[] = measurement
        ? halfCurve(measurement.curve).map((p) => {
            const sheet = toSheet(frame!, p);
            return [sheet[0], sheet[2]];
          })
        : [];
      out.push({
        id: pointId(item.id, fieldKey),
        itemId: item.id,
        fieldKey,
        name:
          cutKeys.length > 1
            ? `${item.name || "unnamed"}.${fieldKey}`
            : item.name || "unnamed",
        // Which axis a cut is a plane of is which KIND of cut it is — the same reading `slices.ts` gives the
        // number, and the same one `snapTargets` offers it under.
        axis: field.shape === "plane" ? "z" : "x",
        // A position that errored or was never written is drawn NOWHERE, rather than at the transom: a cut
        // at zero because its formula is broken is a lie the drawing would tell convincingly.
        at: result?.reading ? result.reading.v : NaN,
        lo,
        hi,
        trace,
        // A position nothing can move sweeps nothing, and a band identical to the outline under it would
        // read as a spread too small to see rather than as no spread at all.
        band: trace.length && lo + hi > 0 ? sweptOutline(trace, lo, hi) : [],
        empty,
      });
    }
  }
  return out;
}

/**
 * A cut's curve up to the point it first crosses the centreline.
 *
 * `slices.ts` builds the curve as one skin run followed by its mirror, so the leading run is a whole half and
 * everything after it is that half again with y negated. Stopping at the crossing keeps the halves apart
 * without assuming how many points each has.
 */
function halfCurve(curve: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const point of curve) {
    if (point[1] < 0) break;
    out.push(point);
  }
  return out;
}

/** How finely the swept outline is resolved up the section. A drawing, so it is sampled for an eye. */
const SWEEP_BANDS = 28;

/**
 * The outline swept over the range its position could fall in.
 *
 * Taken as a per-height envelope rather than as two shifted copies of the curve, because the shape leans:
 * the leftmost x at one height belongs to a different part of the section than at another, and a shifted
 * copy would draw the sweep of a shape that is not there. Degenerate where the cut has no height at all,
 * which is a cut that missed the hull and has nothing to draw either way.
 */
function sweptOutline(trace: readonly Vec2[], lo: number, hi: number): Vec2[] {
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const [, z] of trace) {
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  const height = z1 - z0;
  if (!(height > 0)) return [];
  const left = new Array<number>(SWEEP_BANDS).fill(Infinity);
  const right = new Array<number>(SWEEP_BANDS).fill(-Infinity);
  for (const [x, z] of trace) {
    const i = Math.min(
      SWEEP_BANDS - 1,
      Math.max(0, Math.floor(((z - z0) / height) * SWEEP_BANDS)),
    );
    left[i] = Math.min(left[i], x);
    right[i] = Math.max(right[i], x);
  }
  const zAt = (i: number): number => z0 + ((i + 0.5) / SWEEP_BANDS) * height;
  const out: Vec2[] = [];
  for (let i = 0; i < SWEEP_BANDS; i++)
    if (isFinite(left[i])) out.push([left[i] - lo, zAt(i)]);
  for (let i = SWEEP_BANDS - 1; i >= 0; i--)
    if (isFinite(right[i])) out.push([right[i] + hi, zAt(i)]);
  return out;
}

/**
 * Where a drag can land exactly, and what it writes when it does.
 *
 * All of these write a REFERENCE rather than the number it currently works out to, which is the whole reason
 * to have them. A tank dropped on a cut's plane says `tank flat.section.pos`, and it then follows that plane
 * when the hull changes — where the number it happened to equal today would quietly stop being true. The two
 * datums are the same idea: `0` on the centreline and on the keel baseline are exact statements, not
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
  for (const item of book.items) {
    if (!item.name) continue;
    for (const [fieldKey, field] of Object.entries(item.fields)) {
      if (field.k !== "cut") continue;
      const position = resultAt(results, item.id, fieldKey, "pos");
      if (!position?.reading || position.error) continue;
      // A cut's `pos` is a height for a horizontal cut and a station for a plane-normal one, so which axis it
      // offers is which kind of cut it is. That is the same reading `slices.ts` gives the number.
      out.push({
        axis: field.shape === "plane" ? "z" : "x",
        at: position.reading.v,
        formula: `${item.name}.${fieldKey}.pos`,
        label: `${item.name}.${fieldKey}`,
        // Which cut this IS, so a view already drawing it does not draw a second line over the top of the
        // first — and, for a station, a straight one over a curve.
        cut: pointId(item.id, fieldKey),
      });
    }
  }
  return out;
}

/**
 * The cell of a multi-cell field whose spread is worth ranking, for the footer.
 *
 * A point has no single value to be uncertain about — it has three — and a cut has its position. So the
 * footer shows whichever cell carries the widest spread, which is the one worth going and improving. Null
 * for a field with one cell, leaving the footer's ordinary path exactly as it was.
 */
export function widestCell(
  itemId: string,
  fieldKey: string,
  field: Field,
  results: BookResults,
): { readonly leaf: FieldLeaf; readonly result: CellResult } | null {
  const leaves = leavesOf(field);
  if (leaves.length < 2 && leaves[0] === "formula") return null;
  let best: { leaf: FieldLeaf; result: CellResult } | null = null;
  let widest = -1;
  for (const leaf of leaves) {
    const result = resultAt(results, itemId, fieldKey, leaf);
    if (!result?.reading) continue;
    const width = result.reading.worst.lo + result.reading.worst.hi;
    if (width > widest) {
      widest = width;
      best = { leaf, result };
    }
  }
  return best;
}
