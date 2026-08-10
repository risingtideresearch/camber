// Centerline-fairness regression test.
//
// The hull's swept section planes are raked in plan (their transverse axis is perpendicular to the sheer
// tangent, not the boat centerline), so a section point's world-x grows with depth and the keel sits well
// forward of the sheer. Mirror symmetry then made the keel a forward x-cusp, and a TRUE transverse
// (constant-x) slice rode up over the centerline into a ridge — the visible "pucker", worst at a narrow,
// flared transom.
//
// Version 2 addresses that structurally rather than by un-raking the keel zone as v1 did: each mesh row is
// built FULL WIDTH as one curve (the starboard half plus its y-mirror, sharing the single keel point), so
// the keel is an interior column of one continuous surface and there is no mirror seam to fold. This test is
// the guard on that: it rebuilds the rendered surface (the same rows buildHullMesh draws), cuts a family of
// true transverse sections through the keel-bearing length of every example hull (plus the default and the
// fixtures), and fails if the centerline ever rides ABOVE the surrounding keel — i.e. if the keel is a ridge
// rather than a smooth valley.
//
// It also guards keel SHAPE within a station: scanning deck→keel the section depth should be non-decreasing
// (the keel is the deepest point). The station's control points are clamped monotone by the editor, but the
// curve THROUGH them is a Catmull-Rom and can overshoot into a bulge — REVERSAL caps how far the depth may
// dip below its running max on the way to the keel.
//
// THE TWO BARS ARE LOOSER THAN v1'S, DELIBERATELY. v1 faired a section with a knuckle-aware MONOTONE Hermite,
// which cannot overshoot at all, so its bars could sit just above zero. v2 fairs every section with a
// centripetal Catmull-Rom (the fairing toggle is gone by design), which overshoots slightly wherever a steep
// run meets a flat one — on flat-bottom-fade, whose lofted z-knots near the turn of the bilge go −209.7,
// −216.5, −224.9, the curve dips to −217.9 and comes back up: a 1.9 bulge (0.8% of that section's depth)
// where a monotone interpolant through the SAME knots gives exactly 0. That is the accepted, documented
// consequence of the Catmull-Rom decision — the curve still passes through every authored point — so the bars
// below now bound the Catmull-Rom's INHERENT overshoot rather than v1's keel-round construction bug (which
// this version does not have: there is no keel-round parabola any more). They are still well under the bugs
// they were first written for: a ridge of 8 and a reversal of several, at this scale.
//
// Run with `npm run test:centerline` (tsx runs this directly under node). Non-zero exit on any
// failure so it can gate CI alongside the keel-smoothness test.

import {
  createModel,
  resetModel,
  refreshDerived,
  loa,
  sectionAt,
} from "../src/core/model";
import { hullGrid } from "../src/core/mesh";
import { parseDocument, loadHull } from "../src/core/json";
import { type Vec3 } from "../src/core/math";
import { examplesDir } from "./paths";
import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join } from "path";

const model = createModel();

// The tolerances below are stated at the scale the example hulls are drawn to (v1 documents of length 1000,
// whose numbers carry across as millimetres). The built-in default hull is 5000, so every LENGTH-dimensioned
// bar is mapped onto the live hull; the curvature INDEX goes the other way (a second derivative scales as
// 1/length), and angles need no mapping at all.
const S1 = (v: number): number => (v * loa(model)) / 1000;
const S1inv = (v: number): number => (v * 1000) / loa(model);

// The most the centerline may ride above the deepest keel point in a true transverse section before we call
// it a pucker. Every hull here lands at ~0 (the centerline IS the deepest point) except flat-bottom-fade,
// whose section bulge (see the header) lifts it to 0.55; the old mirror bug spiked to +8 at a narrow transom.
const THRESHOLD = 1.0;
// The most the section depth may dip below its running max while scanning deck→keel (a keel inflection /
// bulge). Every hull here is at 0 except flat-bottom-fade, where the Catmull-Rom's inherent overshoot on its
// near-flat bottom reaches 1.89; the v1 flat-bottom-inflection bug reached several.
const REVERSAL = 3.0;
// max near-keel longitudinal buttock curvature index (|d²z/dx²|·1e3) over the mid-body. A transverse ridge
// can be 0 yet the keel still wrinkle ALONG the hull — e.g. the keel-rounding anchor stepping as the keel
// crossing slides past a chine (the "keel-at-chine" fixture spiked to ~88 here before the chine-proximity
// fade fix; clean hulls sit under ~6).
const KEEL_BUTTOCK_MAX = 40; // a curvature index: scaled INVERSELY with the hull's length
const BUTTOCK_YS = [15, 30, 45]; // half-breadths near the keel at which to judge longitudinal fairness
const R = 11; // sub-steps per section segment → 44 columns per half on a 5-point section, as the 3D mesh uses
const NS = 180; // station sweep resolution — matches the 3D mesh
const BAND = 23; // half-breadth window around the centerline within which we judge the keel shape

// torture-test hulls kept out of examples/ (they may not meet every fairness bar everywhere) but exercised
// here as regression fixtures — e.g. keel-at-chine, which guards the keel-rounding chine-fade fix.
function fixturesDir(): string {
  return join(dirname(examplesDir()), "test", "fixtures");
}

