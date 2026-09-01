// Window-side save presentation and browser confirmation helpers.

import type { SessionDocument } from "../core/sessionDocument";
import type { SessionMeta } from "../core/meta";

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

export function revertTo(
  dirty: boolean,
  meta: SessionMeta,
): SessionDocument | null {
  if (!dirty || !meta.design.savedState) return null;
  if (!confirm("Discard changes since the last save?")) return null;
  return meta.design.savedState;
}
