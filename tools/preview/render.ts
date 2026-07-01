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
import { readFileSync } from "node:fs";
import {
  state,
  L,
  resetModel,
  prepare,
  sweptSection,
  forwardLimit,
  worldZ,
  weightsAt,
  frameAt,
  xTransom,
} from "../../src/model.js";
import { trimmedHullGrid, buildStep } from "../../src/step.js";
import { loadJsonText } from "../../src/json.js";
import type { Vec3 } from "../../src/math.js";

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
  const c1 = Math.cos(yaw),
    s1 = Math.sin(yaw),
    c2 = Math.cos(pitch),
    s2 = Math.sin(pitch);
  const cT = Math.cos(state.deckRake),
    sT = Math.sin(state.deckRake);
  // same transform as render.ts's WebGL vertex shader; SVG y is down so negate. d = toward-eye depth.
  return ([x, y, z]: Vec3): P2 => {
    const rx = x * cT - z * sT,
      rz = x * sT + z * cT;
    return {
      x: rx * c1 - y * s1,
      y: -((rx * s1 + y * c1) * s2 + rz * c2),
      d: -c2 * s1 * rx - c2 * c1 * y + s2 * rz,
    };
  };
}

function svgWrap(
  body: string,
  minX: number,
  minY: number,
  w: number,
  h: number,
  pad: number,
  bg = "#fff",
): string {
  const vb = `${minX - pad} ${minY - pad} ${w + 2 * pad} ${h + 2 * pad}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" viewBox="${vb}"><rect x="${minX - pad}" y="${minY - pad}" width="${w + 2 * pad}" height="${h + 2 * pad}" fill="${bg}"/>${body}</svg>`;
}

