// ---------- entry point: wire the app-level controls and do the first render ----------

import { resetModel, state } from "./model.js";
import { render, draw3d } from "./render.js";
import { initInteraction } from "./interaction.js";

function reset(): void {
  resetModel();
  render(); // render() runs prepare() to build the sheer samplers before drawing
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

initInteraction();
reset();
