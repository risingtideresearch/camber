import { SEL, HILITE, SELB, COL, KNOT_LONG, stationColor } from "./colors";
import { startDrag } from "./drag";
import type { Vec2, Vec3 } from "./math";
import {
  bounds,
  frameAt,
  keepAt,
  knotLongitudinalsSection,
  knotLongitudinalsWorld,
  loa,
  sectionAt,
  stationWorld,
  type Bounds,
  type Model,
  type StationPointCP,
} from "./model";
import {
  dwlContour,
  dwlPointAt,
  forwardLimit,
  keelPointAt,
  keptSpan,
  sweptSection,
  transomOutline,
  type HullColumnV2,
  type HullSampling,
  type SectionRow,
} from "./mesh";
import { crCurveAuto } from "./spline";
import {
  isSelected,
  ModelSelection,
  OnModelSelect,
  selStationIdx,
} from "./modelSelection";
import { curveCombs2, type Comb2, type CurvatureSettings } from "./comb";
import {
  perfBegin,
  perfEnd,
  perfStep,
  perfStation,
  PERF_CUT,
  PERF_PLAN,
  PERF_PROFILE,
} from "./perf";
import { viewOf, PXpad, Ptop, type View } from "./view";

const SVGNS = "http://www.w3.org/2000/svg";

// ---------- sizes for the performance readout ----------
// Each draw* below opens a pass and times the generation of its curves; these say how big the result was, so
// a cost can be read against the work it did. A comb spans one existence run per stretch of curve, so its
// size is the hairs across all of them; the partial evaluators (the waterline footprint, the cusp runs) come
// back as runs of points for the same reason.
const combHairs = (cs: Comb2[]): number =>
  cs.reduce((n, c) => n + c.hairs.length, 0);
const runPts = (runs: { length: number }[]): number =>
  runs.reduce((n, r) => n + r.length, 0);

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
    d += (i ? "L" : "M") + p[0].toFixed(6) + " " + p[1].toFixed(6) + " ";
  });
  return d;
}

// The cut scrubber's position along the plan. `model.x0` is authored in x (it is a vertical line in the
// plan / profile strips, which is what the user drags), but everything swept is parameterized in u, so the
// section it cuts is found by inverting the plan's monotone x(u) once per draw.
const cutU = (model: Model): number => model.plan.uAtX(model.x0);

// ---------- curvature-comb overlay (2D) ----------
// The sharpest hair's length, in CONTENT-space units. The 2D editors draw in an ISOTROPIC content space (the
// view transforms in view.ts share one px/model-unit), so a comb built in content space renders with visually
// perpendicular hairs; it then scales with the zoom like every other drawn curve (only strokes stay a
// constant screen width, via non-scaling-stroke). Two sizes: the wide plan/profile strips vs the square
// station / cut editors. Both are content-space constants: the content box is 1000 wide (or STW) whatever
// the hull's length, so they do not follow the model's scale.
const COMB_LEN_STRIP = 45,
  COMB_LEN_STN = 42;

// draw one comb (hairs + envelope) into `svg`, in the curve's colour, with constant-screen-width strokes
function drawComb2(
  svg: SVGGElement,
  comb: Comb2,
  color: string,
  opacity = 0.9,
): void {
  for (const [a, b] of comb.hairs)
    svg.append(
      el("line", {
        x1: a[0].toFixed(2),
        y1: a[1].toFixed(2),
        x2: b[0].toFixed(2),
        y2: b[1].toFixed(2),
        stroke: color,
        "stroke-width": 1,
        opacity,
        "vector-effect": "non-scaling-stroke",
      }),
    );
  if (comb.env.length > 1)
    svg.append(
      el("path", {
        d: poly(comb.env),
        fill: "none",
        stroke: color,
        "stroke-width": 1.3,
        opacity,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
        "vector-effect": "non-scaling-stroke",
      }),
    );
}

// ---------- fixed-screen-size overlays ----------
// Everything is drawn into the SvgView's content <g>, which the view scales (MSX, MSY) to zoom / fit. Strokes
// stay a constant screen width via the non-scaling-stroke CSS in SvgView.css; but points, the cut triangle,
// and text labels have an intrinsic size, so they're wrapped in a group that counter-scales by the inverse of
// the current view scale. Shapes `build` draws around the local origin then render at a constant pixel size.
// Each draw* entry point sets the current scale (setMarkerScale) before it draws.
let MSX = 1,
  MSY = 1;
export function setMarkerScale(sx: number, sy: number): void {
  MSX = sx || 1;
  MSY = sy || 1;
}
function fixed(
  parent: SVGGElement,
  cx: number,
  cy: number,
  build: (g: SVGGElement) => void,
): void {
  const g = el("g", {
    transform: `translate(${cx.toFixed(2)} ${cy.toFixed(2)}) scale(${(1 / MSX).toFixed(5)} ${(1 / MSY).toFixed(5)})`,
  }) as SVGGElement;
  build(g);
  parent.append(g);
}
// a constant-size text label anchored at content point (x, y) — like placing a <text> there, but immune to
// the view scale (so labels stay legible and undistorted at any zoom)
function fixedText(
  parent: SVGGElement,
  x: number,
  y: number,
  attrs: Record<string, string | number>,
  text: string,
): void {
  fixed(parent, x, y, (g) => {
    const t = el("text", { x: 0, y: 0, ...attrs });
    t.textContent = text;
    g.append(t);
  });
}

// a native tooltip on an SVG node
function titled(node: SVGElement, text: string): SVGElement {
  const t = document.createElementNS(SVGNS, "title");
  t.textContent = text;
  node.append(t);
  return node;
}

