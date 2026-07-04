// Note: we may want to refactor this to make it more generic, but for now `Drag` is a union of everything
// that can be dragged across all apps in this repo.

import { OnModelSelect } from "./modelSelection";

export interface Drag {
  kind: "slider" | "sheer" | "trim" | "transom" | "stn" | "weight" | "rot";
  svg?: SVGSVGElement;
  idx?: number;
  ti?: number; // template index, for a "stn" drag
  wpart?: "x" | "bnd"; // which part of a weight control point is being dragged
  bnd?: number; // boundary index, for a "weight" / "bnd" drag
  px0?: number;
  py0?: number;
  yaw0?: number;
  pitch0?: number;
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
  ti?: number;
  wpart?: "x" | "bnd";
  bnd?: number;
};

export function startDrag(
  d: DragSpec,
  svg: SVGSVGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  setDrag({ ...d, svg, px0: e.clientX });
  // a drag on a control point selects it (persistently); the x-cut slider / rotation leave the selection
  if (d.kind === "sheer") onSelect({ tgt: "plan", idx: d.idx! });
  else if (d.kind === "trim") onSelect({ tgt: "trim", idx: d.idx! });
  else if (d.kind === "transom") onSelect({ tgt: "transom", idx: d.idx! });
  else if (d.kind === "stn")
    onSelect({ tgt: "template", idx: d.idx!, ti: d.ti! });
  else if (d.kind === "weight") onSelect({ tgt: "weight", idx: d.idx! });
  e.stopPropagation();
  e.preventDefault();
}
