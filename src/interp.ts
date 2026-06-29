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
import { buildJson, parseDocument, type HullData, type ParsedDoc } from "./json.js";
import { getDesign, insertDesign, updateDesign } from "./supabase.js";
import { buildPreviewSvg } from "./preview.js";

interface Hull {
  name: string;
  data: HullData; // absolute model coords, decoded from the HullDocument
  weight: number;
}

// the loaded family (2–5 hulls) and the topology the first one fixes
const hulls: Hull[] = [];
let topo: {
  plan: number;
  trim: number;
  section: number;
  templates: number;
  length: number;
} | null = null;
const palette: string[] = ["#2b6cb0", "#dd6b20", "#0f766e", "#7c3aed", "#b45309"];

// check a freshly parsed hull against the family's topology (the first hull fixes it). Throws on
// mismatch — only hulls of one topology (and length) can blend.
function checkTopology(data: HullData, length: number): void {
  const t = {
    plan: data.cp.length,
    trim: data.trim.length,
    section: data.templates[0].length,
    templates: data.templates.length,
    length,
  };
  if (!topo) {
    topo = t;
    return;
  }
  if (
    t.plan !== topo.plan ||
    t.trim !== topo.trim ||
    t.section !== topo.section ||
    t.templates !== topo.templates
  )
    throw new Error(
      `topology mismatch — plan/trim/section/templates counts ` +
        `${t.plan}/${t.trim}/${t.section}/${t.templates}, the family has ` +
        `${topo.plan}/${topo.trim}/${topo.section}/${topo.templates}. ` +
        `Only one topology can blend.`,
    );
  if (Math.abs(t.length - topo.length) > 1e-6)
    throw new Error(`length mismatch — ${t.length} vs the family's ${topo.length}. Lengths must match.`);
}

// ---------- the blend: Σ wᵢ·Vᵢ componentwise over the shared topology → the shared model state ----------
function blend(): void {
  const total = hulls.reduce((a, h) => a + h.weight, 0) || 1;
  const w = hulls.map((h) => h.weight / total); // normalize to Σ = 1 (barycentric)

  const plan = hulls[0].data.cp.map((cp0, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.cp[i].x, 0),
    y: hulls.reduce((a, h, k) => a + w[k] * h.data.cp[i].y, 0),
    // the blend weights ride on the station — a convex blend of simplex points is itself in the simplex
    w: cp0.w.map((_, j) => hulls.reduce((a, h, k) => a + w[k] * h.data.cp[i].w[j], 0)),
  }));
  const trim = hulls[0].data.trim.map((_, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.trim[i].x, 0),
    z: hulls.reduce((a, h, k) => a + w[k] * h.data.trim[i].z, 0),
    k: hulls.reduce((a, h, kk) => a + w[kk] * h.data.trim[i].k, 0),
  }));
  const transom = hulls[0].data.transom.map((_, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.transom[i].x, 0),
    z: hulls.reduce((a, h, k) => a + w[k] * h.data.transom[i].z, 0),
  }));
  // each template j, blended point-for-point across the family (templates are index-aligned)
  const templates: StationCP[][] = hulls[0].data.templates.map((tpl, j) =>
    tpl.map((_, i) => ({
      n: hulls.reduce((a, h, k) => a + w[k] * h.data.templates[j][i].n, 0),
      d: hulls.reduce((a, h, k) => a + w[k] * h.data.templates[j][i].d, 0),
      k: hulls.reduce((a, h, kk) => a + w[kk] * h.data.templates[j][i].k, 0),
    })),
  );
  state.sheer = { cp: plan, trim, transom, yf: () => 0, zf: () => 0 } as Sheer;
  state.templates = templates;
}

// ---------- redraw: blend (if any hulls) then draw the 3D hull ----------
function refresh(): void {
  if (hulls.length === 0) return;
  blend();
  prepare(); // rebuild the sheer samplers for the blended generators
  draw3d(true); // rebuild + draw the mesh
}

// The very first draw (right after an async load) can run before the canvas has its laid-out size, leaving a
// blank 3D view until something redraws. Draw once more next frame, when layout has settled.
function drawAfterLayout(): void {
  requestAnimationFrame(() => {
    if (hulls.length) draw3d(false);
  });
}

