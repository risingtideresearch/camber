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
// It also guards keel SHAPE within a station: scanning sheer→keel the section depth must be non-decreasing
// (the keel is the deepest point). A flat bottom inboard of a chine once made the keel-round parabola bulge
// the bottom UP into an inflection — a depth reversal — so REVERSAL_MM caps how far the depth may dip below
// its running max on the way to the keel.
//
// Run with `npm run test:centerline` (tsx runs this directly under node). Non-zero exit on any
// failure so it can gate CI alongside the keel-smoothness test.

import {
  createModel,
  resetModel,
  prepare,
  L,
  sweptSection,
  stationAt,
} from "../src/core/model";
import { parseDocument, loadHull } from "../src/core/json";
import { type Vec3 } from "../src/core/math";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const model = createModel();

// the most the centerline may ride above the deepest keel point in a true transverse section before we call
// it a pucker. The fair construction lands at ~0 (the centerline IS the deepest point); the old mirror bug
// spiked to +8 mm at a narrow transom. 1.5 mm is wide of the discretisation noise but well under the bug.
const THRESHOLD_MM = 0.375; // (units; ÷4 of the old 1.5 mm under the unitless L=1000 rescale)
// the most the section depth may dip below its running max while scanning sheer→keel (a keel inflection /
// bulge). Clean keels land at ~0; the flat-bottom-inflection bug reached several mm. 1.0 mm is the cap.
const REVERSAL_MM = 0.25; // (units; ÷4 of the old 1.0 mm)
// max near-keel longitudinal buttock curvature index (|d²z/dx²|·1e3) over the mid-body. A transverse ridge
// can be 0 yet the keel still wrinkle ALONG the hull — e.g. the keel-rounding anchor stepping as the keel
// crossing slides past a chine (the "Keel Distortion" flat-bottom hull spiked to ~88 here before the
// chine-proximity fade fix; clean hulls sit under ~6).
const KEEL_BUTTOCK_MAX = 40; // curvature index = |d²z/dx²|·1e3 — scales ×4 under the ÷4 length rescale (was 10)
const BUTTOCK_YS = [15, 30, 45]; // half-breadths (units) near the keel at which to judge longitudinal fairness
const M = 44; // section columns per half — matches the 3D mesh (buildHullMesh)
const NS = 180; // station sweep resolution — matches the 3D mesh
const BAND_MM = 23; // half-breadth window (units) around the centerline within which we judge the keel shape

function examplesDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 4; up++) {
    const cand = join(d, "examples");
    if (existsSync(cand)) return cand;
    d = dirname(d);
  }
  return join(process.cwd(), "examples");
}
// torture-test hulls kept out of examples/ (they may not meet every fairness bar everywhere) but exercised
// here as regression fixtures — e.g. keel-at-chine, which guards the keel-rounding chine-fade fix.
function fixturesDir(): string {
  return join(dirname(examplesDir()), "test", "fixtures");
}

// the rendered full-width surface grid: each row is starboard sheer -> keel -> port sheer (the keel an
// interior column at index M), exactly as buildHullMesh/bilgeRows sample it.
function fullRows(): Vec3[][] {
  const rows: Vec3[][] = [];
  for (let i = 0; i <= NS; i++) {
    const s = sweptSection(model, (L * i) / NS, M, true, false);
    if (s.aft) continue;
    const full: Vec3[] = s.pts.slice();
    for (let j = M - 1; j >= 0; j--)
      full.push([s.pts[j][0], -s.pts[j][1], s.pts[j][2]]);
    rows.push(full);
  }
  return rows;
}

// the true transverse section at world-x = X0: walk each column's longitudinal polyline and read (y,z) where
// it crosses X0. Returns points sorted by y (port -> starboard), or null if the keel isn't reached cleanly.
function trueSection(
  rows: Vec3[][],
  X0: number,
): { y: number; z: number }[] | null {
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
  for (let X = x0 + 10; X <= x1 - 50; X += 6) {
    const sec = trueSection(rows, X);
    if (!sec) continue;
    const band = sec.filter((p) => Math.abs(p.y) <= BAND_MM);
    if (band.length < 3) continue;
    const zCenter = band.reduce((b, p) =>
      Math.abs(p.y) < Math.abs(b.y) ? p : b,
    ).z;
    const zDeep = Math.min(...band.map((p) => p.z)); // most negative = deepest
    const ridge = zCenter - zDeep; // 0 if the centerline is the deepest point; > 0 if it rides up
    if (ridge > worst) {
      worst = ridge;
      at = X;
    }
  }
  return { ridge: worst === -Infinity ? 0 : worst, x: at };
}

