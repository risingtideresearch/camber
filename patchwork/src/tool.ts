// ---------- the camber-hull tool ----------
//
// Mounts the full camber editor inside the tool element and binds it two-way to one variant of an
// Automerge document. The editor is a vanilla-DOM app driven by a module-level singleton, so the tool:
// (1) injects the editor scaffold + scoped styles, (2) starts the editor against the document's variant,
// (3) reconciles the editor's edits field-by-field into the document (so concurrent edits merge rather
// than clobber), and (4) applies remote changes back into the editor. Because the editor uses a global
// model, only one camber tool can be live on a page at a time.
//
// The document is the canonical representation: every control-point field is its own Automerge value
// (see reconcile.ts), the editor's `state` is just the decoded working copy kept in step with it.

import { startEditor, type CamberEditor } from "../../src/app.js";
import { SCAFFOLD_HTML } from "./scaffold.js";
import { CAMBER_CSS } from "./styles.js";
import { isStructured, reconcileDoc, seedDoc, type HullFields } from "./reconcile.js";
import type { ToolRender } from "./patchwork-types.js";
import type { CamberHullDoc } from "./types.js";

// Which variant of the document this editor instance edits. (Authoring multiple variants and blending
// them is a separate surface; this editor binds to one — the others are preserved untouched.)
const EDIT_INDEX = 0;

// The slice of the document this editor mirrors, serialized in the exact shape the editor's `buildJson()`
// produces (a single-variant `HullDocument`), so the two can be compared for echo suppression and fed
// straight back into the editor. Other variants are deliberately excluded.
function docSliceJson(doc: CamberHullDoc, index: number): string {
  const v = doc.variants[index];
  return JSON.stringify({
    length: doc.length,
    waterline: doc.waterline,
    deckRakeDeg: doc.deckRakeDeg,
    topology: doc.topology,
    variants: [
      {
        sheerPlan: v.sheerPlan,
        sheerTrim: v.sheerTrim,
        transom: v.transom,
        templates: v.templates,
        keelK: v.keelK,
        weights: v.weights,
      },
    ],
  });
}

// A document has an editable variant once the datatype's `init` (or a peer) has populated it.
function hasVariant(doc: CamberHullDoc | undefined, index: number): doc is CamberHullDoc {
  return (
    !!doc &&
    !!doc.topology &&
    Array.isArray(doc.variants) &&
    !!doc.variants[index] &&
    Array.isArray(doc.variants[index].sheerPlan)
  );
}

// Order-independent comparison of two hull JSON strings: the editor's `buildJson()` and `docSliceJson()`
// emit the same data with different key orders, so a canonical (recursively key-sorted) form decides
// whether an incoming change is just our own write echoed back — breaking the write -> change-event ->
// reload feedback loop.
function canonical(json: string): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort(o[k]);
          return acc;
        }, {});
    }
    return v;
  };
  try {
    return JSON.stringify(sort(JSON.parse(json)));
  } catch {
    return json;
  }
}

function sameHull(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

export const CamberHullTool: ToolRender<CamberHullDoc> = (handle, element) => {
  const style = document.createElement("style");
  style.textContent = CAMBER_CSS;
  element.appendChild(style);

  const container = document.createElement("div");
  container.className = "camber-app";
  container.innerHTML = SCAFFOLD_HTML;
  element.appendChild(container);

  // The editor's variant slice last loaded from / written to the document, in canonical form — the dedupe
  // key for both directions of sync.
  let lastSynced = "";
  // True while applying a remote change, so the resulting render doesn't echo straight back out.
  let applyingRemote = false;

  // Reconcile the editor's serialized hull into the document, writing only the leaves that changed.
  function writeToDoc(json: string): void {
    const parsed = JSON.parse(json) as HullFields;
    handle.change((d) => {
      if (isStructured(d, EDIT_INDEX)) reconcileDoc(d, parsed, EDIT_INDEX);
      else seedDoc(d, parsed, EDIT_INDEX);
    });
    // Read back what the document now holds for this variant so `lastSynced` matches the change event the
    // write just queued (and so any fields the doc normalized are reflected).
    const doc = handle.doc();
    lastSynced = doc ? canonical(docSliceJson(doc, EDIT_INDEX)) : canonical(json);
  }

  // The editor renders (and so reports a change) on every pointer-move during a drag; debounce the writes
  // so a drag becomes a handful of document changes rather than one per move. The latest edit is always
  // flushed (on the timer, and on unmount) so nothing is lost.
  const WRITE_DEBOUNCE_MS = 120;
  let pendingJson: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function flushWrite(): void {
    flushTimer = null;
    const json = pendingJson;
    pendingJson = null;
    if (json === null || sameHull(json, lastSynced)) return;
    writeToDoc(json);
  }
  function scheduleWrite(json: string): void {
    if (sameHull(json, lastSynced)) return; // no meaningful change vs. the document
    pendingJson = json;
    if (flushTimer === null) flushTimer = setTimeout(flushWrite, WRITE_DEBOUNCE_MS);
  }

  const initialDoc = handle.doc();
  const initialJson = hasVariant(initialDoc, EDIT_INDEX)
    ? docSliceJson(initialDoc, EDIT_INDEX)
    : undefined;
  if (initialJson !== undefined) lastSynced = canonical(initialJson);

  const editor: CamberEditor = startEditor({
    styleRoot: container,
    initialJson,
    onChange: (json) => {
      if (applyingRemote) return;
      scheduleWrite(json);
    },
  });

  // If the document had no editable variant yet (e.g. opened on a bare doc), seed it from the editor's
  // default so it becomes a valid camber-hull document.
  if (initialJson === undefined) writeToDoc(editor.getJson());

  const onRemoteChange = (): void => {
    const doc = handle.doc();
    if (!hasVariant(doc, EDIT_INDEX)) return;
    const incoming = docSliceJson(doc, EDIT_INDEX);
    if (sameHull(incoming, lastSynced)) return; // our own write echoed back, or no change to this variant
    applyingRemote = true;
    const ok = editor.applyRemote(incoming);
    applyingRemote = false;
    // Only advance the dedupe key once the editor actually took the change; a transiently inconsistent
    // mid-merge document is skipped and retried on the next change event.
    if (ok) lastSynced = canonical(incoming);
  };
  handle.on("change", onRemoteChange);

  return () => {
    handle.off("change", onRemoteChange);
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushWrite(); // persist any edit still pending in the debounce window
    editor.destroy();
    container.remove();
    style.remove();
  };
};
