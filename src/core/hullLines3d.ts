// ---------- lines-plan curves, as real 3D polylines ON the rendered hull ----------
//
// The lines plan used to be an SVG hidden-line-removal overlay: project every hull facet, sort by depth,
// paint white occluding polygons, then draw line segments on top (see git history). That whole painter's-
// algorithm pass is gone — the 3D view renders the actual hull mesh (depth-tested) as the occluder and these
// curves on top of it, so hidden-line removal falls out of the GPU depth buffer for free. This module only
// does the first half of the old job: picking which 3D curves to draw.
//
// Every curve here is read off the RENDERED geometry, not off a second, coarser lattice of its own:
//
//   • the feature edges (both sheers, the keel / transom cut, every chine) are chains of the hull mesh's own
//     boundary and rung edges, taken from the shared sampling's trimmed columns;
//   • a station IS a column of that sampling — one of the mesh's girth edge loops;
//   • the buttock / waterline / DWL families are marched across the emitted TRIANGLES, so each crossing lands
//     on an edge of a triangle the GPU actually rasterizes.
//
// So the curves are coplanar with the surface by construction, and nothing is nudged toward the eye to stay
// visible: the view keeps them on top with a polygon offset on the hull instead (see Scene.tsx).
//
// WHICH members a family has is a separate question from where they are drawn, and it is always answered by
// the SHEET: the whole raw sweep, before any trim. So toggling Sheet only ever adds or takes away surface
// under one fixed set of curves — the same stations, the same buttock and waterline planes either way, each
// showing wherever the surface that is up happens to reach it.

import { COL } from "./colors";
import { mirrorRow, type Vec3 } from "./math";
import type { Model } from "./model";
import type { HullColumnV2, HullSample, HullSampling, TrimCurve } from "./mesh";
import type { Mesh } from "./hullGeometry";
import type { LineToggles, TrimToggles } from "./view3dDisplay";

// How many members each family has. The stations are counted in SPACINGS rather than in lines, because a
// station has to land on a column of the sheet's lattice: 32 divides the default sampling's 256 columns
// exactly, so each of the 33 stations is a lattice column outright, at exactly the u it wants, with nothing
// to snap. (Change the Performance panel's section count to something 32 does not divide and the snap comes
// back — by up to half a column, which is the most it can ever be.)
const N_STATION_STEPS = 32,
  N_BUTTOCKS = 8,
  N_WATERLINES = 12;

export interface LinesPlanCurves {
  bold: Vec3[][]; // sheer / keel / chines / both end columns — heavy weight (the `edges` toggle)
  family: Vec3[][]; // the enabled non-chine families: stations / buttocks / waterlines — light weight
  dwl: Vec3[][]; // the design-waterline crossing — blue, always drawn
}

// a scalar field of a mesh vertex, read straight off the position buffer (no Vec3 per vertex)
type Field = (x: number, y: number, z: number) => number;

const EMPTY: LinesPlanCurves = { bold: [], family: [], dwl: [] };

// a column with enough surviving points to draw (the same threshold the mesh builder welds from)
const drawableCol = (c: HullColumnV2): boolean => c.pts.length >= 2;

