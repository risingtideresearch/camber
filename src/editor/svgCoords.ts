// SVG pointer-coordinate helpers shared by the editor's strip views and the window-level drag handler.

import type { Drag } from "../core/drag";

// map a client (screen) point to the svg's viewBox coordinates via its CTM — handles any CSS scaling and
// preserveAspectRatio letterboxing (the editor svgs are fit-to-box, so their box ≠ their viewBox aspect)
export function svgPoint(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): [number, number] {
  const m = svg.getScreenCTM();
  if (!m) return [0, 0];
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const p = pt.matrixTransform(m.inverse());
  return [p.x, p.y];
}

// a strip's viewBox coordinates for a pointer event on that strip
export function vbCoords(
  svg: SVGSVGElement,
  e: PointerEvent,
): [number, number] {
  return svgPoint(svg, e.clientX, e.clientY);
}

// the viewBox coordinates for an in-progress drag (its originating svg is stored on the drag)
export function getVB(d: Drag, e: PointerEvent): [number, number] {
  return svgPoint(d.svg!, e.clientX, e.clientY);
}
