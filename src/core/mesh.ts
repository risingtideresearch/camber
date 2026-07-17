// ---------- the hull mesh: a swept quad sheet, then trimmed ----------
//
// THE SHEET. Columns are uniform in the sheer plan's own parameter u; rows are uniform in the section
// curve's parameter v. Neither is uniform in arclength, and neither needs to be — the plan's B-spline
// parameter and the section's Catmull-Rom parameter are both cheap to evaluate and both smooth in the
// geometry, so a uniform step in either sweeps the surface evenly enough while costing nothing to invert.
// This grid is what the 3D "Sheet" view draws.
//
// Rows are laid out so that STATION KNOTS FALL ON ROWS. Each of the section's S−1 segments gets the same
// number of sub-steps, so knot i is row i·R exactly. That matters because a knuckle lives at a knot: the
// mesh needs an edge loop there for the crease to have somewhere to be, and shading a crease means giving
// one row two sets of normals. A grid that merely passed near the knots would smear every chine.
//
// THE TRIM. The sheet is cut by the sheer trim (above it is not hull), the centerline (y = 0, where the two
// halves meet) and the transom plane. Rather than intersect those surfaces with the quads — which would
// produce ragged rows no quad grid can hold — each column is trimmed on its own: walk its rows, find the
// first and last that survive all three cuts, and keep the run between them. The exact ends are then
// converged by bisection, so the top row sits precisely on the sheer and the bottom precisely on the
// centerline (or the transom) rather than on whichever sample happened to be nearest.
//
// The kept span [vTop, vBot] varies smoothly with u, so the trimmed columns still form a clean quad grid —
// but the knots have to be brought inside it, and the number of rows must not change along the hull or the
// surface would tear where a knot crossed a trim. `anchorsFor` does both: every knot always gets an anchor,
// clamped into the kept span with a small spread that keeps them strictly ordered even when several clamp
// at once.

import { clamp, mirrorRow, type Vec2, type Vec3 } from "./math";
import { perfAdd, perfMark, PERF_MESH } from "./perf";
import {
  bisectRoot,
  frameAt,
  keepAt,
  sectionAt,
  sectionWorld,
  type Frame,
  type Model,
  type Section,
} from "./model";

// sub-steps per section segment: the mesh's girth resolution, S−1 segments × R + 1 rows
export const R_DEFAULT = 16;

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

// ---------- the transom face ----------
// The starboard transom edge, top → bottom: the bottom points of the columns that the transom (rather than
// the centerline) cut. Each such point was converged onto the transom plane by the same bisection the grid
// uses, so the face meets the hull on exactly the hull's own edge.
export function transomEdge(model: Model, N = 120): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N,
      fr = frameAt(model, u),
      sec = sectionAt(model, u),
      span = keptSpan(model, fr, sec);
    if (!span) continue;
    const p = sectionWorld(fr, sec, span[1]);
    if (Math.abs(p[1]) < 1e-6) continue; // the centerline cut this one, not the transom
    if (Math.abs(p[0] - xTransomOf(model, p[2])) > 1e-6) continue;
    out.push(p);
  }
  return out.sort((a, b) => b[2] - a[2]);
}

const xTransomOf = (model: Model, z: number): number => {
  const [a, b] = model.transom;
  return a.x + (b.x - a.x) * ((z - a.z) / (b.z - a.z || 1));
};

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