// The curves `lines` asks for, as world-space 3D polylines. `sampling`, `trimmed` and `hull` must be the very
// ones the view is rendering (mesh.ts's shared sampling, the Sheet toggle's choice of stage, and the triangle
// soup buildHullMesh stitched from them) — the curves are only exactly on the surface because they are read
// from that same geometry. With `trimmed` off the surface is the raw starboard sweep, so there are no trim
// edges to ride and no port half to mirror onto: every curve here is simply one-sided.
export function buildLinesPlanCurves(
  model: Model,
  lines: LineToggles,
  sampling: HullSampling,
  trimmed: boolean,
  hull: Mesh,
): LinesPlanCurves {
  // The SHEET's own columns — the uniform u lattice, which is all the sheet is. This is the lines plan's
  // frame of reference, whichever surface is being drawn on: which columns are stations, and which levels the
  // buttocks and waterlines sit at, are both chosen from these — never from the drawn surface, and never from
  // a trim — so toggling Sheet redraws the SAME lines on more or less surface rather than respacing the whole
  // family over whatever extent is left after trimming. The sampling's stages are index-aligned (one entry per
  // column of the one lattice), so a sheet column's index names the same u in the trimmed hull.
  const sheetCols = sampling.sheet, // the untrimmed grid columns — every one full
    sheetIdx = sheetCols.map((_, i) => i);
  if (sheetIdx.length < 2 || hull.count < 3) return EMPTY; // nothing to lay a lines plan out from

  // the columns the mesh was drawn from: the trimmed sections, or (Sheet view) the untrimmed grid columns
  // wrapped as columns of their own
  const sections: HullColumnV2[] = trimmed
    ? sampling.columns
    : sheetCols.map((col, i) => ({ pts: col, i, keel: false, transom: false }));
  const cols = sections.filter(drawableCol);
  if (cols.length < 2) return EMPTY;

  const mir = (p: Vec3): Vec3 => [p[0], -p[1], p[2]];
  const posOf = (c: HullColumnV2): Vec3[] => c.pts.map((s) => s.pos);
  // a starboard curve and its port mirror — unless it rides the centerline, where the two coincide, or the
  // surface is the untrimmed sheet, which has no port half
  const bothSides = (line: Vec3[]): Vec3[][] =>
    trimmed && line.some((p) => Math.abs(p[1]) > 1e-9)
      ? [line, line.map(mir)]
      : [line];
  // one full-width station: the column joined to its mirror through the keel where the section closes there,
  // and left as two open curves where the transom (or an open bottom) cut it instead — exactly the gap the
  // surface itself has
  const station = (c: HullColumnV2): Vec3[][] => {
    const p = posOf(c);
    return !trimmed ? [p] : c.keel ? [mirrorRow(p)] : [p, p.map(mir)];
  };
  const bold: Vec3[][] = [];
  if (lines.edges) {
    // The bold feature edges are read off the mesh's OWN triangles, so they end exactly where the surface does
    // — at a trim, at the transom, or where the bow closes — never a lattice step short of it. The boundary
    // edges (an edge in a single triangle) give the sheer / keel / transom outline as one connected loop; the
    // edges running along a creased station row give the chines. Both are mirrored to port (the keel, on the
    // centerline, is its own mirror). With `trimmed` off the same extraction outlines the untrimmed patch.
    const creaseRows = new Set<number>();
    for (const col of sheetCols)
      for (const s of col) if (s.vCreaseK > 1e-6) creaseRows.add(s.vSheetIndex);
    const tris: [HullSample, HullSample, HullSample][] = [];
    if (trimmed) {
      for (const q of sampling.hullQuads) {
        tris.push([q[0], q[1], q[2]]);
        tris.push([q[0], q[2], q[3]]);
      }
      for (const t of sampling.hullTris) tris.push(t);
    } else {
      const sh = sampling.sheet;
      for (let i = 0; i + 1 < sh.length; i++)
        for (let k = 0; k + 1 < sh[i].length; k++) {
          tris.push([sh[i][k], sh[i + 1][k], sh[i + 1][k + 1]]);
          tris.push([sh[i][k], sh[i + 1][k + 1], sh[i][k + 1]]);
        }
    }
    const { boundary, chines } = featureEdges(tris, creaseRows);
    for (const run of [...boundary, ...chines]) bold.push(...bothSides(run));
  }

  const family: Vec3[][] = [];
  if (lines.sections) {
    // Spread over the WHOLE SHEET, end to end: equal steps in u from the sheet's aft edge to its fore one, so
    // the sheet's span is a whole number of station spacings and the outermost stations land ON its end
    // columns rather than a hair inside them. A station IS a column, so each of those u's is then taken to the
    // nearest lattice column — which at the default resolution is the column it already sits on.
    const n = sheetIdx.length,
      steps = Math.min(N_STATION_STEPS, n - 1);
    for (let j = 0; j <= steps; j++) {
      // the same u on whichever surface is drawn: the sheet's column, or the trimmed hull's column of that
      // index. Where the trim erased the hull at that u there is simply no station, exactly as there is no
      // surface — which is how the family stays put as Sheet is toggled instead of being redealt.
      const s = sections[sheetIdx[Math.round((j * (n - 1)) / steps)]];
      if (drawableCol(s)) family.push(...station(s));
    }
  }

  // The design waterline shares the waterline family's field, so both are marched in one pass over the
  // triangles: the DWL is simply the last level asked for. The field is `worldZ` with the rake's sin/cos
  // lifted out — it runs once per mesh vertex per pass, and those two trig calls cost more than the whole
  // rest of the march put together.
  const sr = Math.sin(model.deckRake),
    cr = Math.cos(model.deckRake),
    wz: Field = (x, _y, z) => x * sr + z * cr;
  const wzLevels: number[] = [];
  if (lines.waterlines) {
    const [lo, hi] = rangeIn(sheetCols, wz);
    wzLevels.push(...spread(lo, hi, N_WATERLINES));
  }
  wzLevels.push(-model.waterline);
  const wzRuns = contours(hull, wz, wzLevels);
  const dwl = wzRuns.pop() ?? [];
  for (const runs of wzRuns) family.push(...runs);

  if (lines.buttocks) {
    // A buttock is the pair of planes y = ±level, and the trimmed hull is drawn mirrored, so |y| picks up
    // both halves of each in one march. The sheet is starboard skin only — the part of it below y = 0 is the
    // overhang the centerline trim removes, NOT the port half — so there the plain signed y is marched
    // instead, and it draws one plane per level, so the mirror planes have to be asked for by name. |y| would
    // instead fold across y = 0: it is not linear within a triangle that straddles the centerline, so the
    // march's linear edge crossings would stop landing on the level and scatter a few spurious
    // near-centerline curves over the overhang.
    const ay: Field = (_x, y) => Math.abs(y);
    // Spaced out from the CENTERLINE, not across the sheet's range of |y|: buttocks are a family about y = 0,
    // so the span to divide is [0, the sheet's widest point], which puts the innermost line one full spacing
    // off the centerline and the outermost one clear of the sheet's widest column.
    const half = spread(0, rangeIn(sheetCols, ay)[1], N_BUTTOCKS);
    // y = 0 is the family's middle member — the profile — and on the sheet it is an interior curve like any
    // other, so the signed march finds it there along with the rest.
    const levels = trimmed ? half : [0, ...half, ...half.map((v) => -v)];
    for (const runs of contours(hull, trimmed ? ay : (_x, y) => y, levels))
      family.push(...runs);
    // On the hull that same profile is the KEEL, which the surface ends on rather than crosses: |y| touches 0
    // there without changing sign, so no march can catch it however many levels it is given. It is the mesh's
    // own keel edge (`hullCenterline`, foot corner and all) — the same curve `edges` draws bold — shown here
    // only when `edges` is off so the profile member is not lost.
    if (trimmed && !lines.edges && sampling.hullCenterline.length > 1)
      family.push(sampling.hullCenterline.map((s) => s.pos));
  }

  return { bold, family, dwl };
}

