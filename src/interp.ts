// ---------- entry point for the interpolation viewer: load 2–5 hull JSONs, blend by weight, show 3D ----------
//
// A separate, read-only app. It imports the same model + renderer as the editor, but never authors
// geometry: it loads several exported hulls (`camber-hull` JSON), forms a convex blend of them per the
// data model's interpolation rule, writes that blend into the shared `state`, and draws the shaded 3D
// hull. The blended hull can be exported as STEP or JSON, just like in the editor.
//
// Per the spec, a blend of variants V₁…Vₙ with weights wᵢ ≥ 0, Σwᵢ = 1 is `Σ wᵢ·Vᵢ`, taken componentwise
// over the shared topology. The exported JSON stores absolute coordinates rather than the spec's cumulative
// increments, but a convex combination of strictly-ordered absolute sequences is itself strictly ordered,
// so blending absolutes is valid and gives the same hull. Blending is defined only within one topology, so
// all loaded hulls must agree on point counts and length.

import { clamp } from "./math.js";
import { state, L, prepare, type Sheer, type StationCP } from "./model.js";
import { draw3d } from "./render.js";
import { downloadStep } from "./step.js";
import { downloadJson, parseDocument, type HullData } from "./json.js";

interface Hull {
  name: string;
  data: HullData; // absolute model coords, decoded from the HullDocument
  weight: number;
}

// the loaded family (2–5 hulls) and the topology the first one fixes
const hulls: Hull[] = [];
let topo: { plan: number; trim: number; section: number; length: number } | null = null;
const palette: string[] = ["#2b6cb0", "#dd6b20", "#0f766e", "#7c3aed", "#b45309"];

// check a freshly parsed hull against the family's topology (the first hull fixes it). Throws on
// mismatch — only hulls of one topology (and length) can blend.
function checkTopology(data: HullData, length: number): void {
  const t = { plan: data.cp.length, trim: data.trim.length, section: data.aft.length, length };
  if (!topo) {
    topo = t;
    return;
  }
  if (t.plan !== topo.plan || t.trim !== topo.trim || t.section !== topo.section)
    throw new Error(
      `topology mismatch — plan/trim/section counts ${t.plan}/${t.trim}/${t.section}, ` +
        `the family has ${topo.plan}/${topo.trim}/${topo.section}. Only one topology can blend.`,
    );
  if (Math.abs(t.length - topo.length) > 1e-6)
    throw new Error(`length mismatch — ${t.length} vs the family's ${topo.length}. Lengths must match.`);
}

// ---------- the blend: Σ wᵢ·Vᵢ componentwise over the shared topology → the shared model state ----------
function blend(): void {
  const total = hulls.reduce((a, h) => a + h.weight, 0) || 1;
  const w = hulls.map((h) => h.weight / total); // normalize to Σ = 1 (barycentric)

  const plan = hulls[0].data.cp.map((_, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.cp[i].x, 0),
    y: hulls.reduce((a, h, k) => a + w[k] * h.data.cp[i].y, 0),
  }));
  const trim = hulls[0].data.trim.map((_, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.trim[i].x, 0),
    z: hulls.reduce((a, h, k) => a + w[k] * h.data.trim[i].z, 0),
  }));
  const transom = hulls[0].data.transom.map((_, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.transom[i].x, 0),
    z: hulls.reduce((a, h, k) => a + w[k] * h.data.transom[i].z, 0),
  }));
  const stn = (which: "aft" | "fore"): StationCP[] =>
    hulls[0].data[which].map((_, i) => ({
      n: hulls.reduce((a, h, k) => a + w[k] * h.data[which][i].n, 0),
      d: hulls.reduce((a, h, k) => a + w[k] * h.data[which][i].d, 0),
      k: hulls.reduce((a, h, kk) => a + w[kk] * h.data[which][i].k, 0),
    }));

  state.sheer = { cp: plan, trim, transom, yf: () => 0, zf: () => 0 } as Sheer;
  state.AFT = stn("aft");
  state.FORE = stn("fore");
}

// ---------- redraw: blend (if any hulls) then draw the 3D hull ----------
function refresh(): void {
  if (hulls.length === 0) return;
  blend();
  prepare(); // rebuild the sheer samplers for the blended generators
  draw3d(true); // rebuild + draw the mesh
}

// ---------- the weights panel (one slider per loaded hull) ----------
function renderPanel(): void {
  const list = document.getElementById("hullList")!;
  list.replaceChildren();
  hulls.forEach((h, i) => {
    const row = document.createElement("div");
    row.className = "hullrow";
    const total = hulls.reduce((a, x) => a + x.weight, 0) || 1;
    const pct = ((h.weight / total) * 100).toFixed(0);
    row.innerHTML =
      `<div class="hullhead">` +
      `<span class="dot" style="background:${palette[i % palette.length]}"></span>` +
      `<span class="hullname" title="${h.name}">${h.name}</span>` +
      `<span class="pct">${pct}%</span>` +
      `<button class="rm" title="Remove this hull" data-i="${i}">✕</button>` +
      `</div>` +
      `<input type="range" class="wslider" min="0" max="100" step="1" value="${Math.round(h.weight * 100)}" data-i="${i}">`;
    list.append(row);
  });
  list.querySelectorAll<HTMLInputElement>(".wslider").forEach((sl) => {
    sl.addEventListener("input", () => {
      hulls[+sl.dataset.i!].weight = +sl.value / 100;
      renderPanel();
      refresh();
    });
  });
  list.querySelectorAll<HTMLButtonElement>(".rm").forEach((b) => {
    b.addEventListener("click", () => {
      hulls.splice(+b.dataset.i!, 1);
      if (hulls.length === 0) topo = null;
      renderPanel();
      updateStatus();
      refresh();
    });
  });
}

