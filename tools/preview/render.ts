// Offline render harness for debugging the 3D geometry without a browser. Builds the hull from src/* and
// rasterizes an SVG to PNG with resvg, so Claude (or anyone) can SEE the mesh/lines/STEP while iterating.
//
// Usage (via render.sh, which bundles + rasterizes):
//   ./render.sh <mode> <preset|yaw> [pitch] [out.png]
//   mode:    lines  = white hidden-line lines plan (painter's, matches the editor's Lines view)
//            shaded = flat-Lambert mesh (the GL surface; use this to spot puckers/creases)
//            stepnet= the exported STEP's NURBS control net (to compare STEP vs the lines view)
//   preset:  3q | bow | stern | side | top | below   (or pass a numeric yaw + pitch in radians)
// Examples:
//   ./render.sh shaded bow
//   ./render.sh lines 3q
//   ./render.sh stepnet -1.15 0.38 out/step.png

import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { state, L, resetModel, prepare, sweptSection, forwardLimit, type Vec3 } from "../../src/model.js";
import { trimmedHullGrid, buildStep } from "../../src/step.js";

type P2 = { x: number; y: number; d: number };

const PRESETS: Record<string, [number, number]> = {
  "3q": [-1.15, 0.38], // three-quarter bow
  bow: [-1.5708, 0.32], // head-on at the bow
  stern: [1.5708, 0.32], // head-on at the transom
  side: [0, 0.02], // profile
  top: [0, 1.45], // plan-ish from above
  below: [-1.15, -0.5], // three-quarter from below (see the bottom/keel)
};

function projector(yaw: number, pitch: number) {
  const c1 = Math.cos(yaw), s1 = Math.sin(yaw), c2 = Math.cos(pitch), s2 = Math.sin(pitch);
  const cT = Math.cos(state.deckRake), sT = Math.sin(state.deckRake);
  // same transform as render.ts's WebGL vertex shader; SVG y is down so negate. d = toward-eye depth.
  return ([x, y, z]: Vec3): P2 => {
    const rx = x * cT - z * sT, rz = x * sT + z * cT;
    return { x: rx * c1 - y * s1, y: -((rx * s1 + y * c1) * s2 + rz * c2), d: -c2 * s1 * rx - c2 * c1 * y + s2 * rz };
  };
}

function svgWrap(body: string, minX: number, minY: number, w: number, h: number, pad: number): string {
  const vb = `${minX - pad} ${minY - pad} ${w + 2 * pad} ${h + 2 * pad}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" viewBox="${vb}"><rect x="${minX - pad}" y="${minY - pad}" width="${w + 2 * pad}" height="${h + 2 * pad}" fill="#fff"/>${body}</svg>`;
}

// ---- lines: painter's white facets + bold feature edges (replicates the editor Lines view) ----
function renderLines(P: (p: Vec3) => P2): string {
  const { grid, creaseCols } = trimmedHullGrid(40, 10);
  const NS = grid.length - 1, M = grid[0].length - 1, crease = new Set(creaseCols);
  const SP = grid.map((r) => r.map(P)), PP = grid.map((r) => r.map(([x, y, z]) => P([x, -y, z])));
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const quads: { poly: P2[]; depth: number; bold: [P2, P2][] }[] = [];
  for (const G of [SP, PP])
    for (let i = 0; i < NS; i++)
      for (let j = 0; j < M; j++) {
        const A = G[i][j], B = G[i][j + 1], C = G[i + 1][j + 1], D = G[i + 1][j];
        for (const p of [A, B, C, D]) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
        const bold: [P2, P2][] = [];
        if (j === 0 || crease.has(j)) bold.push([D, A]);
        if (j + 1 === M || crease.has(j + 1)) bold.push([B, C]);
        if (i === 0) bold.push([A, B]);
        quads.push({ poly: [A, B, C, D], depth: (A.d + B.d + C.d + D.d) / 4, bold });
      }
  quads.sort((a, b) => a.depth - b.depth);
  const sw = (maxX - minX) / 1000;
  let body = "";
  for (const q of quads) {
    body += `<polygon points="${q.poly.map((p) => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ")}" fill="#fff" stroke="#8995a5" stroke-width="${0.6 * sw}"/>`;
    for (const [a, b] of q.bold) body += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#11181f" stroke-width="${1.8 * sw}"/>`;
  }
  return svgWrap(body, minX, minY, maxX - minX, maxY - minY, (maxX - minX) * 0.06);
}

