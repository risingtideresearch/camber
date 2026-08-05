// ---------- the hull mesh: a swept quad sheet, then trimmed ----------
//
// THE SHEET. Columns are uniform in the sheer plan's own parameter u; rows are uniform in the section
// curve's parameter v. Neither is uniform in arclength, and neither needs to be — the plan's B-spline
// parameter and the section's Catmull-Rom parameter are both cheap to evaluate and both smooth in the
// geometry, so a uniform step in either sweeps the surface evenly enough while costing nothing to invert.
//
// Rows are laid out so that STATION KNOTS FALL ON ROWS. Each of the section's S−1 segments gets the same
// number of sub-steps, so knot i is row i·R exactly. That matters because a knuckle lives at a knot: the
// mesh needs an edge loop there for the crease to have somewhere to be, and shading a crease means giving
// one row two sets of normals. A grid that merely passed near the knots would smear every chine.
//
// TWO TRIMS OF THAT SHEET live in this file:
//
//   • the REGULARIZED path (`sweptSection` / `keptSpan` / `anchorsFor` / `hullGrid` / `trimmedHullGrid`)
//     trims each column on its own to a CONSTANT row count, with the knots clamped inside the kept span. Its
//     rectangular topology is what a B-spline control net needs, so STEP export samples it; the curvature
//     combs read its converged column ends. It is bisection-per-column and keeps the keel on a fixed column.
//
//   • the MARCHED-TRIM path (`computeHullSampling` → `HullSampling`) trims the SHEET ITSELF — classifying
//     lattice nodes by the hull's keep test and tessellating the surviving interior into whole quads and
//     boundary triangles, sharing each edge crossing between the cells that meet on it. Its boundary is exact
//     in both directions and its normals stay clean along every trim, so the 3D surface, the 2D outlines, the
//     lines plan, hydrostatics, and STL/preview are all built from it. See the block above `HullSample`.

import { clamp, mirrorRow, V, type Vec2, type Vec3 } from "./math";
import {
  perfAdd,
  perfMark,
  perfRecording,
  PERF_MESH,
  PERF_SAMPLING,
} from "./perf";
import {
  bisectRoot,
  frameAt,
  keepAt,
  sectionAt,
  sectionWorld,
  xTransom,
  type Frame,
  type Model,
  type Section,
} from "./model";

// sub-steps per section segment: the mesh's girth resolution, S−1 segments × R + 1 rows
export const R_DEFAULT = 16;

// The trimmed starboard half-section `sweptSection` returns for the curvature combs, the cut-station readout,
// and the rectangular `trimmedHullGrid` that STEP export samples. (The 3D/2D/lines/hydro views read the
// marched-trim `HullSampling` below instead; this is the regularized, constant-row-count path.)
export interface SectionRow {
  pts: Vec3[]; // starboard: the sheer edge → the keel (or wherever the trim ended it)
  empty: boolean; // no hull at this u at all
  keel: boolean; // the last point sits on the centerline, so the port half joins it there
  // rows that sit on a station knot and carry a crease. The mesh gives these a tangent break scaled by
  // `creaseK`; a faded knuckle (low k) on a crease row stays smooth, so sharpness stays data-driven.
  creaseRows: number[];
  creaseK: number[];
}

// The kept span of the section at u: [vTop, vBot], or null where the column has no hull.
//
// The scan is coarse and the ends are converged: `keepAt` is the min of three constraints, so it has kinks
// where the binding constraint changes and a root-finder that assumed smoothness could walk off one. A scan
// to bracket, then bisection to converge, is robust to that and still lands on the root to float precision.
export function keptSpan(
  model: Model,
  fr: Frame,
  sec: Section,
  FN = 96,
): [number, number] | null {
  const g = (v: number): number => keepAt(model, fr, sec.at(v));
  const gs: number[] = [];
  for (let i = 0; i <= FN; i++) gs.push(g((sec.vmax * i) / FN));
  let lo = -1,
    hi = -1;
  for (let i = 0; i <= FN; i++)
    if (gs[i] >= 0) {
      if (lo < 0) lo = i;
      hi = i;
    }
  if (lo < 0) return null; // every row trimmed away — no hull at this u
  const at = (i: number): number => (sec.vmax * i) / FN;
  // the top edge: the sheer, unless the column's very first row is already inside (nothing cut it)
  const vTop = lo === 0 ? 0 : bisectRoot(g, at(lo - 1), at(lo), gs[lo - 1]);
  // the bottom edge: the centerline or the transom, unless the section ran out first (an open section)
  const vBot =
    hi === FN ? sec.vmax : bisectRoot(g, at(hi + 1), at(hi), gs[hi + 1]);
  return vBot > vTop + 1e-9 ? [vTop, vBot] : null;
}

// Where each station knot goes once the span is trimmed to [vTop, vBot].
//
// Every knot always gets an anchor, even one the trim cut away, so the row count is CONSTANT along the hull:
// if anchors appeared and vanished as knots crossed a trim, the rows would jump and the surface would tear
// there. A cut-away knot clamps onto the boundary; the `i·margin` spread keeps the anchors strictly ordered
// when several clamp to the same edge, which they do at the ends of the hull.
//
// Anchor 0 is the sheer edge and anchor S−1 the keel, which is why knot 0 (the deck point, always above the
// sheer trim) and the last knot never contribute a crease of their own.
function anchorsFor(
  S: number,
  vTop: number,
  vBot: number,
): {
  anchors: number[];
  pinned: boolean[]; // is this anchor the knot itself, rather than clamped onto the boundary?
} {
  const margin = (vBot - vTop) * 1e-3,
    anchors: number[] = [],
    pinned: boolean[] = [];
  for (let i = 0; i < S; i++) {
    const lo = vTop + i * margin,
      hi = vBot - (S - 1 - i) * margin,
      a = clamp(i, lo, hi);
    anchors.push(a);
    pinned.push(Math.abs(a - i) < 1e-9);
  }
  return { anchors, pinned };
}