// ---- lines: painter's white facets + bold feature edges (replicates the editor Lines view) ----
function renderLines(
  P: (p: Vec3) => P2,
  yaw: number,
  pitch: number,
  sel: number,
  kind: string,
): string {
  const { grid, creaseCols } = trimmedHullGrid(80, 10);
  const NS = grid.length - 1,
    M = grid[0].length - 1,
    crease = new Set(creaseCols);
  const SP = grid.map((r) => r.map(P)),
    PP = grid.map((r) => r.map(([x, y, z]) => P([x, -y, z])));
  const gridM = grid.map((r) => r.map(([x, y, z]): Vec3 => [x, -y, z]));
  let minX = 1e9,
    minY = 1e9,
    maxX = -1e9,
    maxY = -1e9;
  const STEP = 3,
    showStation = (i: number) => i === 0 || i === NS || i % STEP === 0;
  let ymax = 0,
    zlo = Infinity,
    zhi = -Infinity;
  for (const row of grid)
    for (const p of row) {
      ymax = Math.max(ymax, Math.abs(p[1]));
      const wz = worldZ(p[0], p[2]);
      zlo = Math.min(zlo, wz);
      zhi = Math.max(zhi, wz);
    }
  const NB = 8,
    NW = 12;
  const buttLevels = Array.from(
    { length: NB },
    (_, k) => (ymax * (k + 1)) / (NB + 1),
  );
  const wlLevels = Array.from(
    { length: NW },
    (_, k) => zlo + ((zhi - zlo) * (k + 1)) / (NW + 1),
  );
  const march = (
    corn: { p: P2; f: number }[],
    level: number,
  ): [P2, P2] | null => {
    const cr: P2[] = [];
    for (let k = 0; k < 4; k++) {
      const a = corn[k],
        b = corn[(k + 1) % 4],
        fa = a.f - level,
        fb = b.f - level;
      if (fa < 0 !== fb < 0 && fa !== fb) {
        const t = fa / (fa - fb);
        cr.push({
          x: a.p.x + t * (b.p.x - a.p.x),
          y: a.p.y + t * (b.p.y - a.p.y),
          d: a.p.d + t * (b.p.d - a.p.d),
        });
      }
    }
    return cr.length >= 2 ? [cr[0], cr[1]] : null;
  };
  const quads: {
    poly: P2[];
    depth: number;
    bold: [P2, P2][];
    fam: [P2, P2][];
    wl: [P2, P2][];
  }[] = [];
  for (const [G, GW] of [
    [SP, grid],
    [PP, gridM],
  ] as [P2[][], Vec3[][]][])
    for (let i = 0; i < NS; i++)
      for (let j = 0; j < M; j++) {
        const A = G[i][j],
          B = G[i][j + 1],
          C = G[i + 1][j + 1],
          D = G[i + 1][j];
        for (const p of [A, B, C, D]) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
        }
        const wA = GW[i][j],
          wB = GW[i][j + 1],
          wC = GW[i + 1][j + 1],
          wD = GW[i + 1][j];
        const bold: [P2, P2][] = [];
        if (j === 0 || crease.has(j)) bold.push([D, A]);
        if (j + 1 === M || crease.has(j + 1)) bold.push([B, C]);
        if (i === 0) bold.push([A, B]); // transom trim line — bold in every mode
        const fam: [P2, P2][] = [];
        if (kind === "buttocks") {
          const corn = [
            { p: A, f: Math.abs(wA[1]) },
            { p: B, f: Math.abs(wB[1]) },
            { p: C, f: Math.abs(wC[1]) },
            { p: D, f: Math.abs(wD[1]) },
          ];
          for (const lv of buttLevels) {
            const s = march(corn, lv);
            if (s) fam.push(s);
          }
        } else if (kind === "waterline") {
          const corn = [
            { p: A, f: worldZ(wA[0], wA[2]) },
            { p: B, f: worldZ(wB[0], wB[2]) },
            { p: C, f: worldZ(wC[0], wC[2]) },
            { p: D, f: worldZ(wD[0], wD[2]) },
          ];
          for (const lv of wlLevels) {
            const s = march(corn, lv);
            if (s) fam.push(s);
          }
        } else {
          if (showStation(i) && i !== 0) fam.push([A, B]); // transom drawn bold
          if (i === NS - 1 && showStation(NS)) fam.push([D, C]);
        }
        const dc = [
          { p: A, f: worldZ(wA[0], wA[2]) },
          { p: B, f: worldZ(wB[0], wB[2]) },
          { p: C, f: worldZ(wC[0], wC[2]) },
          { p: D, f: worldZ(wD[0], wD[2]) },
        ];
        const dwl = march(dc, -state.waterline);
        quads.push({
          poly: [A, B, C, D],
          depth: (A.d + B.d + C.d + D.d) / 4,
          bold,
          fam,
          wl: dwl ? [dwl] : [],
        });
      }
  // selected template point → its longitudinal, interleaved into the painter's order so it occludes properly
  type Item = { depth: number; q?: (typeof quads)[number]; seg?: [P2, P2] };
  const items: Item[] = quads.map((q) => ({ depth: q.depth, q }));
  if (sel >= 0 && sel < state.templates[0].length) {
    const c1 = Math.cos(yaw),
      s1 = Math.sin(yaw),
      c2 = Math.cos(pitch),
      s2 = Math.sin(pitch);
    const cT = Math.cos(state.deckRake),
      sT = Math.sin(state.deckRake);
    let vx = -c2 * s1 * cT + s2 * sT,
      vy = -c2 * c1,
      vz = c2 * s1 * sT + s2 * cT;
    const vl = Math.hypot(vx, vy, vz) || 1,
      BIAS = 60;
    vx /= vl;
    vy /= vl;
    vz /= vl;
    const tpl = state.templates,
      NP = 120,
      WP: Vec3[] = [],
      keep: boolean[] = [];
    for (let i = 0; i <= NP; i++) {
      const x = (L * i) / NP,
        wt = weightsAt(x);
      let n = 0,
        d = 0;
      for (let t = 0; t < tpl.length; t++) {
        n += wt[t] * tpl[t][sel].n;
        d += wt[t] * tpl[t][sel].d;
      }
      const fr = frameAt(x),
        w: Vec3 = [
          fr.p[0] + n * fr.n[0] + d * fr.d[0],
          fr.p[1] + n * fr.n[1] + d * fr.d[1],
          fr.p[2] + n * fr.n[2] + d * fr.d[2],
        ];
      WP.push(w);
      keep.push(d >= -state.sheer.zf(x) && w[1] >= 0 && w[0] >= xTransom(w[2]));
    }
    for (const sgn of [1, -1])
      for (let i = 0; i < NP; i++) {
        if (!keep[i] || !keep[i + 1]) continue;
        const a = P([
          WP[i][0] + vx * BIAS,
          sgn * WP[i][1] + vy * BIAS,
          WP[i][2] + vz * BIAS,
        ]);
        const b = P([
          WP[i + 1][0] + vx * BIAS,
          sgn * WP[i + 1][1] + vy * BIAS,
          WP[i + 1][2] + vz * BIAS,
        ]);
        items.push({ depth: (a.d + b.d) / 2, seg: [a, b] });
      }
  }
  items.sort((a, b) => a.depth - b.depth);
  const sw = (maxX - minX) / 1000;
  const ln = (a: P2, b: P2, w: number, c: string) =>
    `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${c}" stroke-width="${w * sw}"/>`;
  let body = "";
  for (const it of items) {
    if (it.seg) {
      body += ln(it.seg[0], it.seg[1], 1.8, "#f59e0b");
      continue;
    }
    const q = it.q!;
    body += `<polygon points="${q.poly.map((p) => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ")}" fill="#fff" stroke="#fff" stroke-width="${0.6 * sw}"/>`;
    for (const [a, b] of q.wl) body += ln(a, b, 1.4, "#0ea5e9");
    for (const [a, b] of q.fam) body += ln(a, b, 1.0, "#11181f");
    for (const [a, b] of q.bold) body += ln(a, b, 1.8, "#11181f");
  }
  return svgWrap(
    body,
    minX,
    minY,
    maxX - minX,
    maxY - minY,
    (maxX - minX) * 0.06,
    "#ebeef2",
  );
}