// ---- shaded: full-width rows (like render.ts bilgeRows) flat-Lambert shaded, to spot puckers/creases ----
function renderShaded(P: (p: Vec3) => P2): string {
  const Mh = 44, N = 160, xf = forwardLimit();
  const rows: Vec3[][] = [];
  for (let i = 0; i <= N; i++) {
    const x = xf * 0.5 * (1 - Math.cos((Math.PI * i) / N)); // cosine spacing, matches the real mesh
    const s = sweptSection(x, Mh, true, false);
    if (s.aft) continue;
    const full = s.pts.slice();
    for (let j = Mh - 1; j >= 0; j--) full.push([s.pts[j][0], -s.pts[j][1], s.pts[j][2]]);
    rows.push(full);
  }
  const Lt = [0.4, -0.5, 0.76], nl = Math.hypot(Lt[0], Lt[1], Lt[2]);
  const R = rows.length, C = rows[0].length;
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const quads: { P: P2[]; depth: number; col: string }[] = [];
  for (let i = 0; i < R - 1; i++)
    for (let j = 0; j < C - 1; j++) {
      const A = rows[i][j], B = rows[i + 1][j], Cc = rows[i + 1][j + 1], D = rows[i][j + 1];
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
      let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const ln = Math.hypot(n[0], n[1], n[2]) || 1;
      const dot = Math.abs((n[0] * Lt[0] + n[1] * Lt[1] + n[2] * Lt[2]) / (ln * nl)); // two-sided
      const sh = Math.round(60 + 170 * Math.max(0, Math.min(1, 0.35 + 0.65 * dot)));
      const pr = [A, B, Cc, D].map(P);
      for (const p of pr) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
      quads.push({ P: pr, depth: (pr[0].d + pr[1].d + pr[2].d + pr[3].d) / 4, col: `rgb(${Math.round(sh * 0.55)},${Math.round(sh * 0.7)},${sh})` });
    }
  quads.sort((a, b) => a.depth - b.depth);
  let body = "";
  for (const q of quads) body += `<polygon points="${q.P.map((p) => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ")}" fill="${q.col}"/>`;
  return svgWrap(body, minX, minY, maxX - minX, maxY - minY, (maxX - minX) * 0.06);
}

// ---- stepnet: parse the exported STEP and draw its NURBS control net (STEP vs lines comparison) ----
function renderStepNet(P: (p: Vec3) => P2): string {
  const step = buildStep("2026-01-01T00:00:00");
  const pts: Record<string, Vec3> = {};
  const pre = /#(\d+)=CARTESIAN_POINT\('',\(([-\d.eE]+),([-\d.eE]+),([-\d.eE]+)\)\)/g;
  let m: RegExpExecArray | null;
  while ((m = pre.exec(step))) pts[m[1]] = [+m[2], +m[3], +m[4]];
  const si = step.indexOf("B_SPLINE_SURFACE_WITH_KNOTS");
  const gs = step.indexOf("((", si);
  let depth = 0, e = gs;
  for (; e < step.length; e++) { if (step[e] === "(") depth++; else if (step[e] === ")") { depth--; if (depth === 0) { e++; break; } } }
  const rows = step.slice(gs, e).slice(1, -1).split(/\),\(/).map((r) => r.replace(/[()]/g, "").split(",").map((s) => s.trim().replace("#", "")));
  const grid = rows.map((r) => r.map((id) => pts[id]).filter(Boolean));
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const polys: string[] = [];
  const add = (line: Vec3[]) => {
    const pr = line.map(P);
    for (const p of pr) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    polys.push("M" + pr.map((p) => p.x.toFixed(1) + " " + p.y.toFixed(1)).join("L"));
  };
  for (const r of grid) add(r);
  for (let j = 0; j < grid[0].length; j++) add(grid.map((r) => r[j]));
  const sw = (maxX - minX) / 1000;
  const body = polys.map((d) => `<path d="${d}" fill="none" stroke="#2b6cb0" stroke-width="${1.2 * sw}"/>`).join("");
  return svgWrap(body, minX, minY, maxX - minX, maxY - minY, (maxX - minX) * 0.06);
}

// ---- main ----
const mode = process.argv[2] ?? "lines";
const a2 = process.argv[3] ?? "3q";
let yaw: number, pitch: number, outArg: string | undefined;
if (a2 in PRESETS) { [yaw, pitch] = PRESETS[a2]; outArg = process.argv[4]; }
else { yaw = parseFloat(a2); pitch = parseFloat(process.argv[4] ?? "0.38"); outArg = process.argv[5]; }
const out = outArg ?? `out/${mode}-${a2}.png`;

resetModel();
prepare();
const P = projector(yaw, pitch);
const svg = mode === "shaded" ? renderShaded(P) : mode === "stepnet" ? renderStepNet(P) : renderLines(P);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out.replace(/\.png$/, ".svg"), svg);
writeFileSync(out, new Resvg(svg, { fitTo: { mode: "width", value: 1000 } }).render().asPng());
console.log(`wrote ${out}  (mode=${mode}, yaw=${yaw.toFixed(3)}, pitch=${pitch.toFixed(3)}, L=${L})`);
