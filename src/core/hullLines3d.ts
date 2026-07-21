// ---------- lines-plan curves, as real 3D polylines ON the rendered hull ----------
//
// The "body" / "buttocks" / "waterline" 3D-view modes used to be an SVG hidden-line-removal overlay: project
// every hull facet, sort by depth, paint white occluding polygons, then draw line segments on top (see git
// history). That whole painter's-algorithm pass is gone — the 3D view renders the actual trimmed hull mesh
// (flat white, depth-tested) as the occluder and these curves on top of it, so hidden-line removal falls out
// of the GPU depth buffer for free. This module only does the first half of the old job: picking which 3D
// curves to draw.
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

import { mirrorRow, type Vec3 } from "./math";
import type { Model } from "./model";
import type { HullSampling, SectionRow } from "./mesh";
import type { Mesh } from "./hullGeometry";
import type { View3DMode } from "./view3dMode";

const N_STATIONS = 26, // how many transverse stations "body" draws — the sampling's columns, decimated to this
  N_BUTTOCKS = 8,
  N_WATERLINES = 12;

export interface LinesPlanCurves {
  bold: Vec3[][]; // sheer / keel / chines / the transom edge — heavy weight, drawn in every mode
  family: Vec3[][]; // the mode's own non-chine family: stations / buttocks / waterlines — light weight
  dwl: Vec3[][]; // the design-waterline crossing — blue, drawn in every mode
}

// a scalar field of a mesh vertex, read straight off the position buffer (no Vec3 per vertex)
type Field = (x: number, y: number, z: number) => number;

const EMPTY: LinesPlanCurves = { bold: [], family: [], dwl: [] };

// The lines-plan curves for `mode`, as world-space 3D polylines. `sampling`, `trimmed` and `hull` must be the
// very ones the view is rendering (mesh.ts's shared sampling, the Sheet toggle's choice of stage, and the
// triangle soup buildHullMesh stitched from them) — the curves are only exactly on the surface because they
// are read from that same geometry. With `trimmed` off the surface is the raw starboard sweep, so there are
// no trim edges to ride and no port half to mirror onto: every curve here is simply one-sided.
export function buildLinesPlanCurves(
  model: Model,
  mode: View3DMode,
  sampling: HullSampling,
  trimmed: boolean,
  hull: Mesh,
): LinesPlanCurves {
  // the columns the mesh was actually stitched from: the same stage buildHullMesh used, non-empty and
  // index-tagged
  const cols = (
    trimmed ? sampling.trimmedSections : sampling.sheetSections
  ).filter((s) => !s.empty && s.pts.length >= 2 && s.sheetIndex);
  if (cols.length < 2 || hull.count < 3) return EMPTY;

  const mir = (p: Vec3): Vec3 => [p[0], -p[1], p[2]];
  // a starboard curve and its port mirror — unless it rides the centerline, where the two coincide, or the
  // surface is the untrimmed sheet, which has no port half
  const bothSides = (line: Vec3[]): Vec3[][] =>
    trimmed && line.some((p) => Math.abs(p[1]) > 1e-9)
      ? [line, line.map(mir)]
      : [line];
  // one full-width station: the column joined to its mirror through the keel where the section closes there,
  // and left as two open curves where the transom (or an open bottom) cut it instead — exactly the gap the
  // surface itself has
  const station = (s: SectionRow): Vec3[][] =>
    !trimmed ? [s.pts] : s.keel ? [mirrorRow(s.pts)] : [s.pts, s.pts.map(mir)];

  // the mesh's boundary chains: the first and last point of every column are joined column-to-column by real
  // mesh edges (the stitch always pairs the two columns' first points, and their last)
  const bold: Vec3[][] = [
    ...bothSides(cols.map((s) => s.pts[0])), // the sheer edge (untrimmed: the sheet's deck edge)
    ...bothSides(cols.map((s) => s.pts[s.pts.length - 1])), // the keel, or the transom cut
    ...station(cols[0]), // the aft-most surviving column — the mesh's aft edge
  ];

  // the chines: every station knot carrying a knuckle, which the mesh gives a tangent break, so it reads as a
  // real edge of the surface. A chine only exists where the trim kept its row, hence the runs.
  const creases = new Set<number>();
  for (const s of cols) for (const c of s.creaseRows) creases.add(c);
  for (const c of [...creases].sort((a, b) => a - b)) {
    let run: Vec3[] = [];
    for (const s of cols) {
      const p = atSheetIndex(s, c);
      if (p) run.push(p);
      else {
        if (run.length > 1) bold.push(...bothSides(run));
        run = [];
      }
    }
    if (run.length > 1) bold.push(...bothSides(run));
  }

  const family: Vec3[][] = [];
  if (mode === "body") {
    const step = Math.max(1, Math.round(cols.length / N_STATIONS));
    for (let i = 1; i < cols.length; i++)
      // column 0 is already drawn bold
      if (i % step === 0 || i === cols.length - 1)
        family.push(...station(cols[i]));
  }

  // The design waterline shares the waterline family's field, so both are marched in one pass over the
  // triangles: the DWL is simply the last level asked for. The field is `worldZ` with the rake's sin/cos
  // lifted out — it runs once per mesh vertex per pass, and those two trig calls cost more than the whole
  // rest of the march put together.
  const sr = Math.sin(model.deckRake),
    cr = Math.cos(model.deckRake),
    wz: Field = (x, _y, z) => x * sr + z * cr;
  const wzLevels =
    mode === "waterline" ? levelsIn(hull, wz, N_WATERLINES) : ([] as number[]);
  wzLevels.push(-model.waterline);
  const wzRuns = contours(hull, wz, wzLevels);
  const dwl = wzRuns.pop() ?? [];
  for (const runs of wzRuns) family.push(...runs);

  if (mode === "buttocks") {
    const ay: Field = (_x, y) => Math.abs(y);
    for (const runs of contours(hull, ay, levelsIn(hull, ay, N_BUTTOCKS)))
      family.push(...runs);
  }

  return { bold, family, dwl };
}

// The column's point at sheet index k, or null where the trim cut that row away. A trimmed column keeps the
// consecutive integer indices of the sheet rows it kept, with a fractional crossing at each end, so only an
// exact integer match is the row itself.
function atSheetIndex(s: SectionRow, k: number): Vec3 | null {
  const idx = s.sheetIndex!;
  for (let t = 0; t < idx.length; t++) {
    if (Math.abs(idx[t] - k) < 1e-9) return s.pts[t];
    if (idx[t] > k) break; // indices ascend — past k, it isn't there
  }
  return null;
}

// n evenly spaced levels strictly inside the hull's own range of `field` — the lines plan's classic spacing
function levelsIn(hull: Mesh, field: Field, n: number): number[] {
  const pos = hull.pos;
  let lo = Infinity,
    hi = -Infinity;
  for (let t = 0; t + 2 < pos.length; t += 3) {
    const f = field(pos[t], pos[t + 1], pos[t + 2]);
    if (f < lo) lo = f;
    if (f > hi) hi = f;
  }
  if (!(hi > lo)) return [];
  return Array.from(
    { length: n },
    (_, k) => lo + ((hi - lo) * (k + 1)) / (n + 1),
  );
}

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
