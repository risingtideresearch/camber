// ---------- entry point for the design library (the fullscreen file view) ----------
//
// Lists the hull designs stored in Supabase and lets you open one in the editor (editor.html?id=…), start a
// new one, import a JSON file into the library, or export the selected design as JSON / STEP / STL. Exports
// reuse the same code paths as the editor: JSON is the stored document verbatim; STEP and STL load the
// document into the model and run their writers (which fair the surfaces via prepare() internally).

import { listDesigns, insertDesign, deleteDesign, type DesignRow } from "./supabase.js";
import { parseDocument, loadJsonText } from "./json.js";
import { buildStep } from "./step.js";
import { buildStl } from "./stl.js";
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

const fileappEl = document.querySelector(".fileapp") as HTMLElement;
const gridEl = document.getElementById("grid") as HTMLElement;
const emptyEl = document.getElementById("emptyMsg") as HTMLElement;
const selToolbar = document.getElementById("selToolbar") as HTMLElement;
const selNameEl = document.getElementById("selName") as HTMLElement;
const blendBtn = document.getElementById("blendBtn") as HTMLButtonElement;
const openBtn = document.getElementById("openBtn") as HTMLButtonElement;
const exportJsonBtn = document.getElementById("exportJsonBtn") as HTMLButtonElement;
const exportStepBtn = document.getElementById("exportStepBtn") as HTMLButtonElement;
const exportStlBtn = document.getElementById("exportStlBtn") as HTMLButtonElement;
const deleteBtn = document.getElementById("deleteBtn") as HTMLButtonElement;
const newBtn = document.getElementById("newDesign") as HTMLButtonElement;
const importBtn = document.getElementById("importJson") as HTMLButtonElement;
const blendBar = document.getElementById("blendBar") as HTMLElement;
const blendInfo = document.getElementById("blendInfo") as HTMLElement;
const blendOpenBtn = document.getElementById("blendOpen") as HTMLButtonElement;
const blendCancelBtn = document.getElementById("blendCancel") as HTMLButtonElement;

let rows: DesignRow[] = [];
let selectedId: string | null = null;

// blend mode: pick a base design's compatible family, then open them in the interpolation viewer
let blendMode = false;
let blendSig: string | null = null; // the topology signature being blended
const blendSel = new Set<string>(); // ids chosen for the blend

const topoById = new Map<string, Topo | null>(); // recomputed each render

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function selectedRow(): DesignRow | undefined {
  return rows.find((r) => r.id === selectedId);
}

// is this design blend-compatible with the active base (same topology signature)?
function isCompatible(id: string): boolean {
  const t = topoById.get(id);
  return blendSig != null && !!t && topoSig(t) === blendSig;
}

// reflect selection / blend state into the toolbar + cards
function syncUI(): void {
  fileappEl.classList.toggle("blending", blendMode);
  selToolbar.hidden = blendMode;
  blendBar.hidden = !blendMode;

  if (blendMode) {
    const compat = rows.filter((r) => isCompatible(r.id)).length;
    blendInfo.textContent = `${blendSel.size} selected · pick 2–5 of ${compat} compatible hulls`;
    blendOpenBtn.disabled = blendSel.size < 2 || blendSel.size > 5;
  } else {
    const row = selectedRow();
    selNameEl.textContent = row ? row.name : "No design selected";
    selNameEl.classList.toggle("none", !row);
    for (const b of [openBtn, exportJsonBtn, exportStepBtn, exportStlBtn, deleteBtn]) b.disabled = !row;
    // Blend needs the selected design plus at least one topology-compatible peer
    const t = row ? topoById.get(row.id) : null;
    const peers = t ? rows.filter((r) => { const o = topoById.get(r.id); return o && topoSig(o) === topoSig(t); }).length : 0;
    blendBtn.disabled = peers < 2;
  }
  syncCards();
}

function syncCards(): void {
  for (const card of Array.from(gridEl.children) as HTMLElement[]) {
    const id = card.dataset.id!;
    if (blendMode) {
      const compat = isCompatible(id);
      card.classList.remove("selected");
      card.classList.toggle("compat", compat);
      card.classList.toggle("incompat", !compat);
      card.classList.toggle("picked", blendSel.has(id));
    } else {
      card.classList.remove("compat", "incompat", "picked");
      card.classList.toggle("selected", id === selectedId);
    }
  }
}

