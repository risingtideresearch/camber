// Selection-derived helpers: what a given selection can do (delete / knuckle) and how it reads. Pure
// functions over the model + selection, kept out of the components so the delete/knuckle handlers and the
// SelectionInfo readout share one source of truth.

import {
  removePlanPoint,
  removeStationPoint,
  removeTrimPoint,
  type Model,
} from "../core/model";
import { clamp } from "../core/math";
import type {
  ModelSelection,
  ModelSelectionTarget,
} from "../core/modelSelection";

// the knuckle-carrying point array for the current selection (a station's section, or the sheer trim), or
// null. Both StationPointCP and TrimCP carry `.k`, so the knuckle slider drives either.
export function selArr(
  model: Model,
  selection: ModelSelection,
): { k: number }[] | null {
  if (!selection) return null;
  if (selection.tgt === "station" && selection.si !== undefined)
    return model.stations[selection.si]?.points ?? null;
  if (selection.tgt === "trim") return model.sheerTrim;
  return null;
}

// can the selected point be deleted? Ends are pinned; the plan / trim / section keep a minimum of 3 points;
// the transom is a fixed pair of points.
export function canDelete(
  model: Model,
  s: { tgt: ModelSelectionTarget; idx: number },
): boolean {
  if (s.tgt === "transom") return false;
  if (s.tgt === "plan")
    return (
      model.sheerPlan.length > 3 &&
      s.idx > 0 &&
      s.idx < model.sheerPlan.length - 1
    );
  if (s.tgt === "trim")
    return (
      model.sheerTrim.length > 3 &&
      s.idx > 0 &&
      s.idx < model.sheerTrim.length - 1
    );
  // a station point: the stations are index-aligned, so the count is shared and deleting removes the index
  // from every one of them
  const len = model.stations[0].points.length;
  return len > 3 && s.idx > 0 && s.idx < len - 1;
}

// points that carry a knuckle (k): every sheer-trim point, and every station point but the pinned deck
// point (idx 0). The plan / transom points do not.
export function hasKnuckle(s: {
  tgt: ModelSelectionTarget;
  idx: number;
}): boolean {
  return s.tgt === "trim" || (s.tgt === "station" && s.idx > 0);
}

export function labelFor(s: {
  tgt: ModelSelectionTarget;
  idx: number;
  si?: number;
}): string {
  if (s.tgt === "station")
    return `Station ${(s.si ?? 0) + 1} · point ${s.idx + 1}`;
  const name = { plan: "Sheer (plan)", trim: "Sheer trim", transom: "Transom" }[
    s.tgt as "plan" | "trim" | "transom"
  ];
  return `${name} · point ${s.idx + 1}`;
}

// set the knuckle k of the selected point (a sheer-trim point, or a station point). Returns true if a
// knuckle-carrying point was set. (Kept here rather than in a component so it may mutate the model directly.)
export function setKnuckle(
  model: Model,
  selection: ModelSelection,
  k: number,
): boolean {
  const arr = selArr(model, selection);
  if (!selection || !arr || !hasKnuckle(selection)) return false;
  arr[selection.idx].k = clamp(k, 0, 1);
  return true;
}

// delete the selected control point (if it may be deleted). Returns true if a point was removed.
export function deleteSelected(
  model: Model,
  selection: ModelSelection,
): boolean {
  if (!selection || !canDelete(model, selection)) return false;
  if (selection.tgt === "plan") removePlanPoint(model, selection.idx);
  else if (selection.tgt === "trim") removeTrimPoint(model, selection.idx);
  else removeStationPoint(model, selection.idx); // removes the index from every station
  return true;
}