// ---- shaded: full-width rows (like render.ts bilgeRows) flat-Lambert shaded, to spot puckers/creases ----
function renderShaded(
  P: (p: Vec3) => P2,
  yaw = 0,
  pitch = 0,
  zebra = false,
): string {
  const Mh = 44,
    N = 200,
    xf = forwardLimit();
  const rows: Vec3[][] = [];
  for (let i = 0; i <= N; i++) {
    const x = xf * 0.5 * (1 - Math.cos((Math.PI * i) / N)); // cosine spacing, matches the real mesh
    const s = sweptSection(x, Mh, true, false);
    if (s.aft) continue;
    const full = s.pts.slice();
    for (let j = Mh - 1; j >= 0; j--)
      full.push([s.pts[j][0], -s.pts[j][1], s.pts[j][2]]);
    rows.push(full);
  }
  const Lt = [0.4, -0.5, 0.76],
    nl = Math.hypot(Lt[0], Lt[1], Lt[2]);
  // view direction (toward eye) in world, for the zebra reflection bands
  const c1 = Math.cos(yaw),
    s1 = Math.sin(yaw),
    c2 = Math.cos(pitch),
    s2 = Math.sin(pitch),
    cT = Math.cos(state.deckRake),
    sT = Math.sin(state.deckRake);
  let Vx = -c2 * s1 * cT + s2 * sT,
    Vy = -c2 * c1,
    Vz = c2 * s1 * sT + s2 * cT;
  const Vl = Math.hypot(Vx, Vy, Vz) || 1;
  Vx /= Vl;
  Vy /= Vl;
  Vz /= Vl;
  const R = rows.length,
    C = rows[0].length;
  let minX = 1e9,
    minY = 1e9,
    maxX = -1e9,
    maxY = -1e9;
  const quads: { P: P2[]; depth: number; col: string }[] = [];
  for (let i = 0; i < R - 1; i++)
    for (let j = 0; j < C - 1; j++) {
      const A = rows[i][j],
        B = rows[i + 1][j],
        Cc = rows[i + 1][j + 1],
        D = rows[i][j + 1];
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]],
        e2 = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const ln = Math.hypot(n[0], n[1], n[2]) || 1;
      let col: string;
      if (zebra) {
        const Nx = n[0] / ln,
          Ny = n[1] / ln,
          Nz = n[2] / ln,
          vn = Vx * Nx + Vy * Ny + Vz * Nz;
        const Rz = -Vz + 2 * vn * Nz,
          Ry = -Vy + 2 * vn * Ny; // reflect(-V, N), y/z components
        const s = Math.sin(Math.atan2(Rz, Ry) * 8) > 0 ? 1 : 0;
        col = s ? "rgb(247,250,255)" : "rgb(18,23,38)";
      } else {
        const dot = Math.abs(
          (n[0] * Lt[0] + n[1] * Lt[1] + n[2] * Lt[2]) / (ln * nl),
        );
        const sh = Math.round(
          60 + 170 * Math.max(0, Math.min(1, 0.35 + 0.65 * dot)),
        );
        col = `rgb(${Math.round(sh * 0.55)},${Math.round(sh * 0.7)},${sh})`;
      }
      const pr = [A, B, Cc, D].map(P);
      for (const p of pr) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      quads.push({
        P: pr,
        depth: (pr[0].d + pr[1].d + pr[2].d + pr[3].d) / 4,
        col,
      });
    }
  quads.sort((a, b) => a.depth - b.depth);
  let body = "";
  for (const q of quads)
    body += `<polygon points="${q.P.map((p) => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ")}" fill="${q.col}"/>`;
  return svgWrap(
    body,
    minX,
    minY,
    maxX - minX,
    maxY - minY,
    (maxX - minX) * 0.06,
  );
}

