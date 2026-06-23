// ---------- rendering: the five 2D views + the shaded 3D hull ----------

import { V, lerp, type Vec3 } from "./math.js";
import {
  state,
  L,
  DMAX,
  prepare,
  clippedSection,
  sweptSection,
  stationAt,
  frameAt,
  contour,
  transomEdge,
  xTransom,
  chordParam,
  fairEval,
  weightsAt,
  immersion,
  type Section,
  type StationCP,
  type ActiveTarget,
} from "./model.js";
import {
  PXpad,
  mapX,
  Ptop,
  ZMIN,
  ZMAX,
  PZbase,
  zScreenP,
  LH,
  Lcen,
  yStar,
  yPort,
  snX,
  snY,
  NMIN,
  NMAX,
  wY,
} from "./view.js";
import {
  el,
  poly,
  COL,
  sampleX,
  svgP,
  svgL,
  svgC,
  svgB,
  svgW,
  tplCards,
  sideTabs,
  wideTabs,
  tplColor,
  cv3d,
} from "./dom.js";
import {
  startDrag,
  sheerPointDown,
  trimPointDown,
  transomPointDown,
  stnPointDown,
  templateBgDown,
  weightHandleDown,
  addTemplate,
  removeTemplate,
} from "./interaction.js";

type Proj = (p: Vec3) => [number, number];

function gridX(svg: SVGSVGElement, top: number, bot: number): void {
  for (let q = 0; q <= 4; q++) {
    const x = mapX((L * q) / 4);
    svg.append(
      el("line", { x1: x, y1: top, x2: x, y2: bot, stroke: "#edf2f7", "stroke-width": 1 }),
    );
  }
}

// the draggable cut handle: a triangle + an invisible vertical hit band at x0. The visible red line is
// the station's true-angle trace, drawn by the caller (drawPlan/drawProfile) from the swept section.
function stationLine(svg: SVGSVGElement, top: number, bot: number): void {
  const x = mapX(state.x0);
  const hit = el("line", {
    x1: x,
    y1: top,
    x2: x,
    y2: bot,
    stroke: "#000",
    "stroke-width": 16,
    opacity: 0,
    style: "cursor:ew-resize",
  });
  hit.addEventListener("pointerdown", (e) => startDrag({ kind: "slider" }, svg, e));
  svg.append(hit);
  const tri = el("path", {
    d: `M${x - 6} ${top} L${x + 6} ${top} L${x} ${top + 9} Z`,
    fill: "var(--slider)",
    style: "cursor:ew-resize",
  });
  tri.addEventListener("pointerdown", (e) => startDrag({ kind: "slider" }, svg, e));
  svg.append(tri);
}