// The trimmed starboard half-section at u, as (S−1)·R + 1 world points from the sheer edge down to the keel.
// With `trim` off it is the raw swept sheet instead: the whole section, deck to the last point, uncut.
//
// This is the hull's inner loop — the mesh calls it once per column — so it is where the performance
// readout's mesh sub-steps are measured. The three phases are the real ones, in the order they run: loft
// the section at u, trim it to find the span that survives, then sweep the sheet's rows inside that span.
// (The sheet is sampled AFTER the trim rather than swept whole and cut, which is why there is no separate
// "trimming the sheet" phase to time: the trim is what tells the sweep where to start and stop.) They are
// reported through `perfAdd`, which discards them unless the hull rebuild's own pass is the open one — the
// 2D views call this too, and there the caller's step is already being timed as a whole.
export function sweptSection(
  model: Model,
  u: number,
  R = R_DEFAULT,
  trim = true,
): SectionRow {
  const t0 = perfMark(),
    fr = frameAt(model, u),
    sec = sectionAt(model, u),
    S = sec.vmax + 1;
  const t1 = perfMark();
  const span = trim
    ? keptSpan(model, fr, sec)
    : ([0, sec.vmax] as [number, number]);
  const t2 = perfMark();
  perfAdd(PERF_MESH, "Lofting the sections", t1 - t0);
  perfAdd(PERF_MESH, "Trimming (kept spans)", t2 - t1);
  if (!span)
    return { pts: [], empty: true, keel: false, creaseRows: [], creaseK: [] };
  const [vTop, vBot] = span,
    { anchors, pinned } = anchorsFor(S, vTop, vBot);
  const pts: Vec3[] = [],
    creaseRows: number[] = [],
    creaseK: number[] = [];
  for (let i = 0; i < S - 1; i++) {
    if (i === 0) pts.push(sectionWorld(fr, sec, anchors[0]));
    for (let r = 1; r <= R; r++)
      pts.push(
        sectionWorld(
          fr,
          sec,
          anchors[i] + ((anchors[i + 1] - anchors[i]) * r) / R,
        ),
      );
    // the knot ending this segment gets the crease, if it is a real interior knot and creased at all
    const j = i + 1;
    if (j < S - 1 && pinned[j] && (sec.ks[j] ?? 0) > 1e-6) {
      creaseRows.push(j * R);
      creaseK.push(clamp(sec.ks[j], 0, 1));
    }
  }
  // does the bottom sit on the centerline? Then it is the keel: snap it exactly onto y = 0 — the bisection
  // converges to ~1e-12, but the two halves must MEET, not nearly meet.
  //
  // The station's `keelK` is deliberately NOT read here. The keel is left smooth: it gets no crease row, so
  // the two halves join with the section's own continuity across the centerline. Honouring keelK means
  // deforming the section near the crossing (a hard V has to be built, not merely shaded), which is its own
  // change and lands separately.
  const last = pts[pts.length - 1],
    keel = trim && Math.abs(last[1]) < 1e-6;
  if (keel) last[1] = 0;
  perfAdd(PERF_MESH, "Sweeping the sheet (rows)", perfMark() - t2, pts.length);
  return { pts, empty: false, keel, creaseRows, creaseK };
}

// ---------- the hull sampling: sheet, marched trims, and a trimmed quad/tri mesh ----------
//
// The hull is a quad SHEET (uniform in the plan parameter u × per-segment-uniform in the section parameter v)
// cut by three surfaces: the sheer trim (top), the centerline y = 0 (the keel), and the transom plane (aft).
// The earlier sampling trimmed each COLUMN (a section at fixed u) on its own, so every column ended on a
// fractional sheet row and the mesh was stitched by fanning triangles between neighbouring columns' ragged
// ends — which left the fixed-v longitudinals NOT ending where they were trimmed and scattered inconsistent
// face normals along every trim edge. This one trims the SHEET ITSELF: it classifies every lattice node by
// whether the hull keeps it (`kv` ≥ 0, the min of the three constraints), converges each trim/grid-edge
// crossing by bisection SHARED between the two cells that meet on that edge, and tessellates the surviving
// interior cell by cell — whole quads inside, marching-squares polygons on the boundary. The boundary is then
// exact in BOTH directions and the normals stay clean along every edge.
//
// Every vertex is a `HullSample` carrying its (u, v), its (possibly fractional) sheet indices, and the crease
// strength when crossing it in each direction. Shared boundary vertices are shared by OBJECT IDENTITY — the
// same HullSample object in two cells, in the trimmed boundary curves, and in the transom panel — so nothing
// can crack and the panel rides the skin's own edge. Five things come out of one pass, in the order the hull
// is defined: the untrimmed `sheet`; the three trims marched over it; the three CORNERS where those trims cross
// each other; the trimmed boundary curves (`hullSheer` / `hullCenterline` / `hullTransom`) read off the trimmed
// columns and closed on those corners, each with the cut-away rest of its marched trim beside it
// (`hullSheerLeftover` and its two siblings); and the render mesh (`hullQuads` / `hullTris`) of the starboard half
// (the port half is its y-mirror, added by the mesh builder).

export interface HullSample {
  pos: Vec3;
  u: number;
  v: number;
  uSheetIndex: number; // integer on a column, fractional on a row-edge crossing between two columns
  vSheetIndex: number; // integer on a row, fractional on a column-edge crossing between two rows
  uCreaseK: number; // crease strength crossing this point in u (0 — the model has no transverse creases)
  vCreaseK: number; // crease strength crossing this point in v (a chine / knuckle row)
  // the surface normal read straight off the sheet f(u,v) — the outward normal ∂f/∂u × ∂f/∂v — carried as two
  // one-sided values so a crease row keeps the two normals a chine needs. nrmLo is the normal approaching the
  // sample in −v (toward the sheer), nrmHi in +v (toward the keel); off a crease they are the same vector. The
  // mesh builder reads these and blends them by vCreaseK rather than averaging neighbouring faces (buildHullMesh).
  nrmLo: Vec3;
  nrmHi: Vec3;
}

export type TrimCurve = HullSample[]; // an ordered polyline of samples along one trim
export type Quad = [HullSample, HullSample, HullSample, HullSample];
export type Tri = [HullSample, HullSample, HullSample];

// one trimmed section at a column of the sheet: the surviving run sheer → keel/transom, plus which trim ended
// it. `pts` is empty where the whole column is trimmed away. Needed by hydro (integrates columns), the 2D
// outlines (the max-beam line), and the lines plan (a station IS a column).
export interface HullColumnV2 {
  pts: HullSample[];
  i: number; // the sheet column index: u = uParams[i]
  keel: boolean; // the bottom sits on the centerline
  transom: boolean; // ...or on the transom plane
}

export interface HullSampling {
  R: number; // sub-steps per section segment (girth resolution)
  M: number; // the keel's sheet index in a full untrimmed column: (S−1)·R
  uParams: number[]; // the u of each column — the uniform lattice
  vParams: number[]; // the v of each row: vParams[k] = k / R
  sheet: HullSample[][]; // [column i][row k] — the full untrimmed grid
  // each trim marched over the whole sheet as if it were the only one — its zero contour traced cell by cell
  // through BOTH edge directions, so it reaches the sheet's own top and bottom rows — in runs (a contour can
  // leave and re-enter the sheet), with the corners it makes with the other two spliced in at their exact spot
  sheetSheer: TrimCurve[];
  sheetCenterline: TrimCurve[];
  sheetTransom: TrimCurve[];
  // the hull's actual boundary once the trims are cut against each other, read off the trimmed columns with
  // the three corners — head (sheer ∩ transom), foot (keel ∩ transom) and stem (sheer ∩ centerline, the tip of
  // the bow) — spliced onto the ends they close
  hullSheer: TrimCurve;
  hullCenterline: TrimCurve;
  hullTransom: TrimCurve;
  // and the rest of each marched trim: the span the other two CUT AWAY, which the hull's own edge above does
  // not draw. In RUNS, not one curve — a trim cut at both ends leaves two pieces and they do not join — each
  // closed on the corner where the hull's edge takes over, so a leftover run and that edge together are the
  // whole marched trim again, with the corner the only point in both
  hullSheerLeftover: TrimCurve[];
  hullCenterlineLeftover: TrimCurve[];
  hullTransomLeftover: TrimCurve[];
  columns: HullColumnV2[]; // the per-column trimmed sections, aligned with uParams
  // the render mesh of the STARBOARD trimmed half, vertices shared by object identity
  hullQuads: Quad[];
  hullTris: Tri[];
}

