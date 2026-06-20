// ---------- DOM + SVG helpers and shared element references ----------

import { type Vec2 } from "./math.js";
import { L } from "./model.js";

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
  svgA = byId("svgAft"),
  svgF = byId("svgFore"),
  svgC = byId("svgCut"),
  svgB = byId("svgBody");

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

// a uniform sampling of x across the hull length, used by the plan/profile sweep curves
export function sampleX(): number[] {
  const a: number[] = [],
    N = 100;
  for (let i = 0; i <= N; i++) a.push((L * i) / N);
  return a;
}
