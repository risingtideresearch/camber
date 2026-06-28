// ---------- entry point for the design library (the fullscreen file view) ----------
//
// Lists the hull designs stored in Supabase and lets you open one in the editor (editor.html?id=…), start a
// new one, import a JSON file into the library, or export the selected design as JSON / STEP. Exports reuse
// the same code paths as the editor: JSON is the stored document verbatim; STEP loads the document into the
// model and runs the STEP writer (which fairs the surfaces via prepare() internally).

import { listDesigns, insertDesign, deleteDesign, type DesignRow } from "./supabase.js";
import { parseDocument, loadJsonText } from "./json.js";
import { buildStep } from "./step.js";
import { resetModel } from "./model.js";
import { buildPreviewSvg } from "./preview.js";

// Render a design's stored 3/4 wireframe (built in the editor at save time) as a card thumbnail. Using an
// <img> with a data-URI keeps it self-contained and, crucially, script-disabled — so a preview string from
// the (openly-writable) table can't run anything. Returns a "no preview" placeholder when there's none yet.
function previewEl(preview: string | null): HTMLElement {
  if (preview) {
    const img = document.createElement("img");
    img.className = "preview";
    img.alt = "";
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(preview);
    return img;
  }
  const ph = document.createElement("div");
  ph.className = "preview noprev";
  ph.textContent = "no preview";
  return ph;
}

const gridEl = document.getElementById("grid") as HTMLElement;
const emptyEl = document.getElementById("emptyMsg") as HTMLElement;
const selNameEl = document.getElementById("selName") as HTMLElement;
const openBtn = document.getElementById("openBtn") as HTMLButtonElement;
const exportJsonBtn = document.getElementById("exportJsonBtn") as HTMLButtonElement;
const exportStepBtn = document.getElementById("exportStepBtn") as HTMLButtonElement;
const deleteBtn = document.getElementById("deleteBtn") as HTMLButtonElement;
const newBtn = document.getElementById("newDesign") as HTMLButtonElement;
const importBtn = document.getElementById("importJson") as HTMLButtonElement;

let rows: DesignRow[] = [];
let selectedId: string | null = null;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function selectedRow(): DesignRow | undefined {
  return rows.find((r) => r.id === selectedId);
}

function syncSelectionUI(): void {
  const row = selectedRow();
  selNameEl.textContent = row ? row.name : "No design selected";
  selNameEl.classList.toggle("none", !row);
  for (const b of [openBtn, exportJsonBtn, exportStepBtn, deleteBtn]) b.disabled = !row;
  for (const card of Array.from(gridEl.children) as HTMLElement[])
    card.classList.toggle("selected", card.dataset.id === selectedId);
}

function openInEditor(id: string): void {
  window.location.href = `editor.html?id=${encodeURIComponent(id)}`;
}

function renderGrid(): void {
  gridEl.textContent = "";
  for (const row of rows) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = row.id;
    card.append(previewEl(row.preview));
    const name = document.createElement("div");
    name.className = "cname";
    name.textContent = row.name;
    const date = document.createElement("div");
    date.className = "cdate";
    date.textContent = fmtDate(row.created_at);
    card.append(name, date);
    card.addEventListener("click", () => {
      selectedId = row.id;
      syncSelectionUI();
    });
    card.addEventListener("dblclick", () => openInEditor(row.id));
    gridEl.append(card);
  }
  syncSelectionUI();
}

async function refresh(): Promise<void> {
  emptyEl.style.display = "none";
  try {
    rows = await listDesigns();
  } catch (e) {
    gridEl.textContent = "";
    emptyEl.style.display = "";
    emptyEl.className = "empty err";
    emptyEl.textContent = "Failed to load designs: " + (e instanceof Error ? e.message : String(e));
    return;
  }
  if (selectedId && !rows.some((r) => r.id === selectedId)) selectedId = null;
  renderGrid();
  if (!rows.length) {
    emptyEl.style.display = "";
    emptyEl.className = "empty";
    emptyEl.textContent = "No designs yet. Create one with “+ New design”, or import a JSON file.";
  }
}

function downloadBlob(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// a filesystem-safe version of a design name for download filenames
function safeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").trim() || "hull";
}

// ---------- wiring ----------
newBtn.addEventListener("click", () => {
  window.location.href = "editor.html";
});

openBtn.addEventListener("click", () => {
  if (selectedId) openInEditor(selectedId);
});

exportJsonBtn.addEventListener("click", () => {
  const row = selectedRow();
  if (!row) return;
  try {
    // pretty-print the stored document on the way out
    downloadBlob(`${safeName(row.name)}.json`, JSON.stringify(row.document, null, 2), "application/json");
  } catch (e) {
    alert("Export JSON failed: " + (e instanceof Error ? e.message : String(e)));
  }
});

exportStepBtn.addEventListener("click", () => {
  const row = selectedRow();
  if (!row) return;
  exportStepBtn.disabled = true;
  try {
    resetModel();
    loadJsonText(JSON.stringify(row.document)); // load into the model singleton; buildStep fairs + samples it
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, "");
    downloadBlob(`${safeName(row.name)}.step`, buildStep(stamp), "application/step");
  } catch (e) {
    alert("Export STEP failed: " + (e instanceof Error ? e.message : String(e)));
  } finally {
    exportStepBtn.disabled = false;
  }
});

deleteBtn.addEventListener("click", async () => {
  const row = selectedRow();
  if (!row) return;
  if (!confirm(`Delete "${row.name}"? This cannot be undone.`)) return;
  deleteBtn.disabled = true;
  try {
    await deleteDesign(row.id);
    selectedId = null;
    await refresh();
  } catch (e) {
    alert("Delete failed: " + (e instanceof Error ? e.message : String(e)));
    deleteBtn.disabled = false;
  }
});

importBtn.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const text = String(reader.result);
      try {
        parseDocument(text); // validate before storing; throws on a malformed document
      } catch (e) {
        alert("Import failed: " + (e instanceof Error ? e.message : String(e)));
        return;
      }
      const base = file.name.replace(/\.json$/i, "");
      const name = (prompt("Save imported design as:", base) ?? "").trim();
      if (!name) return;
      // build the wireframe preview from the imported document (same path the editor uses on save)
      let preview = "";
      try {
        resetModel();
        loadJsonText(text);
        preview = buildPreviewSvg();
      } catch {
        /* leave preview empty; the card falls back to a placeholder */
      }
      try {
        const id = await insertDesign(name, text, preview);
        selectedId = id;
        await refresh();
      } catch (e) {
        alert("Import failed: " + (e instanceof Error ? e.message : String(e)));
      }
    };
    reader.readAsText(file);
  });
  input.click();
});

refresh();