// The rendered surface grid: each row is starboard sheer → keel → port sheer (the keel an interior column),
// exactly as buildHullMesh samples it. Returns the rows, the keel's column index, and which rows actually
// REACH the keel.
//
// That last flag matters here. v2 trims every column against all three cuts at once, so near the stern a
// column's bottom is the TRANSOM, not the centerline — the keel column is the transom edge there, and the
// keel line meets it at a genuine corner. (v1's equivalent grid was swept WITHOUT the transom cut and clipped
// afterwards, so its keel column was the real keel for its whole length and no corner appeared.) Judging keel
// fairness across that corner would be measuring the transom, so the callers below stay inside the run of
// rows that reach the centerline.
function fullRows(): { rows: Vec3[][]; keelCol: number; keel: boolean[] } {
  const g = hullGrid(model, NS, R, true);
  return { rows: g.rows, keelCol: g.M, keel: g.keel };
}

// the x-range over which the keel is a real keel (the centerline), not the transom edge
function keelSpan(
  rows: Vec3[][],
  keelCol: number,
  keel: boolean[],
): { lo: number; hi: number } | null {
  const xs = rows.filter((_, i) => keel[i]).map((r) => r[keelCol][0]);
  return xs.length < 4 ? null : { lo: Math.min(...xs), hi: Math.max(...xs) };
}

// the true transverse section at world-x = X0: walk each column's longitudinal polyline and read (y,z) where
// it crosses X0. Returns points sorted by y (port -> starboard), or null if the keel isn't reached cleanly.
function trueSection(
  rows: Vec3[][],
  X0: number,
): { y: number; z: number }[] | null {
  const C = rows[0].length,
    R2 = rows.length,
    pts: { y: number; z: number }[] = [];
  for (let j = 0; j < C; j++)
    for (let i = 0; i < R2 - 1; i++) {
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

// worst centerline ridge (positive = pucker) over the keel-bearing length, and where it is
function worstRidge(): { ridge: number; x: number } {
  const { rows, keelCol, keel } = fullRows();
  if (rows.length < 4) return { ridge: 0, x: 0 };
  const span = keelSpan(rows, keelCol, keel);
  if (!span) return { ridge: 0, x: 0 };
  const x0 = span.lo,
    x1 = span.hi;
  let worst = -Infinity,
    at = 0;
  // sample inside the keel-bearing span, clear of the degenerate bow tip
  for (let X = x0 + S1(10); X <= x1 - S1(50); X += S1(6)) {
    const sec = trueSection(rows, X);
    if (!sec) continue;
    const band = sec.filter((p) => Math.abs(p.y) <= S1(BAND));
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

// worst keel-shape reversal: scanning each station's section deck→keel, the depth must be non-decreasing
// (keel deepest). Returns the largest dip below the running max over the hull, and where.
function worstReversal(): { rev: number; u: number } {
  let worst = 0,
    at = 0;
  for (let u = 0.01; u <= 0.99; u += 0.002) {
    const sec = sectionAt(model, u);
    if (!sec.vmax) continue;
    const K = 80;
    let mx = -Infinity,
      dip = 0;
    for (let i = 0; i <= K; i++) {
      const d = -sec.at((sec.vmax * i) / K)[1]; // depth below the deck datum
      if (d > mx) mx = d;
      else dip = Math.max(dip, mx - d);
    }
    if (dip > worst) {
      worst = dip;
      at = u;
    }
  }
  return { rev: worst, u: at };
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
  const { rows, keelCol, keel } = fullRows();
  if (rows.length < 5) return { curv: 0, x: 0, y: 0 };
  const span = keelSpan(rows, keelCol, keel);
  if (!span) return { curv: 0, x: 0, y: 0 };
  const lo = span.lo,
    hi = span.hi;
  const x0 = lo + S1(38),
    x1 = hi - 0.3 * (hi - lo),
    dx = S1(6);
  const xs: number[] = [];
  for (let X = x0; X <= x1; X += dx) xs.push(X);
  let curv = 0,
    at = 0,
    aty = 0;
  for (const Y0 of BUTTOCK_YS) {
    const Y = S1(Y0);
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
  if (path) loadHull(model, parseDocument(readFileSync(path, "utf8")).hull);
  refreshDerived(model);
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
    `Centerline fairness — keel ridge in a true transverse section (≤${THRESHOLD}), keel-shape ` +
      `reversal deck→keel (≤${REVERSAL}), and near-keel longitudinal fairness (≤${KEEL_BUTTOCK_MAX})\n` +
      `  (all bars are at the 1000-length scale and mapped onto each hull)\n`,
  );
  for (const { name, path } of cases) {
    loadCase(path);
    const { ridge, x } = worstRidge();
    const { rev, u: ru } = worstReversal();
    const { curv, x: bx } = worstKeelButtock();
    const bad =
      ridge > S1(THRESHOLD) ||
      rev > S1(REVERSAL) ||
      curv > S1inv(KEEL_BUTTOCK_MAX);
    if (bad) failures++;
    console.log(
      `  ${bad ? "FAIL" : "ok  "}  ${name.padEnd(42)} ridge ${S1inv(ridge).toFixed(2)} @ x=${Math.round(x)}` +
        `   reversal ${S1inv(rev).toFixed(2)} @ u=${ru.toFixed(2)}   keel-fair ${S1(curv).toFixed(1)} @ x=${Math.round(bx)}${bad ? "  ✗" : ""}`,
    );
  }
  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${cases.length - failures}/${cases.length} cases fair`,
  );
  return failures === 0 ? 0 : 1;
}

process.exit(main());
