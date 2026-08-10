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
  loa,
  worldZ,
  keepAt,
  frameAt,
  stationWorld,
} from "../../src/core/model";
import { hullGrid, trimmedHullGrid } from "../../src/core/mesh";
import { buildStep } from "../../src/core/step";
import { parseHullState } from "../../src/core/json";
import { assemble } from "../../src/core/runtime";
import { defaultHull } from "../../src/core/hull";
import { type Vec3 } from "../../src/core/math";

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
  const cT = Math.cos(model.deckRake),
    sT = Math.sin(model.deckRake);
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

// Wrap an SVG body in a viewBox fitted to the drawn bounds, rasterized `OUT_W` px wide.
//
// The height is stated explicitly, from the viewBox's own aspect. Given a width but no height, resvg takes
// the canvas height from the viewBox's height in USER UNITS and then letterboxes the content into it — which
// was a mild cosmetic quirk while coordinates were unitless against L = 1000, and is a wild one now that they
// are absolute (a 5 m hull in mm gave a 1000×2678 canvas with the boat in a band across the middle).
const OUT_W = 1000;
function svgWrap(
  body: string,
  minX: number,
  minY: number,
  w: number,
  h: number,
  pad: number,
  bg = "#fff",
): string {
  const W = w + 2 * pad,
    H = h + 2 * pad,
    outH = Math.max(1, Math.round((OUT_W * H) / (W || 1)));
  const vb = `${minX - pad} ${minY - pad} ${W} ${H}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${outH}" viewBox="${vb}"><rect x="${minX - pad}" y="${minY - pad}" width="${W}" height="${H}" fill="${bg}"/>${body}</svg>`;
}