// ---------- the sheet's own three trims ----------
//
// Nothing here is computed: every curve this draws is already in the sampling, and it is taken exactly as it
// stands. Each trim comes marched across the WHOLE sheet as if it were the only one (`sheetSheer` /
// `sheetCenterline` / `sheetTransom`), which is the cut itself, running on past the boat wherever another trim
// got to the sheet first; and the span of it the other two leave standing is the hull's own edge (`hullSheer`
// / `hullCenterline` / `hullTransom`), corners and ordering included. The two are drawn as two independent
// toggles — the sheet's form in the Edges black, the hull's in that trim's 2D colour. Alone, each draws the
// whole of its curve. TOGETHER, the sheet form drops back to the LEFTOVER the sampling holds beside the hull
// edge (`hullSheerLeftover` and its two siblings): the span the hull edge already covers would otherwise be
// two coincident polylines fighting for the same pixels, and this way the black picks up exactly where the
// colour stops — at the corner they share.
//
// One-sided, unlike the lines plan: these are curves ON the sheet, and the sheet is the starboard sweep. The
// port half of the finished hull is a mirror of the result of trimming, not a second sheet to trim.

export interface TrimPlanCurves {
  sheet: Vec3[][]; // the shown trims as marched over the whole sheet — black, at the Edges weight
  hull: { color: string; lines: Vec3[][] }[]; // per shown trim: the hull edge it survives as, in its colour
}