// ---------- the blend control: a single slider for 2 hulls, a barycentric "pad" for 3+ ----------
// The control's position is the source of truth; each hull's weight is read off it (a straight split for the
// slider, mean-value coordinates for the pad) and renormalized in blend(). A 2-hull blend is a 1-D simplex
// (the slider); 3 hulls a triangle (the pad is then exact); 4–5 a regular polygon (the pad explores a 2-D
// slice of the simplex — every corner, edge and the centre are reachable).
const PAD = 260,
  PADC = PAD / 2,
  PADR = 88;
type Pt = { x: number; y: number };
let puck: Pt = { x: PADC, y: PADC }; // pad position (viewBox coords), for N ≥ 3
let tTwo = 0.5; // slider position 0..1, for N === 2

// the regular-polygon vertices for n hulls (vertex 0 at the top, going clockwise)
function padVerts(n: number): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { x: PADC + PADR * Math.cos(a), y: PADC + PADR * Math.sin(a) };
  });
}

// inside the (convex) polygon? winding-agnostic: inside ⇔ all edge cross-products share one sign
function insidePoly(p: Pt, V: Pt[]): boolean {
  let pos = false,
    neg = false;
  for (let i = 0; i < V.length; i++) {
    const j = (i + 1) % V.length,
      cr = (V[j].x - V[i].x) * (p.y - V[i].y) - (V[j].y - V[i].y) * (p.x - V[i].x);
    if (cr > 1e-9) pos = true;
    else if (cr < -1e-9) neg = true;
  }
  return !(pos && neg);
}

// clamp p into the polygon (project onto the nearest edge if outside), then nudge a hair inward so the
// mean-value formula never sees a point exactly on an edge (where an angle → π and tan blows up)
function clampPoly(p: Pt, V: Pt[]): Pt {
  let q = p;
  if (!insidePoly(p, V)) {
    let bd = Infinity;
    for (let i = 0; i < V.length; i++) {
      const a = V[i],
        b = V[(i + 1) % V.length],
        dx = b.x - a.x,
        dy = b.y - a.y,
        t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1),
        cxp = a.x + t * dx,
        cyp = a.y + t * dy,
        d = (cxp - p.x) ** 2 + (cyp - p.y) ** 2;
      if (d < bd) {
        bd = d;
        q = { x: cxp, y: cyp };
      }
    }
  }
  return { x: q.x + (PADC - q.x) * 1e-3, y: q.y + (PADC - q.y) * 1e-3 };
}

// mean-value coordinates of p w.r.t. polygon V — non-negative and summing to 1 for p inside a convex V,
// reducing to ordinary barycentric coordinates when V is a triangle
function meanValue(p: Pt, V: Pt[]): number[] {
  const n = V.length,
    s = V.map((v) => ({ x: v.x - p.x, y: v.y - p.y })),
    r = s.map((d) => Math.hypot(d.x, d.y));
  for (let i = 0; i < n; i++) if (r[i] < 1e-6) return V.map((_, k) => (k === i ? 1 : 0));
  const half: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n,
      dot = s[i].x * s[j].x + s[i].y * s[j].y,
      crs = s[i].x * s[j].y - s[i].y * s[j].x;
    half[i] = Math.tan(Math.atan2(Math.abs(crs), dot) / 2);
  }
  let sum = 0;
  const w = V.map((_, i) => {
    const wi = (half[(i - 1 + n) % n] + half[i]) / r[i];
    sum += wi;
    return wi;
  });
  return w.map((x) => x / (sum || 1));
}

// read the hull weights off the current control position
function setWeightsFromControl(): void {
  const n = hulls.length;
  if (n === 2) {
    hulls[0].weight = 1 - tTwo;
    hulls[1].weight = tTwo;
  } else if (n >= 3) {
    const w = meanValue(puck, padVerts(n));
    hulls.forEach((h, i) => (h.weight = w[i]));
  } else if (n === 1) hulls[0].weight = 1;
}

// reset the control to the centre (an equal blend)
function resetBlend(): void {
  puck = { x: PADC, y: PADC };
  tTwo = 0.5;
}

