// Note: we may want to refactor this to make it more generic, but for now `Drag` is a union of everything
// that can be dragged across all apps in this repo.

import { OnModelSelect } from "./modelSelection";

export interface Drag {
  kind: "slider" | "sheer" | "trim" | "transom" | "stn" | "stationU";
  svg?: SVGGraphicsElement; // the pan/zoom content <g> the drag started in (its CTM maps pointer → content)
  idx?: number;
  si?: number; // which station, for a "stn" (section-point) drag
}

let CURRENT_DRAG: Drag | null = null;

export function getDrag(): Drag | null {
  return CURRENT_DRAG;
}

export function setDrag(d: Drag | null): void {
  CURRENT_DRAG = d;
}

type DragSpec = {
  kind: Drag["kind"];
  idx?: number;
  si?: number;
};

export function startDrag(
  d: DragSpec,
  svg: SVGGraphicsElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  setDrag({ ...d, svg });
  // a drag on a control point selects it (persistently). The x-cut slider and a station's u-handle move
  // rather than select: neither is a control point of the shape. (Pressing a station's handle does make it
  // the ACTIVE station, but that is which section is being edited, not a selection — the plan view calls it
  // alongside this, the same way its tab does.)
  if (d.kind === "sheer") onSelect({ tgt: "plan", idx: d.idx! });
  else if (d.kind === "trim") onSelect({ tgt: "trim", idx: d.idx! });
  else if (d.kind === "transom") onSelect({ tgt: "transom", idx: d.idx! });
  else if (d.kind === "stn")
    onSelect({ tgt: "station", idx: d.idx!, si: d.si! });
  e.stopPropagation();
  e.preventDefault();
}