// Which pair of cached curves each of the three per-trim toggles draws, and in which colour. The colours are
// the 2D views' own: the sheer trim's orange and the centerline's teal from the plan / profile, the transom's
// brown from the transom outline both views draw.
const TRIM_SPECS: {
  key: "sheer" | "centerline" | "transom";
  sheet: (s: HullSampling) => TrimCurve; // marched over the whole sheet, as if this were the only trim
  hull: (s: HullSampling) => TrimCurve; // the part of it the other two leave standing: the hull's own edge
  leftover: (s: HullSampling) => TrimCurve[]; // and the rest of it, in runs — what `hull` does not draw
  color: string;
}[] = [
  {
    key: "sheer",
    sheet: (s) => s.sheetSheer,
    hull: (s) => s.hullSheer,
    leftover: (s) => s.hullSheerLeftover,
    color: COL.sheer,
  },
  {
    key: "centerline",
    sheet: (s) => s.sheetCenterline,
    hull: (s) => s.hullCenterline,
    leftover: (s) => s.hullCenterlineLeftover,
    color: COL.keel,
  },
  {
    key: "transom",
    sheet: (s) => s.sheetTransom,
    hull: (s) => s.hullTransom,
    leftover: (s) => s.hullTransomLeftover,
    color: COL.transom,
  },
];

export function buildTrimCurves(
  trims: TrimToggles,
  sampling: HullSampling,
): TrimPlanCurves {
  const sheet: Vec3[][] = [],
    hull: TrimPlanCurves["hull"] = [];
  for (const spec of TRIM_SPECS) {
    if (!trims[spec.key]) continue;
    // each curve in the order the sampling holds it — fore-aft for the sheer and keel, down the plane for the
    // transom's hull edge — with nothing dropped, joined or split. The one choice made here is WHICH sheet
    // curve: the whole march on its own, or, with the hull edge up as well, only the leftover the edge does
    // not already cover.
    if (trims.sheetCurves)
      for (const run of trims.hullCurves
        ? spec.leftover(sampling)
        : [spec.sheet(sampling)])
        if (run.length > 1) sheet.push(run.map((s) => s.pos));
    const edge = spec.hull(sampling);
    if (trims.hullCurves && edge.length > 1)
      hull.push({ color: spec.color, lines: [edge.map((s) => s.pos)] });
  }
  return { sheet, hull };
}

// ---------- feature edges read off the mesh's own triangles ----------
//
// The surface's feature lines are exactly two kinds of triangle edge, so reading them from the mesh keeps them
// ON it — they end where its triangles do, not a lattice step short of a trim or of the bow:
//   • BOUNDARY edges — an edge in a single triangle — are the sheer / keel / transom the surface ends on;
//   • CREASE edges — an edge whose two ends both sit on the same creased station row — are the chines.
// Both come back chained into polylines (a boundary is one closed loop; a chine an open run).

type MeshEdge = [number, number]; // a pair of vertex ids

