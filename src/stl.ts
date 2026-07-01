// ---------- STL export: a triangle mesh of the trimmed hull ----------
//
// Mirrors the STEP path's geometry (step.ts): take the faired starboard half-grid from trimmedHullGrid,
// build the full-width grid by reflecting it across the centerline (dropping the duplicate keel point), then
// triangulate the quad mesh. The stern is closed with a triangle fan over the transom edge; the deck stays
// open (as in the STEP OPEN_SHELL). Output is ASCII STL in millimetres — the model's native units.

import { prepare } from "./model.js";
import { trimmedHullGrid } from "./step.js";
import { type Vec3 } from "./math.js";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function facet(a: Vec3, b: Vec3, c: Vec3): string {
  const n = cross(sub(b, a), sub(c, a));
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const f = (v: number): string => v.toFixed(4);
  return (
    `  facet normal ${f(n[0] / len)} ${f(n[1] / len)} ${f(n[2] / len)}\n` +
    `    outer loop\n` +
    `      vertex ${f(a[0])} ${f(a[1])} ${f(a[2])}\n` +
    `      vertex ${f(b[0])} ${f(b[1])} ${f(b[2])}\n` +
    `      vertex ${f(c[0])} ${f(c[1])} ${f(c[2])}\n` +
    `    endloop\n` +
    `  endfacet\n`
  );
}

// build an ASCII STL string for the current model (call after resetModel + loadJsonText, as STEP export does)
export function buildStl(name = "camber"): string {
  prepare(); // ensure the sheer samplers / faired sections are current
  const M = 24,
    { grid: half } = trimmedHullGrid(80, M);
  if (half.length < 4) throw new Error("hull has too few sections to export");
  // full-width grid: starboard sheer→keel (cols 0..M), then port keel→sheer as the y-mirror, dropping the
  // duplicate keel point — so the keel is one interior column rather than a mirrored seam.
  const grid: Vec3[][] = half.map((row) => {
    const full = row.slice();
    for (let j = M - 1; j >= 0; j--)
      full.push([row[j][0], -row[j][1], row[j][2]]);
    return full;
  });
  const NS = grid.length - 1,
    COLS = grid[0].length;

  let out = `solid ${name}\n`;
  // hull surface: each grid quad → two triangles (wound so the normal faces out of the hull)
  for (let i = 0; i < NS; i++)
    for (let j = 0; j < COLS - 1; j++) {
      const a = grid[i][j],
        b = grid[i][j + 1],
        c = grid[i + 1][j + 1],
        d = grid[i + 1][j];
      out += facet(a, d, c);
      out += facet(a, c, b);
    }
  // transom cap: close the aft edge ring (row 0) with a fan to its centroid
  const aft = grid[0];
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const p of aft) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const ctr: Vec3 = [cx / aft.length, cy / aft.length, cz / aft.length];
  for (let j = 0; j < COLS - 1; j++) out += facet(aft[j], aft[j + 1], ctr);

  out += `endsolid ${name}\n`;
  return out;
}
