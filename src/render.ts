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
  transomEdge,
  xTransom,
  chordParam,
  fairEval,
  weightsAt,
  immersion,
  worldZ,
  forwardLimit,
  LINES_MODES,
  type View3DMode,
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
  Lbase,
  yPlan,
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
  svgW,
  tplCards,
  sideTabs,
  tplColor,
  cv3d,
} from "./dom.js";
import { trimmedHullGrid } from "./step.js";
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
  refreshKeelUI,
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
  // Sample to the hull's true forward closure (forwardLimit), not the LOA: a tumblehome bow closes past x=L,
  // and a fine bow closes before it. Cosine spacing clusters stations toward the transom and the stem, where
  // the keel and waterlines sweep up fastest, so the bow is resolved instead of spanned by a couple of points.
  const NSEC = 80,
    xFwd = forwardLimit(),
    sections: Section[] = [];
  for (let i = 0; i <= NSEC; i++) {
    const x = (xFwd * (1 - Math.cos((Math.PI * i) / NSEC))) / 2;
    sections.push(clippedSection(x, 18));
  }
  let zmin = 0;
  for (const s of sections) {
    if (s.aft) continue;
    for (const p of s.pts) zmin = Math.min(zmin, p[2]);
  }
  drawPlan(sections, zmin);
  drawProfile(sections, zmin);
  drawWeights(svgW);
  drawCutStation(svgC); // the cut station lives in its own (always-visible) panel in the lower right column
  drawSidePanels(); // template editors share one tab strip; show the active one
  draw3d(true);
  const profVal = document.getElementById("profVal") as HTMLElement;
  const h = clippedSection(state.x0, 18);
  // (label uses the live cut) — draft + breadth are measured against the design waterline
  const wl = waterlineStats(h),
    open = h.open ? " · open" : "";
  profVal.textContent = wl.wet
    ? `x=${Math.round(state.x0)}${open} · draft ${Math.round(wl.draft)} · WL beam ${Math.round(wl.beam)}`
    : `x=${Math.round(state.x0)}${open} · above WL`;
}

// Where the plan curve's inboard radius of curvature R is smaller than the section's inboard reach, the
// fanned station planes cross and the swept surface folds (cusps) — every offset from R inward is doubled
// over. The fold's outboard edge is at offset R along the normal (the plan curve's centre of curvature / its
// evolute); the inboard edge is the section's deepest swept point (the keel where it closes, otherwise the
// open bottom). This is section-aware: a station is flagged only where the rendered section actually reaches
// offset R. Each run carries, per station, the plan edges (world x,y at offsets R and n_max) and the profile
// band (z at the offset-R depth and at the deepest depth), so both views can shade the same folded region.
type CuspPt = { x: number; outer: [number, number]; inner: [number, number]; zTop: number; zBot: number };
function cuspRuns(): CuspPt[][] {
  const yf = state.sheer.yf,
    e = 1,
    N = 120,
    runs: CuspPt[][] = [];
  let run: CuspPt[] = [];
  const flush = (): void => {
    if (run.length) runs.push(run);
    run = [];
  };
  for (let i = 0; i <= N; i++) {
    const x = (L * i) / N,
      yp = (yf(x + e) - yf(x - e)) / (2 * e),
      ypp = (yf(x + e) - 2 * yf(x) + yf(x - e)) / (e * e);
    let hit: CuspPt | null = null;
    // concave toward the centerline, and tight enough that R is below the geometric centerline reach
    if (ypp < -1e-9 && Math.pow(1 + yp * yp, 1.5) / -ypp < yf(x) * Math.sqrt(1 + yp * yp)) {
      const R = Math.pow(1 + yp * yp, 1.5) / -ypp,
        fr = frameAt(x),
        sec = sweptSection(x, 72, true);
      if (!(sec.aft && !sec.keel)) {
        let dR = -1,
          nMax = -Infinity,
          dMax = -Infinity;
        for (const p of sec.pts) {
          const n = (p[0] - fr.p[0]) * fr.n[0] + (p[1] - fr.p[1]) * fr.n[1], // inboard offset along n̂
            d = -p[2];
          if (n >= R && dR < 0) dR = d;
          if (n > nMax) nMax = n;
          if (d > dMax) dMax = d;
        }
        if (nMax >= R && dR >= 0 && dMax > dR)
          hit = {
            x,
            outer: [fr.p[0] + R * fr.n[0], fr.p[1] + R * fr.n[1]], // offset R — the cuspidal edge
            inner: [fr.p[0] + nMax * fr.n[0], fr.p[1] + nMax * fr.n[1]], // deepest swept offset
            zTop: -dR,
            zBot: -dMax,
          };
      }
    }
    if (hit) run.push(hit);
    else flush();
  }
  flush();
  return runs;
}

