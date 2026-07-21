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

import { clamp, mirrorRow, V, type Vec2, type Vec3 } from "./math";
import { perfAdd, perfMark, PERF_MESH } from "./perf";
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

export interface SectionRow {
  pts: Vec3[]; // starboard: the sheer edge → the keel (or wherever the trim ended it)
  empty: boolean; // no hull at this u at all
  keel: boolean; // the last point sits on the centerline, so the port half joins it there
  // rows that sit on a station knot and carry a crease. The mesh gives these a tangent break scaled by
  // `creaseK`; a faded knuckle (low k) on a crease row stays smooth, so sharpness stays data-driven.
  creaseRows: number[];
  creaseK: number[];
  // The provenance of each point in the UNTRIMMED sheet: point k of a sheet row has sheetIndex k, and a
  // trim's crossing point carries the fractional index of the segment it split. Two adjacent trimmed rows are
  // stitched into the mesh by matching these indices — equal integers make a quad, a fractional end a
  // triangle. Only the sampling (`computeHullSampling`) sets it; `sweptSection` leaves it undefined.
  sheetIndex?: number[];
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

// ---------- the hull sampling: one lattice, sheet then trims, shared by every view ----------
//
// This is the whole hull sampled ONCE and handed to every view, so nothing re-sweeps it. It is deliberately
// bisection-free: `sweptSection`/`keptSpan` above converge each column's trim ends by bisection (still used
// by the curvature combs, which second-difference the result and need that precision); here the trims are
// intersected against the SHEET LATTICE by one linear crossing each, which is all a rendered mesh or a drawn
// outline needs. The four stages compose the way the hull is defined:
//
//   sheet          — the raw swept sheet: uniform u × uniform-per-segment v, every node a world point. It
//                    depends on no trim at all, so it is empty on the end-refinement columns, which are
//                    placed off the uniform u lattice by where the trimmed hull closes.
//   sheerTrimmed   — the sheet minus the deck (points above the sheer trim's z at this column).
//   centerTrimmed  — minus the far side of the centerline (y < 0), re-entered exactly on the keel (y = 0).
//   trimmed        — minus the far side of the transom plane. What the mesh and the outlines are built from.
//
// Every point keeps a `sheetIndex` recording which sheet row it came from (a crossing point gets a fractional
// index), so two neighbouring trimmed columns can be stitched by matching indices — see the mesh builder.

export interface HullSampling {
  R: number; // sub-steps per section segment (girth resolution)
  M: number; // the keel's sheet index in a full untrimmed row: (S−1)·R
  uParams: number[]; // the u of each column — uniform, plus one linearly-placed column at each closing end
  vParams: number[]; // the v of each sheet row: vParams[k] = k / R, running 0 → vmax
  // aligned with uParams; the trimmed stages carry `empty` where the hull is gone, the sheet where the column
  // is an end refinement (off the uniform lattice, so not part of the sheet)
  sheetSections: SectionRow[];
  sheerTrimmedSections: SectionRow[];
  centerTrimmedSections: SectionRow[];
  trimmedSections: SectionRow[];
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

interface Work {
  pts: Vec3[];
  idx: number[];
}
const emptyRow = (cr: number[], ck: number[]): SectionRow => ({
  pts: [],
  sheetIndex: [],
  empty: true,
  keel: false,
  creaseRows: cr,
  creaseK: ck,
});

// Drop the row's LEADING points where f < 0 (above the sheer trim), and re-enter it with the exact f = 0
// crossing of the last dropped segment. f is linear-crossed, and the crossing's sheet index is the same
// linear blend, so the stitched mesh knows the new point came from between two sheet rows.
function cutFront(row: Work, f: (p: Vec3) => number): Work | null {
  const { pts, idx } = row,
    n = pts.length;
  let k = 0;
  while (k < n && f(pts[k]) < 0) k++;
  if (k >= n) return null; // the whole column is above the trim — no hull here
  const outP: Vec3[] = [],
    outI: number[] = [];
  if (k > 0) {
    const fa = f(pts[k - 1]),
      fb = f(pts[k]),
      t = fa / (fa - fb);
    outP.push(V.lerp(pts[k - 1], pts[k], t));
    outI.push(idx[k - 1] + t * (idx[k] - idx[k - 1]));
  }
  for (let i = k; i < n; i++) {
    outP.push(pts[i]);
    outI.push(idx[i]);
  }
  return { pts: outP, idx: outI };
}

// Drop the row's TRAILING points where f < 0, re-entering at the exact f = 0 crossing of the last dropped
// segment. `snapY` (the centerline) forces the crossing's y to exactly 0 so the two hull halves MEET there
// rather than nearly meet. Returns whether it actually cut (so the caller can tell a keel/transom edge from
// an untouched open bottom).
function cutBack(
  row: Work,
  f: (p: Vec3) => number,
  snapY: boolean,
): { work: Work; cut: boolean } | null {
  const { pts, idx } = row,
    n = pts.length;
  let j = n - 1;
  while (j >= 0 && f(pts[j]) < 0) j--;
  if (j < 0) return null; // the whole column is past the cut
  const outP = pts.slice(0, j + 1),
    outI = idx.slice(0, j + 1);
  if (j < n - 1) {
    const fa = f(pts[j]),
      fb = f(pts[j + 1]),
      t = fa / (fa - fb),
      cp = V.lerp(pts[j], pts[j + 1], t);
    if (snapY) cp[1] = 0;
    outP.push(cp);
    outI.push(idx[j] + t * (idx[j + 1] - idx[j]));
    return { work: { pts: outP, idx: outI }, cut: true };
  }
  return { work: { pts: outP, idx: outI }, cut: false };
}

interface HullColumn {
  u: number;
  margin: number; // > 0 where the hull survives all three trims, < 0 where erased; ~0 at a closing end
  sheet: SectionRow;
  sheer: SectionRow;
  center: SectionRow;
  trimmed: SectionRow;
}

// One column of the sampling: the sheet row at u, then the three trims in turn.
function buildColumn(
  model: Model,
  u: number,
  vParams: number[],
  R: number,
): HullColumn {
  const fr = frameAt(model, u),
    sec = sectionAt(model, u);
  const { creaseRows, creaseK } = creasesOf(sec, R);
  const mk = (w: Work | null, keel: boolean): SectionRow =>
    !w || w.pts.length < 2
      ? emptyRow(creaseRows, creaseK)
      : {
          pts: w.pts,
          sheetIndex: w.idx,
          empty: false,
          keel,
          creaseRows,
          creaseK,
        };

  // (a) the untrimmed sheet, and the smooth existence margin used to place the end-refinement columns
  const sPts: Vec3[] = [],
    sIdx: number[] = [];
  let margin = -Infinity;
  for (let k = 0; k < vParams.length; k++) {
    const p = sectionWorld(fr, sec, vParams[k]);
    sPts.push(p);
    sIdx.push(k);
    // the three-constraint keep test as one signed number (min), maxed over the column: > 0 ⇔ some point
    // survives all three ⇔ the hull exists here. Smooth in u, crossing 0 exactly where a bow/stern closes.
    const m = Math.min(
      model.trimZ(p[0]) - p[2],
      p[1],
      p[0] - xTransom(model, p[2]),
    );
    if (m > margin) margin = m;
  }
  const sheet: SectionRow = {
    pts: sPts,
    sheetIndex: sIdx,
    empty: false,
    keel: false,
    creaseRows,
    creaseK,
  };

  // (b) sheer trim: everything above the trim is deck, not hull. The trim is a cheap 1-D graph z(x) now
  // (model.trimGraph), so it is evaluated per point — the cut follows the authored trim exactly across the
  // fanned station plane, rather than being flattened to one z per column.
  const sheerW = cutFront(
    { pts: sPts, idx: sIdx },
    (p) => model.trimZ(p[0]) - p[2],
  );
  const sheer = mk(sheerW, false);
  // (c) centerline: past y = 0 is the other half; re-enter on the keel. keel ⇔ the bottom reached y = 0.
  const centerR = sheerW ? cutBack(sheerW, (p) => p[1], true) : null;
  const center = mk(centerR?.work ?? null, centerR?.cut ?? false);
  // (d) transom: aft of the transom plane is cut away. It is linear in z, so one linear crossing is exact.
  // If it cut anything the bottom is a transom edge (not the keel), so keel becomes false there.
  const trimR = centerR
    ? cutBack(centerR.work, (p) => p[0] - xTransom(model, p[2]), false)
    : null;
  const trimmed = mk(
    trimR?.work ?? null,
    trimR ? (trimR.cut ? false : (centerR?.cut ?? false)) : false,
  );

  return { u, margin, sheet, sheer, center, trimmed };
}

// Compute the whole sampling: N+1 columns uniform in u, then ONE linearly-placed column at each end that is
// still closing, so the drawn outline reaches the true bow/stern within a linear step rather than being
// quantized to 1/N. numSections is N (segments), numLongitudinalsPerKnot is R (girth sub-steps per segment).
export function computeHullSampling(
  model: Model,
  numSections: number,
  numLongitudinalsPerKnot: number,
): HullSampling {
  const N = Math.max(1, Math.round(numSections)),
    R = Math.max(1, Math.round(numLongitudinalsPerKnot)),
    S = model.loft.S,
    M = (S - 1) * R;
  const vParams: number[] = [];
  for (let k = 0; k <= M; k++) vParams.push(k / R);

  const cols: HullColumn[] = [];
  for (let i = 0; i <= N; i++) cols.push(buildColumn(model, i / N, vParams, R));

  // end refinement: at each end, if the last surviving column sits next to an erased one, place one more
  // column at the linear (false-position) estimate of where the margin crosses 0 — the hull's true closure.
  // A refinement column is placed by the TRIM, at whatever u the hull happens to close at, so it is off the
  // uniform lattice — and the sheet is nothing but that lattice. It therefore contributes no sheet row: were
  // it to carry one, the raw sweep would show a sliver of a section wedged against its last uniform column,
  // a stripe of the trim's business showing through on a surface that is meant to know nothing about it.
  // Leaving the row `empty` (rather than dropping the column) keeps the four stages index-aligned, which is
  // what lets the lines plan name a column in the sheet by its index in the hull.
  const refine = (a: HullColumn, b: HullColumn): HullColumn => {
    const t = a.margin / (a.margin - b.margin),
      c = buildColumn(model, a.u + (b.u - a.u) * clamp(t, 0, 1), vParams, R);
    return { ...c, sheet: emptyRow(c.sheet.creaseRows, c.sheet.creaseK) };
  };
  const alive = (c: HullColumn): boolean => !c.trimmed.empty;
  // forward: first index (from the end) whose column has hull, and the erased one just beyond it
  let f = cols.length - 1;
  while (f >= 0 && !alive(cols[f])) f--;
  if (f >= 0 && f < cols.length - 1)
    cols.splice(f + 1, 0, refine(cols[f], cols[f + 1]));
  // aft: first index with hull, and the erased one just before it
  let a = 0;
  while (a < cols.length && !alive(cols[a])) a++;
  if (a > 0 && a < cols.length) cols.splice(a, 0, refine(cols[a], cols[a - 1]));

  return {
    R,
    M,
    uParams: cols.map((c) => c.u),
    vParams,
    sheetSections: cols.map((c) => c.sheet),
    sheerTrimmedSections: cols.map((c) => c.sheer),
    centerTrimmedSections: cols.map((c) => c.center),
    trimmedSections: cols.map((c) => c.trimmed),
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
