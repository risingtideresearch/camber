// Selection-derived helpers: what a given selection can do (delete / knuckle) and how it reads. Pure
// functions over the model + selection, kept out of the components so the delete/knuckle handlers and the
// SelectionInfo readout share one source of truth.
//
// The selection is WINDOW-LOCAL and must never appear in a command — the document server has no idea what
// this window has selected, and two windows may have selected different things. So the two operations that
// used to reach into the model through a selection now resolve it to a command here, and the caller
// dispatches that.

import type { Model } from "../core/model";
import { isStationEnd } from "../core/hull";
import type { DocumentCommand } from "../core/commands";
import type {
  ModelSelection,
  ModelSelectionTarget,
} from "../core/modelSelection";

// the knuckle-carrying point array for the current selection (a station's section, or the sheer trim), or
// null. Both StationPointCP and TrimCP carry `.k`, so the knuckle slider drives either.
export function selArr(
  model: Model,
  selection: ModelSelection,
): readonly { readonly k: number }[] | null {
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

// points whose knuckle (k) can be set: every sheer-trim point, and every interior station point. A station's
// deck point and bottom point are corners by construction — the section curve is cut there — so their k is
// pinned to 1 (see `stationKnuckle`) and the slider is disabled on them. The plan / transom points carry no
// knuckle at all.
export function hasKnuckle(
  model: Model,
  s: { tgt: ModelSelectionTarget; idx: number; si?: number },
): boolean {
  if (s.tgt === "trim") return true;
  if (s.tgt !== "station") return false;
  const arr = model.stations[s.si ?? 0]?.points;
  return !!arr && !isStationEnd(arr.length, s.idx);
}

// the knuckle the readout shows for the selection: the point's own k, or the pinned 1 of a station's end
// point. 0 where the selection carries no knuckle (or no longer resolves to a point).
export function shownKnuckle(model: Model, selection: ModelSelection): number {
  const point = selection
    ? selArr(model, selection)?.[selection.idx]
    : undefined;
  if (!selection || !point) return 0;
  if (selection.tgt === "station" && !hasKnuckle(model, selection)) return 1;
  return point.k;
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

// The command that sets the knuckle k of the selected point (a sheer-trim point, or a station point), or null
// where the selection carries no knuckle.
export function knuckleCommand(
  model: Model,
  selection: ModelSelection,
  k: number,
): DocumentCommand | null {
  if (!selection || !selArr(model, selection) || !hasKnuckle(model, selection))
    return null;
  return selection.tgt === "trim"
    ? { type: "setTrimK", idx: selection.idx, k }
    : { type: "setStationK", si: selection.si ?? 0, idx: selection.idx, k };
}

// The command that deletes the selected control point, or null where it may not be deleted. This is where
// one window-local selection becomes one of the three remove commands.
export function deleteCommand(
  model: Model,
  selection: ModelSelection,
): DocumentCommand | null {
  if (!selection || !canDelete(model, selection)) return null;
  if (selection.tgt === "plan")
    return { type: "removePlanPoint", idx: selection.idx };
  if (selection.tgt === "trim")
    return { type: "removeTrimPoint", idx: selection.idx };
  return { type: "removeStationPoint", idx: selection.idx }; // from every station
}