// Chain a set of edges into polylines, following each unused edge on from the tip. Open runs first (their
// degree-1 ends), then any closed loop left over. The mesh's crossings are shared by object identity, so the
// ids match exactly and no join is missed.
function chainEdges(edges: MeshEdge[], vert: HullSample[]): Vec3[][] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const V = vert.length,
    ekey = (a: number, b: number): number => (a < b ? a * V + b : b * V + a),
    used = new Set<number>(),
    out: Vec3[][] = [];
  // start from the sparsest vertices, so an open chain's degree-1 end is taken before any interior vertex
  const starts = [...adj.keys()].sort(
    (a, b) => adj.get(a)!.length - adj.get(b)!.length,
  );
  for (const start of starts) {
    let seed = adj.get(start)!.find((x) => !used.has(ekey(start, x)));
    while (seed !== undefined) {
      const line = [start];
      let cur = start,
        next: number | undefined = seed;
      while (next !== undefined && !used.has(ekey(cur, next))) {
        used.add(ekey(cur, next));
        line.push(next);
        const from: number = next;
        next = adj.get(from)!.find((x) => !used.has(ekey(from, x)));
        cur = from;
      }
      if (line.length > 1) out.push(line.map((i) => vert[i].pos));
      seed = adj.get(start)!.find((x) => !used.has(ekey(start, x)));
    }
  }
  return out;
}

function featureEdges(
  tris: [HullSample, HullSample, HullSample][],
  creaseRows: Set<number>,
): { boundary: Vec3[][]; chines: Vec3[][] } {
  const id = new Map<HullSample, number>(),
    vert: HullSample[] = [];
  const vid = (s: HullSample): number => {
    let i = id.get(s);
    if (i === undefined) {
      i = vert.length;
      vert.push(s);
      id.set(s, i);
    }
    return i;
  };
  for (const t of tris) for (const s of t) vid(s);
  const V = vert.length,
    ekey = (a: number, b: number): number => (a < b ? a * V + b : b * V + a);
  const edge = new Map<number, { a: number; b: number; n: number }>();
  for (const t of tris) {
    const i = [vid(t[0]), vid(t[1]), vid(t[2])];
    for (let e = 0; e < 3; e++) {
      const a = i[e],
        b = i[(e + 1) % 3],
        k = ekey(a, b),
        hit = edge.get(k);
      if (hit) hit.n++;
      else edge.set(k, { a, b, n: 1 });
    }
  }
  // a vertex sits on a creased row when its row index is an integer that some station knuckle creased
  const creaseRow = (i: number): boolean => {
    const r = Math.round(vert[i].vSheetIndex);
    return Math.abs(vert[i].vSheetIndex - r) < 1e-6 && creaseRows.has(r);
  };
  const bE: MeshEdge[] = [],
    cE: MeshEdge[] = [];
  for (const { a, b, n } of edge.values()) {
    if (n === 1) bE.push([a, b]); // a boundary edge: only one triangle owns it
    if (
      creaseRow(a) &&
      creaseRow(b) &&
      Math.round(vert[a].vSheetIndex) === Math.round(vert[b].vSheetIndex)
    )
      cE.push([a, b]); // both ends on the same chine row
  }
  return { boundary: chainEdges(bE, vert), chines: chainEdges(cE, vert) };
}

// The range of `field` over the SHEET's columns. Read off the columns rather than off the drawn mesh's
// position buffer precisely so that it is the sheet's range either way: the trimmed hull reaches nowhere near
// as far in either |y| or z, and scanning it would respace the whole family the moment Sheet was toggled.
// Both fields used here are unchanged by the port mirror (z ignores y; |y| is symmetric in it), so the
// starboard sheet gives the full range of the mirrored hull too.
function rangeIn(cols: HullSample[][], field: Field): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (const col of cols)
    for (const s of col) {
      const f = field(s.pos[0], s.pos[1], s.pos[2]);
      if (f < lo) lo = f;
      if (f > hi) hi = f;
    }
  return [lo, hi];
}

// n levels across [lo, hi] at a spacing of exactly (hi − lo) / (n + 1) — the lines plan's classic spacing.
// The span is a whole number of spacings, so the first and last level stand one full spacing clear of the
// ends: a family fitted to the sheet this way never leaves a member crowding the sheet's drawn edge, which is
// what a spacing chosen against some other extent, with the remainder falling where it may, always risks.
const spread = (lo: number, hi: number, n: number): number[] =>
  hi > lo
    ? Array.from({ length: n }, (_, k) => lo + ((hi - lo) * (k + 1)) / (n + 1))
    : [];