// update the live readout in place — NOT a rebuild (rebuilding mid-drag would abort the drag)
function updateReadout(): void {
  const n = hulls.length,
    total = hulls.reduce((a, x) => a + x.weight, 0) || 1,
    pct = (i: number): string => `${((hulls[i].weight / total) * 100).toFixed(0)}%`;
  if (n === 2) {
    const pa = document.querySelector<HTMLElement>(".twopct .pa"),
      pb = document.querySelector<HTMLElement>(".twopct .pb");
    if (pa) pa.textContent = pct(0);
    if (pb) pb.textContent = pct(1);
  } else if (n >= 3) {
    const pk = document.getElementById("puck");
    if (pk) {
      pk.setAttribute("cx", `${puck.x}`);
      pk.setAttribute("cy", `${puck.y}`);
    }
    const V = padVerts(n);
    hulls.forEach((_, i) => {
      const sp = document.getElementById(`spoke${i}`);
      if (sp) {
        sp.setAttribute("x1", `${puck.x}`);
        sp.setAttribute("y1", `${puck.y}`);
        sp.setAttribute("x2", `${V[i].x}`);
        sp.setAttribute("y2", `${V[i].y}`);
        sp.setAttribute("stroke-opacity", `${(0.12 + 0.88 * (hulls[i].weight / total)).toFixed(2)}`);
      }
    });
    const pcts = document.querySelectorAll<HTMLElement>("#hullList .legrow .pct");
    hulls.forEach((_, i) => pcts[i] && (pcts[i].textContent = pct(i)));
  }
}

// (re)build the blend control for the current family (the control position drives the weights)
function renderPanel(): void {
  const list = document.getElementById("hullList")!;
  setWeightsFromControl();
  list.replaceChildren();
  const n = hulls.length,
    col = (i: number): string => palette[i % palette.length];
  if (n < 2) return; // 0–1 hulls: nothing to blend (the status line explains)

  if (n === 2) {
    const wrap = document.createElement("div");
    wrap.className = "twoslider";
    wrap.innerHTML =
      `<div class="twoends">` +
      `<span class="e"><span class="dot" style="background:${col(0)}"></span><span class="nm" title="${hulls[0].name}">${hulls[0].name}</span></span>` +
      `<span class="e r"><span class="dot" style="background:${col(1)}"></span><span class="nm" title="${hulls[1].name}">${hulls[1].name}</span></span>` +
      `</div>` +
      `<input type="range" id="tslider" min="0" max="100" step="1" value="${Math.round(tTwo * 100)}">` +
      `<div class="twopct"><span class="pa"></span><span class="pb"></span></div>`;
    list.append(wrap);
    const sl = wrap.querySelector<HTMLInputElement>("#tslider")!;
    sl.addEventListener("input", () => {
      tTwo = +sl.value / 100;
      setWeightsFromControl();
      updateReadout(); // in-place; do NOT rebuild while the slider is being dragged
      refresh();
    });
    updateReadout();
    return;
  }

  // n ≥ 3: a polygon pad (drag the puck) + a legend of names/percentages
  const V = padVerts(n);
  const polyD = V.map((v, i) => `${i ? "L" : "M"}${v.x.toFixed(1)} ${v.y.toFixed(1)}`).join(" ") + "Z";
  let svg =
    `<svg id="blendPad" viewBox="0 0 ${PAD} ${PAD}" preserveAspectRatio="xMidYMid meet">` +
    `<path d="${polyD}" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1.5" stroke-linejoin="round"/>`;
  for (let i = 0; i < n; i++)
    svg += `<line id="spoke${i}" x1="${PADC}" y1="${PADC}" x2="${V[i].x.toFixed(1)}" y2="${V[i].y.toFixed(1)}" stroke="${col(i)}" stroke-width="2" stroke-opacity="0.5"/>`;
  for (let i = 0; i < n; i++)
    svg += `<circle cx="${V[i].x.toFixed(1)}" cy="${V[i].y.toFixed(1)}" r="6" fill="${col(i)}" stroke="#fff" stroke-width="1.5"/>`;
  svg += `<circle id="puck" class="puck" cx="${puck.x}" cy="${puck.y}" r="9" fill="#fff" stroke="var(--ink)" stroke-width="2.5"/></svg>`;
  const padwrap = document.createElement("div");
  padwrap.className = "padwrap";
  padwrap.innerHTML = svg;
  list.append(padwrap);

  const legend = document.createElement("div");
  legend.className = "padlegend";
  legend.innerHTML = hulls
    .map(
      (h, i) =>
        `<div class="legrow"><span class="dot" style="background:${col(i)}"></span>` +
        `<span class="nm" title="${h.name}">${h.name}</span><span class="pct"></span></div>`,
    )
    .join("");
  list.append(legend);

  // drag the puck (or press anywhere in the pad to jump it there)
  const padEl = padwrap.querySelector<SVGSVGElement>("#blendPad")!;
  const toVB = (e: PointerEvent): Pt => {
    const r = padEl.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * PAD, y: ((e.clientY - r.top) / r.height) * PAD };
  };
  let dragging = false;
  const move = (e: PointerEvent): void => {
    puck = clampPoly(toVB(e), V);
    setWeightsFromControl();
    updateReadout();
    refresh();
  };
  padEl.addEventListener("pointerdown", (e) => {
    dragging = true;
    padEl.setPointerCapture(e.pointerId);
    e.preventDefault();
    move(e);
  });
  padEl.addEventListener("pointermove", (e) => {
    if (dragging) move(e);
  });
  const end = (e: PointerEvent): void => {
    dragging = false;
    if (padEl.hasPointerCapture(e.pointerId)) padEl.releasePointerCapture(e.pointerId);
  };
  padEl.addEventListener("pointerup", end);
  padEl.addEventListener("pointercancel", end);
  updateReadout();
}

