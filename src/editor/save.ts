// Window-side save UI helpers. Backend save execution and design identity belong to the shared owner; this
// module retains only the browser interactions (open, confirm, and presentation) that a worker cannot do.

import type { HullState } from "../core/hull";
import type { SessionMeta } from "../core/meta";
import { VERSION, documentVersion } from "../core/document";
import { parseHullState } from "../core/json";
import { getDesign } from "../core/supabase";

export interface SaveView {
  buttonLabel: string;
  kind: "" | "dirty" | "saved";
  text: string;
}

export function isFork(meta: SessionMeta): boolean {
  return (
    meta.design.currentId != null &&
    meta.name.trim() !== "" &&
    meta.name.trim() !== meta.design.savedName
  );
}

export function isUnsaved(dirty: boolean, meta: SessionMeta): boolean {
  return dirty || isFork(meta);
}

export function saveView(dirty: boolean, meta: SessionMeta): SaveView {
  const buttonLabel = isFork(meta) ? "Save As…" : "Save";
  if (meta.design.currentId == null)
    return {
      buttonLabel,
      kind: dirty ? "dirty" : "",
      text: dirty ? "Unsaved" : "Not saved",
    };
  if (isUnsaved(dirty, meta))
    return { buttonLabel, kind: "dirty", text: "Unsaved changes" };
  return { buttonLabel, kind: "saved", text: "Saved" };
}

export const openedName = (name: string, version: number): string =>
  version < VERSION ? `${name} converted to v${VERSION}` : name;

export async function openDesign(rowId: string): Promise<{
  state: HullState;
  name: string;
  version: number;
}> {
  const opened = await getDesign(rowId);
  const version = documentVersion(JSON.parse(opened.documentText));
  const state = parseHullState(opened.documentText);
  return { state, name: opened.name, version };
}

export function revertTo(dirty: boolean, meta: SessionMeta): HullState | null {
  if (!dirty || !meta.design.savedState) return null;
  if (!confirm("Discard changes since the last save?")) return null;
  return meta.design.savedState;
}