// A corner of the trimmed sheet: the exact point where two of the three trims cross, and which two they are
// (always a < b). It is a point of BOTH of their edges, and the tip the mesh's bevel is cut off short of.
interface TrimCorner {
  s: HullSample;
  a: number; // the trim it was walked along...
  b: number; // ...and the one whose constraint vanished on it
}

// the interior station knots that carry a knuckle, as sheet indices (knot i sits at i·R) with their blended
// strength — the crease rows the mesh gives a tangent break. The deck point (0) and the keel (S−1) never
// crease, so they are skipped. Shared by reference across a column's four stages (read-only).
function creasesOf(
  sec: Section,
  R: number,
): { creaseRows: number[]; creaseK: number[] } {
  const S = sec.vmax + 1,
    creaseRows: number[] = [],
    creaseK: number[] = [];
  for (let i = 1; i < S - 1; i++) {
    const k = sec.ks[i] ?? 0;
    if (k > 1e-6) {
      creaseRows.push(i * R);
      creaseK.push(clamp(k, 0, 1));
    }
  }
  return { creaseRows, creaseK };
}

// Compute the whole sampling: the sheet, the three trims marched over it, the trimmed boundary curves, the
// per-column trimmed sections, and the render mesh — all sharing their boundary vertices by object identity.
// numSections is N (u segments), numLongitudinalsPerKnot is R (girth sub-steps per section segment).
export function computeHullSampling(
  model: Model,
  numSections: number,
  numLongitudinalsPerKnot: number,
): HullSampling {
  // The sub-steps of the readout's "Hull sampling" pass, in the order the phases below run: each call closes
  // the span since the previous one and reports it. Timed with a cursor rather than by wrapping each phase in
  // a closure because the phases share this function's locals wholesale. The count is a THUNK — most of them
  // walk what the phase just built — and nothing is timed or counted unless the sampling's own pass is the
  // open one: hydro, the STL writer and the thumbnails call this outside it, and the hull's crossings are
  // shared and CACHED, so whichever phase asks for one first is the one that pays for its bisection.
  let tPhase = perfMark();
  const phase = (label: string, count?: () => number, unit?: string): void => {
    if (!perfRecording(PERF_SAMPLING)) return;
    const t = performance.now();
    perfAdd(PERF_SAMPLING, label, t - tPhase, count?.() ?? null, unit);
    tPhase = t;
  };

  const N = Math.max(1, Math.round(numSections)),
    R = Math.max(1, Math.round(numLongitudinalsPerKnot)),
    S = model.loft.S,
    M = (S - 1) * R;
  const uParams: number[] = [];
  for (let i = 0; i <= N; i++) uParams.push(i / N);
  const vParams: number[] = [];
  for (let k = 0; k <= M; k++) vParams.push(k / R);

  // the three keep constraints on a world point: ≥ 0 keeps it. Their MIN makes "the hull survives this
  // point" one sign test, and one bisection on it lands on whichever trim binds — sheer, centerline, or
  // transom — with no case analysis (the same construction as `keepAt`, but on a point we already hold).
  const cS = (p: Vec3): number => model.trimZ(p[0]) - p[2]; // at/below the sheer trim
  const cC = (p: Vec3): number => p[1]; // at/inboard of the centerline
  const cT = (p: Vec3): number => p[0] - xTransom(model, p[2]); // forward of the transom
  const cons: ((p: Vec3) => number)[] = [cS, cC, cT];

  // The steps for the surface normal's derivatives. EU nudges u for the ∂f/∂u central difference; EV nudges v
  // to pick the segment on either side of a crease knot for the one-sided ∂f/∂v. Both are tiny against their
  // parameter's [0,1]/[0,vmax] range — small enough to read the local derivative, far above float noise.
  const EU = 1e-4,
    EV = 1e-3;

  // per-column frame + section (each evaluated once), the knuckle strength at each crease row, and the u±EU
  // neighbour frames/sections the ∂f/∂u finite difference reads (clamped to [0,1], so a boundary column takes a
  // one-sided step and reuses its own frame/section on the clamped side)
  const frs: Frame[] = [],
    secs: Section[] = [],
    creaseAt: Map<number, number>[] = [],
    frsLo: Frame[] = [],
    secsLo: Section[] = [],
    frsHi: Frame[] = [],
    secsHi: Section[] = [],
    uSpans: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = uParams[i],
      fr = frameAt(model, u),
      sec = sectionAt(model, u),
      cm = new Map<number, number>(),
      { creaseRows, creaseK } = creasesOf(sec, R);
    for (let t = 0; t < creaseRows.length; t++)
      cm.set(creaseRows[t], creaseK[t]);
    frs.push(fr);
    secs.push(sec);
    creaseAt.push(cm);
    const uLo = Math.max(u - EU, 0),
      uHi = Math.min(u + EU, 1);
    frsLo.push(uLo === u ? fr : frameAt(model, uLo));
    secsLo.push(uLo === u ? sec : sectionAt(model, uLo));
    frsHi.push(uHi === u ? fr : frameAt(model, uHi));
    secsHi.push(uHi === u ? sec : sectionAt(model, uHi));
    uSpans.push(uHi - uLo);
  }
  phase("Frames + sections", () => N + 1, "cols");

  // ---- the surface normal, straight off the sheet f(u,v) = sectionWorld(frame(u), section(u), v) ----
  // ∂f/∂v is the section's OWN exact tangent (an exact quadratic Bézier derivative), rotated into the world by
  // the frame normal — z is world z, so only n rides the frame. ∂f/∂u is a central finite difference of the
  // whole sheet in u: it has no clean closed form, because moving u slides the plan point, turns the frame, AND
  // reshapes the lofted section all at once. Their cross product is the outward normal.
  //
  // Two one-sided ∂f/∂v — v nudged to either side — give the two normals a crease row needs: off a crease they
  // coincide (the section is C¹ there), at a hard knuckle they part, and buildHullMesh blends between them by
  // vCreaseK. The cross product's sign is left as it falls; it is consistent across the whole sheet, and the
  // hull shader is two-sided, so outward-vs-inward never matters here.
  const dfdv = (fr: Frame, sec: Section, v: number): Vec3 => {
    const [dn, dz] = sec.d(v);
    return [dn * fr.n[0], dn * fr.n[1], dz];
  };
  const normalsAt = (
    fr: Frame,
    sec: Section,
    v: number,
    frLo: Frame,
    secLo: Section,
    frHi: Frame,
    secHi: Section,
    uSpan: number,
  ): { lo: Vec3; hi: Vec3 } => {
    const dfdu = V.scale(
      V.sub(sectionWorld(frHi, secHi, v), sectionWorld(frLo, secLo, v)),
      1 / uSpan,
    );
    return {
      lo: V.norm(V.cross(dfdu, dfdv(fr, sec, Math.max(v - EV, 0)))),
      hi: V.norm(V.cross(dfdu, dfdv(fr, sec, Math.min(v + EV, sec.vmax)))),
    };
  };
  // the same for a sample OFF the column lattice (a row-edge crossing or a corner, at fractional u): its u±EU
  // neighbour frames/sections are built on the spot rather than read from the per-column arrays.
  const normalsAtU = (
    u: number,
    v: number,
    fr: Frame,
    sec: Section,
  ): { lo: Vec3; hi: Vec3 } => {
    const uLo = Math.max(u - EU, 0),
      uHi = Math.min(u + EU, 1);
    return normalsAt(
      fr,
      sec,
      v,
      frameAt(model, uLo),
      sectionAt(model, uLo),
      frameAt(model, uHi),
      sectionAt(model, uHi),
      uHi - uLo,
    );
  };

  // (1) the sheet: every lattice node a world point, tagged with its integer indices, v-crease strength, and
  // the two one-sided surface normals
  const sheet: HullSample[][] = [];
  for (let i = 0; i <= N; i++) {
    const col: HullSample[] = [];
    for (let k = 0; k <= M; k++) {
      const nn = normalsAt(
        frs[i],
        secs[i],
        vParams[k],
        frsLo[i],
        secsLo[i],
        frsHi[i],
        secsHi[i],
        uSpans[i],
      );
      col.push({
        pos: sectionWorld(frs[i], secs[i], vParams[k]),
        u: uParams[i],
        v: vParams[k],
        uSheetIndex: i,
        vSheetIndex: k,
        uCreaseK: 0,
        vCreaseK: creaseAt[i].get(k) ?? 0,
        nrmLo: nn.lo,
        nrmHi: nn.hi,
      });
    }
    sheet.push(col);
  }
  phase("Sheet nodes (+ normals)", () => (N + 1) * (M + 1));
  // every constraint at every node — the marched trims' sign fields — and their min, the hull's keep test
  const cv = cons.map((c) => sheet.map((col) => col.map((s) => c(s.pos))));
  const kv = sheet.map((col, i) =>
    col.map((_, k) => Math.min(cv[0][i][k], cv[1][i][k], cv[2][i][k])),
  );
  const inside = (i: number, k: number): boolean => kv[i][k] >= 0;
  phase("Keep fields (3 trims)", () => (N + 1) * (M + 1));

  // A trim/grid-edge crossing, converged by bisection on ONE constraint and CACHED so the two cells that meet
  // on the edge — and the trimmed boundary curves, and the transom panel — share the identical HullSample.
  // That object-identity sharing is what makes the mesh crack-free and lets the panel ride the skin's own edge.
  const colCache = new Map<number, HullSample>(),
    rowCache = new Map<number, HullSample>();
  // the crossing of constraint `ci` between rows k and k+1 of column i (integer u, fractional v)
  const colCross = (ci: number, i: number, k: number): HullSample => {
    const key = (ci * (N + 1) + i) * (M + 1) + k,
      hit = colCache.get(key);
    if (hit) return hit;
    const c = cons[ci],
      fr = frs[i],
      sec = secs[i],
      g = (v: number): number => c(sectionWorld(fr, sec, v)),
      v = bisectRoot(g, vParams[k], vParams[k + 1], g(vParams[k])),
      pos = sectionWorld(fr, sec, v);
    if (ci === 1) pos[1] = 0; // the centerline crossing must sit EXACTLY on y = 0 so the two halves meet
    const nn = normalsAt(
      fr,
      sec,
      v,
      frsLo[i],
      secsLo[i],
      frsHi[i],
      secsHi[i],
      uSpans[i],
    );
    const s: HullSample = {
      pos,
      u: uParams[i],
      v,
      uSheetIndex: i,
      vSheetIndex: v * R,
      uCreaseK: 0,
      vCreaseK: 0,
      nrmLo: nn.lo,
      nrmHi: nn.hi,
    };
    colCache.set(key, s);
    return s;
  };
  // the crossing of constraint `ci` between columns i and i+1 on row k (fractional u, integer v)
  const rowCross = (ci: number, i: number, k: number): HullSample => {
    const key = (ci * (N + 1) + i) * (M + 1) + k,
      hit = rowCache.get(key);
    if (hit) return hit;
    const c = cons[ci],
      vv = vParams[k],
      h = (u: number): number =>
        c(sectionWorld(frameAt(model, u), sectionAt(model, u), vv)),
      u = bisectRoot(h, uParams[i], uParams[i + 1], h(uParams[i])),
      fr = frameAt(model, u),
      sec = sectionAt(model, u),
      pos = sectionWorld(fr, sec, vv);
    if (ci === 1) pos[1] = 0;
    let vc = 0; // a knuckle row carries its crease across this crossing too
    if (k % R === 0) {
      const j = k / R;
      if (j > 0 && j < S - 1) vc = clamp(sec.ks[j] ?? 0, 0, 1);
    }
    const nn = normalsAtU(u, vv, fr, sec);
    const s: HullSample = {
      pos,
      u,
      v: vv,
      uSheetIndex: u * N,
      vSheetIndex: k,
      uCreaseK: 0,
      vCreaseK: vc,
      nrmLo: nn.lo,
      nrmHi: nn.hi,
    };
    rowCache.set(key, s);
    return s;
  };

  // the hull-boundary crossing on a cell edge: whichever constraint binds (its crossing is the one nearest the
  // inside node), plus that constraint's index. A column edge takes its param in v, a row edge in u.
  const colBoundary = (i: number, k: number): { s: HullSample; ci: number } => {
    const vIn = inside(i, k) ? vParams[k] : vParams[k + 1];
    let s: HullSample | null = null,
      ci = -1,
      best = Infinity;
    for (let c = 0; c < 3; c++) {
      const fa = cons[c](sheet[i][k].pos),
        fb = cons[c](sheet[i][k + 1].pos);
      if (fa < 0 === fb < 0) continue;
      const cross = colCross(c, i, k),
        d = Math.abs(cross.v - vIn);
      if (d < best) {
        best = d;
        s = cross;
        ci = c;
      }
    }
    return { s: s as HullSample, ci };
  };
  const rowBoundary = (i: number, k: number): { s: HullSample; ci: number } => {
    const uIn = inside(i, k) ? uParams[i] : uParams[i + 1];
    let s: HullSample | null = null,
      ci = -1,
      best = Infinity;
    for (let c = 0; c < 3; c++) {
      const fa = cons[c](sheet[i][k].pos),
        fb = cons[c](sheet[i + 1][k].pos);
      if (fa < 0 === fb < 0) continue;
      const cross = rowCross(c, i, k),
        d = Math.abs(cross.u - uIn);
      if (d < best) {
        best = d;
        s = cross;
        ci = c;
      }
    }
    return { s: s as HullSample, ci };
  };

  // (2) the trimmed columns, and every boundary point tagged with WHICH trim it lies on. A column is clipped to
  // its single surviving run; `keel` / `transom` record which trim ended its bottom.
  // every hull-boundary crossing the tessellation or the columns land on, deduplicated by object identity and
  // routed by WHICH trim it lies on. Both the columns' ends AND the row-edge crossings the mesh uses near the
  // closures feed this, so the boundary curves are the skin's own aft/keel/sheer edge — vertex for vertex.
  const seenB = new Set<HullSample>();
  const sheerB: HullSample[] = [],
    keelB: HullSample[] = [],
    transomB: HullSample[] = [];
  const ciOf = new Map<HullSample, number>(); // which trim a boundary crossing lies on
  const record = (b: { s: HullSample; ci: number }): void => {
    ciOf.set(b.s, b.ci);
    if (seenB.has(b.s)) return;
    seenB.add(b.s);
    (b.ci === 0 ? sheerB : b.ci === 1 ? keelB : transomB).push(b.s);
  };

  const columns: HullColumnV2[] = [];
  for (let i = 0; i <= N; i++) {
    let lo = -1,
      hi = -1;
    for (let k = 0; k <= M; k++)
      if (kv[i][k] >= 0) {
        if (lo < 0) lo = k;
        hi = k;
      }
    if (lo < 0) {
      columns.push({ pts: [], i, keel: false, transom: false });
      continue;
    }
    const pts: HullSample[] = [];
    if (lo > 0) {
      const t = colBoundary(i, lo - 1); // the trim above the first kept node (usually the sheer)
      pts.push(t.s);
      record(t);
    }
    for (let k = lo; k <= hi; k++) pts.push(sheet[i][k]);
    let keel = false,
      transom = false;
    if (hi < M) {
      const b = colBoundary(i, hi); // the trim below the last kept node (keel or transom)
      pts.push(b.s);
      record(b);
      if (b.ci === 1) keel = true;
      else if (b.ci === 2) transom = true;
    }
    columns.push({ pts, i, keel, transom });
  }
  phase("Trimmed columns", () => columns.reduce((n, c) => n + c.pts.length, 0));

  // (3) marched raw trims: each constraint's zero contour marched over the WHOLE sheet — every cell, both
  // edge directions — ignoring the other trims. The per-column scan this replaces looked only at COLUMN
  // edges (one crossing per column, first hit only), so a trim running steeply in v — the transom, cutting
  // across the sheet's rows — came back with scattered samples and stopped short of the sheet's own top and
  // bottom rows. Marching the cells follows the contour wherever it goes: a crossing on a column edge is
  // `colCross`, on a row edge `rowCross` — the same cached samples the tessellation shares by identity — and
  // each cell links its two crossings into a segment (a saddle cell pairs its four by the cell's mean).
  // The segments then chain end to end into RUNS: open chains first, from their loose ends, then any closed
  // loop left over. Runs, not one curve per trim — a contour can leave and re-enter the sheet.
  const marchTrim = (ci: number): TrimCurve[] => {
    const f = cv[ci],
      neg = (i: number, k: number): boolean => f[i][k] < 0;
    interface Seg {
      a: HullSample;
      b: HullSample;
      used: boolean;
    }
    const segs: Seg[] = [],
      adj = new Map<HullSample, Seg[]>();
    const link = (a: HullSample, b: HullSample): void => {
      const s = { a, b, used: false };
      segs.push(s);
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(s);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(s);
    };
    for (let i = 0; i < N; i++)
      for (let k = 0; k < M; k++) {
        // the cell's edge crossings, ring-ordered bottom → right → top → left
        const cross: HullSample[] = [];
        if (neg(i, k) !== neg(i + 1, k)) cross.push(rowCross(ci, i, k));
        if (neg(i + 1, k) !== neg(i + 1, k + 1))
          cross.push(colCross(ci, i + 1, k));
        if (neg(i + 1, k + 1) !== neg(i, k + 1))
          cross.push(rowCross(ci, i, k + 1));
        if (neg(i, k + 1) !== neg(i, k)) cross.push(colCross(ci, i, k));
        if (cross.length === 2) link(cross[0], cross[1]);
        else if (cross.length === 4) {
          // a saddle: two diagonal corners in, two out, one crossing on every edge. The cell's mean value
          // stands in for its centre and decides the pairing — the contour isolates the corners whose sign
          // the mean disagrees with, so each segment joins the two edges flanking one such corner.
          const mean = f[i][k] + f[i + 1][k] + f[i + 1][k + 1] + f[i][k + 1];
          if (mean < 0 === neg(i, k)) {
            link(cross[0], cross[1]); // around the bottom-right corner...
            link(cross[2], cross[3]); // ...and the top-left
          } else {
            link(cross[3], cross[0]); // around the bottom-left corner...
            link(cross[1], cross[2]); // ...and the top-right
          }
        }
      }
    // chain the shared crossings into runs, following each unused segment on from the tip
    const walk = (start: HullSample, seed: Seg): TrimCurve => {
      const run: TrimCurve = [start];
      let cur = start,
        seg: Seg | undefined = seed;
      while (seg) {
        seg.used = true;
        cur = seg.a === cur ? seg.b : seg.a;
        run.push(cur);
        seg = adj.get(cur)!.find((s) => !s.used);
      }
      return run;
    };
    const runs: TrimCurve[] = [];
    for (const [s, list] of adj)
      if (list.length === 1 && !list[0].used) runs.push(walk(s, list[0]));
    for (const s of segs) if (!s.used) runs.push(walk(s.a, s));
    return runs;
  };
  // orient and order the runs the way the drawn curves read — the sheer and centerline fore-aft (ascending
  // u), the transom head → foot (down the plane by height z) — matching the hull edges they survive as.
  const trims: TrimCurve[][] = [marchTrim(0), marchTrim(1), marchTrim(2)];
  for (let ci = 0; ci < 3; ci++) {
    const key = (s: HullSample): number => (ci === 2 ? -s.pos[2] : s.u);
    for (const run of trims[ci])
      if (key(run[0]) > key(run[run.length - 1])) run.reverse();
    trims[ci].sort((r1, r2) => key(r1[0]) - key(r2[0]));
  }
  phase("Marching the trims", () =>
    trims.reduce((n, runs) => n + runs.reduce((m, r) => m + r.length, 0), 0),
  );

  // (4) THE CORNERS: the points where two trims cross each other — the head (sheer ∩ transom) and the foot
  // (centerline ∩ transom) at the two ends of the transom edge, and the STEM (sheer ∩ centerline) at the tip of
  // the bow, where the sheer trim runs into the centerline and the hull closes to a point.
  //
  // None of them lands on the lattice, and none is where the marching stops: a cell that both trims cut is cut
  // off with a straight bevel, and both edge curves stop at their last cell crossing — short of the point they
  // actually meet at, by up to a cell. So each corner is converged in its own right, the same way for all
  // three: walk ONE of the two trims as a curve in u, and bisect for the u where the OTHER one's constraint
  // vanishes on it.
  const mkCorner = (pos: Vec3, u: number, v: number): HullSample => {
    const fr = frameAt(model, u),
      sec = sectionAt(model, u),
      nn = normalsAtU(u, v, fr, sec);
    return {
      pos,
      u,
      v,
      uSheetIndex: u * N,
      vSheetIndex: v * R,
      uCreaseK: 0,
      vCreaseK: 0,
      nrmLo: nn.lo,
      nrmHi: nn.hi,
    };
  };
  // The crossing of constraint `ci` on the section at u — that trim as a curve in u, converged. `ci` is the
  // sheer or the centerline, never the transom: every PAIR of trims holds one of those two, and both are met
  // going down from the deck point, which starts ABOVE the sheer trim and OUTBOARD of the centerline. A
  // section already past the trim at v = 0 has its crossing there.
  const trimAt = (ci: number, u: number): { pos: Vec3; v: number } => {
    const fr = frameAt(model, u),
      sec = sectionAt(model, u),
      g = (v: number): number => cons[ci](sectionWorld(fr, sec, v)),
      g0 = g(0),
      v = (ci === 0 ? g0 >= 0 : g0 <= 0) ? 0 : bisectRoot(g, 0, sec.vmax, g0),
      pos = sectionWorld(fr, sec, v);
    if (ci === 1) pos[1] = 0;
    return { pos, v };
  };
  const corners: TrimCorner[] = [];
  // Walk trim `a` from sample to sample along its marched runs, bracket the sign changes of trim `b`'s
  // constraint along it, and converge each. The marched trim brackets it (its crossings are the same curve,
  // already computed), but the bisection runs on the exact walk, so a bracket the walk does not agree with is
  // dropped rather than forced. A crossing the THIRD trim has already cut away is no corner of the hull, and
  // is dropped too.
  const findCorners = (a: number, b: number): void => {
    const c = 3 - a - b,
      d = (u: number): number => cons[b](trimAt(a, u).pos);
    for (const run of trims[a])
      for (let j = 0; j + 1 < run.length; j++) {
        const pa = run[j],
          pb = run[j + 1];
        if (cons[b](pa.pos) < 0 === cons[b](pb.pos) < 0) continue;
        const da = d(pa.u);
        if (da < 0 === d(pb.u) < 0) continue;
        const u = bisectRoot(d, pa.u, pb.u, da),
          t = trimAt(a, u);
        if (b === 1) t.pos[1] = 0; // a corner on the centerline sits EXACTLY on it, as its crossings do
        if (cons[c](t.pos) >= 0)
          corners.push({ s: mkCorner(t.pos, u, t.v), a, b });
      }
  };
  findCorners(0, 1); // the stem: the bow's tip, where the sheer trim runs into the centerline
  findCorners(0, 2); // the head: the transom's top, where the sheer edge crosses the plane
  findCorners(1, 2); // the foot: the transom's bottom, where the keel crosses the plane
  phase("Trim corners", () => corners.length);

  // (5) tessellate the interior cell by cell: a whole quad where all four corners survive, a marching-squares
  // polygon on the boundary. The boundary polygons are held back until the corners have been spliced into
  // them, and fanned into triangles after.
  const hullQuads: Quad[] = [],
    hullTris: Tri[] = [],
    polys: HullSample[][] = [];
  const cornersOf: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]; // BL, BR, TR, TL in (Δi, Δk), CCW in (u, v)
  for (let i = 0; i < N; i++)
    for (let k = 0; k < M; k++) {
      const flags = [
        inside(i, k),
        inside(i + 1, k),
        inside(i + 1, k + 1),
        inside(i, k + 1),
      ];
      const cnt = flags.reduce((n, f) => n + (f ? 1 : 0), 0);
      if (cnt === 0) continue;
      if (cnt === 4) {
        hullQuads.push([
          sheet[i][k],
          sheet[i + 1][k],
          sheet[i + 1][k + 1],
          sheet[i][k + 1],
        ]);
        continue;
      }
      const poly: HullSample[] = [];
      for (let e = 0; e < 4; e++) {
        const [di, dk] = cornersOf[e];
        if (flags[e]) poly.push(sheet[i + di][k + dk]);
        if (flags[e] !== flags[(e + 1) % 4]) {
          const [ai, ak] = cornersOf[e],
            [bi, bk] = cornersOf[(e + 1) % 4];
          // a column edge (same i) crosses in v; a row edge (same k) in u
          const b =
            ai === bi
              ? colBoundary(i + ai, k + Math.min(ak, bk))
              : rowBoundary(i + Math.min(ai, bi), k + ak);
          record(b);
          poly.push(b.s);
        }
      }
      polys.push(poly);
    }
  phase(
    "Tessellating the cells",
    () => hullQuads.length + polys.length,
    "cells",
  );

  // Splice each corner into the mesh. Where two trims cross, the marching cuts the tip off with a BEVEL: one
  // polygon edge running straight from a crossing of the first trim to a crossing of the second, whatever
  // sub-cell sliver of the closing wedge lies beyond it (a wedge thinner than a cell holds no lattice node, so
  // it raises no polygon of its own). That edge is the corner's, so the corner goes into the nearest one that
  // joins its two trims — the bevel becomes a point, sharing both of its ends with the skin by identity.
  for (const c of corners) {
    let into: HullSample[] | null = null,
      at = -1,
      best = Infinity;
    for (const poly of polys)
      for (let j = 0; j < poly.length; j++) {
        const p = poly[j].pos,
          q = poly[(j + 1) % poly.length].pos,
          x = ciOf.get(poly[j]),
          y = ciOf.get(poly[(j + 1) % poly.length]);
        if (x === undefined || y === undefined) continue;
        if (Math.min(x, y) !== c.a || Math.max(x, y) !== c.b) continue;
        const dx = (p[0] + q[0]) / 2 - c.s.pos[0],
          dy = (p[1] + q[1]) / 2 - c.s.pos[1],
          dz = (p[2] + q[2]) / 2 - c.s.pos[2],
          d = dx * dx + dy * dy + dz * dz;
        if (d < best) {
          best = d;
          into = poly;
          at = j + 1;
        }
      }
    if (into) into.splice(at, 0, c.s); // between the bevel's two ends, so the winding is unchanged
  }
  phase("Splicing the corners", () => corners.length);
  for (const poly of polys)
    for (let t = 1; t + 1 < poly.length; t++)
      hullTris.push([poly[0], poly[t], poly[t + 1]]);
  phase("Fanning the polygons", () => hullTris.length, "tris");

  // (6) the trimmed boundary curves, assembled from every boundary crossing the mesh actually used — the
  // columns' ends AND the row-edge crossings that carry the aft edge near the head — plus the corners the skin
  // was spliced through, each one an end of BOTH of the edges it joins, so every curve IS the skin's own edge,
  // vertex for vertex, right into its corners. The sheer and keel run fore-aft (order by u); the transom runs
  // head → foot, ordered down the plane by height z.
  for (const c of corners)
    for (const ci of [c.a, c.b])
      (ci === 0 ? sheerB : ci === 1 ? keelB : transomB).push(c.s);
  sheerB.sort((a, b) => a.uSheetIndex - b.uSheetIndex);
  keelB.sort((a, b) => a.uSheetIndex - b.uSheetIndex);
  transomB.sort((a, b) => b.pos[2] - a.pos[2]);
  const hullSheer: TrimCurve = sheerB,
    hullCenterline: TrimCurve = keelB,
    hullTransom: TrimCurve = transomB;

  // and each corner spliced into the marched curves it lies on. The corner is a point OF both of its trims,
  // between two of the crossings the march found, so it goes into the run's segment nearest to it — nearest
  // by point-to-segment distance, since a marched run need not be monotone in u or in anything else. A trim
  // then passes THROUGH every crossing of another trim, so the point where the drawn curve leaves the hull's
  // own edge and carries on cut-away is a vertex of it rather than somewhere inside a segment.
  const segDistSq = (p: Vec3, a: Vec3, b: Vec3): number => {
    const ex = b[0] - a[0],
      ey = b[1] - a[1],
      ez = b[2] - a[2],
      px = p[0] - a[0],
      py = p[1] - a[1],
      pz = p[2] - a[2],
      ee = ex * ex + ey * ey + ez * ez,
      t = ee > 0 ? clamp((px * ex + py * ey + pz * ez) / ee, 0, 1) : 0,
      dx = px - t * ex,
      dy = py - t * ey,
      dz = pz - t * ez;
    return dx * dx + dy * dy + dz * dz;
  };
  for (const c of corners)
    for (const ci of [c.a, c.b]) {
      let into: TrimCurve | null = null,
        at = -1,
        best = Infinity;
      for (const run of trims[ci])
        for (let j = 0; j + 1 < run.length; j++) {
          const d = segDistSq(c.s.pos, run[j].pos, run[j + 1].pos);
          if (d < best) {
            best = d;
            into = run;
            at = j + 1;
          }
        }
      if (into) into.splice(at, 0, c.s);
    }
  phase(
    "Boundary curves",
    () => hullSheer.length + hullCenterline.length + hullTransom.length,
  );

  // (7) and the LEFTOVER of each marched trim: the spans of it that lie outside one of the other two, which is
  // the whole curve minus the run that stands as the hull's own edge. It is read straight off the drawable
  // runs above by the same test the sheet was trimmed with, so the split lands exactly on the corners just
  // spliced in — a corner sits ON both of its trims, so its constraint there is zero to bisection tolerance,
  // and the epsilon keeps that sign from deciding anything. Each cut-away run then carries the corner it was
  // cut at as its end, which is the one point it shares with the hull edge: the two meet rather than overlap.
  const CORNER_EPS = 1e-9; // world units — far below any real crossing, far above the bisection's noise
  const leftovers: TrimCurve[][] = trims.map((curves, ci) => {
    const others = [0, 1, 2].filter((c) => c !== ci),
      runs: TrimCurve[] = [];
    for (const curve of curves) {
      const cut = curve.map((s) =>
        others.some((c) => cons[c](s.pos) < -CORNER_EPS),
      );
      for (let j = 0; j < curve.length; j++) {
        if (!cut[j]) continue;
        let e = j;
        while (e + 1 < curve.length && cut[e + 1]) e++;
        runs.push(curve.slice(Math.max(0, j - 1), e + 2)); // one sample of slack: the corner at either end
        j = e;
      }
    }
    return runs;
  });
  phase("Leftover trim runs", () =>
    leftovers.reduce(
      (n, runs) => n + runs.reduce((m, r) => m + r.length, 0),
      0,
    ),
  );

  return {
    R,
    M,
    uParams,
    vParams,
    sheet,
    sheetSheer: trims[0],
    sheetCenterline: trims[1],
    sheetTransom: trims[2],
    hullSheer,
    hullCenterline,
    hullTransom,
    hullSheerLeftover: leftovers[0],
    hullCenterlineLeftover: leftovers[1],
    hullTransomLeftover: leftovers[2],
    columns,
    hullQuads,
    hullTris,
  };
}