function updateStatus(): void {
  const status = document.getElementById("status")!;
  if (hulls.length === 0) {
    status.textContent = "Open a blend from the design library to begin.";
  } else if (hulls.length === 1) {
    status.textContent = "1 hull loaded — needs at least one more to interpolate.";
  } else {
    status.textContent = `${hulls.length} hulls · blending`;
  }
  refreshSaveUI();
}

// ---------- saving the blend to the library ----------
// First save creates a new design (button reads "Save As…"). After that the button reads "Save" and
// overwrites that design, flipping back to "Save As…" only when the name is changed (which forks a new one) —
// exactly like the hull editor.
let currentId: string | null = null; // the saved design's row id (null until first save)
let savedName: string | null = null; // the name stored for currentId
let savedSnapshot = ""; // buildJson() of the last save
let savingNow = false;
let flashUntil = 0;

const nameInput = () => document.getElementById("blendName") as HTMLInputElement;
const saveBtnEl = () => document.getElementById("saveAs") as HTMLButtonElement;
const saveStateEl = () => document.getElementById("saveState")!;

function defaultBlendName(): string {
  return hulls.length ? `Blend of ${hulls.map((h) => h.name).join(" + ")}`.slice(0, 120) : "Untitled blend";
}
// would saving create a new row? (never saved, or the name was changed away from the saved design)
function willFork(): boolean {
  const name = nameInput().value.trim();
  return currentId == null || (name !== "" && name !== savedName);
}
function isDirty(): boolean {
  if (hulls.length === 0) return false;
  if (currentId == null) return true; // never saved → always unsaved work
  return buildJson() !== savedSnapshot || nameInput().value.trim() !== savedName;
}
function refreshSaveUI(): void {
  saveBtnEl().textContent = willFork() ? "Save As…" : "Save";
  saveBtnEl().disabled = hulls.length < 1 || savingNow;
  if (savingNow || Date.now() < flashUntil) return;
  const st = saveStateEl();
  if (hulls.length < 1) {
    st.className = "savestate";
    st.textContent = "";
  } else if (isDirty()) {
    st.className = "savestate dirty";
    st.textContent = "Unsaved";
  } else {
    st.className = "savestate saved";
    st.textContent = "Saved";
  }
}

async function doSave(): Promise<void> {
  if (savingNow || hulls.length < 1) return;
  const fork = willFork();
  let name = nameInput().value.trim();
  if (fork) {
    if (!name) {
      name = prompt("Name this blend:", defaultBlendName())?.trim() ?? "";
      if (!name) return;
      nameInput().value = name;
    }
  } else {
    name = savedName!; // plain overwrite keeps the existing name
  }
  savingNow = true;
  flashUntil = 0;
  saveBtnEl().disabled = true;
  saveStateEl().className = "savestate";
  saveStateEl().textContent = "Saving…";
  try {
    const json = buildJson(); // the blended hull is already in `state`
    const preview = buildPreviewSvg();
    if (fork) currentId = await insertDesign(name, json, preview);
    else await updateDesign(currentId!, json, preview);
    savedName = name;
    savedSnapshot = json;
    nameInput().value = name;
    flashUntil = Date.now() + 1400;
    saveStateEl().className = "savestate saved";
    saveStateEl().textContent = "Saved ✓";
  } catch (e) {
    saveStateEl().className = "savestate dirty";
    saveStateEl().textContent = "Save failed";
    alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
  } finally {
    savingNow = false;
    refreshSaveUI();
  }
}

