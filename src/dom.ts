// ---------- DOM + SVG helpers and shared element references ----------

import { type Vec2 } from "./math.js";
import { L } from "./model.js";

const SVGNS = "http://www.w3.org/2000/svg";

// The element the CSS custom properties (the colour palette) are read from. Defaults to the document
// root for the standalone app; the embedded Patchwork tool points it at its own scoped container so the
// editor's styles never leak onto (or read from) the host page.
let styleRoot: Element = document.documentElement;

export function getCSS(v: string): string {
  return getComputedStyle(styleRoot).getPropertyValue(v).trim();
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

// Shared element references and the colour palette. These are resolved by `initDom()` rather than at
// module load, so the editor can be mounted into a scaffold that is created at runtime (the Patchwork
// tool injects its DOM, then calls `initDom()`). They are exported as live bindings: importers read them
// inside functions that only run after `initDom()`, so they always see the resolved values.
export let svgP: SVGSVGElement;
export let svgL: SVGSVGElement;
export let svgC: SVGSVGElement;
export let svgB: SVGSVGElement;
export let svgW: SVGSVGElement;

// the container the dynamic per-template station editors are rendered into, and the side tab strip
export let tplCards: HTMLElement;
export let sideTabs: HTMLElement;

export let cv3d: HTMLCanvasElement;

export let COL: {
  sheer: string;
  keel: string;
  aft: string;
  fore: string;
  station: string;
  wl: string;
  bt: string;
  deck: string;
  mut: string;
};

// Resolve the editor's element references and colour palette. `paletteRoot` is the element the CSS
// custom properties are read from — `document.documentElement` for the standalone app (the default), or
// the tool's scoped container when embedded. Call once the editor scaffold is present in the document.
export function initDom(paletteRoot: Element = document.documentElement): void {
  styleRoot = paletteRoot;
  svgP = byId("svgProfile");
  svgL = byId("svgPlan");
  svgC = byId("svgCut");
  svgB = byId("svgBody");
  svgW = byId("svgWeights");
  tplCards = document.getElementById("templateCards") as HTMLElement;
  sideTabs = document.getElementById("sideTabs") as HTMLElement;
  cv3d = document.getElementById("cv3d") as HTMLCanvasElement;
  COL = {
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
}

// per-template accent colors, cycled. Template 0 is the old "aft" blue; later ones fan toward purple/amber.
const TPL_PALETTE = ["#2b6cb0", "#7c3aed", "#dd6b20", "#0f766e", "#b45309", "#be185d", "#0369a1"];
export function tplColor(i: number): string {
  return TPL_PALETTE[((i % TPL_PALETTE.length) + TPL_PALETTE.length) % TPL_PALETTE.length];
}

// a uniform sampling of x across the hull length, used by the plan/profile sweep curves
export function sampleX(): number[] {
  const a: number[] = [],
    N = 100;
  for (let i = 0; i <= N; i++) a.push((L * i) / N);
  return a;
}
