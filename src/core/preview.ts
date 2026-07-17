// ---------- 3/4 wireframe preview (SVG) ----------
//
// Builds a small isometric wireframe of the current model as a self-contained SVG string. It's generated in
// the editor at save time and stored on the design row, so the file view can show it as a plain <img> without
// ever loading the model. Geometry reuses trimmedHullGrid (the same full-width station×offset point grid the
// STEP export samples); the projection reproduces the 3D canvas's orthographic camera (see draw3d.ts VERT_SRC).
// The drawing is fitted to its own projected bounds, so the model's unit and absolute size are irrelevant here.

import { type Model, prepare } from "./model";
import { trimmedHullGrid } from "./mesh";
import type { Vec3 } from "./math";

// a pleasing fixed 3/4 view (matches the editor's default 3D orientation)
const YAW = -0.62,
  PITCH = 0.42;

export function buildPreviewSvg(model: Model): string {
  prepare(model);
  const NS = 36;
  // grid[i][j]: i station (transom→bow), j offset — FULL WIDTH, starboard sheer (0) → keel → port sheer
  const { grid, creaseCols } = trimmedHullGrid(model, NS, 3);
  if (grid.length < 4 || grid[0].length < 2) return "";
  const NC = grid[0].length - 1,
    KEEL = NC >> 1;

  const c1 = Math.cos(YAW),
    s1 = Math.sin(YAW),
    c2 = Math.cos(PITCH),
    s2 = Math.sin(PITCH),
    cT = Math.cos(model.deckRake),
    sT = Math.sin(model.deckRake);
  // world (x,y,z) → screen (sx, sy): deck-rake about y, then yaw about up (z), then pitch. SVG y points down,
  // so negate. Centering/scaling is handled afterward by fitting a viewBox to the projected bounds.
  const proj = ([x, y, z]: Vec3): [number, number] => {
    const rx = x * cT - z * sT,
      rz = x * sT + z * cT;
    const X1 = rx * c1 - y * s1,
      Y1 = rx * s1 + y * c1;
    return [X1, -(Y1 * s2 + rz * c2)];
  };
  const frames: [number, number][][] = [];
  const longs: [number, number][][] = [];

  // transverse frames: a handful of sections. Each row is already the full section (starboard sheer → keel →
  // port sheer), so it draws as one polyline — no mirroring.
  const NF = 8;
  for (let f = 0; f <= NF; f++)
    frames.push(grid[Math.round((NS * f) / NF)].map(proj));

  // longitudinals: both sheers (0, NC), the keel (KEEL), the chine/crease lines (already on both sides), and
  // a mid line per side
  const cols = new Set<number>([
    0,
    NC,
    KEEL,
    KEEL >> 1,
    NC - (KEEL >> 1),
    ...creaseCols,
  ]);
  for (const j of [...cols].sort((a, b) => a - b))
    longs.push(grid.map((row) => proj(row[j])));

  // fit a viewBox to all projected points
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const line of [...frames, ...longs])
    for (const [px, py] of line) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  const padX = (maxX - minX) * 0.04 || 1,
    padY = (maxY - minY) * 0.06 || 1;
  const vb = `${(minX - padX).toFixed(0)} ${(minY - padY).toFixed(0)} ${(maxX - minX + 2 * padX).toFixed(0)} ${(maxY - minY + 2 * padY).toFixed(0)}`;

  const path = (line: [number, number][]): string =>
    "M" + line.map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join("L");
  const grp = (
    lines: [number, number][][],
    stroke: string,
    w: number,
  ): string =>
    `<g fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round">` +
    lines
      .map((l) => `<path vector-effect="non-scaling-stroke" d="${path(l)}"/>`)
      .join("") +
    `</g>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet">` +
    grp(frames, "#9aa7ba", 0.8) +
    grp(longs, "#2b6cb0", 1.2) +
    `</svg>`
  );
}
