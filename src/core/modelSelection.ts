import type { Model } from "./model";

// What a click selected. "station" is a point of a station's section — `si` says which station, `idx` which
// point of it. (Version 1 also had a "weight" target, for a control point of the template-blend curve; v2
// has no blend, so a station's position is edited as the station itself.)
export type ModelSelectionTarget = "plan" | "trim" | "transom" | "station";

export type ModelSelection = {
  tgt: ModelSelectionTarget;
  idx: number;
  si?: number; // which station, for a "station" selection
} | null;

export type OnModelSelect = (selection: ModelSelection) => void;

// the selected section-point index, or null when the selection isn't one
export function selStationIdx(
  model: Model,
  selection: ModelSelection,
): number | null {
  return selection &&
    selection.tgt === "station" &&
    selection.idx < model.stations[0].points.length
    ? selection.idx
    : null;
}

// is the given point the current selection? (for a station point, `si` must match too)
export function isSelected(
  selection: ModelSelection,
  tgt: ModelSelectionTarget,
  idx: number,
  si?: number,
): boolean {
  return (
    !!selection &&
    selection.tgt === tgt &&
    selection.idx === idx &&
    (si === undefined || selection.si === si)
  );
}