export function gridX(
  v: View,
  svg: SVGGElement,
  top: number,
  bot: number,
): void {
  for (let q = 0; q <= 4; q++) {
    const x = v.mapX((v.len * q) / 4);
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
  v: View,
  model: Model,
  svg: SVGGElement,
  top: number,
  bot: number,
  onSelect: OnModelSelect,
): void {
  const x = v.mapX(model.x0);
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
  // the cut indicator triangle — a constant screen size, apex pointing down at x0 along the top edge
  fixed(svg, x, top, (g) => {
    const tri = el("path", {
      d: `M-6 0 L6 0 L0 9 Z`,
      fill: "var(--slider)",
      style: "cursor:ew-resize",
    });
    tri.addEventListener("pointerdown", (e) =>
      startDrag({ kind: "slider" }, svg, e, onSelect),
    );
    g.append(tri);
  });
}

export type Proj = (p: Vec3) => [number, number];

// the swept section at the cut, projected into a 2D view → its true heading/rake (not a plain vertical cut).
// A caller that already has the row at the cut can pass it in to avoid recomputing.
export function cutTrace(
  model: Model,
  svg: SVGGElement,
  proj: Proj,
  row?: SectionRow,
): void {
  const cut = row
    ? row
    : perfStep(
        "Cut section",
        () => sweptSection(model, cutU(model), 10, true),
        (s) => s.pts.length,
      );
  if (cut.empty) return;
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

// ---------- knot longitudinals (2D overlay) ----------
// Every station's knots (its authored section points) as small circles, and the loft curve each knot index
// traces — the u-interpolation a section at any u is read from — in the construction grey. The world reading
// serves the plan and profile strips through their projections; the station editor draws the section reading
// itself. The whole overlay is non-interactive (and drawn under the handles), so nothing grabbable is
// covered by it.

// a plain, non-interactive construction polyline in the knot-longitudinal grey
function knotCurve(svg: SVGGElement, pts: Vec2[]): void {
  if (pts.length < 2) return;
  svg.append(
    el("path", {
      d: poly(pts),
      fill: "none",
      stroke: KNOT_LONG,
      "stroke-width": 2,
      opacity: 0.9,
      "pointer-events": "none",
    }),
  );
}

// a small fixed-size circle marking one knot, ringed in its station's colour
function knotDot(
  svg: SVGGElement,
  sx: number,
  sy: number,
  stroke: string,
): void {
  fixed(svg, sx, sy, (g) =>
    g.append(
      el("circle", {
        cx: 0,
        cy: 0,
        r: 2.6,
        fill: "#fff",
        stroke,
        "stroke-width": 1.3,
        "pointer-events": "none",
      }),
    ),
  );
}

// the world-space overlay the plan and profile strips share, each through its own projection
function knotOverlayWorld(svg: SVGGElement, model: Model, proj: Proj): void {
  const longs = perfStep(
    "Knot longitudinals",
    () => knotLongitudinalsWorld(model),
    runPts,
  );
  for (const run of longs) knotCurve(svg, run.map(proj));
  model.stations.forEach((st, si) => {
    const fr = frameAt(model, st.u),
      col = stationColor(si);
    for (const p of st.points) {
      const [sx, sy] = proj(stationWorld(fr, p.n, p.z));
      knotDot(svg, sx, sy, col);
    }
  });
}

// Where the plan curve's inboard radius of curvature R is smaller than the section's inboard reach, the
// fanned station planes cross and the swept surface folds (cusps) — every offset from R inward is doubled
// over. The fold's outboard edge is at offset R along the normal (the plan curve's centre of curvature / its
// evolute); the inboard edge is the section's deepest swept point. This is section-aware: a station is
// flagged only where the rendered section actually reaches offset R. Each run carries, per station, the plan
// edges (world x,y at offsets R and n_max) and the profile band (z at the offset-R depth and at the deepest
// depth), so both views can shade the same folded region.
//
// The plan is a parametric curve now, so the fold test is stated directly on it: with n̂ the frame's inboard
// normal, the signed curvature about n̂ is κ = (P″·n̂)/|P′|², and κ > 0 puts the centre of curvature INBOARD
// at offset R = 1/κ. P″ is a central difference of the EXACT hodograph (plan.d), not of the position.

export type CuspPt = {
  x: number;
  outer: [number, number];
  inner: [number, number];
  zTop: number;
  zBot: number;
};

export function cuspRuns(model: Model): CuspPt[][] {
  const N = 120,
    e = 1e-4, // in u, for the hodograph's central difference
    runs: CuspPt[][] = [];
  let run: CuspPt[] = [];
  const flush = (): void => {
    if (run.length) runs.push(run);
    run = [];
  };
  for (let i = 0; i <= N; i++) {
    const u = i / N,
      fr = frameAt(model, u),
      d1 = model.plan.d(u),
      ua = Math.max(0, u - e),
      ub = Math.min(1, u + e),
      da = model.plan.d(ua),
      db = model.plan.d(ub),
      h = ub - ua || 1,
      d2: Vec2 = [(db[0] - da[0]) / h, (db[1] - da[1]) / h],
      sp2 = d1[0] * d1[0] + d1[1] * d1[1] || 1,
      kn = (d2[0] * fr.n[0] + d2[1] * fr.n[1]) / sp2;
    let hit: CuspPt | null = null;
    if (kn > 1e-12) {
      const R = 1 / kn,
        // the section is trimmed at the centerline, so it can never reach past it: an R beyond the
        // centerline's own offset cannot fold anything. A cheap reject before sweeping the section.
        ncl = Math.abs(fr.n[1]) > 1e-9 ? -fr.p[1] / fr.n[1] : Infinity;
      if (R < ncl) {
        const sec = sweptSection(model, u, 18, true);
        if (!sec.empty) {
          let zAtR = NaN,
            nMax = -Infinity,
            zMin = Infinity;
          for (const p of sec.pts) {
            const n = (p[0] - fr.p[0]) * fr.n[0] + (p[1] - fr.p[1]) * fr.n[1]; // inboard offset along n̂
            if (n >= R && isNaN(zAtR)) zAtR = p[2];
            if (n > nMax) nMax = n;
            if (p[2] < zMin) zMin = p[2];
          }
          if (nMax >= R && !isNaN(zAtR) && zMin < zAtR)
            hit = {
              x: fr.p[0],
              outer: [fr.p[0] + R * fr.n[0], fr.p[1] + R * fr.n[1]], // offset R — the cuspidal edge
              inner: [fr.p[0] + nMax * fr.n[0], fr.p[1] + nMax * fr.n[1]], // deepest swept offset
              zTop: zAtR,
              zBot: zMin,
            };
        }
      }
    }
    if (hit) run.push(hit);
    else flush();
  }
  flush();
  return runs;
}

export function drawPlan(
  svg: SVGGElement, // the SvgView content group
  model: Model,
  selection: ModelSelection,
  sampling: HullSampling,
  onSelect: OnModelSelect,
  activeStation: number, // the station the section editor is showing — emphasized here, and set by a click
  onActivateStation: (si: number) => void,
  sc: [number, number],
  curv?: CurvatureSettings,
  knotLongs = false, // the station editor's "Show knot longitudinals" toggle, shared by all three 2D views
): void {
  perfBegin(PERF_PLAN);
  const cols = sampling.columns,
    v = viewOf(model);
  setMarkerScale(sc[0], sc[1]);
  svg.replaceChildren();
  gridX(v, svg, 8, v.lh - 8);
  // (waterline contours other than the DWL footprint are shown in the 3D Waterline lines view, not here)
  // faint band below the centerline (y < 0): "past the centerline" — where the sheer plan crosses to close a
  // tumblehome bow.
  svg.append(
    el("rect", {
      x: PXpad,
      y: v.lbase,
      width: 1000 - 2 * PXpad,
      height: v.lh - v.lbase,
      fill: "var(--keel)",
      opacity: 0.05,
    }),
  );
  // centerline (y = 0)
  svg.append(
    el("line", {
      x1: PXpad,
      y1: v.lbase,
      x2: 1000 - PXpad,
      y2: v.lbase,
      stroke: "var(--keel)",
      "stroke-width": 1.5,
      opacity: 0.5,
      "stroke-dasharray": "4 4",
    }),
  );
  fixedText(
    svg,
    PXpad - 4,
    v.lbase - 4,
    { "text-anchor": "end", "font-size": 10, fill: "var(--keel)" },
    "CL",
  );
  stationLine(v, model, svg, 8, v.lh - 8, onSelect);
  // the plan control polygon: the sheer points are B-spline handles, not on-curve, so show the polygon
  // they define faintly behind the curve (the curve interpolates only the ends and stays inside the rest)
  svg.append(
    el("path", {
      d: poly(model.sheerPlan.map((cp): Vec2 => [v.mapX(cp.x), v.yPlan(cp.y)])),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 1,
      opacity: 0.35,
      "stroke-dasharray": "3 4",
    }),
  );
  // the sheer plan curve (the deck-edge half-breadth), sampled in its own parameter — it is a parametric
  // curve, not a graph, so that it can be drawn crossing the centerline at a tumblehome bow.
  const pl = perfStep("Sheer plan curve", () => {
    const out: Vec2[] = [];
    for (let i = 0; i <= 160; i++) {
      const [x, y] = model.plan.at(i / 160);
      out.push([v.mapX(x), v.yPlan(y)]);
    }
    return out;
  });
  svg.append(
    el("path", {
      d: poly(pl),
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
  const beam = perfStep("Max-beam line", () => {
    const out: Vec3[] = [];
    for (const c of cols) {
      if (!c.pts.length) continue;
      let p = c.pts[0].pos;
      for (const q of c.pts) if (q.pos[1] > p[1]) p = q.pos;
      out.push(p);
    }
    return out;
  });
  if (beam.length > 1)
    svg.append(
      el("path", {
        d: poly(beam.map((p): Vec2 => [v.mapX(p[0]), v.yPlan(p[1])])),
        fill: "none",
        stroke: COL.fore,
        "stroke-width": 2.4, // the result line — drawn solid and heavier than the dashed sheer-plan guide
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  // The transom's footprint in plan: its outline seen from above, head at the sheer → foot on the centerline.
  // Read off the same sampling the outline above was drawn from, so the 2D strips and the 3D panel are three
  // projections of ONE curve rather than three curves that ought to agree.
  const te = transomOutline(sampling);
  if (te.length > 1) {
    svg.append(
      el("path", {
        d: poly(te.map((p): Vec2 => [v.mapX(p[0]), v.yPlan(p[1])])),
        fill: "none",
        stroke: "var(--transom)",
        "stroke-width": 2.2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  }
  // design-waterline footprint (where the hull meets the WL plane)
  const dwl = perfStep("Waterline footprint", () => dwlContour(model), runPts);
  for (const run of dwl) {
    svg.append(
      el("path", {
        d: poly(run.map((p): Vec2 => [v.mapX(p[0]), v.yPlan(p[1])])),
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
  const cusps = perfStep("Cusp (fold) check", () => cuspRuns(model), runPts);
  for (const run of cusps) {
    const ring = run
      .map((s): Vec2 => [v.mapX(s.outer[0]), v.yPlan(s.outer[1])])
      .concat(
        run
          .slice()
          .reverse()
          .map((s): Vec2 => [v.mapX(s.inner[0]), v.yPlan(s.inner[1])]),
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
  // curvature combs: the sheer plan (deck-edge half-breadth) and the design-waterline footprint. Both are
  // fore-aft (longitudinal) curves, so they share the longitudinal hair count, and both run over the plan's
  // own parameter u. Each comb evaluates the curve's ORIGINAL definition — the plan spline directly, the
  // waterline through the converged crossing evaluator (dwlPointAt) — never a resampled polyline (comb.ts).
  if (curv?.on) {
    if (curv.planSheer) {
      const f = (u: number): Vec2 => {
        const [x, y] = model.plan.at(u);
        return [v.mapX(x), v.yPlan(y)];
      };
      const cs = perfStep(
        "Comb — sheer plan",
        () => curveCombs2(f, 0, 1, curv.nLongHairs, COMB_LEN_STRIP),
        combHairs,
        "hairs",
      );
      for (const c of cs) drawComb2(svg, c, COL.sheer);
    }
    if (curv.planWaterline) {
      // partial: null wherever the section has no waterline crossing (dry, or fully wet) — each existing
      // run gets its own comb, so the domain is simply the whole plan.
      const f = (u: number): Vec2 | null => {
        const p = dwlPointAt(model, u);
        return p && [v.mapX(p[0]), v.yPlan(p[1])];
      };
      const cs = perfStep(
        "Comb — waterline",
        () => curveCombs2(f, 0, 1, curv.nLongHairs, COMB_LEN_STRIP),
        combHairs,
        "hairs",
      );
      for (const c of cs) drawComb2(svg, c, COL.wl);
    }
  }
  // cut station — true plan heading (the fan angle)
  cutTrace(model, svg, (p) => [v.mapX(p[0]), v.yPlan(p[1])]);
  const [cx, cy] = model.plan.at(cutU(model));
  ringDot(svg, v.mapX(cx), v.yPlan(cy), COL.sheer);
  // every station's knots + the loft curve each knot traces, seen from above
  if (knotLongs)
    knotOverlayWorld(svg, model, (p) => [v.mapX(p[0]), v.yPlan(p[1])]);
  // designed stations, seen from above: each sits at a definite u along the
  // plan, so its mark starts on the plan curve and drags along it. Drawn under
  // the plan control points, since the segment reaches far enough inboard to
  // cross them and they have to stay grabbable.
  model.stations.forEach((st, si) => {
    const fr = frameAt(model, st.u),
      nEnd = st.points[st.points.length - 1].n, // the last knot's inboard offset — the segment's length
      end = stationWorld(fr, nEnd, 0);
    stationHandle(
      svg,
      si,
      [v.mapX(fr.p[0]), v.yPlan(fr.p[1])],
      [v.mapX(end[0]), v.yPlan(end[1])],
      si === activeStation,
      onSelect,
      onActivateStation,
    );
  });
  model.sheerPlan.forEach((cp, idx) =>
    cpDot(selection, svg, idx, v.mapX(cp.x), v.yPlan(cp.y), onSelect),
  );
  perfEnd(PERF_PLAN);
}

export function drawProfile(
  svg: SVGGElement, // the SvgView content group
  model: Model,
  selection: ModelSelection,
  sampling: HullSampling,
  onSelect: OnModelSelect,
  sc: [number, number],
  curv?: CurvatureSettings,
  // the station editor's "Show knot longitudinals" toggle, shared by all three 2D views. Here it also picks
  // how the stations below are drawn: whole (construction geometry) with it on, trimmed to the hull with it off
  knotLongs = false,
): void {
  perfBegin(PERF_PROFILE);
  const cols = sampling.columns,
    v = viewOf(model);
  setMarkerScale(sc[0], sc[1]);
  svg.replaceChildren();
  gridX(v, svg, Ptop - 4, v.pzBase);
  stationLine(v, model, svg, Ptop - 4, v.pzBase, onSelect);
  // (buttock contours are shown in the 3D Buttocks lines view, not here)
  // flat deck at z = 0 — now just a construction reference; the real top edge is the sheer trim below it
  svg.append(
    el("line", {
      x1: PXpad,
      y1: v.zScreenP(0),
      x2: 1000 - PXpad,
      y2: v.zScreenP(0),
      stroke: COL.deck,
      "stroke-width": 1.5,
      "stroke-dasharray": "6 4",
    }),
  );
  fixedText(
    svg,
    1000 - PXpad,
    v.zScreenP(0) - 5,
    { "text-anchor": "end", "font-size": 10, fill: COL.deck },
    "flat deck",
  );
  // design waterline: horizontal in world ⇒ a raked line in this deck-frame profile (slope = the rake).
  // Runs from the transom to the hull's closure (forwardLimit, in u → its x on the plan).
  const xFwd = perfStep(
      "Hull forward limit",
      () => model.plan.at(forwardLimit(model))[0],
    ),
    wlS = Math.sin(model.deckRake),
    wlC = Math.cos(model.deckRake),
    zWL = (x: number): number => (-model.waterline - x * wlS) / wlC;
  svg.append(
    el("line", {
      x1: v.mapX(0),
      y1: v.zScreenP(zWL(0)),
      x2: v.mapX(xFwd),
      y2: v.zScreenP(zWL(xFwd)),
      stroke: COL.wl,
      "stroke-width": 1.8,
      opacity: 0.9,
    }),
  );
  fixedText(
    svg,
    v.mapX(xFwd) - 4,
    v.zScreenP(zWL(xFwd)) - 5,
    { "text-anchor": "end", "font-size": 10, fill: COL.wl },
    "DWL",
  );
  // emergent keel + stem, drawn as one continuous outline from transom to bow so it MATCHES the 3D mesh:
  //  • aft: the transom's foot, where the keel meets the cut — `hullCenterline` already carries it as its first
  //    point (the corner computeHullSampling splices onto the keel's aft end), so the line starts on the plane;
  //  • bottom: the keel/rocker — the deepest point of each closing section — rising to the bow;
  //  • stem: at a tumblehome bow the deck tucks to the centerline, so the section TOP (col.pts[0]) dives below
  //    the authored trim and meets the keel at the forefoot. Trace that diving top edge back from the forefoot
  //    to where it rejoins the trim — the real raked leading edge, not a fabricated plumb line.
  const closing = cols.filter((c) => c.keel && c.pts.length > 1);
  const keel = sampling.hullCenterline.map((s) => s.pos); // foot → rocker, aft to bow
  if (keel.length) {
    // the bow stem: the CONTIGUOUS run of forwardmost sections whose top has dived below the authored trim
    // (the tumblehome lens). Only the forward run — a section's top can also drop below the trim near the
    // transom (the raked transom clip), and including those would draw a stray line back to the transom.
    // The tolerance is a fraction of the hull's own length (it was an absolute number against v1's L=1000).
    const tol = 0.003 * loa(model);
    const dived = (c: HullColumnV2): boolean =>
      c.pts[0].pos[2] < model.trimZ(c.pts[0].pos[0]) - tol;
    let b = closing.length;
    while (b > 0 && dived(closing[b - 1])) b--;
    const stem = closing.slice(b).map((c) => c.pts[0].pos); // forward, increasing x
    if (stem.length)
      for (let i = stem.length - 1; i >= 0; i--) keel.push(stem[i]); // forefoot → back to the trim
    else keel.push([xFwd, 0, model.trimZ(xFwd)]); // a fine bow closes straight onto the trim at the stem
  }
  if (keel.length > 1)
    svg.append(
      el("path", {
        d: poly(keel.map((p): Vec2 => [v.mapX(p[0]), v.zScreenP(p[2])])),
        fill: "none",
        stroke: COL.keel,
        "stroke-width": 2.4,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  // sheer trim line (real sheer in profile) — the swept sheet is cut to this, kept below the deck. It is
  // authored against x and read as a graph, so it is sampled across its own x domain.
  const tx0 = model.sheerTrim[0].x,
    tx1 = model.sheerTrim[model.sheerTrim.length - 1].x;
  // the trim control polygon, shown faint (the curve interpolates these points, with per-point knuckles)
  svg.append(
    el("path", {
      d: poly(
        model.sheerTrim.map((cp): Vec2 => [v.mapX(cp.x), v.zScreenP(cp.z)]),
      ),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 1,
      opacity: 0.35,
      "stroke-dasharray": "3 4",
    }),
  );
  const tpts = perfStep("Sheer trim curve", () => {
    const out: Vec2[] = [];
    for (let i = 0; i <= 160; i++) {
      const x = tx0 + ((tx1 - tx0) * i) / 160;
      out.push([v.mapX(x), v.zScreenP(model.trimZ(x))]);
    }
    return out;
  });
  svg.append(
    el("path", {
      d: poly(tpts),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 2.4,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
  // transom: the construction line through the two control points (dashed) + the actual cut edge (solid)
  const [ta, tb] = model.transom;
  svg.append(
    el("line", {
      x1: v.mapX(ta.x),
      y1: v.zScreenP(ta.z),
      x2: v.mapX(tb.x),
      y2: v.zScreenP(tb.z),
      stroke: "var(--transom)",
      "stroke-width": 1.3,
      opacity: 0.6,
      "stroke-dasharray": "5 4",
    }),
  );
  // the cut edge itself: the outline in side view. Every point of it is on the transom plane by construction,
  // so it lies along the dashed construction line above — between the head at the sheer and the foot on the
  // keel, which is the stretch of that line the hull actually reaches.
  const te = transomOutline(sampling);
  if (te.length > 1)
    svg.append(
      el("path", {
        d: poly(te.map((p): Vec2 => [v.mapX(p[0]), v.zScreenP(p[2])])),
        fill: "none",
        stroke: "var(--transom)",
        "stroke-width": 2.4,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  fixedText(
    svg,
    v.mapX(ta.x) + 6,
    v.zScreenP(ta.z) - 4,
    { "font-size": 10, fill: "var(--transom)" },
    "transom",
  );
  // cusp marker: shade the folded depth band (offset = R down to the deepest swept point) at the cusping
  // stations, in red — the same folded region the plan view shades.
  const cusps = perfStep("Cusp (fold) check", () => cuspRuns(model), runPts);
  for (const run of cusps) {
    const top = run.map((s): Vec2 => [v.mapX(s.x), v.zScreenP(s.zTop)]),
      bot = run.map((s): Vec2 => [v.mapX(s.x), v.zScreenP(s.zBot)]).reverse();
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
  // the cut station's trimmed section, computed once and shared by the trace and the keel dot
  const cu = cutU(model),
    cut = perfStep(
      "Cut section",
      () => sweptSection(model, cu, 10, true),
      (s) => s.pts.length,
    );
  // curvature combs: the sheer-trim curve and the keel / centerline outline (both fore-aft, so the
  // longitudinal hair count), and the live cut station's profile trace (transverse, so the section count).
  // Each comb evaluates the curve's ORIGINAL definition (see comb.ts), never the drawn polyline.
  if (curv?.on) {
    if (curv.profSheer) {
      const f = (x: number): Vec2 => [v.mapX(x), v.zScreenP(model.trimZ(x))];
      const cs = perfStep(
        "Comb — sheer trim",
        () => curveCombs2(f, tx0, tx1, curv.nLongHairs, COMB_LEN_STRIP),
        combHairs,
        "hairs",
      );
      for (const c of cs) drawComb2(svg, c, COL.sheer);
    }
    // the keel/rocker run of the outline (converged keelPointAt over the plan's parameter). The short
    // emergent-stem branch at a tumblehome bow is a different branch of the outline and carries no comb.
    if (curv.profCenterline && keel.length > 2) {
      const f = (u: number): Vec2 | null => {
        const p = keelPointAt(model, u);
        return p && [v.mapX(p[0]), v.zScreenP(p[2])];
      };
      const cs = perfStep(
        "Comb — centerline",
        () => curveCombs2(f, 0, 1, curv.nLongHairs, COMB_LEN_STRIP),
        combHairs,
        "hairs",
      );
      for (const c of cs) drawComb2(svg, c, COL.keel);
    }
    if (curv.profCut) {
      // the cut station's kept span in profile, null wherever the section is trimmed away — `keepAt` is the
      // single signed trim test, so the comb's run edges converge onto the real clip by bisection
      const fr = frameAt(model, cu),
        sec = sectionAt(model, cu);
      const f = (t: number): Vec2 | null => {
        const nz = sec.at(t);
        if (keepAt(model, fr, nz) < 0) return null;
        const p = stationWorld(fr, nz[0], nz[1]);
        return [v.mapX(p[0]), v.zScreenP(p[2])];
      };
      const cs = perfStep(
        "Comb — cut section",
        () => curveCombs2(f, 0, sec.vmax, curv.nSectHairs, COMB_LEN_STRIP),
        combHairs,
        "hairs",
      );
      for (const c of cs) drawComb2(svg, c, "var(--slider)");
    }
  }
  // The authored stations in side view, each in its own accent colour. Drawn through the station's own frame,
  // so each shows the fan's true rake — running inboard shifts x — rather than a plumb line at the station's
  // x. Cut to the hull, exactly as the mesh cuts it; but whole while the knot-longitudinal overlay is up,
  // since there the subject is the authored construction geometry the longitudinals loft between, not the
  // finished surface. Non-interactive, like the overlay it accompanies.
  const stns = perfStep(
    "Station sections",
    () => model.stations.map((st) => sweptSection(model, st.u, 10, !knotLongs)),
    (rows) => rows.reduce((n, r) => n + r.pts.length, 0),
  );
  stns.forEach((row, si) => {
    if (row.empty) return;
    svg.append(
      el("path", {
        d: poly(row.pts.map((p): Vec2 => [v.mapX(p[0]), v.zScreenP(p[2])])),
        fill: "none",
        stroke: stationColor(si),
        "stroke-width": 2,
        opacity: 0.85,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
        "pointer-events": "none",
      }),
    );
  });
  // every station's knots + the loft curve each knot traces, in side view
  if (knotLongs)
    knotOverlayWorld(svg, model, (p) => [v.mapX(p[0]), v.zScreenP(p[2])]);
  // cut station — true profile rake (the fan shifts x as the section runs inboard to the keel)
  cutTrace(model, svg, (p) => [v.mapX(p[0]), v.zScreenP(p[2])], cut);
  // keel dot at the section's deepest point — the keel flag and the last point (y snapped to 0) come from
  // the converged trim in sweptSection, so they are sample-count independent
  if (cut.keel && cut.pts.length)
    ringDot(
      svg,
      v.mapX(cut.pts[cut.pts.length - 1][0]),
      v.zScreenP(cut.pts[cut.pts.length - 1][2]),
      COL.keel,
    );
  ringDot(svg, v.mapX(model.x0), v.zScreenP(model.trimZ(model.x0)), COL.sheer);
  model.sheerTrim.forEach((cp, idx) =>
    trimDot(
      selection,
      svg,
      idx,
      v.mapX(cp.x),
      v.zScreenP(cp.z),
      cp.k,
      onSelect,
    ),
  );
  model.transom.forEach((cp, idx) =>
    transomDot(selection, svg, idx, v.mapX(cp.x), v.zScreenP(cp.z), onSelect),
  );
  perfEnd(PERF_PROFILE);
}

// ---------- the station editors ----------
// One station editor (station `si`): the other stations ghosted faint behind it, this one solid with
// draggable nodes. Built into a fresh svg by drawStation each render.

// the exact content-space evaluator of a station's section curve, t → [snX(n(t)), snY(z(t))] over the
// curve's own parameter t ∈ [0, vmax] (point i at t = i) — shared by the drawn polyline and its curvature
// comb (the comb needs the original curve definition, not a resample of the drawn polyline)
function stnEval(
  v: View,
  pts: StationPointCP[],
): { f: (t: number) => Vec2; vmax: number } {
  const c = crCurveAuto(
    pts.map((p) => [p.n, p.z]),
    pts.map((p) => p.k),
  );
  return {
    f: (t) => {
      const p = c.at(t);
      return [v.snX(p[0]), v.snY(p[1])];
    },
    vmax: c.vmax,
  };
}

// Every station's curve is drawn in every station editor (this one solid, the rest as ghosts), so the step
// is timed here rather than at the call site: it reports the whole fan under one label, with the call count.
export function stnCurve(
  v: View,
  svg: SVGGElement,
  pts: StationPointCP[],
  c: string,
  op: number,
): void {
  const out = perfStep("Section curves", () => {
    const { f, vmax } = stnEval(v, pts),
      o: Vec2[] = [],
      N = 600;
    for (let i = 0; i <= N; i++) o.push(f((vmax * i) / N));
    return o;
  });
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

// axes shared by the station editor and the cut station: the deck point at the origin (top-left),
// n inboard →, z down ↓, the "sheer" label at the origin
function stnAxes(v: View, b: Bounds, svg: SVGGElement): void {
  svg.append(
    el("line", {
      x1: v.snX(b.nMin),
      y1: v.snY(0),
      x2: v.snX(b.nMax),
      y2: v.snY(0),
      stroke: "#edf2f7",
      "stroke-width": 1,
    }),
  );
  svg.append(
    el("line", {
      x1: v.snX(0),
      y1: v.snY(0),
      x2: v.snX(0),
      y2: v.snY(b.zMin),
      stroke: "#e2e8f0",
      "stroke-width": 1.2,
    }),
  );
  fixedText(
    svg,
    v.snX(0) + 6,
    v.snY(0) - 6,
    { "font-size": 10, fill: COL.mut || "#718096" },
    "sheer",
  );
}

export function drawStation(
  model: Model,
  selection: ModelSelection,
  svg: SVGGElement,
  si: number,
  onSelect: OnModelSelect,
  sc: [number, number],
  curv?: CurvatureSettings,
  knotLongs = false, // the "Show knot longitudinals" toggle, shared by all three 2D views
): void {
  perfBegin(perfStation(si));
  const v = viewOf(model),
    b = bounds(model);
  setMarkerScale(sc[0], sc[1]);
  svg.replaceChildren();
  const col = stationColor(si),
    arr = model.stations[si].points;
  stnAxes(v, b, svg);
  // faint ghosts of every other station, then this one solid
  model.stations.forEach((st, j) => {
    if (j !== si) stnCurve(v, svg, st.points, stationColor(j), 0.16);
  });
  stnCurve(v, svg, arr, col, 1);
  // The knot overlay, in this editor's own (n, z) plane: the u-interpolation each knot index rides across
  // the stations, and the OTHER stations' knots as small circles — this station's own knots are already its
  // editing nodes, drawn (grabbable) over all of this.
  if (knotLongs) {
    const longs = perfStep(
      "Knot longitudinals",
      () => knotLongitudinalsSection(model),
      runPts,
    );
    for (const run of longs)
      knotCurve(
        svg,
        run.map((p): Vec2 => [v.snX(p[0]), v.snY(p[1])]),
      );
    model.stations.forEach((st, j) => {
      if (j !== si)
        for (const p of st.points)
          knotDot(svg, v.snX(p.n), v.snY(p.z), stationColor(j));
    });
  }
  // curvature combs on the station section curves (transverse ⇒ the section hair count), each built from
  // the station's exact curve evaluator (stnEval), not the drawn polyline
  if (curv?.on) {
    const comb = (pts: StationPointCP[], c: string, op: number): void => {
      const { f, vmax } = stnEval(v, pts);
      const cs = perfStep(
        "Combs — sections",
        () => curveCombs2(f, 0, vmax, curv.nSectHairs, COMB_LEN_STN),
        combHairs,
        "hairs",
      );
      for (const cb of cs) drawComb2(svg, cb, c, op);
    };
    if (curv.stnUnselected)
      model.stations.forEach((st, j) => {
        if (j !== si) comb(st.points, stationColor(j), 0.5);
      });
    if (curv.stnSelected) comb(arr, col, 0.95);
  }
  arr.forEach((p, idx) => {
    const end = idx === 0,
      s = end ? 4 : 6,
      // knuckle applies to every point but the pinned deck point (idx 0) — including the keel point;
      // the node morphs round (k=0) → square (k=1) via corner radius to show its sharpness
      knuck = idx > 0,
      k = knuck ? Math.min(Math.max(p.k, 0), 1) : 0,
      rad = (1 - k) * s,
      sel = isSelected(selection, "station", idx, si); // the selected node is drawn solid red
    fixed(svg, v.snX(p.n), v.snY(p.z), (g) => {
      const node = el("rect", {
        x: -s,
        y: -s,
        width: 2 * s,
        height: 2 * s,
        rx: rad,
        ry: rad,
        fill: sel ? SEL : end ? "#fff" : col,
        stroke: sel ? "#fff" : end ? col : "#fff",
        "stroke-width": 1.8,
      });
      node.addEventListener("pointerdown", (e) =>
        stnPointDown(si, idx, end, svg, e, onSelect),
      );
      g.append(node);
    });
  });
  // when a station point is selected, mark the corresponding index on every OTHER station's ghost curve
  // with a small red ✕, so you can see where that control point lands on the other sections.
  const sIdx = selStationIdx(model, selection);
  if (sIdx !== null)
    model.stations.forEach((st, j) => {
      if (j !== si)
        redX(svg, v.snX(st.points[sIdx].n), v.snY(st.points[sIdx].z));
    });
  perfEnd(perfStation(si));
}

// ---------- the live cut station ----------
// The section at the red cut, with its trims marked: the sheer trim, the centerline (where the section
// reaches y = 0) and the design waterline. The bold arc between the trims is what survives into the hull.
//
// The reference lines are drawn as polylines across n rather than as single horizontals: the station plane
// is normal to the plan's heading, so running inboard along n also moves in world x — and the sheer trim and
// the waterline are both functions of x. Where the plan is straight they render flat, as they did in v1;
// where it turns they slope, which is the truth.

export function drawCutStation(
  svg: SVGGElement,
  model: Model,
  selection: ModelSelection,
  sc: [number, number],
  curv?: CurvatureSettings,
): void {
  perfBegin(PERF_CUT);
  const v = viewOf(model),
    b = bounds(model);
  setMarkerScale(sc[0], sc[1]);
  svg.replaceChildren();
  stnAxes(v, b, svg);

  const u = cutU(model),
    fr = frameAt(model, u),
    sec = perfStep(
      "Lofting the section",
      () => sectionAt(model, u),
      () => null,
    ),
    span = perfStep(
      "Trimming (kept span)",
      () => keptSpan(model, fr, sec),
      () => null,
    );
  const xAt = (n: number): number => fr.p[0] + n * fr.n[0]; // world x at inboard offset n
  const ncl = Math.abs(fr.n[1]) > 1e-6 ? -fr.p[1] / fr.n[1] : b.nMax; // offset where the section meets y=0

  // the full swept section, faint and dashed: the sheet before the trims cut it
  const full = perfStep("Full section curve", () => {
    const out: Vec2[] = [],
      N = 300;
    for (let i = 0; i <= N; i++) {
      const p = sec.at((sec.vmax * i) / N);
      out.push([v.snX(p[0]), v.snY(p[1])]);
    }
    return out;
  });
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

  // curvature comb on the section curve (transverse ⇒ the section hair count), evaluated straight from the
  // section's own definition, not from the drawn polyline
  if (curv?.on && curv.cutSection) {
    const f = (t: number): Vec2 => {
      const p = sec.at(t);
      return [v.snX(p[0]), v.snY(p[1])];
    };
    const cs = perfStep(
      "Comb — section",
      () => curveCombs2(f, 0, sec.vmax, curv.nSectHairs, COMB_LEN_STN),
      combHairs,
      "hairs",
    );
    for (const c of cs) drawComb2(svg, c, COL.station);
  }

  // the kept arc, bold: sheer trim → keel (or the transom / the open bottom)
  if (span) {
    const kept = perfStep("Kept arc", () => {
      const out: Vec2[] = [],
        KN = 240;
      for (let i = 0; i <= KN; i++) {
        const p = sec.at(span[0] + ((span[1] - span[0]) * i) / KN);
        out.push([v.snX(p[0]), v.snY(p[1])]);
      }
      return out;
    });
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

  // the sheer trim across the section, + the point where the kept arc starts on it
  const trimLine = perfStep("Sheer-trim line", () => {
    const out: Vec2[] = [];
    for (let i = 0; i <= 48; i++) {
      const n = b.nMin + ((b.nMax - b.nMin) * i) / 48;
      out.push([v.snX(n), v.snY(model.trimZ(xAt(n)))]);
    }
    return out;
  });
  svg.append(
    el("path", {
      d: poly(trimLine),
      fill: "none",
      stroke: COL.sheer,
      "stroke-width": 1.5,
      "stroke-dasharray": "5 4",
    }),
  );
  fixedText(
    svg,
    v.snX(b.nMin) + 4,
    v.snY(model.trimZ(xAt(b.nMin))) - 4,
    { "font-size": 10, fill: COL.sheer },
    "sheer trim",
  );
  if (span) {
    const p = sec.at(span[0]);
    ringDot(svg, v.snX(p[0]), v.snY(p[1]), COL.sheer, 4, 1.6);
  }
  // centerline trim (vertical at n = ncl) — solid where the section actually closes on it, faint where it
  // runs out first (an open section)
  const closed =
    !!span && Math.abs(fr.p[1] + sec.at(span[1])[0] * fr.n[1]) < 1e-6;
  const nclC = Math.max(b.nMin, Math.min(ncl, b.nMax));
  svg.append(
    el("line", {
      x1: v.snX(nclC),
      y1: v.snY(0),
      x2: v.snX(nclC),
      y2: v.snY(b.zMin),
      stroke: COL.keel,
      "stroke-width": 1.5,
      opacity: closed ? 1 : 0.4,
      "stroke-dasharray": "5 4",
    }),
  );
  fixedText(
    svg,
    v.snX(nclC) - 4,
    v.snY(b.zMin) - 6,
    { "text-anchor": "end", "font-size": 10, fill: COL.keel },
    "centerline",
  );
  // (no keel-point marker here — it would sit right on the seam and hide the very continuity being inspected)
  // the design waterline across the section: the height where worldZ = −waterline (sinkage + rake)
  const wlS = Math.sin(model.deckRake),
    wlC = Math.cos(model.deckRake),
    wlLine: Vec2[] = [];
  for (let i = 0; i <= 48; i++) {
    const n = b.nMin + ((b.nMax - b.nMin) * i) / 48,
      z = (-model.waterline - xAt(n) * wlS) / wlC;
    wlLine.push([v.snX(n), v.snY(z)]);
  }
  const zWL0 = (-model.waterline - xAt(0) * wlS) / wlC;
  if (zWL0 < 0 && zWL0 > b.zMin) {
    svg.append(
      el("path", {
        d: poly(wlLine),
        fill: "none",
        stroke: COL.wl,
        "stroke-width": 1.5,
        opacity: 0.9,
        "stroke-dasharray": "5 4",
      }),
    );
    fixedText(
      svg,
      v.snX(b.nMax) - 4,
      v.snY((-model.waterline - xAt(b.nMax) * wlS) / wlC) - 4,
      { "text-anchor": "end", "font-size": 10, fill: COL.wl },
      "WL",
    );
  }

  // mark where the currently selected station point lands on this lofted section
  const selIdx = selStationIdx(model, selection);
  if (selIdx !== null) {
    const p = model.loft.at(u).pts[selIdx];
    linkDot(svg, v.snX(p[0]), v.snY(p[1]), COL.station);
  }
  perfEnd(PERF_CUT);
}

// a fixed-size white dot with a colored ring: the non-draggable "computed point" markers (the cut sheer /
// keel dots and the cut station's sheer-trim start point)
function ringDot(
  svg: SVGGElement,
  sx: number,
  sy: number,
  stroke: string,
  r = 3.2,
  sw = 1.5,
): void {
  fixed(svg, sx, sy, (g) =>
    g.append(
      el("circle", {
        cx: 0,
        cy: 0,
        r,
        fill: "#fff",
        stroke,
        "stroke-width": sw,
      }),
    ),
  );
}

// a small red ✕ marking the spot that corresponds (same index) to the selected point — drawn on the other
// stations' ghost curves so you can see where that control point lands on the other sections
export function redX(svg: SVGGElement, sx: number, sy: number): void {
  const r = 4.5;
  fixed(svg, sx, sy, (g) => {
    for (const [dx, dy] of [
      [-1, -1],
      [-1, 1],
    ] as const)
      g.append(
        el("line", {
          x1: dx * r,
          y1: dy * r,
          x2: -dx * r,
          y2: -dy * r,
          stroke: SEL,
          "stroke-width": 2,
          "stroke-linecap": "round",
        }),
      );
  });
}

// mark the point that CORRESPONDS (same index) to the current selection on the lofted cut station:
// a dashed amber ring over a dot in `col`, reading as "linked", matching the amber 3D guide ribbon.
export function linkDot(
  svg: SVGGElement,
  sx: number,
  sy: number,
  col: string,
): void {
  fixed(svg, sx, sy, (g) => {
    g.append(
      el("circle", {
        cx: 0,
        cy: 0,
        r: 8,
        fill: "none",
        stroke: HILITE,
        "stroke-width": 2,
        opacity: 0.9,
        "stroke-dasharray": "3 3",
      }),
    );
    g.append(
      el("circle", {
        cx: 0,
        cy: 0,
        r: 3.5,
        fill: col,
        stroke: "#fff",
        "stroke-width": 1.2,
      }),
    );
  });
}

export function cpDot(
  selection: ModelSelection,
  svg: SVGGElement,
  idx: number,
  sx: number,
  sy: number,
  onSelect: OnModelSelect,
): void {
  fixed(svg, sx, sy, (g) => {
    const c = el("circle", {
      cx: 0,
      cy: 0,
      r: 5.5,
      fill: isSelected(selection, "plan", idx) ? SELB : COL.sheer,
      stroke: "#fff",
      "stroke-width": 1.5,
    });
    c.addEventListener("pointerdown", (e) =>
      sheerPointDown(idx, svg, e, onSelect),
    );
    g.append(c);
  });
}

// A station's handle on the plan curve: the station drawn as it is seen from above — a segment from its
// first knot, on the plan curve, running inboard along the station plane's normal to the last knot's offset
// n — in the station's own accent colour. Pressing it makes that station the active one (the same act as
// clicking its tab over the section editor) and then drags it fore-aft along the sheer; the active one is
// drawn heavier, so the plan says which section is being edited. It is a content-space segment, not a
// fixed()-wrapped marker: its length is a real inboard distance, so it has to scale with the drawing (only
// its stroke stays a constant screen width).
export function stationHandle(
  svg: SVGGElement,
  si: number,
  a: Vec2, // screen: the first knot, on the plan curve
  b: Vec2, // screen: the last knot, at its inboard offset
  active: boolean,
  onSelect: OnModelSelect,
  onActivate: (si: number) => void,
): void {
  const ends = {
    x1: a[0].toFixed(2),
    y1: a[1].toFixed(2),
    x2: b[0].toFixed(2),
    y2: b[1].toFixed(2),
  };
  svg.append(
    el("line", {
      ...ends,
      stroke: stationColor(si),
      "stroke-width": active ? 3 : 2,
      "stroke-linecap": "round",
    }),
  );
  // an invisible band over the segment, wide enough that a thin line is still easy to grab
  const hit = el("line", {
    ...ends,
    stroke: "#000",
    "stroke-width": 10,
    opacity: 0,
    style: "cursor:ew-resize",
  });
  titled(
    hit,
    `Station ${si + 1} — click to edit its section, drag along the sheer to move it`,
  );
  hit.addEventListener("pointerdown", (e) => {
    onActivate(si);
    stationUDown(si, svg, e, onSelect);
  });
  svg.append(hit);
}

export function trimDot(
  selection: ModelSelection,
  svg: SVGGElement,
  idx: number,
  sx: number,
  sy: number,
  k: number,
  onSelect: OnModelSelect,
): void {
  // morph round (k=0, smooth) → square (k=1, hard corner) via corner radius, like the station nodes
  const s = 5.5,
    rad = (1 - Math.min(Math.max(k, 0), 1)) * s;
  fixed(svg, sx, sy, (g) => {
    const c = el("rect", {
      x: -s,
      y: -s,
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
    g.append(c);
  });
}

export function transomDot(
  selection: ModelSelection,
  svg: SVGGElement,
  idx: number,
  sx: number,
  sy: number,
  onSelect: OnModelSelect,
): void {
  fixed(svg, sx, sy, (g) => {
    const c = el("circle", {
      cx: 0,
      cy: 0,
      r: 5.5,
      fill: isSelected(selection, "transom", idx) ? SELB : "var(--transom)",
      stroke: "#fff",
      "stroke-width": 1.5,
    });
    c.addEventListener("pointerdown", (e) =>
      transomPointDown(idx, svg, e, onSelect),
    );
    g.append(c);
  });
}

//------------- event callbacks attached to the SVG nodes in the above draw functions -------------

// click on a station point → select it (and, if it can move, start dragging). The pinned deck point
// (idx 0) selects but does not drag.

export function stnPointDown(
  si: number,
  idx: number,
  end: boolean,
  svg: SVGGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  e.stopPropagation();
  if (end) {
    onSelect({ tgt: "station", idx, si });
    return;
  }
  startDrag({ kind: "stn", si, idx }, svg, e, onSelect);
}

export function sheerPointDown(
  idx: number,
  svg: SVGGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  e.stopPropagation();
  startDrag({ kind: "sheer", idx }, svg, e, onSelect);
}

export function trimPointDown(
  idx: number,
  svg: SVGGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  e.stopPropagation();
  startDrag({ kind: "trim", idx }, svg, e, onSelect);
}

export function transomPointDown(
  idx: number,
  svg: SVGGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  e.stopPropagation();
  startDrag({ kind: "transom", idx }, svg, e, onSelect);
}

// a station's position handle: drags the station along the sheer plan (its u). Like the cut slider, it
// moves rather than selects — a station is chosen by its tab in the section editor.
export function stationUDown(
  si: number,
  svg: SVGGElement,
  e: PointerEvent,
  onSelect: OnModelSelect,
): void {
  e.stopPropagation();
  startDrag({ kind: "stationU", idx: si }, svg, e, onSelect);
}