function closeToLibrary(): void {
  if (isDirty() && !confirm("Discard the unsaved blend and return to the library?")) return;
  window.location.href = "index.html";
}

// add every variant of a parsed document to the family (a HullDocument can carry several), checking each
// against the shared topology. Collects any per-variant problems into `errs`.
function addParsedDoc(parsed: ParsedDoc, base: string, errs: string[]): void {
  let vi = 0;
  for (const data of parsed.variants) {
    if (hulls.length >= 5) {
      errs.push(`${base}: family is full (max 5 hulls) — some variants skipped`);
      break;
    }
    try {
      checkTopology(data, parsed.length);
    } catch (e) {
      errs.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
      vi++;
      continue;
    }
    const name = data.name ?? (parsed.variants.length > 1 ? `${base} #${vi + 1}` : base);
    hulls.push({ name, data, weight: 1 });
    vi++;
  }
}

// ---------- file loading ----------
async function loadFiles(files: FileList | File[]): Promise<void> {
  const errs: string[] = [];
  for (const f of Array.from(files)) {
    try {
      addParsedDoc(parseDocument(await f.text()), f.name.replace(/\.json$/i, "") || "hull", errs);
    } catch (e) {
      errs.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  resetBlend(); // a fresh family starts centred (equal blend)
  renderPanel();
  updateStatus();
  refresh();
  drawAfterLayout();
  if (errs.length) alert("Some files could not be loaded:\n\n" + errs.join("\n"));
}

// ---------- library loading (opened from the design library with ?ids=a,b,c) ----------
async function loadByIds(ids: string[]): Promise<void> {
  const errs: string[] = [];
  for (const id of ids) {
    try {
      const { name, documentText } = await getDesign(id);
      addParsedDoc(parseDocument(documentText), name, errs);
    } catch (e) {
      errs.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  resetBlend(); // a fresh family starts centred (equal blend)
  renderPanel();
  updateStatus();
  refresh();
  drawAfterLayout();
  if (errs.length) alert("Some designs could not be loaded:\n\n" + errs.join("\n"));
}

// ---------- wire up ----------
function init(): void {
  state.x0 = L / 2;

  // drag-and-drop onto the whole page (still works for loading JSON files, though there's no Load button)
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

  // recenter the control → an equal blend
  document.getElementById("equalBtn")!.addEventListener("click", () => {
    resetBlend();
    renderPanel();
    refresh();
  });

  // save the current blend to the library / close back to it
  document.getElementById("blendName")!.addEventListener("input", refreshSaveUI);
  document.getElementById("saveAs")!.addEventListener("click", doSave);
  document.getElementById("closeBtn")!.addEventListener("click", closeToLibrary);
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  setInterval(refreshSaveUI, 300);

  // the 3D canvas fills a CSS box; redraw it when the box resizes (mesh is cached)
  window.addEventListener("resize", () => {
    if (hulls.length) draw3d(false);
  });

  // 3D display mode — a single mutually-exclusive choice (render / lines / zebra / sheet), like the editor
  const view3dModes = document.getElementById("view3dModes")!;
  view3dModes.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.vmode");
    if (!b) return;
    state.view3dMode = b.dataset.mode as typeof state.view3dMode;
    view3dModes.querySelectorAll(".vmode").forEach((x) => x.classList.toggle("on", x === b));
    if (hulls.length) draw3d(true);
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
  // scroll-wheel zoom (the lines overlay is pointer-events:none so this still reaches the canvas)
  cv.addEventListener(
    "wheel",
    (e) => {
      if (!hulls.length) return;
      e.preventDefault();
      state.zoom = clamp(state.zoom * Math.exp(-e.deltaY * 0.0015), 0.3, 8);
      draw3d(false);
    },
    { passive: false },
  );

  // opened from the design library? load that selection straight from Supabase.
  const ids = new URLSearchParams(window.location.search).get("ids");
  if (ids) loadByIds(ids.split(",").filter(Boolean));

  updateStatus();
}

init();