// the swept station at x0 projected into a 2D view → its true heading/rake (not a plain vertical cut)
function cutTrace(svg: SVGSVGElement, proj: Proj): void {
  const cut = clippedSection(state.x0, 40);
  svg.append(
    el("path", {
      d: poly(cut.pts.map(proj)),
      fill: "none",
      stroke: "var(--slider)",
      "stroke-width": 2,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
}

// ---------- design waterline (the horizontal world plane at worldZ = −state.waterline) ----------
// immersion stats for a cut section: draft = deepest point below the WL, beam = breadth at the WL.
function waterlineStats(sec: Section): { draft: number; beam: number; wet: boolean } {
  let draft = 0,
    beam = 0,
    wet = false;
  for (let i = 0; i < sec.pts.length; i++) {
    const p = sec.pts[i],
      imm = immersion(p[0], p[2]);
    if (imm > 0) wet = true;
    if (imm > draft) draft = imm;
    if (i > 0) {
      const a = sec.pts[i - 1],
        ai = immersion(a[0], a[2]);
      if (ai < 0 !== imm < 0 && ai !== imm) {
        const t = (0 - ai) / (imm - ai);
        beam = Math.max(beam, 2 * Math.abs(lerp(a[1], p[1], t)));
      }
    }
  }
  return { draft, beam, wet };
}
// the design-waterline contour in plan (x,y): where each section crosses worldZ = −waterline
function dwlContour(sections: Section[]): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (const s of sections) {
    if (s.aft) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    let f: [number, number] | null = null;
    for (let j = 0; j < s.pts.length - 1; j++) {
      const a = s.pts[j],
        b = s.pts[j + 1],
        ia = immersion(a[0], a[2]),
        ib = immersion(b[0], b[2]);
      if (ia < 0 !== ib < 0 && ia !== ib) {
        const t = (0 - ia) / (ib - ia);
        f = [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
        break;
      }
    }
    if (f) run.push(f);
    else {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

// ---------- render ----------
export function render(): void {
  prepare();
  const NSEC = 64,
    sections: Section[] = [];
  for (let i = 0; i <= NSEC; i++) sections.push(clippedSection((L * i) / NSEC, 18));
  let zmin = 0;
  for (const s of sections) {
    if (s.aft) continue;
    for (const p of s.pts) zmin = Math.min(zmin, p[2]);
  }
  drawPlan(sections, zmin);
  drawProfile(sections, zmin);
  drawWeights(svgW);
  drawCutStation(svgC);
  drawBodyPlan(svgB);
  drawSidePanels(); // template editors + Cut + Body share one tab strip; show the active one
  drawWideTabs(); // plan / profile / blend share one tab strip in the bottom panel
  draw3d(true);
  const profVal = document.getElementById("profVal") as HTMLElement;
  profVal.textContent = `x = ${Math.round(state.x0)} (${((state.x0 / L) * 100).toFixed(0)}% LOA)`;
  const h = clippedSection(state.x0, 18);
  // (label uses the live cut) — draft + breadth are measured against the design waterline
  const wl = waterlineStats(h),
    open = h.open ? " · open" : "";
  profVal.textContent = wl.wet
    ? `x=${Math.round(state.x0)}${open} · draft ${Math.round(wl.draft)} · WL beam ${Math.round(wl.beam)}`
    : `x=${Math.round(state.x0)}${open} · above WL`;
}

function drawPlan(sections: Section[], zmin: number): void {
  const svg = svgL;
  svg.replaceChildren();
  gridX(svg, 8, LH - 8);
  // waterlines (constant z): traced contours, mirrored
  const NWL = 7;
  for (let k = 1; k <= NWL; k++) {
    const zk = (zmin * k) / (NWL + 1);
    for (const run of contour(sections, zk, 2)) {
      svg.append(
        el("path", {
          d: poly(run.map((p) => [mapX(p[0]), yStar(p[1])])),
          fill: "none",
          stroke: COL.wl,
          "stroke-width": 1,
          opacity: 0.55,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        }),
      );
      svg.append(
        el("path", {
          d: poly(run.map((p) => [mapX(p[0]), yPort(p[1])])),
          fill: "none",
          stroke: COL.wl,
          "stroke-width": 1,
          opacity: 0.32,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        }),
      );
    }
  }
  svg.append(
    el("line", {
      x1: PXpad,
      y1: Lcen,
      x2: 1000 - PXpad,
      y2: Lcen,
      stroke: "var(--keel)",
      "stroke-width": 1.5,
      opacity: 0.5,
      "stroke-dasharray": "4 4",
    }),
  );
  const cl = el("text", {
    x: PXpad - 4,
    y: Lcen - 4,
    "text-anchor": "end",
    "font-size": 10,
    fill: "var(--keel)",
  });
  cl.textContent = "CL";
  svg.append(cl);
  stationLine(svg, 8, LH - 8);
  const xs = sampleX();
  svg.append(
    el("path", {
      d: poly(xs.map((x) => [mapX(x), yStar(state.sheer.yf(x))])),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 2.4,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
  svg.append(
    el("path", {
      d: poly(xs.map((x) => [mapX(x), yPort(state.sheer.yf(x))])),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 2.4,
      opacity: 0.5,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
  // transom footprint in plan (centerline → sheer at the stern)
  const te = transomEdge();
  if (te.length > 1) {
    svg.append(
      el("path", {
        d: poly(te.map((p) => [mapX(p[0]), yStar(p[1])])),
        fill: "none",
        stroke: "var(--transom)",
        "stroke-width": 2.2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
    svg.append(
      el("path", {
        d: poly(te.map((p) => [mapX(p[0]), yPort(p[1])])),
        fill: "none",
        stroke: "var(--transom)",
        "stroke-width": 2.2,
        opacity: 0.5,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  }
  // design-waterline footprint (where the hull meets the WL plane), mirrored to both sides
  for (const run of dwlContour(sections)) {
    svg.append(
      el("path", {
        d: poly(run.map((p) => [mapX(p[0]), yStar(p[1])])),
        fill: "none",
        stroke: COL.wl,
        "stroke-width": 2,
        opacity: 0.9,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
    svg.append(
      el("path", {
        d: poly(run.map((p) => [mapX(p[0]), yPort(p[1])])),
        fill: "none",
        stroke: COL.wl,
        "stroke-width": 2,
        opacity: 0.6,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  }
  // cut station — true plan heading (the fan angle), mirrored to the port side
  const cut = clippedSection(state.x0, 40);
  svg.append(
    el("path", {
      d: poly(cut.pts.map((p) => [mapX(p[0]), yPort(p[1])])),
      fill: "none",
      stroke: "var(--slider)",
      "stroke-width": 2,
      opacity: 0.4,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
  cutTrace(svg, (p) => [mapX(p[0]), yStar(p[1])]);
  svg.append(
    el("circle", {
      cx: mapX(state.x0),
      cy: yStar(state.sheer.yf(state.x0)),
      r: 3.2,
      fill: "#fff",
      stroke: COL.sheer,
      "stroke-width": 1.5,
    }),
  );
  state.sheer.cp.forEach((cp, idx) => cpDot(svg, idx, mapX(cp.x), yStar(cp.y)));
}

function drawProfile(sections: Section[], _zmin: number): void {
  const svg = svgP;
  svg.replaceChildren();
  gridX(svg, Ptop - 4, PZbase);
  stationLine(svg, Ptop - 4, PZbase);
  // buttocks (constant y): traced contours in profile
  const ymax = Math.max(...state.sheer.cp.map((p) => p.y)),
    NBT = 5;
  for (let k = 1; k <= NBT; k++) {
    const yk = (ymax * k) / (NBT + 1);
    for (const run of contour(sections, yk, 1))
      svg.append(
        el("path", {
          d: poly(run.map((p) => [mapX(p[0]), zScreenP(p[2])])),
          fill: "none",
          stroke: COL.bt,
          "stroke-width": 1,
          opacity: 0.5,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        }),
      );
  }
  // flat deck at z = 0 — now just a construction reference; the real top edge is the sheer trim below it
  svg.append(
    el("line", {
      x1: PXpad,
      y1: zScreenP(0),
      x2: 1000 - PXpad,
      y2: zScreenP(0),
      stroke: COL.deck,
      "stroke-width": 1.5,
      "stroke-dasharray": "6 4",
    }),
  );
  const dl = el("text", {
    x: 1000 - PXpad,
    y: zScreenP(0) - 5,
    "text-anchor": "end",
    "font-size": 10,
    fill: COL.deck,
  });
  dl.textContent = "flat deck";
  svg.append(dl);
  // design waterline: horizontal in world ⇒ a raked line in this deck-frame profile (slope = the rake)
  const wlS = Math.sin(state.deckRake),
    wlC = Math.cos(state.deckRake),
    zWL = (x: number) => (-state.waterline - x * wlS) / wlC;
  svg.append(
    el("line", {
      x1: mapX(0),
      y1: zScreenP(zWL(0)),
      x2: mapX(L),
      y2: zScreenP(zWL(L)),
      stroke: COL.wl,
      "stroke-width": 1.8,
      opacity: 0.9,
    }),
  );
  const wll = el("text", {
    x: mapX(L) - 4,
    y: zScreenP(zWL(L)) - 5,
    "text-anchor": "end",
    "font-size": 10,
    fill: COL.wl,
  });
  wll.textContent = "DWL";
  svg.append(wll);
  // emergent keel (rocker / stem) — only where the section actually closes on the centerline
  const keel = sections.filter((s) => s.keel).map((s) => s.pts[s.pts.length - 1]);
  if (keel.length > 1)
    svg.append(
      el("path", {
        d: poly(keel.map((p) => [mapX(p[0]), zScreenP(p[2])])),
        fill: "none",
        stroke: COL.keel,
        "stroke-width": 2.4,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  // sheer trim line (real sheer in profile) — the swept sheet is cut to this, kept below the deck
  const xs = sampleX();
  svg.append(
    el("path", {
      d: poly(xs.map((x) => [mapX(x), zScreenP(state.sheer.zf(x))])),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 2.4,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
  // transom: the construction line through the two control points (dashed) + the actual cut edge (solid)
  const [ta, tb] = state.sheer.transom;
  svg.append(
    el("line", {
      x1: mapX(ta.x),
      y1: zScreenP(ta.z),
      x2: mapX(tb.x),
      y2: zScreenP(tb.z),
      stroke: "var(--transom)",
      "stroke-width": 1.3,
      opacity: 0.6,
      "stroke-dasharray": "5 4",
    }),
  );
  const te = transomEdge();
  if (te.length > 1)
    svg.append(
      el("path", {
        d: poly(te.map((p) => [mapX(p[0]), zScreenP(p[2])])),
        fill: "none",
        stroke: "var(--transom)",
        "stroke-width": 2.4,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  const ttl = el("text", {
    x: mapX(ta.x) + 6,
    y: zScreenP(ta.z) - 4,
    "font-size": 10,
    fill: "var(--transom)",
  });
  ttl.textContent = "transom";
  svg.append(ttl);
  // cut station — true profile rake (the fan shifts x as the section runs inboard to the keel)
  cutTrace(svg, (p) => [mapX(p[0]), zScreenP(p[2])]);
  const h = clippedSection(state.x0, 18);
  if (h.keel)
    svg.append(
      el("circle", {
        cx: mapX(h.pts[h.pts.length - 1][0]),
        cy: zScreenP(h.pts[h.pts.length - 1][2]),
        r: 3.2,
        fill: "#fff",
        stroke: COL.keel,
        "stroke-width": 1.5,
      }),
    );
  svg.append(
    el("circle", {
      cx: mapX(state.x0),
      cy: zScreenP(state.sheer.zf(state.x0)),
      r: 3.2,
      fill: "#fff",
      stroke: COL.sheer,
      "stroke-width": 1.5,
    }),
  );
  state.sheer.trim.forEach((cp, idx) => trimDot(svg, idx, mapX(cp.x), zScreenP(cp.z)));
  state.sheer.transom.forEach((cp, idx) => transomDot(svg, idx, mapX(cp.x), zScreenP(cp.z)));
}

// one section-template editor (template `ti`): the other templates ghosted faint behind it, this one
// solid with draggable nodes. Built into a fresh svg by drawTemplates each render.
function stnCurve(svg: SVGSVGElement, pts: StationCP[], c: string, op: number): void {
  const ns = pts.map((p) => p.n),
    ds = pts.map((p) => p.d),
    ks = pts.map((p) => p.k),
    ts = chordParam(ns, ds);
  const nf = fairEval(ts, ns, ks),
    df = fairEval(ts, ds, ks),
    tm = ts[ts.length - 1],
    out: [number, number][] = [],
    N = 120;
  for (let i = 0; i <= N; i++) {
    const u = (tm * i) / N;
    out.push([snX(nf(u)), snY(df(u))]);
  }
  svg.append(
    el("path", {
      d: poly(out),
      fill: "none",
      stroke: c,
      "stroke-width": 2.4,
      opacity: op,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
}

function drawStation(svg: SVGSVGElement, ti: number): void {
  svg.replaceChildren();
  const col = tplColor(ti),
    arr = state.templates[ti];
  // axes: sheer point at origin (top-left), n inboard →, d down ↓
  svg.append(
    el("line", { x1: snX(NMIN), y1: snY(0), x2: snX(NMAX), y2: snY(0), stroke: "#edf2f7", "stroke-width": 1 }),
  );
  svg.append(
    el("line", { x1: snX(0), y1: snY(0), x2: snX(0), y2: snY(DMAX), stroke: "#e2e8f0", "stroke-width": 1.2 }),
  );
  const sh = el("text", { x: snX(0) + 6, y: snY(0) - 6, "font-size": 10, fill: COL.mut || "#718096" });
  sh.textContent = "sheer";
  svg.append(sh);
  // faint ghosts of every other template, then this one solid
  state.templates.forEach((tpl, j) => {
    if (j !== ti) stnCurve(svg, tpl, tplColor(j), 0.16);
  });
  stnCurve(svg, arr, col, 1);
  arr.forEach((p, idx) => {
    const end = idx === 0,
      s = end ? 4 : 6,
      // knuckle applies to every point but the pinned sheer point (idx 0) — including the keel point;
      // the node morphs round (k=0) → square (k=1) via corner radius to show its sharpness
      knuck = idx > 0,
      k = knuck ? Math.min(Math.max(p.k, 0), 1) : 0,
      rad = (1 - k) * s,
      sel = isSelected("template", idx, ti); // the selected node is drawn solid red
    const node = el("rect", {
      x: snX(p.n) - s,
      y: snY(p.d) - s,
      width: 2 * s,
      height: 2 * s,
      rx: rad,
      ry: rad,
      fill: sel ? SEL : end ? "#fff" : col,
      stroke: sel ? "#fff" : end ? col : "#fff",
      "stroke-width": 1.8,
    });
    node.addEventListener("pointerdown", (e) => stnPointDown(ti, idx, end, svg, e));
    svg.append(node);
  });
  // when a template point is selected, mark the corresponding index on every OTHER template's ghost curve
  // with a small red ✕, so you can see where that control point lands on the other sections.
  const si = selStationIdx();
  if (si !== null)
    state.templates.forEach((tpl, j) => {
      if (j !== ti) redX(svg, snX(tpl[si].n), snY(tpl[si].d));
    });
}

// ---------- the side panel: one tab strip over the per-template editors plus the Cut and Body views ----------
// The per-template editor <svg>s are persistent — rebuilt only when the template COUNT changes, never on a
// plain redraw — so a drag started on one stays bound to a live, measurable element (a recreated svg reports
// a zero-size getBoundingClientRect and breaks the pointer-to-model mapping). Cut and Body are the fixed page
// svgs. The tab strip shows exactly one panel at a time.
let tplEls: SVGSVGElement[] = [];
let sideTab: number | "cut" | "body" = 0; // active tab: a template index, or the Cut / Body view
let prevTplCount = 0;

function buildTemplateSvgs(): void {
  tplCards.replaceChildren();
  tplEls = [];
  state.templates.forEach((_, j) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 360 360");
    svg.addEventListener("pointerdown", (e) => templateBgDown(j, svg, e as PointerEvent));
    tplCards.append(svg);
    tplEls.push(svg);
  });
}

// show only the active panel; the others stay drawn but hidden, so switching tabs is instant
function applySideTab(): void {
  tplEls.forEach((svg, j) => (svg.style.display = sideTab === j ? "" : "none"));
  svgC.style.display = sideTab === "cut" ? "" : "none";
  svgB.style.display = sideTab === "body" ? "" : "none";
}

function setSideTab(t: number | "cut" | "body"): void {
  sideTab = t;
  applySideTab();
  buildSideTabs();
}

// the tab strip: one tab per template (its accent color; the active one carries a ✕ to remove it), a "+" to
// add a template, then the Cut and Body views.
function buildSideTabs(): void {
  sideTabs.replaceChildren();
  const K = state.templates.length;
  state.templates.forEach((_, j) => {
    const active = sideTab === j,
      tab = document.createElement("button");
    tab.className = "tab tpltab" + (active ? " active" : "");
    tab.style.setProperty("--tab", tplColor(j));
    const lbl = document.createElement("span");
    lbl.textContent = `T${j + 1}`;
    tab.append(lbl);
    if (active && K > 1) {
      const x = document.createElement("span");
      x.className = "tabx";
      x.textContent = "✕";
      x.title = "Remove this template";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        removeTemplate(j);
      });
      tab.append(x);
    }
    tab.addEventListener("click", () => setSideTab(j));
    sideTabs.append(tab);
  });
  const add = document.createElement("button");
  add.className = "tab tabadd";
  add.textContent = "+";
  add.title = "Add a section template (enters the blend at zero weight; raise it in the blend editor)";
  add.disabled = K >= 7;
  add.addEventListener("click", () => addTemplate());
  sideTabs.append(add);
  const sep = document.createElement("span");
  sep.className = "tabsep";
  sideTabs.append(sep);
  for (const v of [["cut", "Cut"], ["body", "Body"]] as const) {
    const tab = document.createElement("button");
    tab.className = "tab" + (sideTab === v[0] ? " active" : "");
    tab.textContent = v[1];
    tab.addEventListener("click", () => setSideTab(v[0]));
    sideTabs.append(tab);
  }
}

// redraw the side panel: (re)build the template svgs when the count changes, draw each, refresh the tabs
function drawSidePanels(): void {
  const K = state.templates.length;
  if (tplEls.length !== K) {
    const grew = K > prevTplCount && prevTplCount > 0; // a freshly added template becomes active
    buildTemplateSvgs();
    if (grew) sideTab = K - 1;
    prevTplCount = K;
  }
  if (typeof sideTab === "number" && sideTab >= K) sideTab = K - 1; // a removed template → clamp
  tplEls.forEach((svg, j) => drawStation(svg, j));
  buildSideTabs();
  applySideTab();
}

// ---------- the bottom wide panel: plan / profile / blend share one tab strip, one shown at a time ----------
type WideTab = "plan" | "profile" | "blend";
let wideTab: WideTab = "plan";
const WIDE: { key: WideTab; label: string; svg: () => SVGSVGElement }[] = [
  { key: "plan", label: "Plan", svg: () => svgL },
  { key: "profile", label: "Profile", svg: () => svgP },
  { key: "blend", label: "Blend", svg: () => svgW },
];

function applyWide(): void {
  for (const v of WIDE) v.svg().style.display = wideTab === v.key ? "" : "none";
}

function drawWideTabs(): void {
  wideTabs.replaceChildren();
  for (const v of WIDE) {
    const tab = document.createElement("button");
    tab.className = "tab" + (wideTab === v.key ? " active" : "");
    tab.textContent = v.label;
    tab.addEventListener("click", () => {
      wideTab = v.key;
      applyWide();
      drawWideTabs();
    });
    wideTabs.append(tab);
  }
  const addBtn = document.getElementById("addBlendBtn") as HTMLButtonElement | null;
  if (addBtn) addBtn.hidden = wideTab !== "blend"; // the "+ blend point" button is only for the blend view
  applyWide();
}

// the weight curve as a stacked-band ribbon over x: band j is template j's share of the blend, the bands
// summing to 1 at every station. Control points carry an x-handle (interior CPs) and the band-boundary
// handles that edit the simplex split. The red cut slider scrubs x here too.
function drawWeights(svg: SVGSVGElement): void {
  svg.replaceChildren();
  const K = state.templates.length,
    top = wY(1),
    bot = wY(0);
  gridX(svg, top, bot);
  // horizontal guides at 0 / ½ / 1
  for (const g of [0, 0.5, 1])
    svg.append(
      el("line", { x1: mapX(0), y1: wY(g), x2: mapX(L), y2: wY(g), stroke: "#edf2f7", "stroke-width": 1 }),
    );
  // stacked bands from the sampled curve
  const NS = 120,
    xs: number[] = [],
    cum: number[][] = [];
  for (let i = 0; i <= NS; i++) {
    const x = (L * i) / NS,
      w = weightsAt(x),
      c = [0];
    let s = 0;
    for (let j = 0; j < K; j++) {
      s += w[j];
      c.push(s);
    }
    xs.push(x);
    cum.push(c);
  }
  for (let j = 0; j < K; j++) {
    const upper = xs.map((x, i): [number, number] => [mapX(x), wY(cum[i][j + 1])]),
      lower = xs.map((x, i): [number, number] => [mapX(x), wY(cum[i][j])]).reverse();
    svg.append(
      el("path", { d: poly(upper.concat(lower)) + "Z", fill: tplColor(j), opacity: 0.5, stroke: "none" }),
    );
  }
  stationLine(svg, top, bot); // scrub the cut x from here too
  // control points: vertical guide + x-handle (interior only) + the K−1 band-boundary handles
  state.weights.forEach((cp, i) => {
    const n = state.weights.length,
      x = mapX(cp.x),
      sel = state.selected && state.selected.tgt === "weight" && state.selected.idx === i;
    svg.append(
      el("line", { x1: x, y1: top, x2: x, y2: bot, stroke: "#fff", "stroke-width": 1, opacity: 0.75 }),
    );
    const C: number[] = [];
    let s = 0;
    for (let j = 0; j < K; j++) {
      s += cp.w[j];
      C.push(s);
    }
    for (let b = 0; b < K - 1; b++) {
      const hy = wY(C[b]);
      const h = el("circle", {
        cx: x,
        cy: hy,
        r: 5,
        fill: sel ? SEL : "#fff", // selected blend point → red handles
        stroke: sel ? "#fff" : tplColor(b),
        "stroke-width": 2,
        style: "cursor:ns-resize",
      });
      h.addEventListener("pointerdown", (e) => weightHandleDown(i, "bnd", b, svg, e as PointerEvent));
      svg.append(h);
    }
    if (i > 0 && i < n - 1) {
      const xh = el("rect", {
        x: x - 4.5,
        y: top - 11,
        width: 9,
        height: 9,
        fill: sel ? SEL : "#fff",
        stroke: COL.mut,
        "stroke-width": 1.5,
        style: "cursor:ew-resize",
      });
      xh.addEventListener("pointerdown", (e) => weightHandleDown(i, "x", 0, svg, e as PointerEvent));
      svg.append(xh);
    }
  });
}

// the interpolated (blended) station at the red cut x0, with both trims marked: the sheer trim
// (horizontal, at depth -z_sheer(x0)) and the centerline trim (vertical, at the n where the section
// reaches the boat centerline y=0). The bold arc between them is what survives into the final shape.
function drawCutStation(svg: SVGSVGElement): void {
  svg.replaceChildren();
  svg.append(
    el("line", { x1: snX(NMIN), y1: snY(0), x2: snX(NMAX), y2: snY(0), stroke: "#edf2f7", "stroke-width": 1 }),
  );
  svg.append(
    el("line", { x1: snX(0), y1: snY(0), x2: snX(0), y2: snY(DMAX), stroke: "#e2e8f0", "stroke-width": 1.2 }),
  );
  const sh = el("text", { x: snX(0) + 6, y: snY(0) - 6, "font-size": 10, fill: "#718096" });
  sh.textContent = "sheer";
  svg.append(sh);

  const st = stationAt(state.x0),
    fr = frameAt(state.x0);
  const dtrim = Math.max(0, Math.min(-state.sheer.zf(state.x0), DMAX)); // sheer-trim depth below the flat deck
  const yAt = (u: number) => fr.p[1] + st.n(u) * fr.n[1]; // world y along the section (the d-axis is vertical)
  const ncl = Math.abs(fr.n[1]) > 1e-6 ? -fr.p[1] / fr.n[1] : NMAX; // inboard offset where the section meets y=0

  // full interpolated station, faint and dashed (the raw swept curve, deck to keel)
  const full: [number, number][] = [],
    N = 200;
  for (let i = 0; i <= N; i++) {
    const u = (st.tmax * i) / N;
    full.push([snX(st.n(u)), snY(st.d(u))]);
  }
  svg.append(
    el("path", {
      d: poly(full),
      fill: "none",
      stroke: COL.station,
      "stroke-width": 1.4,
      opacity: 0.4,
      "stroke-dasharray": "5 4",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );

  // kept span [umin,umax]: top at the sheer trim, bottom at the centerline — mirrors sweptSection
  let umin = 0,
    umax = st.tmax,
    open = true;
  const FN = 240;
  if (dtrim > 0) {
    umin = st.tmax;
    for (let i = 1; i <= FN; i++) {
      const u = (st.tmax * i) / FN;
      if (st.d(u) >= dtrim) {
        const da = st.d((st.tmax * (i - 1)) / FN);
        umin = (st.tmax * (i - 1 + (dtrim - da) / (st.d(u) - da || 1))) / FN;
        break;
      }
    }
  }
  let prev = yAt(0);
  for (let i = 1; i <= FN; i++) {
    const u = (st.tmax * i) / FN,
      y = yAt(u);
    if (prev >= 0 && y < 0) {
      umax = (st.tmax * (i - 1 + prev / (prev - y))) / FN;
      open = false;
      break;
    }
    prev = y;
  }
  const empty = umin >= umax - 1e-6; // keel shallower than the trim ⇒ nothing kept

  // kept arc, bold
  if (!empty) {
    const kept: [number, number][] = [],
      KN = 120;
    for (let i = 0; i <= KN; i++) {
      const u = umin + ((umax - umin) * i) / KN;
      kept.push([snX(st.n(u)), snY(st.d(u))]);
    }
    svg.append(
      el("path", {
        d: poly(kept),
        fill: "none",
        stroke: COL.station,
        "stroke-width": 2.6,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  }

  // sheer trim (horizontal at d=dtrim) + the point where the section starts
  if (dtrim > 0) {
    svg.append(
      el("line", {
        x1: snX(NMIN),
        y1: snY(dtrim),
        x2: snX(NMAX),
        y2: snY(dtrim),
        stroke: COL.sheer,
        "stroke-width": 1.5,
        "stroke-dasharray": "5 4",
      }),
    );
    const tl = el("text", { x: snX(NMIN) + 4, y: snY(dtrim) - 4, "font-size": 10, fill: COL.sheer });
    tl.textContent = "sheer trim";
    svg.append(tl);
    if (!empty)
      svg.append(
        el("circle", {
          cx: snX(st.n(umin)),
          cy: snY(st.d(umin)),
          r: 4,
          fill: "#fff",
          stroke: COL.sheer,
          "stroke-width": 1.6,
        }),
      );
  }
  // centerline trim (vertical at n=ncl) + the keel point where the section closes
  const nclC = Math.max(NMIN, Math.min(ncl, NMAX));
  svg.append(
    el("line", {
      x1: snX(nclC),
      y1: snY(0),
      x2: snX(nclC),
      y2: snY(DMAX),
      stroke: COL.keel,
      "stroke-width": 1.5,
      opacity: open ? 0.4 : 1,
      "stroke-dasharray": "5 4",
    }),
  );
  const cl = el("text", {
    x: snX(nclC) - 4,
    y: snY(DMAX) - 6,
    "text-anchor": "end",
    "font-size": 10,
    fill: COL.keel,
  });
  cl.textContent = "centerline";
  svg.append(cl);
  if (!open && !empty)
    svg.append(
      el("circle", {
        cx: snX(st.n(umax)),
        cy: snY(st.d(umax)),
        r: 4,
        fill: "#fff",
        stroke: COL.keel,
        "stroke-width": 1.6,
      }),
    );
  // design waterline at this station: the depth where worldZ = −waterline (combines sinkage + rake)
  const dWL = (state.waterline + state.x0 * Math.sin(state.deckRake)) / Math.cos(state.deckRake);
  if (dWL > 0 && dWL < DMAX) {
    svg.append(
      el("line", {
        x1: snX(NMIN),
        y1: snY(dWL),
        x2: snX(NMAX),
        y2: snY(dWL),
        stroke: COL.wl,
        "stroke-width": 1.5,
        opacity: 0.9,
        "stroke-dasharray": "5 4",
      }),
    );
    const wt = el("text", { x: snX(NMAX) - 4, y: snY(dWL) - 4, "text-anchor": "end", "font-size": 10, fill: COL.wl });
    wt.textContent = "WL";
    svg.append(wt);
  }

  // mark where the currently selected template point lands on this interpolated station (its blend by w(x0))
  const selIdx = selStationIdx();
  if (selIdx !== null) {
    const wt = weightsAt(state.x0);
    let bn = 0,
      bd = 0;
    state.templates.forEach((tpl, j) => {
      bn += wt[j] * tpl[selIdx].n;
      bd += wt[j] * tpl[selIdx].d;
    });
    linkDot(svg, snX(bn), snY(bd), COL.station);
  }
}

// classic body plan: the trimmed hull stations overlaid on one cross-section frame, sharing a
// centerline — forward stations on the right half, aft stations on the left (mirrored). Each section
// already carries both trims (sheer trim at the top, centerline trim at the keel).
function drawBodyPlan(svg: SVGSVGElement): void {
  svg.replaceChildren();
  const NB = 24,
    secs: { f: number; s: Section }[] = [];
  for (let i = 0; i <= NB; i++) {
    const x = (L * i) / NB,
      s = clippedSection(x, 40);
    if (!s.aft) secs.push({ f: x / L, s });
  }
  let ymax = 1,
    zmin = 0;
  for (const o of secs)
    for (const p of o.s.pts) {
      ymax = Math.max(ymax, Math.abs(p[1]));
      zmin = Math.min(zmin, p[2]);
    }
  const W = 360,
    H = 360,
    pad = 26;
  const sc = Math.min((W - 2 * pad) / (2 * ymax), (H - 2 * pad) / (0 - zmin || 1));
  const cx = W / 2,
    top = pad + 6;
  const Y = (y: number) => cx + y * sc,
    Z = (z: number) => top - z * sc; // z=0 at top (deck), keel below
  // deck reference + centerline
  svg.append(
    el("line", { x1: pad, y1: Z(0), x2: W - pad, y2: Z(0), stroke: COL.deck, "stroke-width": 1.3, "stroke-dasharray": "6 4" }),
  );
  svg.append(
    el("line", { x1: cx, y1: Z(0) - 6, x2: cx, y2: Z(zmin), stroke: COL.keel, "stroke-width": 1.2, opacity: 0.6, "stroke-dasharray": "4 4" }),
  );
  const tA = el("text", { x: pad, y: Z(0) - 6, "font-size": 10, fill: COL.aft });
  tA.textContent = "AFT";
  svg.append(tA);
  const tF = el("text", { x: W - pad, y: Z(0) - 6, "text-anchor": "end", "font-size": 10, fill: COL.fore });
  tF.textContent = "FWD";
  svg.append(tF);
  // stations: fore on the right (+y), aft mirrored to the left (−y)
  for (const o of secs) {
    const fwd = o.f >= 0.5,
      col = fwd ? COL.fore : COL.aft,
      sgn = fwd ? 1 : -1;
    const pts = o.s.pts.map((p): [number, number] => [Y(sgn * p[1]), Z(p[2])]);
    svg.append(
      el("path", {
        d: poly(pts),
        fill: "none",
        stroke: col,
        "stroke-width": 1.2,
        opacity: 0.75,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  }
  // highlight the live cut station
  const cut = clippedSection(state.x0, 40),
    fwd = state.x0 / L >= 0.5,
    sgn = fwd ? 1 : -1;
  if (!cut.aft)
    svg.append(
      el("path", {
        d: poly(cut.pts.map((p): [number, number] => [Y(sgn * p[1]), Z(p[2])])),
        fill: "none",
        stroke: COL.station,
        "stroke-width": 2.4,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
}

// ---------- 3D shaded hull (WebGL) ----------
// Orthographic camera that reproduces the old projection: yaw spins about the vertical (z = up), pitch
// tilts. The vertex shader maps world (x,y,z) to NDC the same way the SVG renderer mapped to screen, and
// fills a real depth buffer so the transom/hull overlap correctly. Per-pixel Phong + specular; a zebra
// mode bands the surface by the reflected eye direction so unfair (non-smooth) spots show as kinked lines.
let GL: WebGLRenderingContext | null = null,
  prog: WebGLProgram | null = null,
  loc: Record<string, any> = {},
  posBuf: WebGLBuffer | null = null,
  nrmBuf: WebGLBuffer | null = null;

interface Mesh {
  pos: Float32Array;
  nrm: Float32Array;
  count: number;
}

const VERT_SRC = `
attribute vec3 aPos; attribute vec3 aNormal;
uniform float uc1,us1,uc2,us2,uKX,uKY,uCX,uCY,ucxm,uczm,uDepth,uRakeC,uRakeS;
varying vec3 vN; varying vec3 vW; varying float vWZ;
void main(){
  float rx=aPos.x*uRakeC - aPos.z*uRakeS;     // deck rake: rotate the hull about y through the sheer origin
  float rz=aPos.x*uRakeS + aPos.z*uRakeC;
  float X=rx-ucxm, Z=rz-uczm, y=aPos.y;
  float X1=X*uc1 - y*us1;
  float Y1=X*us1 + y*uc1;
  float sx=X1, sy=Y1*us2 + Z*uc2;            // screen-space position (world units), boat-centered
  float ndcx=(sx-uCX)*uKX;                    // fit-to-box: per-axis scale → isometric at any canvas aspect
  float ndcy=(sy-uCY)*uKY;
  float ndcz=(uc2*Y1 - us2*Z)/uDepth;        // nearer (old depth large) → smaller → passes LESS test
  gl_Position=vec4(ndcx,ndcy,ndcz,1.0);
  vN=vec3(aNormal.x*uRakeC - aNormal.z*uRakeS, aNormal.y, aNormal.x*uRakeS + aNormal.z*uRakeC);
  vW=aPos;
  vWZ=rz;                                      // true (raked) world height, for the waterline boot-top
}`;
const FRAG_SRC = `
precision highp float;
varying vec3 vN; varying vec3 vW; varying float vWZ;
uniform vec3 uLight,uView,uBase; uniform float uStripes,uAlpha,uWaterZ,uPaint; uniform int uZebra;
void main(){
  vec3 N=normalize(vN), V=normalize(uView);
  if(dot(N,V)<0.0) N=-N;                      // two-sided
  vec3 Lc=normalize(uLight);
  // half-Lambert: wrap the light around so the terminator is soft (less harsh) and the form still reads
  float diff=dot(N,Lc)*0.5+0.5; diff*=diff;
  vec3 H=normalize(Lc+V);
  float spec=pow(max(dot(N,H),0.0),26.0);     // broader, gentler highlight than a tight 48
  if(uZebra==1){
    vec3 R=reflect(-V,N);
    float band=sin(atan(R.z,R.y)*uStripes);
    float s=smoothstep(-0.14,0.14,band);
    vec3 col=mix(vec3(0.07,0.09,0.15),vec3(0.97,0.98,1.0),s)*(0.66+0.34*diff);
    gl_FragColor=vec4(col,uAlpha);
  } else {
    // below the design waterline the hull wears bottom paint: a darker body, but still glossy so the
    // surface reads. A soft 8mm boot-top (smoothstep) avoids an aliased paint line; uPaint gates it off.
    float sub=(1.0 - smoothstep(uWaterZ-4.0, uWaterZ+4.0, vWZ)) * uPaint;
    vec3 body=uBase*0.34 + uBase*diff*0.80;
    body=mix(body, uBase*(0.14 + 0.34*diff), sub);  // darken the diffuse body below the DWL
    vec3 col=body + vec3(1.0)*spec*0.40;            // softer specular highlight on top (still glossy)
    gl_FragColor=vec4(clamp(col,0.0,1.0),uAlpha);
  }
}`;

function glShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || "shader compile error");
  return s;
}
function initGL(): void {
  GL = cv3d.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: false });
  const gl = GL!;
  prog = gl.createProgram()!;
  gl.attachShader(prog, glShader(gl, gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(prog, glShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  loc = {};
  ["aPos", "aNormal"].forEach((n) => (loc[n] = gl.getAttribLocation(prog!, n)));
  ["uc1", "us1", "uc2", "us2", "uKX", "uKY", "uCX", "uCY", "ucxm", "uczm", "uDepth", "uRakeC", "uRakeS", "uLight", "uView", "uBase", "uStripes", "uAlpha", "uZebra", "uWaterZ", "uPaint"].forEach(
    (n) => (loc[n] = gl.getUniformLocation(prog!, n)),
  );
  posBuf = gl.createBuffer();
  nrmBuf = gl.createBuffer();
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);
}

// the "longitudinal" of a single template-point index: the locus that control point traces as the section
// sweeps from stern to bow. At each x the blended point (lerp of the aft/fore control point by f = x/L) is
// placed into the world by the frame there — the same construction the hull surface uses — so the curve
// rides exactly on the swept sheet (it is the keel line when idx is the keel point, a chine line at a
// knuckle, etc.). Each sample is trimmed exactly as the hull is — by the sheer-trim line, the centerline,
// and the transom plane — so the line stops where the hull does (an overshooting keel point, for instance,
// only shows where it actually reaches the centerline). Drawn as a thin camera-facing ribbon (GL line
// width is unreliable), starboard plus its port mirror, nudged toward the eye by BIAS so it sits just
// proud of the surface without z-fighting.
function buildLongitudinalMesh(idx: number, view: Vec3): Mesh {
  const tpl = state.templates;
  if (idx < 0 || idx >= tpl[0].length) return { pos: new Float32Array(0), nrm: new Float32Array(0), count: 0 };
  const N = 160,
    HW = 5, // ribbon half-width (mm) — a thin guide line
    BIAS = 22, // shift toward the eye (mm) so the line floats just above the hull it lies on
    off = V.scale(view, BIAS);
  const W: Vec3[] = [],
    keep: boolean[] = []; // each sample trimmed the same way the hull surface is
  for (let i = 0; i <= N; i++) {
    const x = (L * i) / N,
      wt = weightsAt(x); // the blend at this station mixes the same template point across all templates
    let n = 0,
      d = 0;
    for (let j = 0; j < tpl.length; j++) {
      n += wt[j] * tpl[j][idx].n;
      d += wt[j] * tpl[j][idx].d;
    }
    const fr = frameAt(x),
      w: Vec3 = [
        fr.p[0] + n * fr.n[0] + d * fr.d[0],
        fr.p[1] + n * fr.n[1] + d * fr.d[1],
        fr.p[2] + n * fr.n[2] + d * fr.d[2],
      ];
    W.push(w);
    // kept iff below the sheer-trim line (depth ≥ trim depth), not past the centerline (world y ≥ 0),
    // and forward of the raked transom plane (x ≥ xTransom(z)) — the same three clips the hull gets.
    keep.push(d >= -state.sheer.zf(x) && w[1] >= 0 && w[0] >= xTransom(w[2]));
  }
  const P: number[] = [],
    Nn: number[] = [];
  const emitSide = (sgn: number) => {
    const M = W.map((p): Vec3 => [p[0], sgn * p[1], p[2]]); // sgn = -1 mirrors to port
    const Ls: Vec3[] = [],
      Rs: Vec3[] = [];
    for (let i = 0; i <= N; i++) {
      const t = V.norm(V.sub(M[Math.min(i + 1, N)], M[Math.max(i - 1, 0)]));
      let w = V.cross(t, view); // ribbon width axis ⟂ tangent and the eye ⇒ always faces the camera
      if (V.dot(w, w) < 1e-9) w = V.cross(t, [0, 0, 1]);
      const wn = V.scale(V.norm(w), HW),
        c = M[i];
      Ls.push([c[0] + wn[0] + off[0], c[1] + wn[1] + off[1], c[2] + wn[2] + off[2]]);
      Rs.push([c[0] - wn[0] + off[0], c[1] - wn[1] + off[1], c[2] - wn[2] + off[2]]);
    }
    for (let i = 0; i < N; i++) {
      if (!keep[i] || !keep[i + 1]) continue; // break the ribbon across trimmed-away spans
      pushTri(P, Nn, Ls[i], view, Rs[i], view, Rs[i + 1], view);
      pushTri(P, Nn, Ls[i], view, Rs[i + 1], view, Ls[i + 1], view);
    }
  };
  emitSide(1);
  emitSide(-1);
  return { pos: new Float32Array(P), nrm: new Float32Array(Nn), count: P.length / 3 };
}

// A fair section grid for the trimmed hull: each row is one station from the sheer-trim (top) down to
// the keel, sampled uniformly in x and WITHOUT the transom cut. Because the rows are never renormalised
// to a clipped sub-span, adjacent stations stay parallel (no sliver shear), so the surface is smooth all
// the way aft. The transom is then taken out by clipping this grid against the transom plane (below),
// which yields an exact, shared hull/transom edge instead of two independently sampled curves.
function bilgeRows(N: number, M: number, trim: boolean): Vec3[][] {
  const rows: Vec3[][] = [];
  for (let i = 0; i <= N; i++) {
    // trimmed: sheer-trim → keel, no transom clip (done later by clipQuad). untrimmed: the raw swept
    // sheet, full station deck → tmax with no trims at all.
    const s = sweptSection((L * i) / N, M, trim, false);
    if (!s.aft) rows.push(s.pts);
  }
  return rows;
}
// smooth per-vertex normals on a grid via central differences (orientation is irrelevant — shader is two-sided)
function gridNormal(rows: Vec3[][], i: number, j: number): Vec3 {
  const R = rows.length,
    C = rows[0].length;
  const a = rows[Math.min(i + 1, R - 1)][j],
    b = rows[Math.max(i - 1, 0)][j];
  const c = rows[i][Math.min(j + 1, C - 1)],
    d = rows[i][Math.max(j - 1, 0)];
  return V.norm(V.cross(V.sub(c, d), V.sub(a, b)));
}
function pushTri(
  P: number[],
  Nn: number[],
  p0: Vec3,
  n0: Vec3,
  p1: Vec3,
  n1: Vec3,
  p2: Vec3,
  n2: Vec3,
): void {
  P.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
  Nn.push(n0[0], n0[1], n0[2], n1[0], n1[1], n1[2], n2[0], n2[1], n2[2]);
}

// the transom plane gate: forward of the raked cut (kept) where this is ≥ 0
const transomGate = (p: Vec3): number => p[0] - xTransom(p[2]);
const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
interface PN {
  p: Vec3;
  n: Vec3;
}
// Sutherland–Hodgman clip of a quad against transomGate ≥ 0, carrying per-vertex normals. Returns the
// kept (forward) polygon and, if the quad straddles the plane, the cut segment lying on the transom.
function clipQuad(poly: PN[]): { inside: PN[]; cut: [Vec3, Vec3] | null } {
  const out: PN[] = [],
    cutPts: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length],
      ga = transomGate(a.p),
      gb = transomGate(b.p);
    if (ga >= 0) out.push(a);
    if (ga >= 0 !== gb >= 0) {
      const t = ga / (ga - gb),
        ip = lerpV(a.p, b.p, t),
        inrm = V.norm(lerpV(a.n, b.n, t));
      out.push({ p: ip, n: inrm });
      cutPts.push(ip);
    }
  }
  return { inside: out, cut: cutPts.length === 2 ? [cutPts[0], cutPts[1]] : null };
}

// build the hull triangle soup by clipping the fair grid against the transom plane; also collect the cut
// segments so the transom panel can be built from the very same edge. mirror ⇒ add the port half.
// trimmed ⇒ clip the fair grid against the transom plane, collect the cut edge, and mirror to the port
// half (a closed hull). Untrimmed ⇒ emit the raw swept sheet as-is: one side, no sheer/transom/keel trim.
function buildHullMesh(trimmed: boolean): { hull: Mesh; cuts: [Vec3, Vec3][] } {
  const M = 44,
    rows = bilgeRows(180, M, trimmed),
    R = rows.length,
    C = M + 1,
    P: number[] = [],
    Nn: number[] = [],
    cuts: [Vec3, Vec3][] = [];
  const nrm = rows.map((_, i) => rows[i].map((_, j) => gridNormal(rows, i, j)));
  const emit = (a: PN, b: PN, c: PN): void => {
    pushTri(P, Nn, a.p, a.n, b.p, b.n, c.p, c.n);
    if (trimmed) {
      const m = (q: PN): PN => ({ p: [q.p[0], -q.p[1], q.p[2]], n: [q.n[0], -q.n[1], q.n[2]] });
      const ma = m(a),
        mb = m(b),
        mc = m(c);
      pushTri(P, Nn, ma.p, ma.n, mc.p, mc.n, mb.p, mb.n); // reversed winding for the mirror
    }
  };
  for (let i = 0; i < R - 1; i++)
    for (let j = 0; j < C - 1; j++) {
      const quad: PN[] = [
        { p: rows[i][j], n: nrm[i][j] },
        { p: rows[i + 1][j], n: nrm[i + 1][j] },
        { p: rows[i + 1][j + 1], n: nrm[i + 1][j + 1] },
        { p: rows[i][j + 1], n: nrm[i][j + 1] },
      ];
      if (!trimmed) {
        emit(quad[0], quad[1], quad[2]); // raw sheet: the whole quad, untrimmed
        emit(quad[0], quad[2], quad[3]);
        continue;
      }
      const { inside, cut } = clipQuad(quad);
      if (cut) cuts.push(cut);
      for (let k = 1; k + 1 < inside.length; k++) emit(inside[0], inside[k], inside[k + 1]); // fan
    }
  return { hull: { pos: new Float32Array(P), nrm: new Float32Array(Nn), count: P.length / 3 }, cuts };
}

// the ordered starboard transom edge (sheer→keel) recovered from the hull-clip cut segments: collapse to
// a single half-breadth-vs-depth curve, snap the bottom onto the centerline so the two halves meet cleanly
function transomCurve(cuts: [Vec3, Vec3][]): Vec3[] {
  const pts: Vec3[] = [];
  const seen = new Set<string>();
  for (const seg of cuts)
    for (const q of seg) {
      const key = Math.round(q[2] / 4) + "," + Math.round(q[1] / 4);
      if (!seen.has(key)) {
        seen.add(key);
        pts.push(q);
      }
    }
  pts.sort((a, b) => b[2] - a[2]); // top (z high, at the sheer) → bottom (z low, at the keel)
  if (pts.length) pts[pts.length - 1] = [pts[pts.length - 1][0], 0, pts[pts.length - 1][2]];
  return pts;
}

// the flat transom panel, built from the shared hull edge so it meets the hull with no gap or overlap
function buildTransomMesh(cuts: [Vec3, Vec3][]): Mesh {
  const e = transomCurve(cuts);
  if (e.length < 2) return { pos: new Float32Array(0), nrm: new Float32Array(0), count: 0 };
  const [ta, tb] = state.sheer.transom,
    slope = (tb.x - ta.x) / (tb.z - ta.z || 1),
    nt = V.norm([-1, 0, slope]), // outward (aft-facing)
    P: number[] = [],
    Nn: number[] = [];
  for (let i = 0; i < e.length - 1; i++) {
    const a = e[i],
      b = e[i + 1],
      ap: Vec3 = [a[0], -a[1], a[2]],
      bp: Vec3 = [b[0], -b[1], b[2]];
    pushTri(P, Nn, a, nt, ap, nt, bp, nt);
    pushTri(P, Nn, a, nt, bp, nt, b, nt);
  }
  return { pos: new Float32Array(P), nrm: new Float32Array(Nn), count: P.length / 3 };
}
function drawMesh(gl: WebGLRenderingContext, mesh: Mesh, base: number[]): void {
  if (!mesh.count) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(loc.aPos);
  gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.nrm, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(loc.aNormal);
  gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 0, 0);
  gl.uniform3fv(loc.uBase, base);
  gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
}
let meshHull: Mesh | null = null,
  meshTrans: Mesh | null = null,
  meshBBox: number[] | null = null; // [x0,y0,z0, x1,y1,z1] world bounds of the hull mesh, for fit-to-box

function computeBBox(pos: Float32Array): number[] | null {
  if (!pos.length) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  }
  return [x0, y0, z0, x1, y1, z1];
}

// project a world point to screen space (world units), boat-centered — mirrors the vertex shader so the
// CPU can frame the camera to the mesh bounding box
function screenXY(
  px: number, py: number, pz: number,
  c1: number, s1: number, c2: number, s2: number, rc: number, rs: number, cxm: number, czm: number,
): [number, number] {
  const rx = px * rc - pz * rs,
    rz = px * rs + pz * rc,
    X = rx - cxm,
    Z = rz - czm,
    X1 = X * c1 - py * s1,
    Y1 = X * s1 + py * c1;
  return [X1, Y1 * s2 + Z * c2];
}

// the screen-space extent (and center) of the bbox's 8 corners under a given rotation
function projExtent(
  bb: number[], c1: number, s1: number, c2: number, s2: number, rc: number, rs: number, cxm: number, czm: number,
): { exX: number; exY: number; cX: number; cY: number } {
  let sxmin = Infinity, sxmax = -Infinity, symin = Infinity, symax = -Infinity;
  for (let ix = 0; ix < 2; ix++)
    for (let iy = 0; iy < 2; iy++)
      for (let iz = 0; iz < 2; iz++) {
        const [sx, sy] = screenXY(bb[ix ? 3 : 0], bb[iy ? 4 : 1], bb[iz ? 5 : 2], c1, s1, c2, s2, rc, rs, cxm, czm);
        if (sx < sxmin) sxmin = sx;
        if (sx > sxmax) sxmax = sx;
        if (sy < symin) symin = sy;
        if (sy > symax) symax = sy;
      }
  return { exX: Math.max(sxmax - sxmin, 1), exY: Math.max(symax - symin, 1), cX: (sxmin + sxmax) / 2, cY: (symin + symax) / 2 };
}

// the zoom is fixed: it frames a NOMINAL hull box (≈ the default hull's overall size) at a reference
// orientation, so it depends only on the canvas size — not on the live rotation, the edited geometry, or
// the rake. The live hull then just sits inside that fixed frame, centered.
const REF_YAW = -0.62,
  REF_PITCH = 0.42,
  NOMINAL: number[] = [0, -950, -1300, 4000, 950, 0]; // [x0,y0,z0, x1,y1,z1]

export function draw3d(rebuild?: boolean): void {
  if (!GL) initGL();
  const trimmed = state.view3d === "trimmed";
  if (rebuild !== false || !meshHull) {
    const built = buildHullMesh(trimmed);
    meshHull = built.hull;
    meshTrans = trimmed ? buildTransomMesh(built.cuts) : null;
    meshBBox = computeBBox(meshHull.pos);
  }
  const gl = GL!,
    cv = gl.canvas as HTMLCanvasElement,
    dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(cv.clientWidth * dpr),
    h = Math.round(cv.clientHeight * dpr); // fill the canvas's CSS box (any aspect)
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  gl.viewport(0, 0, cv.width, cv.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(prog);
  const c1 = Math.cos(state.rot.yaw),
    s1 = Math.sin(state.rot.yaw),
    c2 = Math.cos(state.rot.pitch),
    s2 = Math.sin(state.rot.pitch);
  gl.uniform1f(loc.uc1, c1);
  gl.uniform1f(loc.us1, s1);
  gl.uniform1f(loc.uc2, c2);
  gl.uniform1f(loc.us2, s2);
  // Framing: a FIXED zoom (no auto-zoom). The scale frames the nominal hull box at the reference
  // orientation, unraked, so it changes only with the canvas size. The center tracks the LIVE rotation and
  // the live hull bounds, so the hull pivots in place, staying centered, at a constant size.
  const cxm = L / 2,
    czm = (ZMIN + ZMAX) / 2,
    rc = Math.cos(state.deckRake),
    rs = Math.sin(state.deckRake),
    bb = meshBBox ?? NOMINAL;
  const ref = projExtent(NOMINAL, Math.cos(REF_YAW), Math.sin(REF_YAW), Math.cos(REF_PITCH), Math.sin(REF_PITCH), 1, 0, cxm, czm),
    live = projExtent(bb, c1, s1, c2, s2, rc, rs, cxm, czm),
    pxScale = 0.92 * Math.min(w / ref.exX, h / ref.exY);
  gl.uniform1f(loc.uKX, (pxScale * 2) / w);
  gl.uniform1f(loc.uKY, (pxScale * 2) / h);
  gl.uniform1f(loc.uCX, live.cX);
  gl.uniform1f(loc.uCY, live.cY);
  gl.uniform1f(loc.ucxm, cxm);
  gl.uniform1f(loc.uczm, czm);
  gl.uniform1f(loc.uDepth, 3000);
  gl.uniform1f(loc.uRakeC, Math.cos(state.deckRake)); // deck rake floats the hull at its trim
  gl.uniform1f(loc.uRakeS, Math.sin(state.deckRake));
  gl.uniform1f(loc.uAlpha, 1.0);
  const view = V.norm([-c2 * s1, -c2 * c1, s2]); // surface→eye direction (orthographic)
  gl.uniform3fv(loc.uView, view);
  // key light at the lower-left of the screen, raking (well off the view axis) so 3/4 views read as
  // form instead of flat front-lighting, with a smaller toward-eye term to keep the visible faces lit.
  // right/up are the screen axes expressed in world; left = −right, down = −up.
  const right: Vec3 = [c1, -s1, 0],
    up: Vec3 = [s2 * s1, s2 * c1, c2];
  gl.uniform3fv(
    loc.uLight,
    V.norm([
      0.5 * view[0] - 0.85 * right[0] - 0.85 * up[0],
      0.5 * view[1] - 0.85 * right[1] - 0.85 * up[1],
      0.5 * view[2] - 0.85 * right[2] - 0.85 * up[2],
    ]),
  );
  gl.uniform1f(loc.uStripes, 11.0);
  gl.uniform1i(loc.uZebra, state.zebra ? 1 : 0);
  gl.uniform1f(loc.uWaterZ, -state.waterline); // boot-top height in world z; below it the hull is bottom-painted
  gl.uniform1f(loc.uPaint, 1.0); // hull + transom take bottom paint
  drawMesh(gl, meshHull, [0.3, 0.5, 0.72]);
  if (meshTrans) {
    gl.uniform1i(loc.uZebra, 0);
    drawMesh(gl, meshTrans, [0.74, 0.55, 0.37]);
  } // transom always solid
  // selected station point → draw its longitudinal (swept locus along x) on top of the hull, in amber
  const li = selStationIdx();
  if (li !== null) {
    gl.uniform1i(loc.uZebra, 0);
    gl.uniform1f(loc.uPaint, 0.0); // guide ribbon keeps its amber above and below the waterline
    drawMesh(gl, buildLongitudinalMesh(li, view), [0.96, 0.62, 0.04]); // matches the 2D link-marker amber
  }
}

// ---------- control-point dots ----------
const HILITE = "#f59e0b"; // amber "linked" marker (cut station + the 3D guide ribbon)
const SEL = "#ef4444"; // the currently selected control point is drawn in this red

// is the given point the current selection? (for templates, the template index `ti` must match too)
function isSelected(tgt: ActiveTarget, idx: number, ti?: number): boolean {
  const a = state.selected;
  return !!a && a.tgt === tgt && a.idx === idx && (ti === undefined || a.ti === ti);
}

// a small red ✕ marking the spot that corresponds (same index) to the selected point — drawn on the other
// templates' ghost curves so you can see where that control point lands on the other sections
function redX(svg: SVGSVGElement, sx: number, sy: number): void {
  const r = 4.5;
  for (const [dx, dy] of [[-1, -1], [-1, 1]] as const)
    svg.append(
      el("line", { x1: sx + dx * r, y1: sy + dy * r, x2: sx - dx * r, y2: sy - dy * r, stroke: SEL, "stroke-width": 2, "stroke-linecap": "round" }),
    );
}

// mark the point that CORRESPONDS (same index) to the current selection on the interpolated cut station:
// a dashed amber ring over a dot in `col`, reading as "linked", matching the amber 3D guide ribbon.
function linkDot(svg: SVGSVGElement, sx: number, sy: number, col: string): void {
  svg.append(
    el("circle", { cx: sx, cy: sy, r: 8, fill: "none", stroke: HILITE, "stroke-width": 2, opacity: 0.9, "stroke-dasharray": "3 3" }),
  );
  svg.append(el("circle", { cx: sx, cy: sy, r: 3.5, fill: col, stroke: "#fff", "stroke-width": 1.2 }));
}
// the selected template-point index, or null when the selection isn't a template point
function selStationIdx(): number | null {
  const a = state.selected;
  return a && a.tgt === "template" && a.idx < state.templates[0].length ? a.idx : null;
}

function cpDot(svg: SVGSVGElement, idx: number, sx: number, sy: number): void {
  const c = el("circle", { cx: sx, cy: sy, r: 5.5, fill: isSelected("plan", idx) ? SEL : COL.sheer, stroke: "#fff", "stroke-width": 1.5 });
  c.addEventListener("pointerdown", (e) => sheerPointDown(idx, svg, e));
  svg.append(c);
}
function trimDot(svg: SVGSVGElement, idx: number, sx: number, sy: number): void {
  const c = el("circle", { cx: sx, cy: sy, r: 5.5, fill: isSelected("trim", idx) ? SEL : COL.sheer, stroke: "#fff", "stroke-width": 1.5 });
  c.addEventListener("pointerdown", (e) => trimPointDown(idx, svg, e));
  svg.append(c);
}
function transomDot(svg: SVGSVGElement, idx: number, sx: number, sy: number): void {
  const c = el("circle", { cx: sx, cy: sy, r: 5.5, fill: isSelected("transom", idx) ? SEL : "var(--transom)", stroke: "#fff", "stroke-width": 1.5 });
  c.addEventListener("pointerdown", (e) => transomPointDown(idx, svg, e));
  svg.append(c);
}
