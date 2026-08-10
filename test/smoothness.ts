// Keel-smoothness regression test.
//
// The keel/stem/rocker is emergent: it is the locus of points where the swept sections reach the
// centerline. If that locus STEPS — the section's near-keel deadrise jumping from one station to the next —
// it reads as creases running across the hull up the stem. Version 1 could produce exactly that, because its
// keel knuckle reshaped the section near the centerline and re-snapped as the kept knot set changed.
//
// Version 2 builds the keel differently: the section is a plain centripetal Catmull-Rom and the keel is
// simply where it crosses y = 0, with no reshaping at all (mesh.ts deliberately does not read `keelK` yet —
// honouring it means DEFORMING the section near the centerline, which lands separately). So the specific
// mechanism this test was written against is gone; the PROPERTY it guards is not. The keel still has to come
// out smooth, and it now rests on the loft and the trim convergence instead — which is worth a regression
// test of its own, and is what this is.
//
// It sweeps the bow half of every example hull (plus the built-in default), measures the keel deadrise angle
// station to station, and fails if it ever jumps by more than THRESHOLD_DEG between adjacent stations.
//
// The deadrise is read from the section's EXACT tangent at its converged centerline crossing. Version 1
// least-squares-fitted a band of sampled points near the keel, because it had no better handle on the
// crossing; that measurement quantises — points enter and leave the band as the station moves, and each
// entry jolts the fitted slope by a degree or two, which is indistinguishable from the stepping the test is
// looking for. (On flat-bottom-fade that noise alone reads as a ~2° "jump" that halves as the sampling
// refines.) v2 converges the crossing by bisection and the section carries its own derivative, so the angle
// can just be evaluated.
//
// ONE JUMP IS REAL AND EXPECTED: where the keel crossing slides across a KNUCKLED station point, the
// section's tangent breaks there by construction — that is what a chine IS — so the deadrise at the crossing
// steps as the chine runs into the keel. On the default hull the crossing passes knot 2 at u ≈ 0.896, where
// the bilge chine (k = 1 aft, fading to 0 forward) still carries k ≈ 0.1, and the angle jumps ~2°; on
// flat-bottom-fade, ~8°. That is the hull's own crease, not a defect, so those samples are skipped — v1's
// band fit simply averaged the crease away and never saw it. Everything either side of the crossing stays
// under test.
//
// Run with `npm run test:smooth` (tsx runs this directly under node). Exit code is
// non-zero on any failure so it can gate CI.

import { frameAt, sectionAt, stationWorld } from "../src/core/model";
import { keptSpan } from "../src/core/mesh";
import { parseHullState } from "../src/core/json";
import { assemble } from "../src/core/runtime";
import { defaultHull } from "../src/core/hull";
import { examplesDir } from "./paths";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

let model = assemble(defaultHull());

// the largest jump in keel deadrise (degrees) between adjacent stations we accept as "smooth". A fair keel
// lands well under 1°; the old stepped construction spiked above 20°. Deadrise is an ANGLE — scale-invariant
// — so this needs no unit scaling, which is what lets one threshold cover the 1000-long examples and the
// 5000-long default alike.
const THRESHOLD_DEG = 1.5;
const DU = 0.001; // station spacing in the plan's own parameter — fine enough to resolve a step as one jump
const CHINE_K = 0.02; // a lofted knuckle at or above this is a real crease: its tangent break is not a defect

// The keel of the section at u: the body-plan angle from horizontal (atan|dz/dy|) of the section's tangent
// where it crosses the centerline, plus which curve segment that crossing is in. Null where this column has
// no keel — the section was cut by the transom or ran out before reaching y = 0.
function keelAt(u: number): { deg: number; seg: number; k: number } | null {
  const fr = frameAt(model, u),
    sec = sectionAt(model, u),
    span = keptSpan(model, fr, sec);
  if (!span) return null;
  const v = span[1],
    [n, z] = sec.at(v);
  if (Math.abs(stationWorld(fr, n, z)[1]) > 1e-6) return null; // not the centerline
  const [dn, dz] = sec.d(v),
    dy = dn * fr.n[1], // the tangent's transverse component: n̂ swings as the plan turns
    deg =
      Math.abs(dy) < 1e-12
        ? 90
        : (Math.atan(Math.abs(dz / dy)) * 180) / Math.PI;
  // the knot the crossing is nearest, and how creased that knot is: crossing a creased knot breaks the
  // tangent by design
  const knot = Math.round(v);
  return { deg, seg: Math.floor(v), k: sec.ks[knot] ?? 0 };
}

// worst adjacent-station deadrise jump over the bow half (u 0.55 → 0.99), and where it is. A step taken
// while the crossing moves between segments THROUGH a creased knot is the chine, not a defect (see above).
function worstStep(): { jump: number; u: number } {
  let jump = 0,
    at = 0;
  let prev: { deg: number; seg: number; k: number } | null = null;
  for (let u = 0.55; u <= 0.99; u += DU) {
    const cur = keelAt(u);
    if (prev && cur) {
      const crossedCrease =
        cur.seg !== prev.seg && Math.max(cur.k, prev.k) >= CHINE_K;
      const j = Math.abs(cur.deg - prev.deg);
      if (!crossedCrease && j > jump) {
        jump = j;
        at = u;
      }
    }
    prev = cur;
  }
  return { jump, u: at };
}

// load a named case into the live model; "default" is the built-in reset model
function loadCase(name: string): void {
  model = assemble(
    name === "default"
      ? defaultHull()
      : parseHullState(readFileSync(join(examplesDir(), name), "utf8")),
  );
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
    loadCase(name);
    const { jump, u } = worstStep();
    const bad = jump > THRESHOLD_DEG;
    if (bad) failures++;
    console.log(
      `  ${bad ? "FAIL" : "ok  "}  ${name.padEnd(42)} ${jump.toFixed(2)}° @ u=${u.toFixed(3)}${bad ? " ✗" : ""}`,
    );
  }
  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${cases.length - failures}/${cases.length} cases smooth`,
  );
  return failures === 0 ? 0 : 1;
}

process.exit(main());