// ---------- the hull grid ----------
export interface HullGrid {
  rows: Vec3[][]; // one per surviving column
  us: number[]; // the u of each row
  keel: boolean[];
  creaseS: number[][]; // per row, per column index: crease strength (0 = smooth, 1 = hard)
  M: number; // the keel's index within a full-width row ((S−1)·R)
}

// The hull as a grid: columns uniform in u, rows as above.
//
// For the TRIMMED hull each row is FULL WIDTH — starboard sheer → keel → port sheer — built as one curve
// (the starboard half plus its y-mirror, sharing the single keel point). The keel is then an interior
// column and inherits the section's own continuity across the centerline. Mirroring the whole SURFACE
// instead only joins smoothly where the half meets the centerline with zero slope; where it doesn't, the
// mirror folds the keel into a visible welt. One continuous row has no seam to fold.
//
// Untrimmed (the raw sheet) is one side, no mirror, no cuts.
export function hullGrid(
  model: Model,
  N: number,
  R = R_DEFAULT,
  trim = true,
): HullGrid {
  const rows: Vec3[][] = [],
    us: number[] = [],
    keel: boolean[] = [],
    creaseS: number[][] = [],
    S = model.loft.S,
    M = (S - 1) * R;
  for (let i = 0; i <= N; i++) {
    const u = i / N,
      s = sweptSection(model, u, R, trim);
    if (s.empty) continue;
    us.push(u);
    if (!trim) {
      rows.push(s.pts);
      keel.push(false);
      creaseS.push(spread(s, s.pts.length, M, false));
      continue;
    }
    rows.push(mirrorRow(s.pts));
    keel.push(s.keel);
    creaseS.push(spread(s, 2 * M + 1, M, true));
  }
  return { rows, us, keel, creaseS, M };
}

