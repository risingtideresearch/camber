// Selection-derived helpers: what a given selection can do (delete / knuckle) and how it reads. Pure
// functions over the model + selection, kept out of the components so the delete/knuckle handlers and the
// SelectionInfo readout share one source of truth.
//
// The selection is WINDOW-LOCAL and must never appear in a command — the document server has no idea what
// this window has selected, and two windows may have selected different things. So the two operations that
// used to reach into the model through a selection now resolve it to a command here, and the caller
// dispatches that.

import type { Model } from "../core/model";
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

// The command that sets the knuckle k of the selected point (a sheer-trim point, or a station point), or null
// where the selection carries no knuckle.
export function knuckleCommand(
  model: Model,
  selection: ModelSelection,
  k: number,
): DocumentCommand | null {
  if (!selection || !selArr(model, selection) || !hasKnuckle(selection))
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