// ---- stepnet: parse the exported STEP and draw its NURBS control net (STEP vs lines comparison) ----
function renderStepNet(P: (p: Vec3) => P2): string {
  const step = buildStep("2026-01-01T00:00:00");
  const pts: Record<string, Vec3> = {};
  const pre =
    /#(\d+)=CARTESIAN_POINT\('',\(([-\d.eE]+),([-\d.eE]+),([-\d.eE]+)\)\)/g;
  let m: RegExpExecArray | null;
  while ((m = pre.exec(step))) pts[m[1]] = [+m[2], +m[3], +m[4]];
  const si = step.indexOf("B_SPLINE_SURFACE_WITH_KNOTS");
  const gs = step.indexOf("((", si);
  let depth = 0,
    e = gs;
  for (; e < step.length; e++) {
    if (step[e] === "(") depth++;
    else if (step[e] === ")") {
      depth--;
      if (depth === 0) {
        e++;
        break;
      }
    }
  }
  const rows = step
    .slice(gs, e)
    .slice(1, -1)
    .split(/\),\(/)
    .map((r) =>
      r
        .replace(/[()]/g, "")
        .split(",")
        .map((s) => s.trim().replace("#", "")),
    );
  const grid = rows.map((r) => r.map((id) => pts[id]).filter(Boolean));
  let minX = 1e9,
    minY = 1e9,
    maxX = -1e9,
    maxY = -1e9;
  const polys: string[] = [];
  const add = (line: Vec3[]) => {
    const pr = line.map(P);
    for (const p of pr) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    polys.push(
      "M" + pr.map((p) => p.x.toFixed(1) + " " + p.y.toFixed(1)).join("L"),
    );
  };
  for (const r of grid) add(r);
  for (let j = 0; j < grid[0].length; j++) add(grid.map((r) => r[j]));
  const sw = (maxX - minX) / 1000;
  const body = polys
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="#2b6cb0" stroke-width="${1.2 * sw}"/>`,
    )
    .join("");
  return svgWrap(
    body,
    minX,
    minY,
    maxX - minX,
    maxY - minY,
    (maxX - minX) * 0.06,
  );
}

// ---- main ----
const mode = process.argv[2] ?? "lines";
const a2 = process.argv[3] ?? "3q";
let yaw: number, pitch: number, outArg: string | undefined;
if (a2 in PRESETS) {
  [yaw, pitch] = PRESETS[a2];
  outArg = process.argv[4];
} else {
  yaw = parseFloat(a2);
  pitch = parseFloat(process.argv[4] ?? "0.38");
  outArg = process.argv[5];
}
const out = outArg ?? `out/${mode}-${a2}.png`;

resetModel();
// CAMBER_DOC=<path> loads a specific HullDocument JSON instead of the default boat; CAMBER_KEELK overrides
// the keel knuckle on every template (handy for A/B-ing the keel-flat-vs-V pucker).
if (process.env.CAMBER_DOC)
  loadJsonText(readFileSync(process.env.CAMBER_DOC, "utf8"));
if (process.env.CAMBER_KEELK)
  state.keelK = state.keelK.map(() => parseFloat(process.env.CAMBER_KEELK!));
prepare();
const P = projector(yaw, pitch);
const sel = process.env.CAMBER_SEL ? parseInt(process.env.CAMBER_SEL, 10) : -1; // template point index to highlight
// lines family: pass mode "body"|"buttocks"|"waterline" directly, or use mode "lines" + CAMBER_LINES env
const linesKind = ["body", "buttocks", "waterline"].includes(mode)
  ? mode
  : (process.env.CAMBER_LINES ?? "body");
const svg =
  mode === "shaded"
    ? renderShaded(P, yaw, pitch, false)
    : mode === "zebra"
      ? renderShaded(P, yaw, pitch, true)
      : mode === "stepnet"
        ? renderStepNet(P)
        : renderLines(P, yaw, pitch, sel, linesKind);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out.replace(/\.png$/, ".svg"), svg);
writeFileSync(
  out,
  new Resvg(svg, { fitTo: { mode: "width", value: 1000 } }).render().asPng(),
);
console.log(
  `wrote ${out}  (mode=${mode}, yaw=${yaw.toFixed(3)}, pitch=${pitch.toFixed(3)}, L=${L})`,
);