function updateStatus(): void {
  const status = document.getElementById("status")!;
  const exportable = hulls.length >= 1;
  (document.getElementById("exportStep") as HTMLButtonElement).disabled = !exportable;
  (document.getElementById("exportJson") as HTMLButtonElement).disabled = !exportable;
  if (hulls.length === 0) {
    status.textContent = "Load 2–5 exported hulls to begin.";
  } else if (hulls.length === 1) {
    status.textContent = "1 hull loaded — add at least one more to interpolate.";
  } else {
    status.textContent = `${hulls.length} hulls · blending`;
  }
}

// ---------- file loading ----------
async function loadFiles(files: FileList | File[]): Promise<void> {
  const errs: string[] = [];
  for (const f of Array.from(files)) {
    let parsed;
    try {
      parsed = parseDocument(await f.text());
    } catch (e) {
      errs.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const base = f.name.replace(/\.json$/i, "") || "hull";
    // a HullDocument can carry several variants — each becomes a hull in the family
    let vi = 0;
    for (const data of parsed.variants) {
      if (hulls.length >= 5) {
        errs.push(`${f.name}: family is full (max 5 hulls) — some variants skipped`);
        break;
      }
      try {
        checkTopology(data, parsed.length);
      } catch (e) {
        errs.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
        vi++;
        continue;
      }
      const name = data.name ?? (parsed.variants.length > 1 ? `${base} #${vi + 1}` : base);
      hulls.push({ name, data, weight: 1 });
      vi++;
    }
  }
  renderPanel();
  updateStatus();
  refresh();
  if (errs.length) alert("Some files could not be loaded:\n\n" + errs.join("\n"));
}

// ---------- wire up ----------
function init(): void {
  state.x0 = L / 2;

  const file = document.getElementById("fileInput") as HTMLInputElement;
  document.getElementById("loadBtn")!.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    if (file.files) loadFiles(file.files);
    file.value = "";
  });

  // drag-and-drop onto the whole page
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ["dragenter", "dragover", "dragleave", "drop"].forEach((ev) =>
    document.addEventListener(ev, stop, false),
  );
  document.addEventListener("drop", (e: DragEvent) => {
    if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files);
  });

  // equal-weights reset
  document.getElementById("equalBtn")!.addEventListener("click", () => {
    hulls.forEach((h) => (h.weight = 1));
    renderPanel();
    refresh();
  });

  // export the current blend — both read the shared `state`, so they emit exactly what is shown
  document.getElementById("exportStep")!.addEventListener("click", () => {
    if (!hulls.length) return;
    try {
      downloadStep();
    } catch (e) {
      alert("STEP export failed: " + (e instanceof Error ? e.message : String(e)));
    }
  });
  document.getElementById("exportJson")!.addEventListener("click", () => {
    if (!hulls.length) return;
    try {
      downloadJson();
    } catch (e) {
      alert("JSON export failed: " + (e instanceof Error ? e.message : String(e)));
    }
  });

  // 3D view toggles (display-only, same as the editor)
  const t3 = document.getElementById("toggle3d") as HTMLButtonElement;
  t3.addEventListener("click", () => {
    state.view3d = state.view3d === "trimmed" ? "sheet" : "trimmed";
    t3.textContent = state.view3d === "trimmed" ? "Untrimmed sheet" : "Trimmed hull";
    if (hulls.length) draw3d(true);
  });
  const tz = document.getElementById("toggleZebra") as HTMLButtonElement;
  tz.addEventListener("click", () => {
    state.zebra = !state.zebra;
    tz.classList.toggle("on", state.zebra);
    if (hulls.length) draw3d(false);
  });

  // 3D rotation (view-only; no model is touched)
  const cv = document.getElementById("cv3d") as HTMLCanvasElement;
  let rot: { px: number; py: number; yaw: number; pitch: number } | null = null;
  cv.addEventListener("pointerdown", (e) => {
    rot = { px: e.clientX, py: e.clientY, yaw: state.rot.yaw, pitch: state.rot.pitch };
    e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => {
    if (!rot || !hulls.length) return;
    state.rot.yaw = rot.yaw + (e.clientX - rot.px) * 0.008;
    state.rot.pitch = clamp(rot.pitch + (e.clientY - rot.py) * 0.008, -1.45, 1.45);
    draw3d(false);
  });
  window.addEventListener("pointerup", () => (rot = null));

  updateStatus();
}

init();