// March each of `levels` across the hull's triangles, chaining the crossings into polylines: one list of
// polylines per level, in the order the levels were given.
function contours(hull: Mesh, field: Field, levels: number[]): Vec3[][][] {
  if (!levels.length) return [];
  const pos = hull.pos,
    per: Segment[][] = levels.map(() => []),
    f = [0, 0, 0];
  for (let t = 0; t + 8 < pos.length; t += 9) {
    let lo = Infinity,
      hi = -Infinity;
    for (let e = 0; e < 3; e++) {
      const v = field(pos[t + 3 * e], pos[t + 3 * e + 1], pos[t + 3 * e + 2]);
      f[e] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    for (let k = 0; k < levels.length; k++) {
      if (levels[k] < lo || levels[k] > hi) continue; // this triangle doesn't reach that level
      const seg = crossTri(pos, t, f, levels[k]);
      if (seg) per[k].push(seg);
    }
  }
  return per.map(chain);
}

type Segment = [Vec3, Vec3];

// Where `level` crosses one triangle of the position buffer, as a segment: the field is linear along each
// edge, so each crossed edge contributes one point and a crossed triangle has exactly two of them.
function crossTri(
  pos: Float32Array,
  t: number,
  f: number[],
  level: number,
): Segment | null {
  const cr: Vec3[] = [];
  for (let e = 0; e < 3 && cr.length < 2; e++) {
    const a = f[e] - level,
      b = f[(e + 1) % 3] - level;
    if (a < 0 === b < 0 || a === b) continue;
    const s = a / (a - b),
      i = t + 3 * e,
      j = t + 3 * ((e + 1) % 3);
    cr.push([
      pos[i] + (pos[j] - pos[i]) * s,
      pos[i + 1] + (pos[j + 1] - pos[i + 1]) * s,
      pos[i + 2] + (pos[j + 2] - pos[i + 2]) * s,
    ]);
  }
  // a level grazing a vertex crosses two edges at that same point — a zero-length segment with no direction,
  // which no ribbon can be built around
  return cr.length === 2 && !same(cr[0], cr[1]) ? [cr[0], cr[1]] : null;
}

const same = (a: Vec3, b: Vec3): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// Chain marched segments that share an endpoint into connected polylines — worth doing because the ribbon
// built from these is re-widened on every frame the camera moves, and a chain of n segments costs half the
// per-point work of n loose ones.
//
// The two triangles either side of a shared edge compute that edge's crossing from bit-identical copies of
// the same two vertices, so the shared endpoint comes out bit-identical too and can be matched exactly. The
// index buckets endpoints by x alone (a plain number key, far cheaper than a string of all three) and the
// match is then confirmed on all three coordinates — so a shared x is only ever a wasted comparison, never a
// wrong join, and a crossing that somehow fails to match only costs one more polyline.
function chain(segs: Segment[]): Vec3[][] {
  const at = new Map<number, number[]>();
  for (let i = 0; i < segs.length; i++)
    for (const p of segs[i]) {
      const list = at.get(p[0]);
      if (list) list.push(i);
      else at.set(p[0], [i]);
    }
  const used = segs.map(() => false),
    out: Vec3[][] = [];
  // walk on from the polyline's last point, consuming whatever unused segment continues it
  const grow = (line: Vec3[]): void => {
    for (;;) {
      const tip = line[line.length - 1];
      let next = -1;
      for (const i of at.get(tip[0]) ?? [])
        if (!used[i] && (same(segs[i][0], tip) || same(segs[i][1], tip))) {
          next = i;
          break;
        }
      if (next < 0) return;
      used[next] = true;
      line.push(same(segs[next][0], tip) ? segs[next][1] : segs[next][0]);
    }
  };
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const line = [segs[i][0], segs[i][1]];
    grow(line); // forward from one end...
    line.reverse();
    grow(line); // ...then from the other
    out.push(line);
  }
  return out;
}
