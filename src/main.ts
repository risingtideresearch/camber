// ---------- entry point: wire the app-level controls and do the first render ----------

import { resetModel, state } from "./model.js";
import { render, draw3d } from "./render.js";
import { initInteraction, refreshSelUI } from "./interaction.js";
import { downloadStep } from "./step.js";
import { downloadJson, importJson } from "./json.js";
import { svgL, svgP } from "./dom.js";
import { LH, PH } from "./view.js";

// the plan / profile panels are sized to the isometric scale (see view.ts); set their viewBox heights
// from the derived constants so the SVG aspect matches the to-scale drawing (no stretching).
svgL.setAttribute("viewBox", `0 0 1000 ${LH}`);
svgP.setAttribute("viewBox", `0 0 1000 ${PH}`);

// the 3D canvas fills a viewport-relative box now, so reflow it on resize (mesh is cached; just redraw)
window.addEventListener("resize", () => draw3d(false));

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
reset();
