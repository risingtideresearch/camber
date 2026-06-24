// ---------- entry point: wire the app-level controls and do the first render ----------

import { resetModel, state } from "./model.js";
import { render, draw3d } from "./render.js";
import { initInteraction, refreshSelUI, addBlendPoint } from "./interaction.js";
import { downloadStep } from "./step.js";
import { downloadJson, importJson } from "./json.js";
import { svgL, svgP, svgW } from "./dom.js";
import { LH, PH, WVW, WVH } from "./view.js";

// the plan / profile strips are sized to the isometric scale (see view.ts); set their viewBox heights
// from the derived constants so the SVG aspect matches the to-scale drawing (no stretching). The blend
// control carries its own (vertical) viewBox.
svgL.setAttribute("viewBox", `0 0 1000 ${LH}`);
svgP.setAttribute("viewBox", `0 0 1000 ${PH}`);
svgW.setAttribute("viewBox", `0 0 ${WVW} ${WVH}`);

// ---------- size the right column ----------
// The right column's width IS the section editor's side: the square fills that width (CSS aspect-ratio),
// and the blend control takes the remaining height below it. We pick a width that is a sensible fraction of
// the main area but never taller (as a square) than half its height, so the blend always has room — and
// never wider than MAX_SIDE so the left column (3D + plan + profile) keeps the bulk of the width.
const MIN_SIDE = 220,
  MAX_SIDE = 460,
  LEFT_GAP = 20; // the two 10px gaps between the three stacked items in the left column
const mainEl = document.querySelector(".main") as HTMLElement;
const rightCol = document.querySelector(".rightcol") as HTMLElement;
const leftCol = document.querySelector(".leftcol") as HTMLElement;

function fitLayout(): void {
  const w = mainEl.clientWidth,
    h = mainEl.clientHeight;
  if (!w || !h) return;
  const side = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.min(w * 0.34, h * 0.5)));
  rightCol.style.width = `${side}px`;
  // Cap the left column. The plan + profile strips render at the isometric aspect, so their stacked height
  // is (LH+PH)/1000 × the column width — left uncapped, a wider window makes them balloon and squeeze the 3D
  // view. Cap the width at the value where the 3D view ends up as tall as the station square (= `side`),
  // which is the proportion that reads best; wider windows then center the columns instead of growing them.
  const stripAspect = (LH + PH) / 1000;
  const leftMax = Math.max(360, (h - side - LEFT_GAP) / stripAspect);
  leftCol.style.maxWidth = `${leftMax}px`;
}

// the 3D canvas fills a flex box, so reflow it on resize (mesh is cached; just redraw)
window.addEventListener("resize", () => {
  fitLayout();
  draw3d(false);
});

function reset(): void {
  resetModel();
  state.selected = null; // the old selection no longer refers to a meaningful point
  render(); // render() runs prepare() to build the sheer samplers before drawing
  refreshSelUI();
  syncTrim();
}

// ---------- waterline + deck-rake controls ----------
const wlRange = document.getElementById("wlRange") as HTMLInputElement;
const wlVal = document.getElementById("wlVal") as HTMLElement;
const rakeRange = document.getElementById("rakeRange") as HTMLInputElement;
const rakeVal = document.getElementById("rakeVal") as HTMLElement;

function syncTrim(): void {
  wlRange.value = String(state.waterline);
  wlVal.textContent = String(Math.round(state.waterline));
  const deg = (state.deckRake * 180) / Math.PI;
  rakeRange.value = String(deg);
  rakeVal.textContent = `${deg.toFixed(1)}°`;
}
wlRange.addEventListener("input", () => {
  state.waterline = parseFloat(wlRange.value);
  wlVal.textContent = String(Math.round(state.waterline));
  render();
});
rakeRange.addEventListener("input", () => {
  const deg = parseFloat(rakeRange.value);
  state.deckRake = (deg * Math.PI) / 180;
  rakeVal.textContent = `${deg.toFixed(1)}°`;
  render();
});

const toggle3d = document.getElementById("toggle3d") as HTMLButtonElement;
toggle3d.addEventListener("click", () => {
  state.view3d = state.view3d === "trimmed" ? "sheet" : "trimmed";
  toggle3d.textContent = state.view3d === "trimmed" ? "Untrimmed sheet" : "Trimmed hull";
  draw3d(true);
});

const toggleZebra = document.getElementById("toggleZebra") as HTMLButtonElement;
toggleZebra.addEventListener("click", () => {
  state.zebra = !state.zebra;
  toggleZebra.classList.toggle("on", state.zebra);
  draw3d(false);
});

document.getElementById("addBlendBtn")!.addEventListener("click", () => addBlendPoint());

document.getElementById("reset")!.addEventListener("click", reset);

const exportStep = document.getElementById("exportStep") as HTMLButtonElement;
exportStep.addEventListener("click", () => {
  try {
    downloadStep();
  } catch (e) {
    alert("STEP export failed: " + (e instanceof Error ? e.message : String(e)));
  }
});

const exportJson = document.getElementById("exportJson") as HTMLButtonElement;
exportJson.addEventListener("click", () => {
  try {
    downloadJson();
  } catch (e) {
    alert("JSON export failed: " + (e instanceof Error ? e.message : String(e)));
  }
});

const importJsonBtn = document.getElementById("importJson") as HTMLButtonElement;
importJsonBtn.addEventListener("click", () =>
  importJson(() => {
    render(); // loadHull already cleared the selection
    refreshSelUI();
    syncTrim(); // waterline / deck rake may have come from the file
  }),
);

initInteraction();
fitLayout(); // size the columns before the first render so the 3D canvas picks up its real size
reset();