function drawPlan(sections: Section[], _zmin: number): void {
  const svg = svgL;
  svg.replaceChildren();
  gridX(svg, 8, LH - 8);
  // (waterline contours other than the DWL footprint are shown in the 3D Waterline lines view, not here)
  // faint band below the centerline (y < 0): "past the centerline" — where the sheer plan crosses to close a
  // tumblehome bow.
  svg.append(
    el("rect", { x: PXpad, y: Lbase, width: 1000 - 2 * PXpad, height: LH - Lbase, fill: "var(--keel)", opacity: 0.05 }),
  );
  // centerline (y = 0)
  svg.append(
    el("line", {
      x1: PXpad,
      y1: Lbase,
      x2: 1000 - PXpad,
      y2: Lbase,
      stroke: "var(--keel)",
      "stroke-width": 1.5,
      opacity: 0.5,
      "stroke-dasharray": "4 4",
    }),
  );
  const cl = el("text", {
    x: PXpad - 4,
    y: Lbase - 4,
    "text-anchor": "end",
    "font-size": 10,
    fill: "var(--keel)",
  });
  cl.textContent = "CL";
  svg.append(cl);
  stationLine(svg, 8, LH - 8);
  // the sheer plan curve (the deck-edge half-breadth) — drawn only out to the last control point; the plan is
  // not extrapolated past what the user drew (the hull ends at the last cp too, see forwardLimit)
  const xEnd = state.sheer.cp[state.sheer.cp.length - 1].x,
    xs: number[] = [];
  for (let i = 0; i <= 110; i++) xs.push((xEnd * i) / 110);
  // the plan control polygon: the sheer points are B-spline handles, not on-curve, so show the polygon
  // they define faintly behind the curve (the curve interpolates only the ends and stays inside the rest)
  svg.append(
    el("path", {
      d: poly(state.sheer.cp.map((cp) => [mapX(cp.x), yPlan(cp.y)])),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 1,
      opacity: 0.35,
      "stroke-dasharray": "3 4",
    }),
  );
  svg.append(
    el("path", {
      d: poly(xs.map((x) => [mapX(x), yPlan(state.sheer.yf(x))])),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 2,
      opacity: 0.8,
      "stroke-dasharray": "8 5", // the sheer plan is the control/guide; the max-beam line below is the result
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
  // widest-point (max-beam) longitudinal: the locus of each section's widest point. On a tumblehome hull it
  // lies OUTBOARD of the sheer (deck edge), and where it reaches the centerline is the true bow closure — so
  // it is the line to watch when shaping a tumblehome bow (the deck can close while the body is still open).
  const beam: Vec3[] = [];
  for (const s of sections) {
    if (s.aft || !s.pts.length) continue;
    let p = s.pts[0];
    for (const q of s.pts) if (q[1] > p[1]) p = q;
    beam.push(p);
  }
  if (beam.length > 1)
    svg.append(
      el("path", {
        d: poly(beam.map((p) => [mapX(p[0]), yPlan(p[1])])),
        fill: "none",
        stroke: COL.fore,
        "stroke-width": 2.4, // the result line — drawn solid and heavier than the dashed sheer-plan guide
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  // transom footprint in plan (centerline → sheer at the stern)
  const te = transomEdge();
  if (te.length > 1) {
    svg.append(
      el("path", {
        d: poly(te.map((p) => [mapX(p[0]), yPlan(p[1])])),
        fill: "none",
        stroke: "var(--transom)",
        "stroke-width": 2.2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  }
  // design-waterline footprint (where the hull meets the WL plane)
  for (const run of dwlContour(sections)) {
    svg.append(
      el("path", {
        d: poly(run.map((p) => [mapX(p[0]), yPlan(p[1])])),
        fill: "none",
        stroke: COL.wl,
        "stroke-width": 2,
        opacity: 0.85,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  }
  // cusp marker: where the plan curvature is too tight for the beam the swept surface folds. Shade the whole
  // folded area — from the cuspidal edge (offset R) inboard to the deepest swept point — in red.
  for (const run of cuspRuns()) {
    const ring = run
      .map((s): [number, number] => [mapX(s.outer[0]), yPlan(s.outer[1])])
      .concat(run.slice().reverse().map((s): [number, number] => [mapX(s.inner[0]), yPlan(s.inner[1])]));
    svg.append(
      el("path", {
        d: poly(ring) + "Z",
        fill: "#e11d48",
        "fill-opacity": 0.22,
        stroke: "#e11d48",
        "stroke-width": 1.4,
        "stroke-linejoin": "round",
      }),
    );
  }
  // cut station — true plan heading (the fan angle)
  cutTrace(svg, (p) => [mapX(p[0]), yPlan(p[1])]);
  svg.append(
    el("circle", {
      cx: mapX(state.x0),
      cy: yPlan(state.sheer.yf(state.x0)),
      r: 3.2,
      fill: "#fff",
      stroke: COL.sheer,
      "stroke-width": 1.5,
    }),
  );
  state.sheer.cp.forEach((cp, idx) => cpDot(svg, idx, mapX(cp.x), yPlan(cp.y)));
}

function drawProfile(sections: Section[], _zmin: number): void {
  const svg = svgP;
  svg.replaceChildren();
  gridX(svg, Ptop - 4, PZbase);
  stationLine(svg, Ptop - 4, PZbase);
  // (buttock contours are shown in the 3D Buttocks lines view, not here)
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
  // design waterline: horizontal in world ⇒ a raked line in this deck-frame profile (slope = the rake).
  // Runs all the way forward to the hull's closure (forwardLimit), past the LOA for a tumblehome bow.
  const xFwd = forwardLimit(),
    wlS = Math.sin(state.deckRake),
    wlC = Math.cos(state.deckRake),
    zWL = (x: number) => (-state.waterline - x * wlS) / wlC;
  svg.append(
    el("line", {
      x1: mapX(0),
      y1: zScreenP(zWL(0)),
      x2: mapX(xFwd),
      y2: zScreenP(zWL(xFwd)),
      stroke: COL.wl,
      "stroke-width": 1.8,
      opacity: 0.9,
    }),
  );
  const wll = el("text", {
    x: mapX(xFwd) - 4,
    y: zScreenP(zWL(xFwd)) - 5,
    "text-anchor": "end",
    "font-size": 10,
    fill: COL.wl,
  });
  wll.textContent = "DWL";
  svg.append(wll);
  // emergent keel + stem, drawn as one continuous outline from transom to bow so it MATCHES the 3D mesh:
  //  • aft: start at the transom's deepest point (where the transom outline reaches the centerline);
  //  • bottom: the keel/rocker — the deepest point of each closing section (s.pts[last]) — rising to the bow;
  //  • stem: at a tumblehome bow the deck tucks to the centerline, so the section TOP (s.pts[0]) dives below
  //    the authored trim and meets the keel at the forefoot. Trace that diving top edge back from the forefoot
  //    to where it rejoins the trim — the real raked leading edge, not a fabricated plumb line.
  const closing = sections.filter((s) => s.keel && s.pts.length > 1);
  const keel = closing.map((s) => s.pts[s.pts.length - 1]);
  if (keel.length) {
    const te = transomEdge();
    if (te.length) keel.unshift(te[te.length - 1]); // transom keel: deepest point of the transom outline
    // the bow stem: the CONTIGUOUS run of forwardmost sections whose top has dived below the authored trim
    // (the tumblehome lens). Only the forward run — a section's top can also drop below the trim near the
    // transom (the raked transom clip), and including those would draw a stray line back to the transom.
    const dived = (s: Section): boolean => s.pts[0][2] < state.sheer.zf(s.pts[0][0]) - 3;
    let b = closing.length;
    while (b > 0 && dived(closing[b - 1])) b--;
    const stem = closing.slice(b).map((s) => s.pts[0]); // forward, increasing x
    if (stem.length) for (let i = stem.length - 1; i >= 0; i--) keel.push(stem[i]); // forefoot → back to the trim
    else keel.push([xFwd, 0, state.sheer.zf(xFwd)]); // a fine bow closes straight onto the trim at the stem
  }
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
  // the trim control polygon, shown faint (the curve interpolates these points, with per-point knuckles)
  svg.append(
    el("path", {
      d: poly(state.sheer.trim.map((cp) => [mapX(cp.x), zScreenP(cp.z)])),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 1,
      opacity: 0.35,
      "stroke-dasharray": "3 4",
    }),
  );
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
  // cusp marker: shade the folded depth band (offset = R down to the deepest swept point) at the cusping
  // stations, in red — the same folded region the plan view shades.
  for (const run of cuspRuns()) {
    const top = run.map((s): [number, number] => [mapX(s.x), zScreenP(s.zTop)]),
      bot = run.map((s): [number, number] => [mapX(s.x), zScreenP(s.zBot)]).reverse();
    svg.append(
      el("path", {
        d: poly(top.concat(bot)) + "Z",
        fill: "#e11d48",
        "fill-opacity": 0.22,
        stroke: "#e11d48",
        "stroke-width": 1.4,
        "stroke-linejoin": "round",
      }),
    );
  }
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
  state.sheer.trim.forEach((cp, idx) => trimDot(svg, idx, mapX(cp.x), zScreenP(cp.z), cp.k));
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
let sideTab = 0; // active tab: a template index (the Cut view is now its own panel, not a tab)
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

// show only the active template panel; the others stay drawn but hidden, so switching tabs is instant
function applySideTab(): void {
  tplEls.forEach((svg, j) => (svg.style.display = sideTab === j ? "" : "none"));
}

function setSideTab(t: number): void {
  sideTab = t;
  applySideTab();
  buildSideTabs();
  refreshKeelUI(); // the keel slider targets the active template tab
}

// the active template tab as a template index (always a template now that Cut is its own panel)
export function activeTemplateIndex(): number | null {
  return sideTab;
}

// the tab strip: one tab per template (its accent color; the active one carries a ✕ to remove it), then a
// "+" to add a template.
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
  if (sideTab >= K) sideTab = K - 1; // a removed template → clamp
  tplEls.forEach((svg, j) => drawStation(svg, j));
  buildSideTabs();
  applySideTab();
  refreshKeelUI(); // keep the keel slider in sync after add/remove/clamp of the active tab
}

// the horizontal blend ribbon: x runs left→right (shared mapX, aligned with plan/profile), and at each x
// the templates stack BOTTOM→TOP, band j being template j's share — the bands summing to 1 everywhere.
// Each station shows the K−1 band-boundary handles (drag ↕) that edit the simplex split; x is set in the
// plan view (the station is shared). The red cut slider (shared stationLine) scrubs x here too.
function drawWeights(svg: SVGSVGElement): void {
  svg.replaceChildren();
  const K = state.templates.length,
    top = wY(1),
    bot = wY(0),
    xEnd = state.sheer.cp[state.sheer.cp.length - 1].x,
    xL = mapX(0),
    xR = mapX(xEnd);
  gridX(svg, top, bot); // vertical x-gridlines (quarters of the length) — aligned with plan/profile
  // simplex guides at 0 / ½ / 1: horizontal
  for (const g of [0, 0.5, 1])
    svg.append(el("line", { x1: xL, y1: wY(g), x2: xR, y2: wY(g), stroke: "#edf2f7", "stroke-width": 1 }));
  // stacked bands from the sampled curve (each band a horizontal ribbon, its top/bottom edges varying with x)
  const NS = 120,
    xs: number[] = [],
    cum: number[][] = [];
  for (let i = 0; i <= NS; i++) {
    const x = (xEnd * i) / NS,
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
  // stern / bow labels (x runs stern→bow, left→right)
  for (const [txt, x, anchor] of [
    ["stern", xL, "start"],
    ["bow", xR, "end"],
  ] as const) {
    const t = el("text", { x, y: top - 4, "font-size": 10, fill: COL.mut, "text-anchor": anchor });
    t.textContent = txt;
    svg.append(t);
  }
  stationLine(svg, top, bot); // the red cut scrubber (vertical, shared with the plan/profile strips)
  // control points: a vertical guide + the K−1 band-boundary handles (drag ↕). One column per unified
  // station at its x; x is set in the plan view (the station is shared), so there is no x-handle here.
  state.sheer.cp.forEach((cp, i) => {
    const x = mapX(cp.x),
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

  const st = stationAt(state.x0, true), // the keel-knuckle symmetric section — matches the trimmed hull
    fr = frameAt(state.x0);
  const dtrim = Math.max(0, Math.min(-state.sheer.zf(state.x0), DMAX)); // sheer-trim depth below the flat deck
  const yAt = (u: number) => fr.p[1] + st.n(u) * fr.n[1]; // world y along the section (the d-axis is vertical)
  const ncl = Math.abs(fr.n[1]) > 1e-6 ? -fr.p[1] / fr.n[1] : NMAX; // inboard offset where the section meets y=0

  // kept span [umin,umax]: top at the sheer trim, bottom at the centerline (the keel) — mirrors sweptSection
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

  // the full adjusted section, faint and dashed — both halves: sheer → keel (at the midpoint) → port sheer,
  // so the mirrored keel-rounded shape is visible across the centerline
  const full: [number, number][] = [],
    N = 300;
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

  // DIAGNOSTIC: the raw interpolated half-section (before the keel mirror/round), magenta, so the keel
  // construction's effect is visible — where the magenta and the gray diverge near the centerline is exactly
  // the mirror + keel-flatten/round at work.
  const raw = stationAt(state.x0, false),
    rawPts: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const u = (raw.tmax * i) / N;
    rawPts.push([snX(raw.n(u)), snY(raw.d(u))]);
  }
  svg.append(
    el("path", {
      d: poly(rawPts),
      fill: "none",
      stroke: "#c026d3",
      "stroke-width": 1.4,
      opacity: 0.8,
      "stroke-dasharray": "2 3",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
  for (const [txt, col, y] of [
    ["raw interpolated", "#c026d3", 16],
    ["mirrored + keel-round", COL.station, 30],
  ] as const) {
    const t = el("text", { x: snX(NMIN) + 4, y, "font-size": 10, fill: col });
    t.textContent = txt;
    svg.append(t);
  }

  // kept arc, bold — both sides: from the starboard sheer trim (umin) through the keel to the port sheer
  // trim (its mirror at tmax − umin), so the surviving hull section shows full width with its keel
  if (!empty) {
    const kept: [number, number][] = [],
      KN = 240,
      ka = umin,
      kb = st.tmax - umin;
    for (let i = 0; i <= KN; i++) {
      const u = ka + ((kb - ka) * i) / KN;
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
  // (no keel-point marker here — it would sit right on the seam and hide the very continuity being inspected;
  // the blended keel knuckle is shown by the keel slider)
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
    HW = 1.25, // ribbon half-width (units) — a thin guide line
    BIAS = 6, // shift toward the eye (units) so the line floats just above the hull it lies on
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

// A fair section grid sampled uniformly in x and WITHOUT the transom cut (clipQuad does that below, so
// adjacent stations stay parallel — no sliver shear — and the surface is smooth all the way aft).
//
// For the TRIMMED hull each row is the FULL-WIDTH section: starboard sheer-trim → keel → port sheer-trim,
// built as ONE continuous curve (the starboard half plus its y-mirror, sharing the single keel point at
// the centre). The keel is therefore an interior column and inherits the section's C¹ smoothness across
// the centerline. The old approach sampled the starboard half and mirrored the whole SURFACE, which only
// joins smoothly if the half meets the centerline with zero depth-slope; at a steep (e.g. narrow-transom)
// stern it doesn't, so the mirror folded the keel into a visible welt ("pucker"). One continuous row has
// no seam to fold. For an OPEN section (never reaches the centerline) there is no port half to join, so
// the row carries an `open` flag and buildHullMesh leaves the centre strip unbridged (a real gap there).
//
// Untrimmed (the raw swept sheet) is unchanged: one side, full station deck → tmax, no trims, no mirror.
function bilgeRows(
  N: number,
  M: number,
  trim: boolean,
): { rows: Vec3[][]; open: boolean[]; creaseS: number[][] } {
  const rows: Vec3[][] = [],
    open: boolean[] = [],
    creaseS: number[][] = []; // per row, per column: crease strength (0 = smooth, 1 = hard)
  // for the trimmed hull, stop the forward sweep at the bow closure so the surface tapers to a clean stem
  // (forward of it the forefoot is above the sheer trim — no hull); the raw untrimmed sheet runs to L.
  const xMax = trim ? forwardLimit() : L;
  for (let i = 0; i <= N; i++) {
    // cosine (Chebyshev) spacing clusters stations toward the transom and the bow, so the fine bow tapers
    // over many rows instead of collapsing in one — smoother shading and no abrupt facet at the stem.
    const x = xMax * 0.5 * (1 - Math.cos((Math.PI * i) / N));
    const s = sweptSection(x, M, trim, false);
    if (s.aft) continue;
    if (!trim) {
      rows.push(s.pts); // raw sheet: half only, meshed without a mirror
      open.push(true);
      creaseS.push(new Array(s.pts.length).fill(0));
      continue;
    }
    // full width: starboard sheer→keel (cols 0..M), then port keel→sheer (cols M+1..2M) as the y-mirror,
    // dropping the duplicate keel point so a closed section reads as one smooth curve through y=0.
    const full: Vec3[] = s.pts.slice();
    for (let j = M - 1; j >= 0; j--) full.push([s.pts[j][0], -s.pts[j][1], s.pts[j][2]]);
    rows.push(full);
    open.push(s.open);
    // map the half-section crease columns to the full row: a chine at half-col c sits at c and 2M−c; the
    // keel (half-col M) is the centre col M. Strength = the blended knuckle / keel-V from the section.
    const cs = new Array(2 * M + 1).fill(0);
    for (let t = 0; t < s.creaseCols.length; t++) {
      const c = s.creaseCols[t],
        k = s.creaseK[t];
      if (c === M) cs[M] = k;
      else {
        cs[c] = k;
        cs[2 * M - c] = k;
      }
    }
    creaseS.push(cs);
  }
  return { rows, open, creaseS };
}
// per-vertex grid normal (orientation irrelevant — shader is two-sided). side = 0 uses the central
// transverse difference (smooth); side = +1/−1 uses a ONE-SIDED difference (toward the next/previous
// column) — the two faces of a crease column, so a knuckle/keel-V reads as a hard edge.
function gridNormal(rows: Vec3[][], i: number, j: number, side = 0): Vec3 {
  const R = rows.length,
    C = rows[0].length;
  const a = rows[Math.min(i + 1, R - 1)][j],
    b = rows[Math.max(i - 1, 0)][j];
  const c = side < 0 ? rows[i][j] : rows[i][Math.min(j + 1, C - 1)],
    d = side > 0 ? rows[i][j] : rows[i][Math.max(j - 1, 0)];
  const n = V.cross(V.sub(c, d), V.sub(a, b));
  // On the centerline (the keel, y = 0) a smooth keel's normal must have no transverse component. The
  // central difference is one-sided in y here, tilting it; zero the y-component so the two halves join
  // smoothly. (A V keel reads from its off-centerline faces via the one-sided side ≠ 0 normals.)
  if (side === 0 && Math.abs(rows[i][j][1]) < 1e-6) n[1] = 0;
  return V.norm(n);
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
// segments so the transom panel can be built from the very same edge.
// trimmed ⇒ the rows are FULL-WIDTH (port-sheer → keel → starboard-sheer, no mirror): clip each quad
// against the transom plane and collect the cut edge — one continuous skin with a seamless keel.
// Untrimmed ⇒ emit the raw swept sheet as-is: one side, no sheer/transom/keel trim.
function buildHullMesh(trimmed: boolean): { hull: Mesh; cuts: [Vec3, Vec3][] } {
  const M = 44,
    { rows, open, creaseS } = bilgeRows(180, M, trimmed),
    R = rows.length,
    C = rows[0]?.length ?? 0,
    P: number[] = [],
    Nn: number[] = [],
    cuts: [Vec3, Vec3][] = [];
  if (R < 2 || C < 2)
    return { hull: { pos: new Float32Array(0), nrm: new Float32Array(0), count: 0 }, cuts };
  const nrmC = rows.map((_, i) => rows[i].map((_, j) => gridNormal(rows, i, j)));
  // the normal at vertex (i,j) as seen from the strip on side `dir` (+1 = the strip to its right, −1 left).
  // On a crease column the two sides use one-sided normals (the crease's two faces), blended toward the
  // smooth central normal by the local crease strength — so a hard knuckle reads as an edge and a faded
  // one stays smooth. Off a crease column both sides return the shared central normal (no seam).
  const vN = (i: number, j: number, dir: number): Vec3 => {
    const s = creaseS[i]?.[j] ?? 0;
    if (s <= 1e-6) return nrmC[i][j];
    return V.norm(lerpV(nrmC[i][j], gridNormal(rows, i, j, dir), s));
  };
  const emit = (a: PN, b: PN, c: PN): void => pushTri(P, Nn, a.p, a.n, b.p, b.n, c.p, c.n);
  for (let i = 0; i < R - 1; i++)
    for (let j = 0; j < C - 1; j++) {
      // the keel sits at column M of a full-width row; where the section is open there is no surface
      // across the centerline, so don't bridge the strip just inboard of the open bottom on the port side.
      if (trimmed && j === M && (open[i] || open[i + 1])) continue;
      // cols j / j+1 bound this strip: col j sees the strip on its right (+1), col j+1 on its left (−1)
      const quad: PN[] = [
        { p: rows[i][j], n: vN(i, j, +1) },
        { p: rows[i + 1][j], n: vN(i + 1, j, +1) },
        { p: rows[i + 1][j + 1], n: vN(i + 1, j + 1, -1) },
        { p: rows[i][j + 1], n: vN(i, j + 1, -1) },
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
// a single half-breadth-vs-depth curve, snap the bottom onto the centerline so the two halves meet cleanly.
// The hull grid is now FULL WIDTH, so the cut segments span both halves; keep only the starboard side
// (y ≥ 0) — buildTransomMesh mirrors it back to port — else the edge zigzags across the centerline.
function transomCurve(cuts: [Vec3, Vec3][]): Vec3[] {
  const pts: Vec3[] = [];
  const seen = new Set<string>();
  for (const seg of cuts)
    for (const q of seg) {
      if (q[1] < -2) continue; // port side; the mirror rebuilds it (keep the centerline crossing, y≈0)
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
  NOMINAL: number[] = [0, -238, -325, 1000, 238, 0]; // [x0,y0,z0, x1,y1,z1]

// ---------- lines-plan wireframe (SVG overlay) ----------
// A white, unshaded line drawing in the style of a hand-drawn hull lines plan: a transparent mesh of
// stations (transverse) and longitudinals, with the feature edges (sheer, keel, stem, transom, chines) bold
// and the interior grid thin. Rendered as SVG so the strokes can carry real, view-independent line weights
// (WebGL clamps lineWidth to 1 on most browsers). It reuses the 3D canvas's camera, so it rotates live.
const LINES_NS = 80,
  LINES_M = 10,
  LINES_STATION_STEP = 3; // draw a station (transverse) line every Nth grid row (≈ NS/STEP stations)
let linesGrid: { grid: Vec3[][]; creaseCols: number[] } | null = null;

interface ProjPt {
  x: number;
  y: number;
  d: number;
}
interface LineQuad {
  poly: ProjPt[];
  depth: number; // toward-eye; larger = nearer
  bold: [ProjPt, ProjPt][]; // sheer / keel / chine longitudinals (heavy)
  fam: [ProjPt, ProjPt][]; // the mode's non-chine family: stations / buttocks / waterlines (lighter)
  wl: [ProjPt, ProjPt][]; // design-waterline crossing through this facet (blue, all modes)
}

function drawLines(svg: SVGSVGElement, kind: View3DMode, rebuild: boolean): void {
  if (rebuild || !linesGrid) linesGrid = trimmedHullGrid(LINES_NS, LINES_M);
  const { grid, creaseCols } = linesGrid;
  svg.replaceChildren();
  const NS = grid.length - 1,
    M = grid[0].length - 1;
  if (NS < 1 || M < 1) return;

  // project world (x,y,z) → screen, the same transform as the WebGL vertex shader (deck rake, then yaw about
  // up, then pitch); SVG y is down, so negate. `d` is the toward-eye depth (larger = nearer) for painter sort.
  const c1 = Math.cos(state.rot.yaw),
    s1 = Math.sin(state.rot.yaw),
    c2 = Math.cos(state.rot.pitch),
    s2 = Math.sin(state.rot.pitch),
    cT = Math.cos(state.deckRake),
    sT = Math.sin(state.deckRake);
  const proj = ([x, y, z]: Vec3): ProjPt => {
    const rx = x * cT - z * sT,
      rz = x * sT + z * cT;
    return { x: rx * c1 - y * s1, y: -((rx * s1 + y * c1) * s2 + rz * c2), d: -c2 * s1 * rx - c2 * c1 * y + s2 * rz };
  };
  // projected point grids for both sides (starboard + the y-mirror)
  const SP = grid.map((row) => row.map(proj));
  const PP = grid.map((row) => row.map(([x, y, z]) => proj([x, -y, z])));
  const crease = new Set(creaseCols);
  const showStation = (i: number): boolean => i === 0 || i === NS || i % LINES_STATION_STEP === 0;
  const gridM = grid.map((row) => row.map(([x, y, z]): Vec3 => [x, -y, z])); // port-side world points

  // line-family levels (only the active mode's are used): evenly spaced constant-y (buttocks) and constant
  // worldZ (waterlines), bracketed by the hull's own range so they sit inside it.
  let ymax = 0,
    zlo = Infinity,
    zhi = -Infinity;
  for (const row of grid)
    for (const p of row) {
      if (Math.abs(p[1]) > ymax) ymax = Math.abs(p[1]);
      const wz = worldZ(p[0], p[2]);
      if (wz < zlo) zlo = wz;
      if (wz > zhi) zhi = wz;
    }
  const NB = 8,
    NW = 12,
    buttLevels = Array.from({ length: NB }, (_, k) => (ymax * (k + 1)) / (NB + 1)),
    wlLevels = Array.from({ length: NW }, (_, k) => zlo + ((zhi - zlo) * (k + 1)) / (NW + 1));
  // marching: the segment where field f crosses `level` across a facet's 4 corners (linear on each edge)
  const march = (corn: { p: ProjPt; f: number }[], level: number): [ProjPt, ProjPt] | null => {
    const cr: ProjPt[] = [];
    for (let k = 0; k < 4; k++) {
      const a = corn[k],
        b = corn[(k + 1) % 4],
        fa = a.f - level,
        fb = b.f - level;
      if (fa < 0 !== fb < 0 && fa !== fb) {
        const t = fa / (fa - fb);
        cr.push({ x: a.p.x + t * (b.p.x - a.p.x), y: a.p.y + t * (b.p.y - a.p.y), d: a.p.d + t * (b.p.d - a.p.d) });
      }
    }
    return cr.length >= 2 ? [cr[0], cr[1]] : null;
  };

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const quads: LineQuad[] = [];
  for (const [G, GW] of [[SP, grid], [PP, gridM]] as [ProjPt[][], Vec3[][]][])
    for (let i = 0; i < NS; i++)
      for (let j = 0; j < M; j++) {
        const A = G[i][j],
          B = G[i][j + 1],
          C = G[i + 1][j + 1],
          D = G[i + 1][j];
        for (const p of [A, B, C, D]) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        const wA = GW[i][j],
          wB = GW[i][j + 1],
          wC = GW[i + 1][j + 1],
          wD = GW[i + 1][j];
        const bold: [ProjPt, ProjPt][] = [];
        if (j === 0 || crease.has(j)) bold.push([D, A]); // sheer / chine longitudinal
        if (j + 1 === M || crease.has(j + 1)) bold.push([B, C]); // keel / chine longitudinal
        if (i === 0) bold.push([A, B]); // transom trim line — bold in every mode (it is a hull edge)
        // the mode's non-chine family
        const fam: [ProjPt, ProjPt][] = [];
        if (kind === "body") {
          if (showStation(i) && i !== 0) fam.push([A, B]); // station at this row (the transom is drawn bold)
          if (i === NS - 1 && showStation(NS)) fam.push([D, C]); // bow/forwardmost station
        } else if (kind === "buttocks") {
          const corn = [{ p: A, f: Math.abs(wA[1]) }, { p: B, f: Math.abs(wB[1]) }, { p: C, f: Math.abs(wC[1]) }, { p: D, f: Math.abs(wD[1]) }];
          for (const lv of buttLevels) {
            const s = march(corn, lv);
            if (s) fam.push(s);
          }
        } else {
          const corn = [
            { p: A, f: worldZ(wA[0], wA[2]) }, { p: B, f: worldZ(wB[0], wB[2]) },
            { p: C, f: worldZ(wC[0], wC[2]) }, { p: D, f: worldZ(wD[0], wD[2]) },
          ];
          for (const lv of wlLevels) {
            const s = march(corn, lv);
            if (s) fam.push(s);
          }
        }
        // design waterline (blue, all modes): worldZ crosses −waterline
        const dc = [{ p: A, f: worldZ(wA[0], wA[2]) }, { p: B, f: worldZ(wB[0], wB[2]) }, { p: C, f: worldZ(wC[0], wC[2]) }, { p: D, f: worldZ(wD[0], wD[2]) }];
        const dwl = march(dc, -state.waterline);
        quads.push({ poly: [A, B, C, D], depth: (A.d + B.d + C.d + D.d) / 4, bold, fam, wl: dwl ? [dwl] : [] });
      }
  quads.sort((a, b) => a.depth - b.depth); // far → near: nearer white facets are drawn last and occlude

  // FIXED zoom (matches the shaded view): the viewBox size frames the NOMINAL hull box at a reference
  // orientation, so it depends only on the overlay's pixel size — not the live rotation. Only the center
  // tracks the live hull, so it pivots in place at a constant size instead of rescaling as you rotate.
  const ref = projExtent(
    NOMINAL,
    Math.cos(REF_YAW), Math.sin(REF_YAW), Math.cos(REF_PITCH), Math.sin(REF_PITCH),
    1, 0, L / 2, (ZMIN + ZMAX) / 2,
  );
  const w = svg.clientWidth || 800,
    h = svg.clientHeight || 400;
  const pxScale = 0.92 * Math.min(w / ref.exX, h / ref.exY) * state.zoom;
  const vbw = w / pxScale,
    vbh = h / pxScale,
    cx = (minX + maxX) / 2,
    cy = (minY + maxY) / 2;
  svg.setAttribute(
    "viewBox",
    `${(cx - vbw / 2).toFixed(1)} ${(cy - vbh / 2).toFixed(1)} ${vbw.toFixed(1)} ${vbh.toFixed(1)}`,
  );
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // Painter's: each quad is an opaque WHITE facet (a white hairline stroke only closes the anti-alias seams).
  // Nearer facets, drawn later, paint over the lines behind them, so the far side is hidden like a solid hull.
  // Per facet we draw the occluded interior lines: stations, chines, and the design-waterline crossing (blue).
  const pts = (q: ProjPt[]): string => q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const line = (p0: ProjPt, p1: ProjPt, w: number, color: string): SVGElement =>
    el("line", {
      x1: p0.x.toFixed(1), y1: p0.y.toFixed(1), x2: p1.x.toFixed(1), y2: p1.y.toFixed(1),
      stroke: color, "stroke-width": w, "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
    });
  // The selected template point's longitudinal (the locus it sweeps) is drawn occluded like everything else:
  // its segments are mixed INTO the painter's order, each at its own depth, biased a hair toward the eye so it
  // sits just proud of its own facet (no z-fight) but is hidden behind any nearer surface. Built and trimmed
  // exactly like buildLongitudinalMesh. Amber, matching the shaded view's guide.
  type Item = { depth: number; q?: LineQuad; seg?: [ProjPt, ProjPt] };
  const items: Item[] = quads.map((q) => ({ depth: q.depth, q }));
  const li = selStationIdx();
  if (li !== null) {
    // world-space toward-eye direction (gradient of the projected depth), for the small proud-of-surface bias
    let vx = -c2 * s1 * cT + s2 * sT,
      vy = -c2 * c1,
      vz = c2 * s1 * sT + s2 * cT;
    const vl = Math.hypot(vx, vy, vz) || 1,
      BIAS = 15; // clear the coarse flat-facet chords (the guide rides facet interiors, not edges)
    (vx /= vl), (vy /= vl), (vz /= vl);
    const tpl = state.templates,
      NP = 120,
      WP: Vec3[] = [],
      keep: boolean[] = [];
    for (let i = 0; i <= NP; i++) {
      const x = (L * i) / NP,
        wt = weightsAt(x);
      let n = 0,
        d = 0;
      for (let t = 0; t < tpl.length; t++) {
        n += wt[t] * tpl[t][li].n;
        d += wt[t] * tpl[t][li].d;
      }
      const fr = frameAt(x),
        w: Vec3 = [fr.p[0] + n * fr.n[0] + d * fr.d[0], fr.p[1] + n * fr.n[1] + d * fr.d[1], fr.p[2] + n * fr.n[2] + d * fr.d[2]];
      WP.push(w);
      keep.push(d >= -state.sheer.zf(x) && w[1] >= 0 && w[0] >= xTransom(w[2]));
    }
    for (const sgn of [1, -1])
      for (let i = 0; i < NP; i++) {
        if (!keep[i] || !keep[i + 1]) continue;
        const a = proj([WP[i][0] + vx * BIAS, sgn * WP[i][1] + vy * BIAS, WP[i][2] + vz * BIAS]),
          b = proj([WP[i + 1][0] + vx * BIAS, sgn * WP[i + 1][1] + vy * BIAS, WP[i + 1][2] + vz * BIAS]);
        items.push({ depth: (a.d + b.d) / 2, seg: [a, b] });
      }
  }
  items.sort((a, b) => a.depth - b.depth); // far → near, facets and guide segments together

  for (const it of items) {
    if (it.seg) {
      svg.append(line(it.seg[0], it.seg[1], 1.8, HILITE)); // selected longitudinal (amber), occluded
      continue;
    }
    const q = it.q!;
    svg.append(
      el("polygon", {
        points: pts(q.poly),
        fill: "#ffffff", // white occlusion faces (the hull reads as a white shape on the grey background)
        stroke: "#ffffff",
        "stroke-width": 0.6,
        "stroke-linejoin": "round",
        "vector-effect": "non-scaling-stroke",
      }),
    );
    for (const [p0, p1] of q.wl) svg.append(line(p0, p1, 1.4, COL.wl)); // design waterline (blue)
    for (const [p0, p1] of q.fam) svg.append(line(p0, p1, 1, "#11181f")); // stations / buttocks / waterlines
    for (const [p0, p1] of q.bold) svg.append(line(p0, p1, 1.8, "#11181f")); // sheer / keel / chines (heavy)
  }
}

export function draw3d(rebuild?: boolean): void {
  // lines-plan style: draw the SVG overlay and skip the WebGL surface entirely
  const lines = document.getElementById("lines3d") as SVGSVGElement | null;
  if (LINES_MODES.includes(state.view3dMode) && lines) {
    lines.style.display = "";
    drawLines(lines, state.view3dMode, rebuild !== false);
    return;
  }
  if (lines) lines.style.display = "none";
  if (!GL) initGL();
  const trimmed = state.view3dMode !== "sheet";
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
    pxScale = 0.92 * Math.min(w / ref.exX, h / ref.exY) * state.zoom;
  gl.uniform1f(loc.uKX, (pxScale * 2) / w);
  gl.uniform1f(loc.uKY, (pxScale * 2) / h);
  gl.uniform1f(loc.uCX, live.cX);
  gl.uniform1f(loc.uCY, live.cY);
  gl.uniform1f(loc.ucxm, cxm);
  gl.uniform1f(loc.uczm, czm);
  gl.uniform1f(loc.uDepth, 750); // depth-range scale; ÷4 with the unitless L=1000 rescale to keep ndcz unchanged
  gl.uniform1f(loc.uRakeC, Math.cos(state.deckRake)); // deck rake floats the hull at its trim
  gl.uniform1f(loc.uRakeS, Math.sin(state.deckRake));
  gl.uniform1f(loc.uAlpha, 1.0);
  const view = V.norm([-c2 * s1, -c2 * c1, s2]); // surface→eye direction (orthographic)
  gl.uniform3fv(loc.uView, view);
  // key light at the lower-left of the screen, off the view axis so 3/4 views read as form rather than flat
  // front-lighting, with a toward-eye term to keep the visible faces lit. The toward-eye / off-axis balance
  // (EYE vs SIDE) sets how grazing the light is: a very grazing light is maximally sensitive to tiny normal
  // tilts, so it amplifies sub-degree faceting noise in the swept mesh into false puckering. Keeping a solid
  // off-axis component preserves the form read while easing the grazing enough to quiet that meshing noise.
  const right: Vec3 = [c1, -s1, 0],
    up: Vec3 = [s2 * s1, s2 * c1, c2];
  const EYE = 0.72,
    SIDE = 0.62;
  gl.uniform3fv(
    loc.uLight,
    V.norm([
      EYE * view[0] - SIDE * right[0] - SIDE * up[0],
      EYE * view[1] - SIDE * right[1] - SIDE * up[1],
      EYE * view[2] - SIDE * right[2] - SIDE * up[2],
    ]),
  );
  gl.uniform1f(loc.uStripes, 11.0);
  gl.uniform1i(loc.uZebra, state.view3dMode === "zebra" ? 1 : 0);
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
const SEL = "#ef4444"; // selected control point red — in the section editors (no red cut slider there)
const SELB = "#2563eb"; // selected control point blue — in plan/profile, where the red cut slider lives

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
  const c = el("circle", { cx: sx, cy: sy, r: 5.5, fill: isSelected("plan", idx) ? SELB : COL.sheer, stroke: "#fff", "stroke-width": 1.5 });
  c.addEventListener("pointerdown", (e) => sheerPointDown(idx, svg, e));
  svg.append(c);
}
function trimDot(svg: SVGSVGElement, idx: number, sx: number, sy: number, k: number): void {
  // morph round (k=0, smooth) → square (k=1, hard corner) via corner radius, like the template nodes
  const s = 5.5,
    rad = (1 - Math.min(Math.max(k, 0), 1)) * s;
  const c = el("rect", {
    x: sx - s,
    y: sy - s,
    width: 2 * s,
    height: 2 * s,
    rx: rad,
    ry: rad,
    fill: isSelected("trim", idx) ? SELB : COL.sheer,
    stroke: "#fff",
    "stroke-width": 1.5,
  });
  c.addEventListener("pointerdown", (e) => trimPointDown(idx, svg, e));
  svg.append(c);
}
function transomDot(svg: SVGSVGElement, idx: number, sx: number, sy: number): void {
  const c = el("circle", { cx: sx, cy: sy, r: 5.5, fill: isSelected("transom", idx) ? SELB : "var(--transom)", stroke: "#fff", "stroke-width": 1.5 });
  c.addEventListener("pointerdown", (e) => transomPointDown(idx, svg, e));
  svg.append(c);
}
