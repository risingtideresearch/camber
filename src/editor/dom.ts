// ---------- DOM element references ----------

import { byId } from "../core/draw2d";

export const svgP = byId("svgProfile"),
  svgL = byId("svgPlan"),
  svgC = byId("svgCut"),
  svgW = byId("svgWeights");

// the container the dynamic per-template station editors are rendered into, and the side tab strip
export const tplCards = document.getElementById("templateCards") as HTMLElement;
export const sideTabs = document.getElementById("sideTabs") as HTMLElement;

export const cv3d = document.getElementById("cv3d") as HTMLCanvasElement;
