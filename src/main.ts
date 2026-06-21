// ---------- entry point: wire the app-level controls and do the first render ----------

import { resetModel, state } from "./model.js";
import { render, draw3d } from "./render.js";
import { initInteraction, refreshSelUI } from "./interaction.js";
import { downloadStep } from "./step.js";
import { downloadJson, importJson } from "./json.js";

function reset(): void {
  resetModel();
  state.selected = null; // the old selection no longer refers to a meaningful point
  render(); // render() runs prepare() to build the sheer samplers before drawing
  refreshSelUI();
}

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
  }),
);

initInteraction();
reset();
