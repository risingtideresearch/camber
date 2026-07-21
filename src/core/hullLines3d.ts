// ---------- lines-plan curves, as real 3D polylines ----------
//
// The "body" / "buttocks" / "waterline" 3D-view modes used to be an SVG hidden-line-removal overlay: project
// every hull facet, sort by depth, paint white occluding polygons, then draw line segments on top (see git
// history). That whole painter's-algorithm pass is gone — the 3D view now renders the actual trimmed hull
// mesh (flat white, depth-tested) as the occluder, and these curves as camera-facing ribbons on top of it, so
// hidden-line removal falls out of the GPU depth buffer for free. This module only does the first half of
// the old job: picking which 3D crossings to draw.

import { type Vec3, V } from "./math";
import { type Model, worldZ } from "./model";
import { trimmedHullGrid } from "./mesh";
import type { View3DMode } from "./view3dMode";

const LINES_NS = 80,
  LINES_R = 3, // sub-steps per section segment: the lines plan wants few, widely spaced longitudinals
  LINES_STATION_STEP = 3; // draw a station (transverse) line every Nth grid row (≈ NS/STEP stations)

// the segment where field f crosses `level` across a facet's 4 corners (linear on each edge), in world space
function march3(
  corners: { p: Vec3; f: number }[],
  level: number,
): [Vec3, Vec3] | null {
  const cr: Vec3[] = [];
  for (let k = 0; k < 4; k++) {
    const a = corners[k],
      b = corners[(k + 1) % 4],
      fa = a.f - level,
      fb = b.f - level;
    if (fa < 0 !== fb < 0 && fa !== fb)
      cr.push(V.lerp(a.p, b.p, fa / (fa - fb)));
  }
  return cr.length >= 2 ? [cr[0], cr[1]] : null;
}

export interface LinesPlanCurves {
  bold: Vec3[][]; // sheer / keel / chines / the transom edge — heavy weight, drawn in every mode
  family: Vec3[][]; // the mode's own non-chine family: stations / buttocks / waterlines — light weight
  dwl: Vec3[][]; // the design-waterline crossing — blue, drawn in every mode
}

// The lines-plan curves for `mode`, as world-space 3D polylines (each `family`/`dwl` entry from marching is a
// disconnected 2-point segment — like the old SVG overlay, adjacent segments simply line up visually rather
// than being stitched into one polyline). Reuses `trimmedHullGrid` (mesh.ts) — the same full-width grid
// `buildCurvature3`'s keel/longitudinal curves ride.
export function buildLinesPlanCurves(
  model: Model,
  mode: View3DMode,
): LinesPlanCurves {
  const { grid, creaseCols, keel } = trimmedHullGrid(model, LINES_NS, LINES_R);
  const NS = grid.length - 1,
    NC = (grid[0]?.length ?? 0) - 1,
    KEEL = NC >> 1;
  if (NS < 1 || NC < 1) return { bold: [], family: [], dwl: [] };

  const crease = new Set(creaseCols);
  // the bold (feature) longitudinals: both sheers, the keel, and every chine. The keel is listed explicitly
  // because it carries no crease of its own (the mesh leaves it smooth), yet it is still the hull's profile.
  const feature = (j: number): boolean =>
    j === 0 || j === NC || j === KEEL || crease.has(j);
  const showStation = (i: number): boolean =>
    i === 0 || i === NS || i % LINES_STATION_STEP === 0;

  const bold: Vec3[][] = [grid[0]]; // the transom / aft-most row — a hull edge, bold in every mode
  for (let j = 0; j <= NC; j++)
    if (feature(j)) bold.push(grid.map((row) => row[j]));

  // "body": a station is literally a full grid row — no per-facet reconstruction needed. (Where a row is
  // open at the centerline the curve still pinches through the grid's single interior point rather than
  // showing the small gap the old per-facet overlay had there — an accepted simplification for a rare edge
  // case: an unclosed bow/stern cross-section in body mode.)
  const family: Vec3[][] = [];
  if (mode === "body")
    for (let i = 0; i <= NS; i++)
      if (i !== 0 && showStation(i)) family.push(grid[i]);

  // buttock / waterline levels, evenly spaced inside the hull's own range
  let buttLevels: number[] = [],
    wlLevels: number[] = [];
  if (mode === "buttocks" || mode === "waterline") {
    let ymax = 0,
      zlo = Infinity,
      zhi = -Infinity;
    for (const row of grid)
      for (const p of row) {
        if (Math.abs(p[1]) > ymax) ymax = Math.abs(p[1]);
        const wz = worldZ(model, p[0], p[2]);
        if (wz < zlo) zlo = wz;
        if (wz > zhi) zhi = wz;
      }
    const NB = 8,
      NW = 12;
    buttLevels = Array.from(
      { length: NB },
      (_, k) => (ymax * (k + 1)) / (NB + 1),
    );
    wlLevels = Array.from(
      { length: NW },
      (_, k) => zlo + ((zhi - zlo) * (k + 1)) / (NW + 1),
    );
  }

  // the design-waterline crossing (blue, every mode) and the buttock/waterline family both march each
  // facet; the design-waterline field (worldZ) is shared with the waterline family.
  const dwl: Vec3[][] = [];
  for (let i = 0; i < NS; i++)
    for (let j = 0; j < NC; j++) {
      // where the section is open there is no surface across the centerline — don't march a crossing through
      // a facet that has no real hull surface behind it
      if (j === KEEL && (!keel[i] || !keel[i + 1])) continue;
      const A = grid[i][j],
        B = grid[i][j + 1],
        C = grid[i + 1][j + 1],
        D = grid[i + 1][j];
      const wzCorners = [
        { p: A, f: worldZ(model, A[0], A[2]) },
        { p: B, f: worldZ(model, B[0], B[2]) },
        { p: C, f: worldZ(model, C[0], C[2]) },
        { p: D, f: worldZ(model, D[0], D[2]) },
      ];
      const dwlSeg = march3(wzCorners, -model.waterline);
      if (dwlSeg) dwl.push(dwlSeg);
      if (mode === "buttocks") {
        const corn = [
          { p: A, f: Math.abs(A[1]) },
          { p: B, f: Math.abs(B[1]) },
          { p: C, f: Math.abs(C[1]) },
          { p: D, f: Math.abs(D[1]) },
        ];
        for (const lv of buttLevels) {
          const seg = march3(corn, lv);
          if (seg) family.push(seg);
        }
      } else if (mode === "waterline") {
        for (const lv of wlLevels) {
          const seg = march3(wzCorners, lv);
          if (seg) family.push(seg);
        }
      }
    }

  return { bold, family, dwl };
}
