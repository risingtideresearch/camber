// ---------- STL export: a triangle mesh of the trimmed hull ----------
//
// Mirrors the STEP path's geometry (step.ts): take the faired full-width grid from trimmedHullGrid (starboard
// sheer → keel → port sheer, the keel an interior column) and triangulate the quad mesh. The stern is closed
// with a triangle fan over the transom edge; the deck stays open (as in the STEP OPEN_SHELL).
//
// Output is ASCII STL in MILLIMETRES. STL carries no unit of its own and is universally read as mm, so a hull
// authored in another unit is converted on the way out — the model's coordinates are absolute in `model.unit`
// now, so "the model's native units" is no longer a synonym for millimetres.

import { type Model, prepare } from "./model";
import { trimmedHullGrid } from "./mesh";
import { unitScale } from "./json";
import { V, type Vec3 } from "./math";

function facet(a: Vec3, b: Vec3, c: Vec3): string {
  const n = V.cross(V.sub(b, a), V.sub(c, a));
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
export function buildStl(model: Model, name = "camber"): string {
  prepare(model); // ensure the derived curves are current
  // R = 6 on the default 5-point section gives a 24-column half, as v1's M did
  const { grid: raw } = trimmedHullGrid(model, 80, 6);
  if (raw.length < 4) throw new Error("hull has too few sections to export");
  const s = unitScale(model.unit, "mm"),
    grid: Vec3[][] = raw.map((row) =>
      row.map((p): Vec3 => [p[0] * s, p[1] * s, p[2] * s]),
    );
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
  out += facet(aft[COLS - 1], aft[0], ctr); // close the ring across the transom top (sheer to sheer)

  out += `endsolid ${name}\n`;
  return out;
}
