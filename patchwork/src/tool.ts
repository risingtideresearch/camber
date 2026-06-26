// ---------- the camber-hull tool ----------
//
// Mounts the full camber editor inside the tool element and binds it two-way to an Automerge document.
// The editor is a vanilla-DOM app driven by a module-level singleton, so the tool: (1) injects the editor
// scaffold + scoped styles into its element, (2) starts the editor against the document's current hull,
// (3) writes the editor's serialized hull back on every local edit, and (4) reloads the editor when the
// document changes remotely. Because the editor uses a global model, only one camber tool can be live on
// a page at a time.

import { startEditor, type CamberEditor } from "../../src/app.js";
import { SCAFFOLD_HTML } from "./scaffold.js";
import { CAMBER_CSS } from "./styles.js";
import type { ToolRender } from "./patchwork-types.js";
import type { CamberHullDoc } from "./types.js";

// The `HullDocument` fields the editor reads/writes (everything on the doc except Patchwork metadata and
// title). Serialized to a string so it can be compared against the editor's own `buildJson()` output.
function docToHullJson(doc: CamberHullDoc): string {
  return JSON.stringify({
    length: doc.length,
    waterline: doc.waterline,
    deckRakeDeg: doc.deckRakeDeg,
    topology: doc.topology,
    variants: doc.variants,
  });
}

// A document only has a loadable hull once the datatype's `init` has populated it.
function hasHull(doc: CamberHullDoc | undefined): doc is CamberHullDoc {
  return !!doc && !!doc.topology && Array.isArray(doc.variants) && doc.variants.length > 0;
}

// Order-independent comparison of two hull JSON strings. The editor's `buildJson()` and `docToHullJson()`
// emit the same data with different key orders, so a canonical (recursively key-sorted) form is used to
// decide whether an incoming change is really just our own write echoed back — which breaks the
// edit -> write -> change-event -> reload feedback loop.
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

  // The hull JSON last loaded from / written to the document, in canonical form — the dedupe key for
  // both directions of sync.
  let lastSynced = "";
  // True while we are applying a remote change, so the resulting render doesn't echo straight back out.
  let applyingRemote = false;

  // Write the given hull JSON into the document. Camber re-serializes the whole `HullDocument` on each
  // edit, so this assigns the fields wholesale.
  function writeToDoc(json: string): void {
    lastSynced = canonical(json);
    const parsed = JSON.parse(json) as Omit<CamberHullDoc, "@patchwork" | "title">;
    handle.change((d) => {
      d.length = parsed.length;
      d.waterline = parsed.waterline;
      d.deckRakeDeg = parsed.deckRakeDeg;
      d.topology = parsed.topology;
      d.variants = parsed.variants;
    });
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
  const initialJson = hasHull(initialDoc) ? docToHullJson(initialDoc) : undefined;
  if (initialJson !== undefined) lastSynced = canonical(initialJson);

  const editor: CamberEditor = startEditor({
    styleRoot: container,
    initialJson,
    onChange: (json) => {
      if (applyingRemote) return;
      scheduleWrite(json);
    },
  });

  // If the document had no hull yet (e.g. opened on a bare doc), seed it from the editor's default so it
  // becomes a valid camber-hull document.
  if (initialJson === undefined) writeToDoc(editor.getJson());

  const onRemoteChange = (): void => {
    const doc = handle.doc();
    if (!hasHull(doc)) return;
    const incoming = docToHullJson(doc);
    if (sameHull(incoming, lastSynced)) return; // our own write echoed back, or no real change
    lastSynced = canonical(incoming);
    applyingRemote = true;
    try {
      editor.loadJson(incoming);
    } finally {
      applyingRemote = false;
    }
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