// worst keel-shape reversal: scanning each closed station's mirrored section sheer→keel, the depth must be
// non-decreasing (keel deepest). Returns the largest dip below the running max over the hull, and where.
function worstReversal(): { rev: number; x: number } {
  let worst = 0,
    at = 0;
  for (let x = 0.01 * L; x <= 0.99 * L; x += 2) {
    const st = stationAt(model, x, true);
    if (!st.tmax) continue;
    const us = st.tmax / 2,
      K = 80;
    let mx = -Infinity,
      dip = 0;
    for (let i = 0; i <= K; i++) {
      const d = st.d((us * i) / K);
      if (d > mx) mx = d;
      else dip = Math.max(dip, mx - d);
    }
    if (dip > worst) {
      worst = dip;
      at = x;
    }
  }
  return { rev: worst, x: at };
}

// z on the starboard side at half-breadth Y from a true transverse section, or NaN if the section is too
// narrow there (< ~1.4·Y) — that avoids the artificially high curvature where a buttock runs out into the
// keel toward the bow, which is geometry, not a defect.
function zAtHalfBreadth(sec: { y: number; z: number }[], Y: number): number {
  const half = sec.length ? sec[sec.length - 1].y : 0;
  if (half < Y * 1.4) return NaN;
  for (let i = 0; i < sec.length - 1; i++) {
    const a = sec[i],
      b = sec[i + 1];
    if ((a.y - Y) * (b.y - Y) <= 0 && a.y !== b.y)
      return a.z + ((Y - a.y) / (b.y - a.y)) * (b.z - a.z);
  }
  return NaN;
}

// worst near-keel buttock curvature along the hull over the mid-body (we drop the forward 30% of the keel
// length, where buttocks terminate into the keel and read artificially high). This catches a LONGITUDINAL
// keel wrinkle that the transverse ridge/reversal checks miss.
function worstKeelButtock(): { curv: number; x: number; y: number } {
  const rows = fullRows();
  if (rows.length < 5) return { curv: 0, x: 0, y: 0 };
  const keelXs = rows.map((r) => r[M][0]);
  const lo = Math.min(...keelXs),
    hi = Math.max(...keelXs);
  const x0 = lo + 38,
    x1 = hi - 0.3 * (hi - lo),
    dx = 6;
  const xs: number[] = [];
  for (let X = x0; X <= x1; X += dx) xs.push(X);
  let curv = 0,
    at = 0,
    aty = 0;
  for (const Y of BUTTOCK_YS) {
    const Z = xs.map((X) => {
      const s = trueSection(rows, X);
      return s ? zAtHalfBreadth(s, Y) : NaN;
    });
    for (let i = 1; i < xs.length - 1; i++) {
      if (!isFinite(Z[i - 1]) || !isFinite(Z[i]) || !isFinite(Z[i + 1]))
        continue;
      const c = (Math.abs(Z[i + 1] - 2 * Z[i] + Z[i - 1]) / (dx * dx)) * 1e3;
      if (c > curv) {
        curv = c;
        at = xs[i];
        aty = Y;
      }
    }
  }
  return { curv, x: at, y: aty };
}

function loadCase(path: string | null): void {
  resetModel(model);
  if (path)
    loadHull(
      model,
      parseDocument(model, readFileSync(path, "utf8")).variants[0],
    );
  prepare(model);
}

function listJson(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];
}

function main(): number {
  const cases: { name: string; path: string | null }[] = [
    { name: "default", path: null },
  ];
  for (const f of listJson(examplesDir()))
    cases.push({ name: f, path: join(examplesDir(), f) });
  for (const f of listJson(fixturesDir()))
    cases.push({ name: `${f} (fixture)`, path: join(fixturesDir(), f) });
  let failures = 0;
  console.log(
    `Centerline fairness — keel ridge in a true transverse section (≤${THRESHOLD_MM} mm), keel-shape ` +
      `reversal sheer→keel (≤${REVERSAL_MM} mm), and near-keel longitudinal fairness (≤${KEEL_BUTTOCK_MAX})\n`,
  );
  for (const { name, path } of cases) {
    loadCase(path);
    const { ridge, x } = worstRidge();
    const { rev, x: rx } = worstReversal();
    const { curv, x: bx } = worstKeelButtock();
    const bad =
      ridge > THRESHOLD_MM || rev > REVERSAL_MM || curv > KEEL_BUTTOCK_MAX;
    if (bad) failures++;
    console.log(
      `  ${bad ? "FAIL" : "ok  "}  ${name.padEnd(26)} ridge ${ridge.toFixed(2)} @ x=${Math.round(x)}` +
        `   reversal ${rev.toFixed(2)} @ x=${Math.round(rx)}   keel-fair ${curv.toFixed(1)} @ x=${Math.round(bx)}${bad ? "  ✗" : ""}`,
    );
  }
  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${cases.length - failures}/${cases.length} cases fair`,
  );
  return failures === 0 ? 0 : 1;
}

process.exit(main());