// map a half-section's crease rows onto the (possibly mirrored) row: a chine at half-index c sits at c and,
// mirrored, at 2M − c; the keel (half-index M) is the single centre index M.
function spread(
  s: SectionRow,
  len: number,
  M: number,
  mirror: boolean,
): number[] {
  const cs = new Array(len).fill(0);
  for (let t = 0; t < s.creaseRows.length; t++) {
    const c = s.creaseRows[t],
      k = s.creaseK[t];
    if (c >= len) continue;
    cs[c] = k;
    if (mirror && c !== M) cs[2 * M - c] = k;
  }
  return cs;
}

// The full-width trimmed grid, for the exporters and the lines plan.
//
// Version 1 built this by scanning each column for its crossing of the transom plane and starting the
// column there, because its columns ran along x and the transom cut across them. Trimming per column
// against all three constraints at once (see `keptSpan`) already puts every column's ends on whichever
// constraint binds, so there is nothing left for a separate transom pass to do.
//
// `creaseCols` are the column indices that carry a crease anywhere along the hull — the exporters put a
// knot there, which is a property of the whole surface and so cannot vary row by row.
export function trimmedHullGrid(
  model: Model,
  N: number,
  R = R_DEFAULT,
): { grid: Vec3[][]; creaseCols: number[]; keel: boolean[] } {
  const g = hullGrid(model, N, R, true),
    set = new Set<number>();
  for (const row of g.creaseS)
    row.forEach((k, j) => {
      if (k > 1e-6) set.add(j);
    });
  return {
    grid: g.rows,
    creaseCols: [...set].sort((a, b) => a - b),
    keel: g.keel,
  };
}

