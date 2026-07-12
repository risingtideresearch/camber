// Saving the blend to the library. Mirrors the editor's save/dirty logic (editor/save.ts): the mutable
// identity (which row is open, its saved name, the last-saved JSON) is a plain value kept in a ref, and these
// functions are pure over (model, identity, working name, whether any hulls are loaded).
//
// First save creates a new design (the button reads "Save As…"). After that it reads "Save" and overwrites
// that design, flipping back to "Save As…" only when the name is changed (which forks a new one).

import type { Model } from "../core/model";
import { buildJson } from "../core/json";
import { buildPreviewSvg } from "../core/preview";
import { insertDesign, updateDesign } from "../core/supabase";

// the steady-state (non-transient) save indicator, mirrored into React
export interface SaveView {
  buttonLabel: string; // "Save" | "Save As…"
  kind: "" | "dirty" | "saved";
  text: string;
}

// what the app knows about the saved blend row
export interface BlendId {
  currentId: string | null; // the saved design's row id (null = never saved)
  savedName: string | null; // the name stored for currentId
  savedSnapshot: string; // buildJson(model) as of the last successful save
}

export const newBlendId = (): BlendId => ({
  currentId: null,
  savedName: null,
  savedSnapshot: "",
});

// would saving create a new row? (never saved, or the name was changed away from the saved design)
function willFork(id: BlendId, name: string): boolean {
  const n = name.trim();
  return id.currentId == null || (n !== "" && n !== id.savedName);
}
export function isDirty(
  model: Model,
  id: BlendId,
  name: string,
  hasHulls: boolean,
): boolean {
  if (!hasHulls) return false;
  if (id.currentId == null) return true; // never saved → always unsaved work
  return buildJson(model) !== id.savedSnapshot || name.trim() !== id.savedName;
}

// the steady save indicator for the given working title
export function saveView(
  model: Model,
  id: BlendId,
  name: string,
  hasHulls: boolean,
): SaveView {
  const buttonLabel = willFork(id, name) ? "Save As…" : "Save";
  if (!hasHulls) return { buttonLabel, kind: "", text: "" };
  return isDirty(model, id, name, hasHulls)
    ? { buttonLabel, kind: "dirty", text: "Unsaved" }
    : { buttonLabel, kind: "saved", text: "Saved" };
}

// The one save action: fork (insert a new row) when the blend was never saved or its name was changed;
// otherwise overwrite the open design. Returns the new identity + final name, or null if the user cancelled
// a create prompt. Throws on a backend failure so the caller can surface it.
export async function saveBlend(
  model: Model,
  id: BlendId,
  name: string,
  defaultName: string,
): Promise<{ id: BlendId; name: string } | null> {
  const fork = willFork(id, name);
  let finalName = name.trim();
  if (fork) {
    if (!finalName) {
      finalName = prompt("Name this blend:", defaultName)?.trim() ?? "";
      if (!finalName) return null;
    }
  } else {
    finalName = id.savedName!; // a plain overwrite keeps the existing name
  }
  const json = buildJson(model); // the blended hull is already in `model`
  const preview = buildPreviewSvg(model);
  let currentId = id.currentId;
  if (fork) currentId = await insertDesign(finalName, json, preview);
  else await updateDesign(currentId!, json, preview);
  return {
    id: { currentId, savedName: finalName, savedSnapshot: json },
    name: finalName,
  };
}
