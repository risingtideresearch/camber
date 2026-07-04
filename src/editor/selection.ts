// Selection-derived helpers: what a given selection can do (delete / knuckle) and how it reads. Pure
// functions over the model + selection, kept out of the components so the delete/knuckle handlers and the
// SelectionInfo readout share one source of truth.

import {
  removeSheerPoint,
  removeStationPoint,
  removeTrimPoint,
  removeWeightPoint,
  type Model,
} from "../core/model";
import { clamp } from "../core/math";
import type {
  ModelSelection,
  ModelSelectionTarget,
} from "../core/modelSelection";

// the knuckle-carrying point array for the current selection (a template, or the sheer trim), or null.
// Both StationCP and TrimCP carry `.k`, so the knuckle slider drives either.
export function selArr(
  model: Model,
  selection: ModelSelection,
): { k: number }[] | null {
  if (!selection) return null;
  if (selection.tgt === "template" && selection.ti !== undefined)
    return model.templates[selection.ti];
  if (selection.tgt === "trim") return model.sheer.trim;
  return null;
}

// can the selected point be deleted? ends are pinned; the sheer/trim/template keep a minimum of 3; the
// weight curve keeps its two ends; the transom is a fixed pair of points.
export function canDelete(
  model: Model,
  s: { tgt: ModelSelectionTarget; idx: number },
): boolean {
  if (s.tgt === "transom") return false;
  if (s.tgt === "plan")
    return (
      model.sheer.cp.length > 3 &&
      s.idx > 0 &&
      s.idx < model.sheer.cp.length - 1
    );
  if (s.tgt === "trim")
    return (
      model.sheer.trim.length > 3 &&
      s.idx > 0 &&
      s.idx < model.sheer.trim.length - 1
    );
  if (s.tgt === "weight")
    return (
      model.sheer.cp.length > 3 &&
      s.idx > 0 &&
      s.idx < model.sheer.cp.length - 1
    );
  const len = model.templates[0].length; // template
  return len > 3 && s.idx > 0 && s.idx < len - 1;
}

// points that carry a knuckle (k): every sheer-trim point, and every template point but the pinned sheer
// point (idx 0). The plan/transom/weight points do not.
export function hasKnuckle(s: {
  tgt: ModelSelectionTarget;
  idx: number;
}): boolean {
  return s.tgt === "trim" || (s.tgt === "template" && s.idx > 0);
}

export function labelFor(s: {
  tgt: ModelSelectionTarget;
  idx: number;
  ti?: number;
}): string {
  if (s.tgt === "template")
    return `Template ${(s.ti ?? 0) + 1} · point ${s.idx + 1}`;
  if (s.tgt === "weight") return `Blend point ${s.idx + 1}`;
  const name = { plan: "Sheer (plan)", trim: "Sheer trim", transom: "Transom" }[
    s.tgt as "plan" | "trim" | "transom"
  ];
  return `${name} · point ${s.idx + 1}`;
}

// set the knuckle k of the selected point (a sheer-trim point, or a template point). Returns true if a
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
  if (selection.tgt === "plan") removeSheerPoint(model, selection.idx);
  else if (selection.tgt === "trim") removeTrimPoint(model, selection.idx);
  else if (selection.tgt === "weight") removeWeightPoint(model, selection.idx);
  else removeStationPoint(model, selection.idx); // template (removes the index from every template)
  return true;
}