// ---- lines: painter's white facets + bold feature edges (replicates the editor Lines view) ----
function renderLines(
  P: (p: Vec3) => P2,
  yaw: number,
  pitch: number,
  sel: number,
  kind: string,
): string {
  // R = 3 sub-steps per section segment: few, widely spaced longitudinals, as a lines plan wants. The rows
  // come back FULL WIDTH (starboard sheer 0 → keel → port sheer NC), so unlike v1 there is no half to mirror.
  const { grid, creaseCols, keel } = trimmedHullGrid(model, 80, 3);
  const NS = grid.length - 1,
    NC = (grid[0]?.length ?? 0) - 1,
    KEEL = NC >> 1,
    crease = new Set(creaseCols);
  // the bold longitudinals: both sheers, the keel (which carries no crease of its own — the mesh leaves it
  // smooth — but is still the hull's profile), and every chine
  const feature = (j: number): boolean =>
    j === 0 || j === NC || j === KEEL || crease.has(j);
  const SP = grid.map((r) => r.map(P));
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
      const wz = worldZ(model, p[0], p[2]);
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
  for (let i = 0; i < NS; i++)
    for (let j = 0; j < NC; j++) {
      // where the section is open there is no surface across the centerline — don't bridge the gap
      if (j === KEEL && (!keel[i] || !keel[i + 1])) continue;
      {
        const A = SP[i][j],
          B = SP[i][j + 1],
          C = SP[i + 1][j + 1],
          D = SP[i + 1][j];
        for (const p of [A, B, C, D]) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
        }
        const wA = grid[i][j],
          wB = grid[i][j + 1],
          wC = grid[i + 1][j + 1],
          wD = grid[i + 1][j];
        const bold: [P2, P2][] = [];
        if (feature(j)) bold.push([D, A]);
        if (feature(j + 1)) bold.push([B, C]);
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
            { p: A, f: worldZ(model, wA[0], wA[2]) },
            { p: B, f: worldZ(model, wB[0], wB[2]) },
            { p: C, f: worldZ(model, wC[0], wC[2]) },
            { p: D, f: worldZ(model, wD[0], wD[2]) },
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
          { p: A, f: worldZ(model, wA[0], wA[2]) },
          { p: B, f: worldZ(model, wB[0], wB[2]) },
          { p: C, f: worldZ(model, wC[0], wC[2]) },
          { p: D, f: worldZ(model, wD[0], wD[2]) },
        ];
        const dwl = march(dc, -model.waterline);
        quads.push({
          poly: [A, B, C, D],
          depth: (A.d + B.d + C.d + D.d) / 4,
          bold,
          fam,
          wl: dwl ? [dwl] : [],
        });
      }
    }
  // the selected station point → its longitudinal, interleaved into the painter's order so it occludes properly
  type Item = { depth: number; q?: (typeof quads)[number]; seg?: [P2, P2] };
  const items: Item[] = quads.map((q) => ({ depth: q.depth, q }));
  if (sel >= 0 && sel < model.loft.S) {
    const c1 = Math.cos(yaw),
      s1 = Math.sin(yaw),
      c2 = Math.cos(pitch),
      s2 = Math.sin(pitch);
    const cT = Math.cos(model.deckRake),
      sT = Math.sin(model.deckRake);
    let vx = -c2 * s1 * cT + s2 * sT,
      vy = -c2 * c1,
      vz = c2 * s1 * sT + s2 * cT;
    const vl = Math.hypot(vx, vy, vz) || 1,
      BIAS = 0.06 * loa(model); // a world-space nudge toward the eye, in the hull's own length
    vx /= vl;
    vy /= vl;
    vz /= vl;
    // the locus of station point `sel` along the hull IS the loft of that point, trimmed exactly as the
    // hull is (keepAt is the same signed min of the three cuts the mesh uses)
    const NP = 120,
      WP: Vec3[] = [],
      keepP: boolean[] = [];
    for (let i = 0; i <= NP; i++) {
      const u = i / NP,
        fr = frameAt(model, u),
        nz = model.loft.at(u).pts[sel];
      WP.push(stationWorld(fr, nz[0], nz[1]));
      keepP.push(keepAt(model, fr, nz) >= 0);
    }
    for (const sgn of [1, -1])
      for (let i = 0; i < NP; i++) {
        if (!keepP[i] || !keepP[i + 1]) continue;
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
  // R = 11 sub-steps per section segment → 44 columns per half, as the app's mesh uses. hullGrid returns the
  // rows already trimmed and already full width (starboard sheer → keel → port sheer), so there is nothing
  // to mirror here — v1 swept an untrimmed half and mirrored it row by row.
  const rows = hullGrid(model, 200, 11, true).rows;
  const Lt = [0.4, -0.5, 0.76],
    nl = Math.hypot(Lt[0], Lt[1], Lt[2]);
  // view direction (toward eye) in world, for the zebra reflection bands
  const c1 = Math.cos(yaw),
    s1 = Math.sin(yaw),
    c2 = Math.cos(pitch),
    s2 = Math.sin(pitch),
    cT = Math.cos(model.deckRake),
    sT = Math.sin(model.deckRake);
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
  const step = buildStep(model, "2026-01-01T00:00:00");
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

// CAMBER_DOC=<path> loads a specific HullDocument JSON instead of the default boat; CAMBER_KEELK overrides
// the keel knuckle on every station.
//
// NOTE: CAMBER_KEELK currently changes NOTHING you can see here. `keelK` is parsed, stored, lofted and
// round-tripped, but the mesh deliberately does not read it yet — the keel gets no crease row, because
// honouring it means DEFORMING the section near the centerline (a hard V has to be built, not merely
// shaded), which lands as its own change. The override is kept wired so it is ready to A/B then.
const loaded = process.env.CAMBER_DOC
  ? parseHullState(readFileSync(process.env.CAMBER_DOC, "utf8"))
  : defaultHull();
const keelK = process.env.CAMBER_KEELK
  ? parseFloat(process.env.CAMBER_KEELK)
  : null;
const model = assemble(
  keelK === null
    ? loaded
    : {
        ...loaded,
        stations: loaded.stations.map((st) => ({ ...st, keelK })),
      },
);
const P = projector(yaw, pitch);
const sel = process.env.CAMBER_SEL ? parseInt(process.env.CAMBER_SEL, 10) : -1; // station point index to highlight
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
  `wrote ${out}  (mode=${mode}, yaw=${yaw.toFixed(3)}, pitch=${pitch.toFixed(3)}, loa=${loa(model)} ${model.unit})`,
);
