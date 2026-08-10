// Design identity + the save / revert / dirty logic. The mutable identity (which row is open, its saved name,
// the document as of that save) is a plain value the editor keeps in a ref, and these functions are pure over
// (identity, working name, dirty).
//
// Dirtiness is no longer measured here. It is `revision !== savedRevision` on the store's snapshot — exact,
// and free — where it used to be a `buildJson` string comparison run on a 300 ms poll. What is still kept is
// the saved DOCUMENT, because Revert has to restore it and a revision number cannot be un-parsed into a hull.

import type { HullState } from "../core/hull";
import type { Model } from "../core/model";
import { VERSION, documentVersion } from "../core/document";
import { buildJson, parseHullState } from "../core/json";
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
  savedDocument: string; // the document as of the last successful save / load — what Revert restores
}

export const newDesignId = (): DesignId => ({
  currentId: null,
  savedName: null,
  savedDocument: "",
});

// would saving create a new row? (the working title was changed away from the saved design's name)
export function isFork(id: DesignId, name: string): boolean {
  return (
    id.currentId != null && name.trim() !== "" && name.trim() !== id.savedName
  );
}
// anything unsaved: edited geometry, or a renamed existing design
export function isUnsaved(dirty: boolean, id: DesignId, name: string): boolean {
  return dirty || isFork(id, name);
}

// the steady save indicator for the given working title
export function saveView(dirty: boolean, id: DesignId, name: string): SaveView {
  const buttonLabel = isFork(id, name) ? "Save As…" : "Save";
  if (id.currentId == null)
    return {
      buttonLabel,
      kind: dirty ? "dirty" : "",
      text: dirty ? "Unsaved" : "Not saved",
    };
  if (isUnsaved(dirty, id, name))
    return { buttonLabel, kind: "dirty", text: "Unsaved changes" };
  return { buttonLabel, kind: "saved", text: "Saved" };
}

// The title a design opens under. A document older than VERSION is CONVERTED as it loads (this build only
// writes VERSION), so it opens under a converted name: that makes the editor a fork from the start, and the
// one save action inserts a new row instead of overwriting — the original stays in the library as it was.
export const openedName = (name: string, version: number): string =>
  version < VERSION ? `${name} converted to v${VERSION}` : name;

/**
 * Read the design with the given row id. It comes back as authored state for the caller to install through
 * the store, along with its stored name, the format version its document declares, and the document text
 * itself (which Revert will want). Throws on failure.
 */
export async function openDesign(rowId: string): Promise<{
  state: HullState;
  name: string;
  version: number;
  document: string;
}> {
  const opened = await getDesign(rowId);
  // read the version off the stored document before parsing converts it away
  const version = documentVersion(JSON.parse(opened.documentText));
  const state = parseHullState(opened.documentText);
  // The document kept for Revert is what this build WRITES, not what it read: a v1 document opens converted,
  // and reverting to the file on disk would undo the conversion along with the edits.
  return { state, name: opened.name, version, document: buildJson(state) };
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
    id: { currentId, savedName: finalName, savedDocument: json },
    name: finalName,
  };
}

/**
 * Revert: the hull to install to discard every edit since the last save or open, or null when there is
 * nothing to revert or the user declined. Installing it is the caller's job — one `installHull` command,
 * which means Revert is itself undoable.
 */
export function revertTo(dirty: boolean, id: DesignId): HullState | null {
  if (!dirty || !id.savedDocument) return null;
  if (!confirm("Discard changes since the last save?")) return null;
  return parseHullState(id.savedDocument);
}