// ---------- exact evaluators (for the curvature combs) ----------
// The combs finite-difference these, so every crossing is CONVERGED rather than read off a coarse scan with
// one linear-interpolation step — that scan's O(h²) placement noise is pure noise to a second difference.

// The hull's top edge at u: the sheer-trim crossing of the section. Null where there is no hull.
export function sheerPointAt(model: Model, u: number): Vec3 | null {
  const fr = frameAt(model, u),
    sec = sectionAt(model, u),
    span = keptSpan(model, fr, sec);
  return span ? sectionWorld(fr, sec, span[0]) : null;
}

// The keel point at u — the centerline crossing — or null where there is no hull or the section never
// reaches the centerline (so there is no keel here, only an open edge).
export function keelPointAt(model: Model, u: number): Vec3 | null {
  const fr = frameAt(model, u),
    sec = sectionAt(model, u),
    span = keptSpan(model, fr, sec);
  if (!span) return null;
  const p = sectionWorld(fr, sec, span[1]);
  return Math.abs(p[1]) < 1e-6 ? p : null;
}

// The exact point of grid row j (of the (S−1)·R + 1 rows) at u — the same row the grid samples, with the
// span converged. Null where the trimmed hull has no section here.
export function longitudinalPointAt(
  model: Model,
  u: number,
  R: number,
  j: number,
): Vec3 | null {
  const fr = frameAt(model, u),
    sec = sectionAt(model, u),
    span = keptSpan(model, fr, sec);
  if (!span) return null;
  const S = sec.vmax + 1,
    { anchors } = anchorsFor(S, span[0], span[1]),
    seg = Math.min(Math.floor(j / R), S - 2),
    r = j - seg * R;
  return sectionWorld(
    fr,
    sec,
    anchors[seg] + ((anchors[seg + 1] - anchors[seg]) * r) / R,
  );
}

