// Keel-smoothness regression test.
//
// The keel/stem/rocker is emergent: it is the locus of points where the swept sections reach the
// centerline. A bug in how the keel knuckle reshapes those sections used to make that locus STEP — the
// section's near-keel deadrise jumped from one station to the next, which reads as creases running across
// the hull up the stem (the keel knuckle's flat-vs-V control re-snapping as the kept knot set changed).
//
// This test sweeps the bow half of every example hull (plus the built-in default), measures the keel
// deadrise angle station to station, and fails if it ever jumps by more than THRESHOLD_DEG between adjacent
// stations — i.e. if the swept keel is no longer smooth. It runs at keel knuckle 0 (flat), 0.5, and 1 (V),
// since the failure mode lives in the flattening path.
//
// Run with `npm run test:smooth` (tsx runs this directly under node). Exit code is
// non-zero on any failure so it can gate CI.

import { resetModel, prepare, state, L, sweptSection } from "../src/model";
import { parseDocument, loadHull } from "../src/json";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// the largest jump in keel deadrise (degrees) between adjacent stations we accept as "smooth". The fixed
// reflected-keel construction lands around 0.3–0.9°; the old stepped one spiked above 20°. 1.5° is a wide
// margin that still catches any return of the stepping.
const THRESHOLD_DEG = 1.5; // deadrise is an ANGLE — scale-invariant, unchanged by the unitless rescale
const DX = 1; // station spacing (units) for the sweep — fine enough to resolve a step as a single jump
const KEEL_KS = [0, 0.5, 1]; // keel-knuckle settings to exercise (flat → V)

// the example hulls live alongside the repo; resolve from this file so the cwd does not matter
function examplesDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 4; up++) {
    const cand = join(d, "examples");
    if (existsSync(cand)) return cand;
    d = dirname(d);
  }
  return join(process.cwd(), "examples");
}

// keel deadrise at station x: the body-plan angle from horizontal of the section near the keel, as the
// least-squares slope of the lowest 70 mm of the (half-breadth, depth) points. NaN where there is no keel
// (open section / above the trim).
function deadriseDeg(x: number): number {
  const s = sweptSection(x, 200, true);
  if (!s.keel) return NaN;
  const p = s.pts,
    keel = p[p.length - 1],
    band = p.filter((q) => q[2] <= keel[2] + 18);
  if (band.length < 3) return NaN;
  let n = 0,
    sy = 0,
    sz = 0,
    syz = 0,
    szz = 0;
  for (const q of band) {
    const y = Math.abs(q[1] - keel[1]),
      z = q[2] - keel[2];
    n++;
    sy += y;
    sz += z;
    syz += y * z;
    szz += z * z;
  }
  const denom = n * szz - sz * sz;
  if (Math.abs(denom) < 1e-9) return NaN;
  const slope = (n * syz - sy * sz) / denom; // d(half-breadth)/d(depth)
  return (Math.atan(1 / Math.abs(slope)) * 180) / Math.PI;
}

// worst adjacent-station deadrise jump over the bow half (0.55L → 0.99L), and where it is
function worstStep(): { jump: number; x: number } {
  let jump = 0,
    at = 0,
    prev = NaN;
  for (let x = 0.55 * L; x <= 0.99 * L; x += DX) {
    const d = deadriseDeg(x);
    if (!Number.isNaN(prev) && !Number.isNaN(d)) {
      const j = Math.abs(d - prev);
      if (j > jump) {
        jump = j;
        at = x;
      }
    }
    prev = d;
  }
  return { jump, x: at };
}

function setKeel(k: number): void {
  for (let i = 0; i < state.keelK.length; i++) state.keelK[i] = k;
  prepare();
}

// load a named case into the live model; "default" is the built-in reset model
function loadCase(name: string): void {
  resetModel();
  if (name !== "default") {
    const doc = parseDocument(readFileSync(join(examplesDir(), name), "utf8"));
    loadHull(doc.variants[0]);
  }
  prepare();
}

function main(): number {
  const cases = [
    "default",
    ...readdirSync(examplesDir())
      .filter((f) => f.endsWith(".json"))
      .sort(),
  ];
  let failures = 0;
  console.log(
    `Keel smoothness — worst adjacent-station deadrise jump (threshold ${THRESHOLD_DEG}°)\n`,
  );
  for (const name of cases) {
    const cells: string[] = [];
    let caseFailed = false;
    for (const k of KEEL_KS) {
      loadCase(name);
      setKeel(k);
      const { jump, x } = worstStep();
      const bad = jump > THRESHOLD_DEG;
      if (bad) caseFailed = true;
      cells.push(
        `k=${k}: ${jump.toFixed(2)}°@${Math.round(x)}${bad ? " ✗" : ""}`,
      );
    }
    if (caseFailed) failures++;
    console.log(
      `  ${caseFailed ? "FAIL" : "ok  "}  ${name.padEnd(26)} ${cells.join("   ")}`,
    );
  }
  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${cases.length - failures}/${cases.length} cases smooth`,
  );
  return failures === 0 ? 0 : 1;
}

process.exit(main());
