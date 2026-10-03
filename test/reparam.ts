// The ratio coordinates of `src/core/reparam.ts`: a change of variables for sampling.
//
//   - round trip: encoding a hull and decoding the result reproduces it to float precision — on the default
//     hull and on every example, including the flat-bottomed ones (level panels) and a three-station one;
//     and re-encoding the decoded hull gives the same θ (the map is a bijection on its range).
//   - validity: every finite θ decodes to a hull that passes the document invariants, even far from the
//     prior's centre.
//   - the prior lands on boats: θ = 0 floats, dry and closed, with sane proportions; at half temperature
//     almost every draw does, and at full temperature most do. Seeded, so the rates are exact numbers.
//
// Run with `npm run test:reparam`.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { defaultHull, loa, type HullState } from "../src/core/hull";
import { parseHullState } from "../src/core/json";
import { hullViolations } from "../src/core/invariants";
import { createHullCodec, sampleTheta } from "../src/core/reparam";
import { seededRandom } from "../src/core/sheet/generateTrials";
import { score, summarize } from "../tools/hullSampleMetrics";
import { examplesDir } from "./paths";

let fails = 0;
const ok = (c: boolean, m: string): void => {
  if (!c) {
    console.log("FAIL: " + m);
    fails++;
  } else console.log("  ok: " + m);
};

const flat = (h: HullState): number[] => [
  ...h.sheerPlan.flatMap((p) => [p.x, p.y]),
  ...h.sheerTrim.flatMap((p) => [p.x, p.z, p.k]),
  ...h.transom.flatMap((p) => [p.x, p.z]),
  ...h.stations.flatMap((s) => [
    s.u,
    s.keelK,
    ...s.points.flatMap((p) => [p.n, p.z, p.k]),
  ]),
  h.waterline,
  h.deckTrim,
];

// ---- round trip ----
const hulls: { name: string; hull: HullState }[] = [
  { name: "default", hull: defaultHull() },
];
for (const f of readdirSync(examplesDir()).filter((f) => f.endsWith(".json"))) {
  const h = parseHullState(readFileSync(join(examplesDir(), f), "utf8"));
  // the v1 examples carry no waterline; give them one inside the hull so the slot round-trips exactly
  hulls.push({ name: f, hull: { ...h, waterline: 0.15 * loa(h) } });
}
for (const { name, hull } of hulls) {
  const c = createHullCodec(hull);
  const th = c.encode(hull),
    back = c.decode(th),
    a = flat(hull),
    b = flat(back);
  const tol = 1e-5 * loa(hull);
  const worst = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  ok(
    worst < tol,
    `${name}: decode(encode(h)) reproduces h (worst |Δ| ${worst.toExponential(1)})`,
  );
  const th2 = c.encode(back);
  const dth = Math.max(...th.map((v, i) => Math.abs(v - th2[i])));
  ok(
    dth < 1e-6,
    `${name}: encode(decode(θ)) = θ (worst |Δ| ${dth.toExponential(1)})`,
  );
  ok(
    th.length === c.dim && th.every((v) => isFinite(v)),
    `${name}: θ has ${c.dim} finite coordinates`,
  );
}

// ---- validity far from the centre ----
{
  const c = createHullCodec(defaultHull()),
    rng = seededRandom(99);
  let bad = 0;
  for (let i = 0; i < 300; i++) {
    const h = c.decode(sampleTheta(c.dim, rng, 3));
    if (hullViolations(h, "document").length) bad++;
  }
  ok(
    bad === 0,
    `300 draws at temperature 3 all pass the document invariants (${bad} failed)`,
  );
}

// ---- the prior lands on boats ----
{
  const c = createHullCodec(defaultHull());
  const zero = score(c.decode([]));
  ok(
    zero.boat,
    `θ = 0 is a boat (L/B ${zero.lb.toFixed(1)}, B/T ${zero.bt.toFixed(1)}, Cb ${zero.cb.toFixed(2)})`,
  );
  const rate = (T: number, n: number): number => {
    const rng = seededRandom(7),
      cards = [];
    for (let i = 0; i < n; i++) {
      const th = sampleTheta(c.dim, rng, T);
      th[0] = 0;
      cards.push(score(c.decode(th)));
    }
    return summarize(cards).boat;
  };
  const r05 = rate(0.5, 60),
    r1 = rate(1, 60);
  ok(
    r05 >= 0.9,
    `temperature 0.5: ${(100 * r05).toFixed(0)}% of draws are boats (≥ 90%)`,
  );
  ok(
    r1 >= 0.65,
    `temperature 1: ${(100 * r1).toFixed(0)}% of draws are boats (≥ 65%)`,
  );
}

if (fails) {
  console.log(`${fails} failure(s)`);
  process.exit(1);
}
console.log("reparam: all passed");
