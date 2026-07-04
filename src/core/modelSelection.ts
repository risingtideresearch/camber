import type { Model } from "./model";

// selection also carries which template (state.selected.ti); a "weight" selection is a weight CP.
export type ModelSelectionTarget =
  "plan" | "trim" | "transom" | "template" | "weight";

export type ModelSelection = {
  tgt: ModelSelectionTarget;
  idx: number;
  ti?: number;
} | null;

export type OnModelSelect = (selection: ModelSelection) => void;

// the selected template-point index, or null when the selection isn't a template point
export function selStationIdx(
  model: Model,
  selection: ModelSelection,
): number | null {
  return selection &&
    selection.tgt === "template" &&
    selection.idx < model.templates[0].length
    ? selection.idx
    : null;
}

// is the given point the current selection? (for templates, the template index `ti` must match too)
export function isSelected(
  selection: ModelSelection,
  tgt: ModelSelectionTarget,
  idx: number,
  ti?: number,
): boolean {
  return (
    !!selection &&
    selection.tgt === tgt &&
    selection.idx === idx &&
    (ti === undefined || selection.ti === ti)
  );
}
