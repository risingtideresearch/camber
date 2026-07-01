// ---------- DOM + SVG helpers and shared element references ----------

import { type Vec2 } from "./math.js";
import { L, XFWD } from "./model.js";

const SVGNS = "http://www.w3.org/2000/svg";

export function getCSS(v: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}

export function el(
  tag: string,
  attrs: Record<string, string | number>,
): SVGElement {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

export function poly(pts: Vec2[]): string {
  let d = "";
  pts.forEach((p, i) => {
    d += (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1) + " ";
  });
  return d;
}

const byId = (id: string): SVGSVGElement =>
  document.getElementById(id) as unknown as SVGSVGElement;

export const svgP = byId("svgProfile"),
  svgL = byId("svgPlan"),
  svgC = byId("svgCut"),
  svgW = byId("svgWeights");

// the container the dynamic per-template station editors are rendered into, and the side tab strip
export const tplCards = document.getElementById("templateCards") as HTMLElement;
export const sideTabs = document.getElementById("sideTabs") as HTMLElement;

export const cv3d = document.getElementById("cv3d") as HTMLCanvasElement;

export const COL = {
  sheer: getCSS("--sheer"),
  keel: getCSS("--keel"),
  aft: getCSS("--aft"),
  fore: getCSS("--fore"),
  station: getCSS("--station"),
  wl: getCSS("--wl"),
  bt: getCSS("--bt"),
  deck: getCSS("--deck"),
  mut: getCSS("--mut"),
};

// per-template accent colors, cycled. Template 0 is the old "aft" blue; later ones fan toward purple/amber.
const TPL_PALETTE = [
  "#2b6cb0",
  "#7c3aed",
  "#dd6b20",
  "#0f766e",
  "#b45309",
  "#be185d",
  "#0369a1",
];
export function tplColor(i: number): string {
  return TPL_PALETTE[
    ((i % TPL_PALETTE.length) + TPL_PALETTE.length) % TPL_PALETTE.length
  ];
}

// a uniform sampling of x across the hull length, used by the plan/profile sweep curves. Runs to L+XFWD so
// the sheer-trim curve (which may carry control points over the bow overhang) is drawn out there too.
export function sampleX(): number[] {
  const a: number[] = [],
    N = 110;
  for (let i = 0; i <= N; i++) a.push(((L + XFWD) * i) / N);
  return a;
}
