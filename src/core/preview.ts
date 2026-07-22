// ---------- 3/4 wireframe preview (SVG) ----------
//
// Builds a small isometric wireframe of the current model as a self-contained SVG string. It's generated in
// the editor at save time and stored on the design row, so the file view can show it as a plain <img> without
// ever loading the model. Geometry reuses the shared sampling's trimmed columns (the same surface the 3D view
// draws); the projection reproduces the 3D canvas's orthographic camera (see draw3d.ts VERT_SRC). The drawing
// is fitted to its own projected bounds, so the model's unit and absolute size are irrelevant here.

import { type Model, prepare } from "./model";
import { computeHullSampling, type HullColumnV2 } from "./mesh";
import { mirrorRow, type Vec3 } from "./math";

// a pleasing fixed 3/4 view (matches the editor's default 3D orientation)
const YAW = -0.62,
  PITCH = 0.42;

export function buildPreviewSvg(model: Model): string {
  prepare(model);
  const NS = 36;
  const sampling = computeHullSampling(model, NS, 3),
    cols = sampling.columns.filter((c) => c.pts.length >= 2),
    M = sampling.M;
  if (cols.length < 4) return "";

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
  const mir = (p: Vec3): Vec3 => [p[0], -p[1], p[2]];
  const frames: [number, number][][] = [];
  const longs: [number, number][][] = [];

  // transverse frames: a handful of full-width sections. A section that closes on the keel is mirrored through
  // it into one polyline; one the transom (or an open bottom) cut is drawn as its two open half-sections.
  const NF = 8;
  for (let f = 0; f <= NF; f++) {
    const c = cols[Math.round(((cols.length - 1) * f) / NF)],
      pts = c.pts.map((s) => s.pos);
    if (c.keel) frames.push(mirrorRow(pts).map(proj));
    else {
      frames.push(pts.map(proj));
      frames.push(pts.map(mir).map(proj));
    }
  }

  // longitudinals: the sheer, a couple of interior sheet rows, and the chine/crease rows — each traced across
  // the columns and broken into runs where the trim dropped it — plus the bottom (keel / transom) edge. Every
  // run that leaves the centerline is drawn on both sides.
  const rowAt = (c: HullColumnV2, k: number): Vec3 | null => {
    for (const s of c.pts) {
      if (Math.abs(s.vSheetIndex - k) < 1e-9) return s.pos;
      if (s.vSheetIndex > k) break;
    }
    return null;
  };
  const runsAlong = (pick: (c: HullColumnV2) => Vec3 | null): void => {
    let run: Vec3[] = [];
    const flush = (): void => {
      if (run.length > 1) {
        longs.push(run.map(proj));
        if (run.some((p) => Math.abs(p[1]) > 1e-9))
          longs.push(run.map(mir).map(proj));
      }
      run = [];
    };
    for (const c of cols) {
      const p = pick(c);
      if (p) run.push(p);
      else flush();
    }
    flush();
  };
  const creaseRows = new Set<number>();
  for (const col of sampling.sheet)
    for (const s of col) if (s.vCreaseK > 1e-6) creaseRows.add(s.vSheetIndex);
  const rows = new Set<number>([0, M >> 2, M >> 1, ...creaseRows]);
  for (const k of [...rows].sort((a, b) => a - b))
    runsAlong(k === 0 ? (c) => c.pts[0].pos : (c) => rowAt(c, k));
  runsAlong((c) => c.pts[c.pts.length - 1].pos); // the keel / transom bottom edge

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
