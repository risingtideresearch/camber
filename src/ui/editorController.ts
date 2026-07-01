// ---------- editorController: the imperative bridge between the React shell and the core ----------
//
// IMPORTANT — module-evaluation ordering. This module is the FIRST to statically import the
// imperative core (model / render / interaction / dom / …). `dom.ts` resolves its element
// references at module-eval time (`export const svgP = byId("svgProfile")`), so the core must not
// be imported until the React shell has mounted the DOM. `EditorApp` therefore pulls THIS module
// in via a dynamic `import()` inside its mount effect — keep every static core import confined to
// this file. The React components import only *types* from the core (erased, eval-free).
//
// What lives here is a near-verbatim lift of the app-level wiring that used to sit at the top of
// `main.ts`: boot, column fitting, the save / dirty / fork logic and the design identity. Every
// helper it calls (`buildJson`, `loadJsonText`, `getDesign`, `insertDesign`, `updateDesign`,
// `buildPreviewSvg`, `resetModel`, `render`, `draw3d`, `initInteraction`, `refreshSelUI`) is used
// exactly as before — none of the core modules change.

import { resetModel, state, type View3DMode } from "../model";
import { render, draw3d } from "../render";
import { initInteraction, refreshSelUI } from "../interaction";
import { buildJson, loadJsonText } from "../json";
import { getDesign, insertDesign, updateDesign } from "../supabase";
import { buildPreviewSvg } from "../preview";
import { svgL, svgP, svgW } from "../dom";
import { LH, PH, WH } from "../view";

// the trim/view values React mirrors after a load or revert (the model is the source of truth)
export interface TrimSnapshot {
  waterline: number; // mm below the sheer origin
  rakeDeg: number; // deck rake in degrees (state stores radians)
  mode: View3DMode;
}
export interface BootResult extends TrimSnapshot {
  name: string; // the opened design's name, or "" for a fresh/Untitled hull
}
// the steady-state (non-transient) save indicator, mirrored into React by the dirty poll
export interface SaveView {
  buttonLabel: string; // "Save" | "Save As…"
  kind: "" | "dirty" | "saved";
  text: string;
}

// ---------- design identity (mirrors main.ts) ----------
let currentId: string | null = null; // the open design's row id (null = never saved)
let savedName: string | null = null; // the name stored for currentId; the React title is the working copy
let savedSnapshot = ""; // buildJson() as of the last successful save / load

const radToDeg = (r: number): number => (r * 180) / Math.PI;
const snapshot = (): TrimSnapshot => ({
  waterline: state.waterline,
  rakeDeg: radToDeg(state.deckRake),
  mode: state.view3dMode,
});

function markSaved(): void {
  savedSnapshot = buildJson();
}

export function isDirty(): boolean {
  return buildJson() !== savedSnapshot;
}
// would saving create a new row? (the working title was changed away from the saved design's name)
export function isFork(name: string): boolean {
  return currentId != null && name.trim() !== "" && name.trim() !== savedName;
}
// anything unsaved: edited geometry, or a renamed existing design
export function isUnsaved(name: string): boolean {
  return isDirty() || isFork(name);
}
// the saved design's name (for restoring a blanked title — a name is required to save)
export function savedDesignName(): string | null {
  return savedName;
}

// the steady save indicator for the given working title (the dirty poll calls this each tick)
export function saveView(name: string): SaveView {
  const buttonLabel = isFork(name) ? "Save As…" : "Save";
  if (currentId == null) {
    const dirty = isDirty();
    return {
      buttonLabel,
      kind: dirty ? "dirty" : "",
      text: dirty ? "Unsaved" : "Not saved",
    };
  }
  if (isUnsaved(name))
    return { buttonLabel, kind: "dirty", text: "Unsaved changes" };
  return { buttonLabel, kind: "saved", text: "Saved" };
}

// ---------- trim / view edits (mutate the model, then redraw) ----------
export function setWaterline(mm: number): void {
  state.waterline = mm;
  render();
}
export function setDeckRake(deg: number): void {
  state.deckRake = (deg * Math.PI) / 180;
  render();
}
export function setView3dMode(mode: View3DMode): void {
  state.view3dMode = mode;
  draw3d(true); // rebuild for the new mode (mesh vs lines grid vs sheet)
}

