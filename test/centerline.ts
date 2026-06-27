// Centerline-fairness regression test.
//
// The hull's swept section planes are raked in plan (their transverse axis is perpendicular to the sheer
// tangent, not the boat centerline), so a section point's world-x grows with depth and the keel sits well
// forward of the sheer. Mirror symmetry then made the keel a forward x-cusp, and a TRUE transverse
// (constant-x) slice rode up over the centerline into a ridge — the visible "pucker", worst at a narrow,
// flared transom. sweptSection now un-rakes the keel zone so the keel crossing is transverse.
//
// This test rebuilds the rendered full-width surface (the same rows buildHullMesh uses), cuts a family of
// TRUE transverse sections through the keel-bearing length of every example hull (plus the default), and
// fails if the centerline ever rides ABOVE the surrounding keel — i.e. if the keel is a ridge rather than a
// smooth valley. A clean keel has the centerline as its deepest point (ridge <= 0); the old bug spiked to
// +8 mm at the stern. THRESHOLD_MM is a small margin above the residual discretisation noise.
//
// Run with `npm run test:centerline` (esbuild bundles to dist/ and runs under node). Non-zero exit on any
// failure so it can gate CI alongside the keel-smoothness test.

import { resetModel, prepare, L, sweptSection } from "../src/model.js";
import { parseDocument, loadHull } from "../src/json.js";
import { type Vec3 } from "../src/math.js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// the most the centerline may ride above the deepest keel point in a true transverse section before we call
// it a pucker. The fair construction lands at ~0 (the centerline IS the deepest point); the old mirror bug
// spiked to +8 mm at a narrow transom. 1.5 mm is wide of the discretisation noise but well under the bug.
const THRESHOLD_MM = 1.5;
const M = 44; // section columns per half — matches the 3D mesh (buildHullMesh)
const NS = 180; // station sweep resolution — matches the 3D mesh
const BAND_MM = 90; // half-breadth window around the centerline within which we judge the keel shape

function examplesDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 4; up++) {
    const cand = join(d, "examples");
    if (existsSync(cand)) return cand;
    d = dirname(d);
  }
  return join(process.cwd(), "examples");
}

// the rendered full-width surface grid: each row is starboard sheer -> keel -> port sheer (the keel an
// interior column at index M), exactly as buildHullMesh/bilgeRows sample it.
function fullRows(): Vec3[][] {
  const rows: Vec3[][] = [];
  for (let i = 0; i <= NS; i++) {
    const s = sweptSection((L * i) / NS, M, true, false);
    if (s.aft) continue;
    const full: Vec3[] = s.pts.slice();
    for (let j = M - 1; j >= 0; j--) full.push([s.pts[j][0], -s.pts[j][1], s.pts[j][2]]);
    rows.push(full);
  }
  return rows;
}

// the true transverse section at world-x = X0: walk each column's longitudinal polyline and read (y,z) where
// it crosses X0. Returns points sorted by y (port -> starboard), or null if the keel isn't reached cleanly.
function trueSection(rows: Vec3[][], X0: number): { y: number; z: number }[] | null {
  const C = rows[0].length,
    R = rows.length,
    pts: { y: number; z: number }[] = [];
  for (let j = 0; j < C; j++)
    for (let i = 0; i < R - 1; i++) {
      const a = rows[i][j],
        b = rows[i + 1][j];
      if ((a[0] - X0) * (b[0] - X0) <= 0 && a[0] !== b[0]) {
        const t = (X0 - a[0]) / (b[0] - a[0]);
        pts.push({ y: a[1] + t * (b[1] - a[1]), z: a[2] + t * (b[2] - a[2]) });
        break;
      }
    }
  return pts.length >= 3 ? pts.sort((p, q) => p.y - q.y) : null;
}

// worst centerline ridge (mm, positive = pucker) over the keel-bearing length, and where it is
function worstRidge(): { ridge: number; x: number } {
  const rows = fullRows();
  if (rows.length < 4) return { ridge: 0, x: 0 };
  const keelXs = rows.map((r) => r[M][0]);
  const x0 = Math.min(...keelXs),
    x1 = Math.max(...keelXs);
  let worst = -Infinity,
    at = 0;
  // sample inside the keel-bearing span, clear of the degenerate bow tip
  for (let X = x0 + 40; X <= x1 - 200; X += 25) {
    const sec = trueSection(rows, X);
    if (!sec) continue;
    const band = sec.filter((p) => Math.abs(p.y) <= BAND_MM);
    if (band.length < 3) continue;
    const zCenter = band.reduce((b, p) => (Math.abs(p.y) < Math.abs(b.y) ? p : b)).z;
    const zDeep = Math.min(...band.map((p) => p.z)); // most negative = deepest
    const ridge = zCenter - zDeep; // 0 if the centerline is the deepest point; > 0 if it rides up
    if (ridge > worst) {
      worst = ridge;
      at = X;
    }
  }
  return { ridge: worst === -Infinity ? 0 : worst, x: at };
}

function loadCase(name: string): void {
  resetModel();
  if (name !== "default") {
    const doc = parseDocument(readFileSync(join(examplesDir(), name), "utf8"));
    loadHull(doc.variants[0]);
  }
  prepare();
}

function main(): number {
  const cases = ["default", ...readdirSync(examplesDir()).filter((f) => f.endsWith(".json")).sort()];
  let failures = 0;
  console.log(`Centerline fairness — worst keel ridge in a true transverse section (threshold ${THRESHOLD_MM} mm)\n`);
  for (const name of cases) {
    loadCase(name);
    const { ridge, x } = worstRidge();
    const bad = ridge > THRESHOLD_MM;
    if (bad) failures++;
    console.log(`  ${bad ? "FAIL" : "ok  "}  ${name.padEnd(26)} ridge ${ridge.toFixed(2)} mm @ x=${Math.round(x)}${bad ? "  ✗" : ""}`);
  }
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${cases.length - failures}/${cases.length} cases fair`);
  return failures === 0 ? 0 : 1;
}

process.exit(main());