// The design-waterline crossing of the section at u, or null where the span never crosses it (fully dry, or
// fully wet).
export function dwlPointAt(model: Model, u: number): Vec3 | null {
  const fr = frameAt(model, u),
    sec = sectionAt(model, u),
    span = keptSpan(model, fr, sec);
  if (!span) return null;
  const g = (v: number): number => {
    const p = sectionWorld(fr, sec, v);
    return immersionOf(model, p);
  };
  const FN = 48;
  let pv = span[0],
    pg = g(span[0]);
  for (let i = 1; i <= FN; i++) {
    const v = span[0] + ((span[1] - span[0]) * i) / FN,
      gv = g(v);
    if (pg < 0 !== gv < 0)
      return sectionWorld(fr, sec, bisectRoot(g, pv, v, pg));
    pv = v;
    pg = gv;
  }
  return null;
}

const immersionOf = (model: Model, p: Vec3): number =>
  -model.waterline -
  (p[0] * Math.sin(model.deckRake) + p[2] * Math.cos(model.deckRake));

// ---------- the hull's longitudinal extent ----------
// The bow closes where the sections vanish — the forefoot rises above the sheer trim, or a tumblehome lens
// shrinks to nothing. Bisect for the last u that still has a section. Where the hull runs the whole plan
// (a blunt bow) this is 1.
export function forwardLimit(model: Model): number {
  const exists = (u: number): boolean => !sweptSection(model, u, 2, true).empty;
  if (exists(1)) return 1;
  let lo = 0.5,
    hi = 1;
  if (!exists(lo)) return 1; // already gone amidships (a degenerate model) — don't clamp shorter
  for (let k = 0; k < 24; k++) {
    const m = (lo + hi) / 2;
    if (exists(m)) lo = m;
    else hi = m;
  }
  return lo;
}

