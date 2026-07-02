// Design identity + the save / revert / dirty logic. The mutable identity (which row is open, its saved
// name, the last-saved JSON snapshot) is a plain value the editor keeps in a ref, and these functions are
// pure over (model, identity, working name).

import type { Model } from "../core/model";
import { buildJson, loadJsonText } from "../core/json";
import { buildPreviewSvg } from "../core/preview";
import { getDesign, insertDesign, updateDesign } from "../core/supabase";

// the steady-state (non-transient) save indicator, mirrored into React
export interface SaveView {
  buttonLabel: string; // "Save" | "Save As…"
  kind: "" | "dirty" | "saved";
  text: string;
}

// what the editor knows about the open design row
export interface DesignId {
  currentId: string | null; // the open design's row id (null = never saved)
  savedName: string | null; // the name stored for currentId; the working title is the editable copy
  savedSnapshot: string; // buildJson(model) as of the last successful save / load
}

export const newDesignId = (): DesignId => ({
  currentId: null,
  savedName: null,
  savedSnapshot: "",
});

export function isDirty(model: Model, id: DesignId): boolean {
  return buildJson(model) !== id.savedSnapshot;
}
// would saving create a new row? (the working title was changed away from the saved design's name)
export function isFork(id: DesignId, name: string): boolean {
  return (
    id.currentId != null && name.trim() !== "" && name.trim() !== id.savedName
  );
}
// anything unsaved: edited geometry, or a renamed existing design
export function isUnsaved(model: Model, id: DesignId, name: string): boolean {
  return isDirty(model, id) || isFork(id, name);
}

// the steady save indicator for the given working title
export function saveView(model: Model, id: DesignId, name: string): SaveView {
  const buttonLabel = isFork(id, name) ? "Save As…" : "Save";
  if (id.currentId == null) {
    const dirty = isDirty(model, id);
    return {
      buttonLabel,
      kind: dirty ? "dirty" : "",
      text: dirty ? "Unsaved" : "Not saved",
    };
  }
  if (isUnsaved(model, id, name))
    return { buttonLabel, kind: "dirty", text: "Unsaved changes" };
  return { buttonLabel, kind: "saved", text: "Saved" };
}

// open the design with the given row id into the model; returns its name. Throws on failure.
export async function openDesign(model: Model, rowId: string): Promise<string> {
  const opened = await getDesign(rowId);
  loadJsonText(model, opened.documentText);
  return opened.name;
}

// The one save action: overwrite the open design, or — if the name was changed (fork) or it was never saved
// (create) — insert a new row and re-point the editor at it. Returns the new identity + final name (which may
// differ from the input when a create prompts for one), or null if the user cancelled. Throws on a backend
// failure so the caller can surface it.
export async function saveDesign(
  model: Model,
  id: DesignId,
  name: string,
): Promise<{ id: DesignId; name: string } | null> {
  const create = id.currentId == null;
  const fork = isFork(id, name);
  let finalName = name.trim();
  if (create && !finalName) {
    finalName = prompt("Name this design:", "")?.trim() ?? "";
    if (!finalName) return null; // a name is required to create
  }
  if (!create && !fork) finalName = id.savedName!; // a plain overwrite keeps the existing name

  const json = buildJson(model);
  const preview = buildPreviewSvg(model); // a 3/4 wireframe stored with the design for the file view
  let currentId = id.currentId;
  if (create || fork) {
    currentId = await insertDesign(finalName, json, preview);
    history.replaceState(
      null,
      "",
      `editor.html?id=${encodeURIComponent(currentId)}`,
    );
  } else {
    await updateDesign(currentId!, json, preview);
  }
  return {
    id: { currentId, savedName: finalName, savedSnapshot: json },
    name: finalName,
  };
}

// Revert: discard edits since the last save/open by reloading the saved snapshot into the model. Returns
// true if it reverted, false if there was nothing to revert or the user cancelled.
export function revert(model: Model, id: DesignId): boolean {
  if (!isDirty(model, id)) return false;
  if (!confirm("Discard changes since the last save?")) return false;
  loadJsonText(model, id.savedSnapshot);
  return true;
}