function onCardClick(id: string): void {
  if (blendMode) {
    if (!isCompatible(id)) return; // incompatible cards are inert
    if (blendSel.has(id)) blendSel.delete(id);
    else if (blendSel.size < 5) blendSel.add(id);
    syncUI();
  } else {
    selectedId = id;
    syncUI();
  }
}

function enterBlend(): void {
  const row = selectedRow();
  const t = row ? topoById.get(row.id) : null;
  if (!row || !t) return;
  blendMode = true;
  blendSig = topoSig(t);
  blendSel.clear();
  blendSel.add(row.id);
  syncUI();
}
function exitBlend(): void {
  blendMode = false;
  blendSig = null;
  blendSel.clear();
  syncUI();
}
function openBlender(): void {
  // preserve grid (newest-first) order
  const ids = rows.filter((r) => blendSel.has(r.id)).map((r) => r.id);
  if (ids.length < 2) return;
  window.location.href = `interpolate.html?ids=${ids.join(",")}`;
}

function openInEditor(id: string): void {
  window.location.href = `editor.html?id=${encodeURIComponent(id)}`;
}

interface Topo {
  length: number;
  plan: number;
  trim: number;
  section: number;
  templates: number;
  variants: number;
}
// the topology that governs blending. parseDocument normalizes it (filling legacy aft/fore defaults), so this
// matches what the interpolation viewer checks. Returns null if the document can't be parsed.
function topoOf(row: DesignRow): Topo | null {
  try {
    const p = parseDocument(JSON.stringify(row.document));
    return {
      length: p.length,
      plan: p.topology.sheerPlan,
      trim: p.topology.sheerTrim,
      section: p.topology.section,
      templates: p.topology.templateCount,
      variants: p.variants.length,
    };
  } catch {
    return null;
  }
}
// the blend signature: only designs with an identical one (length + all control-point counts) can interpolate
const topoSig = (t: Topo): string => `${t.length}|${t.plan}/${t.trim}/${t.section}/${t.templates}`;

function statChip(val: number, label: string): HTMLElement {
  const s = document.createElement("span");
  s.className = "stat";
  const b = document.createElement("b");
  b.textContent = String(val);
  s.append(b, document.createTextNode(" " + label));
  return s;
}

// resolve every design's topology (used for the stat chips and blend compatibility)
function computeTopo(): void {
  topoById.clear();
  for (const row of rows) topoById.set(row.id, topoOf(row));
}

function renderGrid(): void {
  computeTopo();
  gridEl.textContent = "";

  for (const row of rows) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = row.id;
    card.append(previewEl(row.preview));

    const t = topoById.get(row.id) ?? null;

    const name = document.createElement("div");
    name.className = "cname";
    name.textContent = row.name;
    card.append(name);

    if (t) {
      const tt = document.createElement("div");
      tt.className = "topo";
      tt.append(
        statChip(t.templates, "templates"),
        statChip(t.section, "section"),
        statChip(t.plan, "plan"),
        statChip(t.trim, "trim"),
        statChip(t.length, "mm"),
      );
      if (t.variants > 1) tt.append(statChip(t.variants, "variants"));
      card.append(tt);
    }

    const date = document.createElement("div");
    date.className = "cdate";
    date.textContent = fmtDate(row.created_at);
    card.append(date);

    // the blend-pick check badge (shown only in blend mode, via CSS)
    const pick = document.createElement("span");
    pick.className = "pick";
    pick.textContent = "✓";
    card.append(pick);

    card.addEventListener("click", () => onCardClick(row.id));
    card.addEventListener("dblclick", () => {
      if (!blendMode) openInEditor(row.id);
    });
    gridEl.append(card);
  }
  syncUI();
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

blendBtn.addEventListener("click", enterBlend);
blendCancelBtn.addEventListener("click", exitBlend);
blendOpenBtn.addEventListener("click", openBlender);

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

exportStlBtn.addEventListener("click", () => {
  const row = selectedRow();
  if (!row) return;
  exportStlBtn.disabled = true;
  try {
    resetModel();
    loadJsonText(JSON.stringify(row.document)); // load into the model singleton; buildStl fairs + meshes it
    downloadBlob(`${safeName(row.name)}.stl`, buildStl(safeName(row.name)), "model/stl");
  } catch (e) {
    alert("Export STL failed: " + (e instanceof Error ? e.message : String(e)));
  } finally {
    exportStlBtn.disabled = false;
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