// ---------- column fitting (lifted verbatim from main.ts) ----------
// The right column's width IS each panel's side: both the section editor and the cut station are
// squares that fill that width, stacked vertically. Pick a width that is a sensible fraction of the
// main area but never taller (as a square) than ~0.42 of its height, and never wider than MAX_SIDE.
const MIN_SIDE = 200,
  MAX_SIDE = 420,
  LEFT_GAP = 30; // the three 10px gaps between the four stacked items (3D, blend, plan, profile)

export function fitLayout(): void {
  const mainEl = document.querySelector(".main") as HTMLElement | null;
  const rightCol = document.querySelector(".rightcol") as HTMLElement | null;
  const leftCol = document.querySelector(".leftcol") as HTMLElement | null;
  if (!mainEl || !rightCol || !leftCol) return;
  const w = mainEl.clientWidth,
    h = mainEl.clientHeight;
  if (!w || !h) return;
  const side = Math.max(
    MIN_SIDE,
    Math.min(MAX_SIDE, Math.min(w * 0.34, h * 0.42)),
  );
  rightCol.style.width = `${side}px`;
  const stripAspect = (WH + LH + PH) / 1000;
  const leftMax = Math.max(360, (h - side - LEFT_GAP) / stripAspect);
  leftCol.style.maxWidth = `${leftMax}px`;
}

// resize: reflow the columns, then redraw the (cached-mesh) 3D canvas at its new size
export function handleResize(): void {
  fitLayout();
  draw3d(false);
}

// ---------- boot: wire interaction, size the columns, load the URL design, first render ----------
export async function boot(): Promise<BootResult> {
  initInteraction();
  // the plan / profile / blend strips are sized to the isometric scale (see view.ts); set their
  // viewBox heights from the derived constants so the SVG aspect matches the to-scale drawing.
  svgL.setAttribute("viewBox", `0 0 1000 ${LH}`);
  svgP.setAttribute("viewBox", `0 0 1000 ${PH}`);
  svgW.setAttribute("viewBox", `0 0 1000 ${WH}`);
  fitLayout(); // size the columns before the first render so the 3D canvas picks up its real size

  // Build the default model first: it initializes state.sheer (null until now) and the template /
  // weight arrays that loadHull writes into. An opened design is then loaded over this baseline.
  resetModel();

  const id = new URLSearchParams(window.location.search).get("id");
  let name = "";
  if (id) {
    try {
      const opened = await getDesign(id);
      loadJsonText(opened.documentText);
      currentId = id;
      savedName = opened.name;
      name = opened.name;
    } catch (e) {
      console.error("open design failed:", e);
      alert(
        "Couldn't open that design: " +
          (e instanceof Error ? e.message : String(e)),
      );
      resetModel(); // discard any partial load; fall back to a clean default hull
      currentId = null;
      savedName = null;
    }
  } else {
    currentId = null;
    savedName = null;
  }

  // first render (mirrors main.ts redraw(): drop any stale selection, render, refresh the readouts)
  state.selected = null;
  render();
  refreshSelUI();
  markSaved();
  return { name, ...snapshot() };
}

// Revert: discard edits since the last save/open by reloading the saved snapshot. Returns the
// reverted trim/view values for React to mirror, or null if there was nothing to revert.
export function revert(): TrimSnapshot | null {
  if (!isDirty()) return null;
  if (!confirm("Discard changes since the last save?")) return null;
  loadJsonText(savedSnapshot);
  state.selected = null;
  render();
  refreshSelUI();
  return snapshot();
}

// The one save action: overwrite the open design, or — if the name was changed (fork) or it was
// never saved (create) — insert a new row and re-point the editor at it. Returns the final name
// (which may differ from the input when a create prompts for one), or null if the user cancelled.
// Throws on a backend failure so the caller can surface it.
export async function save(name: string): Promise<{ name: string } | null> {
  const create = currentId == null;
  const fork = isFork(name);
  let finalName = name.trim();
  if (create && !finalName) {
    finalName = prompt("Name this design:", "")?.trim() ?? "";
    if (!finalName) return null; // a name is required to create
  }
  if (!create && !fork) finalName = savedName!; // a plain overwrite keeps the existing name

  const json = buildJson();
  const preview = buildPreviewSvg(); // a 3/4 wireframe stored with the design for the file view
  if (create || fork) {
    const newId = await insertDesign(finalName, json, preview);
    currentId = newId;
    history.replaceState(
      null,
      "",
      `editor.html?id=${encodeURIComponent(newId)}`,
    );
  } else {
    await updateDesign(currentId!, json, preview);
  }
  savedName = finalName;
  markSaved();
  return { name: finalName };
}
