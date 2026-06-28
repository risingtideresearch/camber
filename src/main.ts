// ---------- entry point: wire the app-level controls and do the first render ----------

import { resetModel, state } from "./model.js";
import { render, draw3d } from "./render.js";
import { initInteraction, refreshSelUI, addBlendPoint } from "./interaction.js";
import { buildJson, loadJsonText } from "./json.js";
import { getDesign, insertDesign, updateDesign } from "./supabase.js";
import { buildPreviewSvg } from "./preview.js";
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

// re-render the editor from the current model state (after a load / revert)
function redraw(): void {
  state.selected = null; // any prior selection no longer refers to a meaningful point
  render(); // render() runs prepare() to build the sheer samplers before drawing
  refreshSelUI();
  syncTrim();
  updateDirty();
}

// Revert: discard edits since the last save/open by reloading the saved snapshot. For a never-saved design
// (New), the snapshot is the default hull, so Revert returns to that starting point.
function revert(): void {
  if (!isDirty()) return;
  if (!confirm("Discard changes since the last save?")) return;
  loadJsonText(savedSnapshot);
  redraw();
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
  updateDirty();
});
rakeRange.addEventListener("input", () => {
  const deg = parseFloat(rakeRange.value);
  state.deckRake = (deg * Math.PI) / 180;
  rakeVal.textContent = `${deg.toFixed(1)}°`;
  render();
  updateDirty();
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

const toggleLines = document.getElementById("toggleLines") as HTMLButtonElement;
toggleLines.addEventListener("click", () => {
  state.lineArt = !state.lineArt;
  toggleLines.classList.toggle("on", state.lineArt);
  draw3d(true); // build the wireframe grid (or restore the shaded surface)
});

document.getElementById("addBlendBtn")!.addEventListener("click", () => {
  addBlendPoint();
  updateDirty();
});

document.getElementById("revertDesign")!.addEventListener("click", revert);

// ---------- the open design: identity, name, and save state ----------
// The editor opens one design (editor.html?id=<uuid>). A single button does both roles: it reads "Save" while
// the title still matches the saved design (overwrite that row), and flips to "Save As…" once you change the
// name (insert a new row under the new name, leaving the original intact). Dirtiness is a snapshot compare of
// buildJson() at the last save/load — accurate no matter which edit path touched the model; a poll keeps the
// UI in sync since interaction.ts handles drags at the window level.
const docNameEl = document.getElementById("docName") as HTMLInputElement;
const saveStateEl = document.getElementById("saveState") as HTMLElement;
const saveBtn = document.getElementById("saveDesign") as HTMLButtonElement;
const toFilesBtn = document.getElementById("toFiles") as HTMLButtonElement;

let currentId: string | null = null; // the open design's row id (null = never saved)
let savedName: string | null = null; // the name stored for currentId; the title field is the working copy
let savedSnapshot = ""; // buildJson() as of the last successful save/load
let savingNow = false; // true while a Save request is in flight
let flashUntil = 0; // keep a transient "Saved ✓" on screen until this timestamp (ms)

function workingName(): string {
  return docNameEl.value.trim();
}
function setDocName(name: string): void {
  docNameEl.value = name;
  document.title = `${name || "Untitled"} — Camber`;
}
function isDirty(): boolean {
  return buildJson() !== savedSnapshot;
}
// would clicking the button create a new row (the title was changed away from the saved design's name)?
function isFork(): boolean {
  return currentId != null && workingName() !== "" && workingName() !== savedName;
}
// anything unsaved: edited geometry, or a renamed existing design
function unsaved(): boolean {
  return isDirty() || isFork();
}
function markSaved(): void {
  savedSnapshot = buildJson();
  updateDirty();
}
function setSaveState(kind: "" | "dirty" | "saved", text: string): void {
  saveStateEl.className = "savestate" + (kind ? " " + kind : "");
  saveStateEl.textContent = text;
  docNameEl.classList.toggle("dirty", kind === "dirty");
}
// reflect the current state in the button label + status text. Driven by a poll (below) so it stays accurate
// no matter how the model changed — interaction.ts handles drags at the window level, out of our reach.
function updateDirty(): void {
  saveBtn.textContent = isFork() ? "Save As…" : "Save";
  if (savingNow || Date.now() < flashUntil) return; // don't stomp "Saving…" / "Saved ✓"
  if (currentId == null) setSaveState(isDirty() ? "dirty" : "", isDirty() ? "Unsaved" : "Not saved");
  else if (unsaved()) setSaveState("dirty", "Unsaved changes");
  else setSaveState("saved", "Saved");
}
setInterval(updateDirty, 300);

// typing in the title switches the button between Save / Save As live; blanking it on an existing design
// restores the saved name (a name is required to save)
docNameEl.addEventListener("input", updateDirty);
docNameEl.addEventListener("change", () => {
  if (!workingName() && savedName != null) setDocName(savedName);
  updateDirty();
});

// flash a transient confirmation, then let the poll fall back to the steady "Saved" state
function flashSaved(): void {
  flashUntil = Date.now() + 1400;
  setSaveState("saved", "Saved ✓");
}

// The one save action: overwrite the open design, or — if the name was changed (fork) or it was never saved
// (create) — insert a new row and re-point the editor at it.
async function doSave(): Promise<void> {
  if (savingNow) return;
  const create = currentId == null;
  const fork = isFork();
  let name = workingName();
  if (create && !name) {
    name = prompt("Name this design:", "")?.trim() ?? "";
    if (!name) return; // a name is required to create
  }
  if (!create && !fork) name = savedName!; // a plain overwrite keeps the existing name

  savingNow = true;
  saveBtn.disabled = true;
  flashUntil = 0;
  setSaveState("", "Saving…");
  try {
    const json = buildJson();
    const preview = buildPreviewSvg(); // a 3/4 wireframe stored with the design for the file view
    if (create || fork) {
      const id = await insertDesign(name, json, preview);
      currentId = id;
      history.replaceState(null, "", `editor.html?id=${encodeURIComponent(id)}`);
    } else {
      await updateDesign(currentId!, json, preview);
    }
    savedName = name;
    setDocName(name);
    markSaved();
    flashSaved();
  } catch (e) {
    setSaveState("dirty", "Save failed");
    alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
  } finally {
    savingNow = false;
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", doSave);
toFilesBtn.addEventListener("click", () => {
  if (unsaved() && !confirm("Discard unsaved changes and return to the library?")) return;
  window.location.href = "index.html";
});
// Ctrl/Cmd-S saves the open design
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    doSave();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (unsaved()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---------- boot: load the design named in the URL, or start from the default model ----------
// Only the fetch + parse can legitimately fail (bad id, network, malformed document); those get the
// "couldn't open" alert. Rendering happens once, afterward and outside the try, so a render hiccup can't
// masquerade as an open failure (the earlier bug: a spurious "cannot open" while the design loaded anyway).
async function boot(): Promise<void> {
  initInteraction();
  fitLayout(); // size the columns before the first render so the 3D canvas picks up its real size

  // Build the default model first: it initializes state.sheer (null until now) and the template/weight arrays
  // that loadHull writes into. An opened design is then loaded over this baseline.
  resetModel();

  const id = new URLSearchParams(window.location.search).get("id");
  let opened = false;
  if (id) {
    try {
      const { name, documentText } = await getDesign(id);
      loadJsonText(documentText);
      currentId = id;
      savedName = name;
      setDocName(name);
      opened = true;
    } catch (e) {
      console.error("open design failed:", e);
      alert("Couldn't open that design: " + (e instanceof Error ? e.message : String(e)));
      resetModel(); // discard any partial load; fall back to a clean default hull
    }
  }
  if (!opened) {
    currentId = null;
    savedName = null;
    docNameEl.value = ""; // show the muted "Untitled" placeholder; the user types a real name
  }
  redraw();
  markSaved();
}

boot();