// The aft limit, by the same argument: the transom cuts the hull off, so the first u with a section.
export function aftLimit(model: Model): number {
  const exists = (u: number): boolean => !sweptSection(model, u, 2, true).empty;
  if (exists(0)) return 0;
  let lo = 0,
    hi = 0.5;
  if (!exists(hi)) return 0;
  for (let k = 0; k < 24; k++) {
    const m = (lo + hi) / 2;
    if (exists(m)) hi = m;
    else lo = m;
  }
  return hi;
}

// ---------- the transom outline ----------
//
// Where the swept surface meets the raked transom plane, head (on the sheer) → foot (on the centerline). It is
// `hullTransom` itself — the trimmed boundary curve, its two ends the head / foot corners computeHullSampling
// root-finds onto the plane — so whatever is built on it (the 3D panel, the plan footprint, the profile edge)
// rides the hull's own aft edge exactly, sharing its very vertices, rather than a second approximation of it.
export function transomOutline(sampling: HullSampling): Vec3[] {
  return sampling.hullTransom.length > 1
    ? sampling.hullTransom.map((s) => s.pos)
    : [];
}

// ---------- waterline ----------
export function waterlineStats(
  model: Model,
  pts: Vec3[],
): { draft: number; beam: number; wet: boolean } {
  let draft = 0,
    beam = 0,
    wet = false;
  for (let i = 0; i < pts.length; i++) {
    const imm = immersionOf(model, pts[i]);
    if (imm > 0) wet = true;
    if (imm > draft) draft = imm;
    if (i > 0) {
      const ai = immersionOf(model, pts[i - 1]);
      if (ai < 0 !== imm < 0 && ai !== imm) {
        const t = -ai / (imm - ai);
        beam = Math.max(
          beam,
          2 * Math.abs(pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t),
        );
      }
    }
  }
  return { draft, beam, wet };
}

// the design-waterline contour in plan (x, y): where each column crosses worldZ = −waterline
export function dwlContour(model: Model, N = 160): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const p = dwlPointAt(model, i / N);
    if (p) run.push([p[0], p[1]]);
    else {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

// re-exported so callers building sections don't need both modules
export type { Vec2 };
