import { SEL, HILITE, SELB, COL, tplColor } from "./colors";
import { startDrag } from "./drag";
import type { Vec2, Vec3 } from "./math";
import {
  chordParam,
  clippedSection,
  DMAX,
  dwlContour,
  fairEval,
  forwardLimit,
  frameAt,
  L,
  NMAX,
  NMIN,
  sampleX,
  stationAt,
  sweptSection,
  transomEdge,
  weightsAt,
  type Model,
  type Section,
  type StationCP,
} from "./model";
import {
  isSelected,
  ModelSelection,
  OnModelSelect,
  selStationIdx,
} from "./modelSelection";
import {
  Lbase,
  LH,
  mapX,
  Ptop,
  PXpad,
  PZbase,
  snX,
  snY,
  wY,
  yPlan,
  zScreenP,
} from "./view";

const SVGNS = "http://www.w3.org/2000/svg";

export function el(
  tag: string,
  attrs: Record<string, string | number>,
): SVGElement {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

export function poly(pts: Vec2[]): string {
  let d = "";
  pts.forEach((p, i) => {
    d += (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1) + " ";
  });
  return d;
}

export const byId = (id: string): SVGSVGElement =>
  document.getElementById(id) as unknown as SVGSVGElement;

export function gridX(svg: SVGSVGElement, top: number, bot: number): void {
  for (let q = 0; q <= 4; q++) {
    const x = mapX((L * q) / 4);
    svg.append(
      el("line", {
        x1: x,
        y1: top,
        x2: x,
        y2: bot,
        stroke: "#edf2f7",
        "stroke-width": 1,
      }),
    );
  }
}

// the draggable cut handle: a triangle + an invisible vertical hit band at x0. The visible red line is
// the station's true-angle trace, drawn by the caller (drawPlan/drawProfile) from the swept section.
export function stationLine(
  model: Model,
  svg: SVGSVGElement,
  top: number,
  bot: number,
  onSelect: OnModelSelect,
): void {
  const x = mapX(model.x0);
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
  hit.addEventListener("pointerdown", (e) =>
    startDrag({ kind: "slider" }, svg, e, onSelect),
  );
  svg.append(hit);
  const tri = el("path", {
    d: `M${x - 6} ${top} L${x + 6} ${top} L${x} ${top + 9} Z`,
    fill: "var(--slider)",
    style: "cursor:ew-resize",
  });
  tri.addEventListener("pointerdown", (e) =>
    startDrag({ kind: "slider" }, svg, e, onSelect),
  );
  svg.append(tri);
}

export type Proj = (p: Vec3) => [number, number];

// the swept station at x0 projected into a 2D view → its true heading/rake (not a plain vertical cut)
export function cutTrace(model: Model, svg: SVGSVGElement, proj: Proj): void {
  const cut = clippedSection(model, model.x0, 40);
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

// Where the plan curve's inboard radius of curvature R is smaller than the section's inboard reach, the
// fanned station planes cross and the swept surface folds (cusps) — every offset from R inward is doubled
// over. The fold's outboard edge is at offset R along the normal (the plan curve's centre of curvature / its
// evolute); the inboard edge is the section's deepest swept point (the keel where it closes, otherwise the
// open bottom). This is section-aware: a station is flagged only where the rendered section actually reaches
// offset R. Each run carries, per station, the plan edges (world x,y at offsets R and n_max) and the profile
// band (z at the offset-R depth and at the deepest depth), so both views can shade the same folded region.

export type CuspPt = {
  x: number;
  outer: [number, number];
  inner: [number, number];
  zTop: number;
  zBot: number;
};

export function cuspRuns(model: Model): CuspPt[][] {
  const yf = model.sheer.yf,
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
    if (
      ypp < -1e-9 &&
      Math.pow(1 + yp * yp, 1.5) / -ypp < yf(x) * Math.sqrt(1 + yp * yp)
    ) {
      const R = Math.pow(1 + yp * yp, 1.5) / -ypp,
        fr = frameAt(model, x),
        sec = sweptSection(model, x, 72, true);
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

export function drawPlan(
  svg: SVGSVGElement, // = svgL;
  model: Model,
  selection: ModelSelection,
  sections: Section[],
  _zmin: number,
  onSelect: OnModelSelect,
): void {
  svg.replaceChildren();
  gridX(svg, 8, LH - 8);
  // (waterline contours other than the DWL footprint are shown in the 3D Waterline lines view, not here)
  // faint band below the centerline (y < 0): "past the centerline" — where the sheer plan crosses to close a
  // tumblehome bow.
  svg.append(
    el("rect", {
      x: PXpad,
      y: Lbase,
      width: 1000 - 2 * PXpad,
      height: LH - Lbase,
      fill: "var(--keel)",
      opacity: 0.05,
    }),
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
  stationLine(model, svg, 8, LH - 8, onSelect);
  // the sheer plan curve (the deck-edge half-breadth) — drawn only out to the last control point; the plan is
  // not extrapolated past what the user drew (the hull ends at the last cp too, see forwardLimit)
  const xEnd = model.sheer.cp[model.sheer.cp.length - 1].x,
    xs: number[] = [];
  for (let i = 0; i <= 110; i++) xs.push((xEnd * i) / 110);
  // the plan control polygon: the sheer points are B-spline handles, not on-curve, so show the polygon
  // they define faintly behind the curve (the curve interpolates only the ends and stays inside the rest)
  svg.append(
    el("path", {
      d: poly(model.sheer.cp.map((cp) => [mapX(cp.x), yPlan(cp.y)])),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 1,
      opacity: 0.35,
      "stroke-dasharray": "3 4",
    }),
  );
  svg.append(
    el("path", {
      d: poly(xs.map((x) => [mapX(x), yPlan(model.sheer.yf(x))])),
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
  const te = transomEdge(model);
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
  for (const run of dwlContour(model, sections)) {
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
  for (const run of cuspRuns(model)) {
    const ring = run
      .map((s): [number, number] => [mapX(s.outer[0]), yPlan(s.outer[1])])
      .concat(
        run
          .slice()
          .reverse()
          .map((s): [number, number] => [mapX(s.inner[0]), yPlan(s.inner[1])]),
      );
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
  cutTrace(model, svg, (p) => [mapX(p[0]), yPlan(p[1])]);
  svg.append(
    el("circle", {
      cx: mapX(model.x0),
      cy: yPlan(model.sheer.yf(model.x0)),
      r: 3.2,
      fill: "#fff",
      stroke: COL.sheer,
      "stroke-width": 1.5,
    }),
  );
  model.sheer.cp.forEach((cp, idx) =>
    cpDot(selection, svg, idx, mapX(cp.x), yPlan(cp.y), onSelect),
  );
}

export function drawProfile(
  svg: SVGSVGElement, // = svgP
  model: Model,
  selection: ModelSelection,
  sections: Section[],
  _zmin: number,
  onSelect: OnModelSelect,
): void {
  svg.replaceChildren();
  gridX(svg, Ptop - 4, PZbase);
  stationLine(model, svg, Ptop - 4, PZbase, onSelect);
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
  const xFwd = forwardLimit(model),
    wlS = Math.sin(model.deckRake),
    wlC = Math.cos(model.deckRake),
    zWL = (x: number) => (-model.waterline - x * wlS) / wlC;
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
    const te = transomEdge(model);
    if (te.length) keel.unshift(te[te.length - 1]); // transom keel: deepest point of the transom outline

    // the bow stem: the CONTIGUOUS run of forwardmost sections whose top has dived below the authored trim
    // (the tumblehome lens). Only the forward run — a section's top can also drop below the trim near the
    // transom (the raked transom clip), and including those would draw a stray line back to the transom.
    const dived = (s: Section): boolean =>
      s.pts[0][2] < model.sheer.zf(s.pts[0][0]) - 3;
    let b = closing.length;
    while (b > 0 && dived(closing[b - 1])) b--;
    const stem = closing.slice(b).map((s) => s.pts[0]); // forward, increasing x
    if (stem.length)
      for (let i = stem.length - 1; i >= 0; i--) keel.push(stem[i]); // forefoot → back to the trim
    else keel.push([xFwd, 0, model.sheer.zf(xFwd)]); // a fine bow closes straight onto the trim at the stem
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
      d: poly(model.sheer.trim.map((cp) => [mapX(cp.x), zScreenP(cp.z)])),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 1,
      opacity: 0.35,
      "stroke-dasharray": "3 4",
    }),
  );
  svg.append(
    el("path", {
      d: poly(xs.map((x) => [mapX(x), zScreenP(model.sheer.zf(x))])),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 2.4,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
  // transom: the construction line through the two control points (dashed) + the actual cut edge (solid)
  const [ta, tb] = model.sheer.transom;
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
  const te = transomEdge(model);
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
  for (const run of cuspRuns(model)) {
    const top = run.map((s): [number, number] => [mapX(s.x), zScreenP(s.zTop)]),
      bot = run
        .map((s): [number, number] => [mapX(s.x), zScreenP(s.zBot)])
        .reverse();
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
  cutTrace(model, svg, (p) => [mapX(p[0]), zScreenP(p[2])]);
  const h = clippedSection(model, model.x0, 18);
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
      cx: mapX(model.x0),
      cy: zScreenP(model.sheer.zf(model.x0)),
      r: 3.2,
      fill: "#fff",
      stroke: COL.sheer,
      "stroke-width": 1.5,
    }),
  );
  model.sheer.trim.forEach((cp, idx) =>
    trimDot(selection, svg, idx, mapX(cp.x), zScreenP(cp.z), cp.k, onSelect),
  );
  model.sheer.transom.forEach((cp, idx) =>
    transomDot(selection, svg, idx, mapX(cp.x), zScreenP(cp.z), onSelect),
  );
}

// one section-template editor (template `ti`): the other templates ghosted faint behind it, this one
// solid with draggable nodes. Built into a fresh svg by drawTemplates each render.

export function stnCurve(
  model: Model,
  svg: SVGSVGElement,
  pts: StationCP[],
  c: string,
  op: number,
): void {
  const ns = pts.map((p) => p.n),
    ds = pts.map((p) => p.d),
    ks = pts.map((p) => p.k),
    ts = chordParam(ns, ds);
  const nf = fairEval(model, ts, ns, ks),
    df = fairEval(model, ts, ds, ks),
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

export function drawStation(
  model: Model,
  selection: ModelSelection,
  svg: SVGSVGElement,
  ti: number,
  onSelect: OnModelSelect,
): void {
  svg.replaceChildren();
  const col = tplColor(ti),
    arr = model.templates[ti];
  // axes: sheer point at origin (top-left), n inboard →, d down ↓
  svg.append(
    el("line", {
      x1: snX(NMIN),
      y1: snY(0),
      x2: snX(NMAX),
      y2: snY(0),
      stroke: "#edf2f7",
      "stroke-width": 1,
    }),
  );
  svg.append(
    el("line", {
      x1: snX(0),
      y1: snY(0),
      x2: snX(0),
      y2: snY(DMAX),
      stroke: "#e2e8f0",
      "stroke-width": 1.2,
    }),
  );
  const sh = el("text", {
    x: snX(0) + 6,
    y: snY(0) - 6,
    "font-size": 10,
    fill: COL.mut || "#718096",
  });
  sh.textContent = "sheer";
  svg.append(sh);
  // faint ghosts of every other template, then this one solid
  model.templates.forEach((tpl, j) => {
    if (j !== ti) stnCurve(model, svg, tpl, tplColor(j), 0.16);
  });
  stnCurve(model, svg, arr, col, 1);
  arr.forEach((p, idx) => {
    const end = idx === 0,
      s = end ? 4 : 6,
      // knuckle applies to every point but the pinned sheer point (idx 0) — including the keel point;
      // the node morphs round (k=0) → square (k=1) via corner radius to show its sharpness
      knuck = idx > 0,
      k = knuck ? Math.min(Math.max(p.k, 0), 1) : 0,
      rad = (1 - k) * s,
      sel = isSelected(selection, "template", idx, ti); // the selected node is drawn solid red
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
    node.addEventListener("pointerdown", (e) =>
      stnPointDown(ti, idx, end, svg, e, onSelect),
    );
    svg.append(node);
  });
  // when a template point is selected, mark the corresponding index on every OTHER template's ghost curve
  // with a small red ✕, so you can see where that control point lands on the other sections.
  const si = selStationIdx(model, selection);
  if (si !== null)
    model.templates.forEach((tpl, j) => {
      if (j !== ti) redX(svg, snX(tpl[si].n), snY(tpl[si].d));
    });
}

// the horizontal blend ribbon: x runs left→right (shared mapX, aligned with plan/profile), and at each x
// the templates stack BOTTOM→TOP, band j being template j's share — the bands summing to 1 everywhere.
// Each station shows the K−1 band-boundary handles (drag ↕) that edit the simplex split; x is set in the
// plan view (the station is shared). The red cut slider (shared stationLine) scrubs x here too.

export function drawWeights(
  svg: SVGSVGElement,
  model: Model,
  selection: ModelSelection,
  onSelect: OnModelSelect,
): void {
  svg.replaceChildren();
  const K = model.templates.length,
    top = wY(1),
    bot = wY(0),
    xEnd = model.sheer.cp[model.sheer.cp.length - 1].x,
    xL = mapX(0),
    xR = mapX(xEnd);
  gridX(svg, top, bot); // vertical x-gridlines (quarters of the length) — aligned with plan/profile

  // simplex guides at 0 / ½ / 1: horizontal
  for (const g of [0, 0.5, 1])
    svg.append(
      el("line", {
        x1: xL,
        y1: wY(g),
        x2: xR,
        y2: wY(g),
        stroke: "#edf2f7",
        "stroke-width": 1,
      }),
    );
  // stacked bands from the sampled curve (each band a horizontal ribbon, its top/bottom edges varying with x)
  const NS = 120,
    xs: number[] = [],
    cum: number[][] = [];
  for (let i = 0; i <= NS; i++) {
    const x = (xEnd * i) / NS,
      w = weightsAt(model, x),
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
    const upper = xs.map((x, i): [number, number] => [
        mapX(x),
        wY(cum[i][j + 1]),
      ]),
      lower = xs
        .map((x, i): [number, number] => [mapX(x), wY(cum[i][j])])
        .reverse();
    svg.append(
      el("path", {
        d: poly(upper.concat(lower)) + "Z",
        fill: tplColor(j),
        opacity: 0.5,
        stroke: "none",
      }),
    );
  }
  // stern / bow labels (x runs stern→bow, left→right)
  for (const [txt, x, anchor] of [
    ["stern", xL, "start"],
    ["bow", xR, "end"],
  ] as const) {
    const t = el("text", {
      x,
      y: top - 4,
      "font-size": 10,
      fill: COL.mut,
      "text-anchor": anchor,
    });
    t.textContent = txt;
    svg.append(t);
  }
  stationLine(model, svg, top, bot, onSelect); // the red cut scrubber (vertical, shared with the plan/profile strips)

  // control points: a vertical guide + the K−1 band-boundary handles (drag ↕). One column per unified
  // station at its x; x is set in the plan view (the station is shared), so there is no x-handle here.
  model.sheer.cp.forEach((cp, i) => {
    const x = mapX(cp.x),
      sel = selection && selection.tgt === "weight" && selection.idx === i;
    svg.append(
      el("line", {
        x1: x,
        y1: top,
        x2: x,
        y2: bot,
        stroke: "#fff",
        "stroke-width": 1,
        opacity: 0.75,
      }),
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
      h.addEventListener("pointerdown", (e) =>
        weightHandleDown(i, "bnd", b, svg, e as PointerEvent, onSelect),
      );
      svg.append(h);
    }
  });
}

// the interpolated (blended) station at the red cut x0, with both trims marked: the sheer trim
// (horizontal, at depth -z_sheer(x0)) and the centerline trim (vertical, at the n where the section
// reaches the boat centerline y=0). The bold arc between them is what survives into the final shape.

export function drawCutStation(
  svg: SVGSVGElement,
  model: Model,
  selection: ModelSelection,
): void {
  svg.replaceChildren();
  svg.append(
    el("line", {
      x1: snX(NMIN),
      y1: snY(0),
      x2: snX(NMAX),
      y2: snY(0),
      stroke: "#edf2f7",
      "stroke-width": 1,
    }),
  );
  svg.append(
    el("line", {
      x1: snX(0),
      y1: snY(0),
      x2: snX(0),
      y2: snY(DMAX),
      stroke: "#e2e8f0",
      "stroke-width": 1.2,
    }),
  );
  const sh = el("text", {
    x: snX(0) + 6,
    y: snY(0) - 6,
    "font-size": 10,
    fill: "#718096",
  });
  sh.textContent = "sheer";
  svg.append(sh);

  const st = stationAt(model, model.x0, true), // the keel-knuckle symmetric section — matches the trimmed hull
    fr = frameAt(model, model.x0);
  const dtrim = Math.max(0, Math.min(-model.sheer.zf(model.x0), DMAX)); // sheer-trim depth below the flat deck
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
  const raw = stationAt(model, model.x0, false),
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
    const tl = el("text", {
      x: snX(NMIN) + 4,
      y: snY(dtrim) - 4,
      "font-size": 10,
      fill: COL.sheer,
    });
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
  const dWL =
    (model.waterline + model.x0 * Math.sin(model.deckRake)) /
    Math.cos(model.deckRake);
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
    const wt = el("text", {
      x: snX(NMAX) - 4,
      y: snY(dWL) - 4,
      "text-anchor": "end",
      "font-size": 10,
      fill: COL.wl,
    });
    wt.textContent = "WL";
    svg.append(wt);
  }

  // mark where the currently selected template point lands on this interpolated station (its blend by w(x0))
  const selIdx = selStationIdx(model, selection);
  if (selIdx !== null) {
    const wt = weightsAt(model, model.x0);
    let bn = 0,
      bd = 0;
    model.templates.forEach((tpl, j) => {
      bn += wt[j] * tpl[selIdx].n;
      bd += wt[j] * tpl[selIdx].d;
    });
    linkDot(svg, snX(bn), snY(bd), COL.station);
  }
}

// a small red ✕ marking the spot that corresponds (same index) to the selected point — drawn on the other
// templates' ghost curves so you can see where that control point lands on the other sections
export function redX(svg: SVGSVGElement, sx: number, sy: number): void {
  const r = 4.5;
  for (const [dx, dy] of [
    [-1, -1],
    [-1, 1],
  ] as const)
    svg.append(
      el("line", {
        x1: sx + dx * r,
        y1: sy + dy * r,
        x2: sx - dx * r,
        y2: sy - dy * r,
        stroke: SEL,
        "stroke-width": 2,
        "stroke-linecap": "round",
      }),
    );
}

// mark the point that CORRESPONDS (same index) to the current selection on the interpolated cut station:
// a dashed amber ring over a dot in `col`, reading as "linked", matching the amber 3D guide ribbon.
export function linkDot(
  svg: SVGSVGElement,
  sx: number,
  sy: number,
  col: string,
): void {
  svg.append(
    el("circle", {
      cx: sx,
      cy: sy,
      r: 8,
      fill: "none",
      stroke: HILITE,
      "stroke-width": 2,
      opacity: 0.9,
      "stroke-dasharray": "3 3",
    }),
  );
  svg.append(
    el("circle", {
      cx: sx,
      cy: sy,
      r: 3.5,
      fill: col,
      stroke: "#fff",
      "stroke-width": 1.2,
    }),
  );
}

export function cpDot(
  selection: ModelSelection,
  svg: SVGSVGElement,
  idx: number,
  sx: number,
  sy: number,
  onSelect: OnModelSelect,
): void {
  const c = el("circle", {
    cx: sx,
    cy: sy,
    r: 5.5,
    fill: isSelected(selection, "plan", idx) ? SELB : COL.sheer,
    stroke: "#fff",
    "stroke-width": 1.5,
  });
  c.addEventListener("pointerdown", (e) =>
    sheerPointDown(idx, svg, e, onSelect),
  );
  svg.append(c);
}

export function trimDot(
  selection: ModelSelection,
  svg: SVGSVGElement,
  idx: number,
  sx: number,
  sy: number,
  k: number,
  onSelect: OnModelSelect,
): void {
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
    fill: isSelected(selection, "trim", idx) ? SELB : COL.sheer,
    stroke: "#fff",
    "stroke-width": 1.5,
  });
  c.addEventListener("pointerdown", (e) =>
    trimPointDown(idx, svg, e, onSelect),
  );
  svg.append(c);
}

export function transomDot(
  selection: ModelSelection,
  svg: SVGSVGElement,
  idx: number,
  sx: number,
  sy: number,
  onSelect: OnModelSelect,
): void {
  const c = el("circle", {
    cx: sx,
    cy: sy,
    r: 5.5,
    fill: isSelected(selection, "transom", idx) ? SELB : "var(--transom)",
    stroke: "#fff",
    "stroke-width": 1.5,
  });
  c.addEventListener("pointerdown", (e) =>
    transomPointDown(idx, svg, e, onSelect),
  );
  svg.append(c);
}

//------------- event callabacks attached to the SVG nodes in the above draw functions -------------

// click on a template point → select it (and, if it can move, start dragging). The pinned sheer-origin
// (idx 0) selects but does not drag.

export function stnPointDown(
  ti: number,
  idx: number,
  end: boolean,
  svg: SVGSVGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  e.stopPropagation();
  if (end) {
    onSelect({ tgt: "template", idx, ti });
    return;
  }
  startDrag({ kind: "stn", ti, idx }, svg, e, onSelect);
}

export function sheerPointDown(
  idx: number,
  svg: SVGSVGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  e.stopPropagation();
  startDrag({ kind: "sheer", idx }, svg, e, onSelect);
}

export function trimPointDown(
  idx: number,
  svg: SVGSVGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  e.stopPropagation();
  startDrag({ kind: "trim", idx }, svg, e, onSelect);
}

export function transomPointDown(
  idx: number,
  svg: SVGSVGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  e.stopPropagation();
  startDrag({ kind: "transom", idx }, svg, e, onSelect);
}

// a weight-curve handle: `part` is "x" (drag the control point along the hull) or "bnd" (drag band
// boundary `bnd`, editing the simplex split at that control point).
export function weightHandleDown(
  idx: number,
  part: "x" | "bnd",
  bnd: number,
  svg: SVGSVGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  e.stopPropagation();
  startDrag({ kind: "weight", idx, wpart: part, bnd }, svg, e, onSelect);
}
