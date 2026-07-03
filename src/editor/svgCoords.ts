// SVG pointer-coordinate helpers shared by the editor's views and the window-level drag handler.

import type { Drag } from "../core/drag";

// map a client (screen) point to a graphics element's local coordinate system via its CTM. The element the
// views draw into is the pan/zoom content <g>, so its CTM folds in the view transform: the result is the
// fixed content coordinates the draw2d mappings (invX / invY / …) expect, at any zoom / pan.
export function svgPoint(
  el: SVGGraphicsElement,
  clientX: number,
  clientY: number,
): [number, number] {
  const m = el.getScreenCTM();
  if (!m) return [0, 0];
  const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
  return [p.x, p.y];
}

// the content coordinates for an in-progress drag (its originating content group is stored on the drag)
export function getVB(d: Drag, e: PointerEvent): [number, number] {
  return svgPoint(d.svg!, e.clientX, e.clientY);
}
