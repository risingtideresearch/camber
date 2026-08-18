// Large-angle stability: the KN cross curves and the GZ curve at a stated ∇ and VCG.
//
// These check the properties the construction is supposed to guarantee, rather than fixed numbers, so they
// survive any retuning of the sampling:
//
//   - agreement: at zero heel and the design waterline this and hydro.ts report the same ∇ and KB. They now
//     share `sweep.ts`, so this is a wiring check rather than evidence about the integration itself — the
//     evidence for that is the 3D mesh comparison at the bottom.
//   - upright: KN = 0 at every displacement (buoyancy acts through K when the hull is upright).
//   - the table inverts: ∇ is strictly increasing along each heel's march, and interpolating KN back at a
//     volume the march actually produced returns that step's own KN.
//   - small angles: GZ → (KMt − VCG)·sin φ, the initial-stability result hydro.ts reports. Load-bearing: KMt
//     comes from the WATERPLANE integrals and KN from the VOLUME ones, so the two agreeing to 0.02% says
//     those two halves of `sweep.ts` describe the same hull.
//   - the VCG identity: two VCGs against the same displacement differ by exactly ΔVCG·sin φ, at no extra
//     flotation solve. That is the whole reason the table is built in KN rather than GZ.
//   - a raked hull: the same agreement holds with deckRake ≠ 0, which exercises the world-height path, and
//     so does a hull whose sheer plan turns three times as hard, which tilts the station planes hardest.
//   - symmetry: KN and GZ are odd in heel, which also pins the sign convention (+φ heels to starboard).
//   - the deck-immersion flag flips exactly where the lowest sheer point crosses the waterline, and ∇ stays
//     continuous through it.
//   - low displacement: the sparse end of the table still tracks directly computed cuts, and KN tends to the
//     limit it should (the heeled lowest point's offset from K — NOT zero, except upright).
//   - the area under GZ: the split into a hull term and a VCG term is the exact identity it claims, the
//     integral over the 5° table tracks a 0.25° one, and the closed-form inverse really inverts it.
//   - past 90°: the curve runs to a vanishing angle and closes at exactly 0 at 180°.
//   - a 3D mesh: ∇ and KN checked against the triangle mesh the STL exporter writes, integrated by the
//     divergence theorem — no shared integration code. This is the real oracle, and it is what caught the
//     fanning-Jacobian error that `sweep.ts` now corrects.
//
// Run with `npm run test:stability` (tsx runs this directly under node). Non-zero exit on any failure.
import { assemble } from "../src/core/runtime";
import { defaultHull, type HullState } from "../src/core/hull";
import { hydrostatics } from "../src/core/hydro";
import { computeHullSampling, type HullSampling } from "../src/core/mesh";
import { worldZ, type Model } from "../src/core/model";
import {
  crossCurves,
  gzArea,
  gzAreaTerms,
  gzCurve,
  stationGeometry,
  immersedAt,
  knAt,
  limitingKgAt,
  limitingKgCurve,
  vcgForGzArea,
} from "../src/core/stability";
import { meshImmersed } from "./support/meshIntegral";

let fails = 0;
const ok = (c: boolean, m: string): void => {
  if (!c) {
    console.log("FAIL: " + m);
    fails++;
  } else console.log("  ok: " + m);
};

const DEG = Math.PI / 180;
const NS = 200,
  M = 12;
// The hull is swept ONCE per model and handed to everything that cuts it — hydro, the station geometry and
// the KN table all read the same lattice, which is the point of taking the sampling as an argument.
const sampled = new Map<Model, HullSampling>();
const sample = (model: Model): HullSampling => {
  let s = sampled.get(model);
  if (!s) sampled.set(model, (s = computeHullSampling(model, NS, M)));
  return s;
};

// ---- agreement with hydro.ts at the design waterline ----
{
  for (const rake of [0, 3 * DEG]) {
    const model = assemble({ ...defaultHull(), deckRake: rake });
    const h = hydrostatics(model, sample(model));
    const sec = stationGeometry(model, sample(model));
    if (!h || !sec) {
      ok(false, `hydro and sections both build (rake ${rake / DEG}°)`);
      continue;
    }
    // hydro's waterline is a DEPTH below the deck datum; the cut here is at a world HEIGHT
    const im = immersedAt(sec, 0, -model.waterline);
    const tag = `(rake ${Math.round(rake / DEG)}°)`;
    ok(
      Math.abs(im.vol - h.vol) / h.vol < 2e-3,
      `∇ matches hydro.ts to 0.2% ${tag} — ${im.vol.toFixed(1)} vs ${h.vol.toFixed(1)}`,
    );
    ok(
      Math.abs(im.zB - h.kb) / h.kb < 5e-3,
      `KB matches hydro.ts to 0.5% ${tag} — ${im.zB.toFixed(3)} vs ${h.kb.toFixed(3)}`,
    );
    ok(
      Math.abs(im.yB) < 1e-9 * Math.max(1, h.bwl),
      `upright y_B is exactly on the centerline ${tag}`,
    );
  }
}

// ---- the table: upright KN, monotonicity, and that it inverts ----
{
  const model = assemble(defaultHull());
  const cc = crossCurves(model, sample(model), { steps: 40 });
  if (!cc) throw new Error("no cross curves");

  ok(
    cc.kn[0].every((v) => Math.abs(v) < 1e-9),
    "upright KN is zero at every displacement",
  );

  let increasing = true;
  for (const vol of cc.vol)
    for (let k = 1; k < vol.length; k++)
      if (vol[k] <= vol[k - 1]) increasing = false;
  ok(increasing, "∇ is strictly increasing along every heel's march");

  ok(
    cc.vol.every((v) => v.length >= 20),
    "every heel angle keeps a usable number of steps after de-duplication",
  );

  // interpolating back at a volume the march itself produced must return that step's KN
  let worst = 0,
    scale = 0;
  for (let i = 0; i < cc.heel.length; i++)
    for (let k = 1; k < cc.vol[i].length - 1; k++) {
      worst = Math.max(
        worst,
        Math.abs(knAt(cc, i, cc.vol[i][k]) - cc.kn[i][k]),
      );
      scale = Math.max(scale, Math.abs(cc.kn[i][k]));
    }
  ok(worst < 1e-9 * Math.max(1, scale), "the table reproduces its own knots");

  // and BETWEEN knots the interpolation must track a directly computed cut
  const sec = stationGeometry(model, sample(model));
  if (!sec) throw new Error("no sections");
  let worstMid = 0;
  for (let i = 0; i < cc.heel.length; i += 4) {
    const k = Math.floor(cc.vol[i].length / 2),
      wlZ = (cc.wl[i][k] + cc.wl[i][k + 1]) / 2,
      im = immersedAt(sec, cc.heel[i], wlZ);
    worstMid = Math.max(worstMid, Math.abs(knAt(cc, i, im.vol) - im.kn));
  }
  ok(
    worstMid < 1e-3 * scale,
    `interpolation between knots tracks a direct cut to 0.1% of max KN (worst ${(worstMid / scale).toExponential(1)})`,
  );
}

// ---- small angles: GZ → (KMt − VCG)·sin φ ----
{
  const model = assemble(defaultHull());
  const h = hydrostatics(model, sample(model));
  if (!h) throw new Error("no hydrostatics");
  const cc = crossCurves(model, sample(model), {
    steps: 60,
    heel: [0, 1, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90],
  });
  if (!cc) throw new Error("no cross curves");

  const vcg = h.kb; // put G at the centre of buoyancy — a sane, floatable condition
  const gz = gzCurve(cc, h.vol, vcg);
  const gm = h.kmt - vcg; // the initial metacentric height hydro.ts already knows

  for (const deg of [1, 2]) {
    const p = gz.find((q) => Math.abs(q.heel - deg * DEG) < 1e-9);
    if (!p) {
      ok(false, `${deg}° is in the curve`);
      continue;
    }
    const want = gm * Math.sin(p.heel),
      err = Math.abs(p.gz - want) / Math.abs(want);
    ok(
      err < 0.005,
      `GZ at ${deg}° is GM·sin φ to 0.5% (GM ${gm.toFixed(2)}) — ${p.gz.toFixed(4)} vs ${want.toFixed(4)}`,
    );
  }

  // the curve should be well formed for a stable hull: positive, rising, then falling back
  const arms = gz.map((p) => p.gz);
  ok(
    arms.every((v) => Number.isFinite(v)),
    "the whole curve is defined at the design displacement",
  );
  const iMax = arms.indexOf(Math.max(...arms));
  ok(arms[iMax] > 0, `max GZ is positive (${arms[iMax].toFixed(3)})`);
  ok(
    iMax > 0 && iMax < arms.length - 1,
    `max GZ is at an interior heel angle (${(cc.heel[iMax] / DEG).toFixed(0)}°)`,
  );

  // ---- the VCG identity ----
  const dv = 0.3 * Math.max(1e-6, h.kb);
  const gz2 = gzCurve(cc, h.vol, vcg + dv);
  let worst = 0;
  for (let i = 0; i < gz.length; i++)
    worst = Math.max(
      worst,
      Math.abs(gz[i].gz - gz2[i].gz - dv * Math.sin(gz[i].heel)),
    );
  ok(worst < 1e-12, "two VCGs differ by exactly ΔVCG·sin φ at every angle");

  // raising G must cut the range of positive stability, never extend it
  const range = (c: { gz: number }[]): number =>
    c.filter((p) => p.gz > 0).length;
  ok(
    range(gz2) <= range(gz),
    "raising the VCG never widens the range of positive stability",
  );

  // ---- limiting KG envelope: static stability means M above G ----
  const geom = stationGeometry(model, sample(model))!;
  const envelope = limitingKgCurve(geom, cc);
  const limit = limitingKgAt(envelope, h.vol);
  ok(
    Math.abs(limit - h.kmt) / h.kmt < 5e-3,
    `limiting KG at design displacement is KMt (${limit.toFixed(2)} vs ${h.kmt.toFixed(2)})`,
  );
  ok(
    envelope.length >= 20 &&
      envelope.every((p) => Number.isFinite(p.kg) && p.vol > 0),
    "the limiting KG envelope samples finite, floatable upright conditions",
  );

  // ---- off the table ----
  ok(
    gzCurve(cc, h.vol * 1e6, vcg).every((p) => Number.isNaN(p.gz)),
    "an impossible displacement returns NaN rather than an extrapolation",
  );
}

// ---- negative heel is the mirror of positive heel ----
//
// Every hull here is built y-symmetric, so heeling to port must produce exactly the opposite righting arm.
// KN is odd in φ, and so is GZ — which also pins down the sign convention: +φ heels to STARBOARD and
// returns a POSITIVE arm.
{
  const model = assemble(defaultHull());
  const h = hydrostatics(model, sample(model))!;
  const angles = [5, 20, 45, 70];
  const cc = crossCurves(model, sample(model), {
    steps: 40,
    heel: [...angles.map((a) => -a), 0, ...angles],
  })!;
  const idx = (deg: number): number =>
    cc.heel.findIndex((v) => Math.abs(v - deg * DEG) < 1e-12);

  let worstKn = 0,
    worstVol = 0,
    scale = 0;
  for (const a of angles) {
    const i = idx(a),
      j = idx(-a);
    // the two marches must sweep the same volumes: a mirrored cut displaces the same water
    for (let k = 0; k < Math.min(cc.vol[i].length, cc.vol[j].length); k++)
      worstVol = Math.max(worstVol, Math.abs(cc.vol[i][k] - cc.vol[j][k]));
    const kp = knAt(cc, i, h.vol),
      km = knAt(cc, j, h.vol);
    worstKn = Math.max(worstKn, Math.abs(kp + km));
    scale = Math.max(scale, Math.abs(kp));
  }
  ok(
    worstVol < 1e-6 * h.vol,
    `port and starboard heel sweep identical volumes (worst ${(worstVol / h.vol).toExponential(1)} rel)`,
  );
  ok(
    worstKn < 1e-9 * scale,
    `KN is odd in heel: KN(−φ) = −KN(φ) (worst ${(worstKn / scale).toExponential(1)} rel)`,
  );

  const gz = gzCurve(cc, h.vol, h.kb);
  let worstGz = 0,
    gzScale = 0;
  for (const a of angles) {
    worstGz = Math.max(worstGz, Math.abs(gz[idx(a)].gz + gz[idx(-a)].gz));
    gzScale = Math.max(gzScale, Math.abs(gz[idx(a)].gz));
  }
  ok(worstGz < 1e-9 * gzScale, "GZ is odd in heel");
  ok(
    gz[idx(20)].gz > 0,
    `+φ heels to starboard and gives a positive righting arm (${gz[idx(20)].gz.toFixed(2)} at 20°)`,
  );
}

// ---- the deck-immersion threshold is sharp and in the right place ----
//
// `deckDown` says the watertight cap across the sheer has started carrying load. It must flip exactly when
// the lowest sheer point crosses the waterline — not a step early or late — because past that point the
// numbers describe a hull with a deck on it, and a caller needs to know precisely where that starts.
{
  const model = assemble(defaultHull());
  const sec = stationGeometry(model, sample(model))!;
  const hs = sample(model);
  // the sheer points, straight from the sampling rather than from the cached sections
  const sheer = hs.columns
    .filter((c) => c.pts.length >= 2)
    .map((c) => ({
      zeta: worldZ(model, c.pts[0].pos[0], c.pts[0].pos[2]),
      y: c.pts[0].pos[1],
    }));
  const phi = 35 * DEG,
    c = Math.cos(phi),
    s = Math.sin(phi);
  // the exact height at which the lowest sheer point goes under, computed independently
  const trueFlip = Math.min(...sheer.map((p) => p.zeta * c - p.y * s));

  // bisect the height at which the flag flips
  let lo = trueFlip - 0.25 * Math.abs(trueFlip || 1) - 10,
    hi = trueFlip + 0.25 * Math.abs(trueFlip || 1) + 10;
  ok(
    !immersedAt(sec, phi, lo).deckDown && immersedAt(sec, phi, hi).deckDown,
    "the flag brackets: dry below, wet above",
  );
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (immersedAt(sec, phi, mid).deckDown) hi = mid;
    else lo = mid;
  }
  const span = Math.abs(hi - lo);
  ok(
    Math.abs((lo + hi) / 2 - trueFlip) < 1e-6 * Math.max(1, Math.abs(trueFlip)),
    `the flag flips exactly at the lowest sheer point (off by ${Math.abs((lo + hi) / 2 - trueFlip).toExponential(1)}, bisected to ${span.toExponential(1)})`,
  );

  // ∇ must be continuous across the threshold — the cap adds area gradually, it does not appear all at once
  const e = 1e-3 * Math.max(1, Math.abs(trueFlip));
  const below = immersedAt(sec, phi, trueFlip - e).vol,
    above = immersedAt(sec, phi, trueFlip + e).vol,
    // the local slope is the waterplane area, so estimate the jump against what 2e of sinkage should add
    slope =
      (immersedAt(sec, phi, trueFlip + 3 * e).vol -
        immersedAt(sec, phi, trueFlip + e).vol) /
      (2 * e);
  ok(
    Math.abs(above - below) < 3 * slope * e,
    "∇ is continuous across the deck-immersion threshold (no jump from the cap)",
  );

  // and once the deck is under it stays under as the hull sinks further
  let monotone = true,
    seen = false;
  for (let k = 0; k <= 60; k++) {
    const wlZ = trueFlip - 200 + (k * 400) / 60,
      d = immersedAt(sec, phi, wlZ).deckDown;
    if (d) seen = true;
    else if (seen) monotone = false;
  }
  ok(
    monotone,
    "deck immersion is monotone in sinkage — once under, always under",
  );
}

// ---- low displacement: KN → 0, and the sparse end of the table still interpolates ----
//
// The march is uniform in waterline height, so the low-∇ end of the table is the THINNEST in ∇ — the hull
// is a sliver near the keel there and ∇ grows superlinearly with depth. That is exactly where interpolation
// is most likely to be wrong, so it is checked against directly computed cuts rather than against itself.
{
  const model = assemble(defaultHull());
  const h = hydrostatics(model, sample(model))!;
  const sec = stationGeometry(model, sample(model))!;
  const cc = crossCurves(model, sample(model), {
    steps: 40,
  })!;

  // find the waterline that gives a target ∇ exactly, so the direct cut and the table are asked the same
  // question; then compare. Bisection is fine here — this is the test, not the method under test.
  const cutAt = (
    phi: number,
    target: number,
  ): ReturnType<typeof immersedAt> => {
    let lo = -1e7,
      hi = 1e7;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (immersedAt(sec, phi, mid).vol < target) lo = mid;
      else hi = mid;
    }
    return immersedAt(sec, phi, (lo + hi) / 2);
  };

  // As ∇ → 0 the immersed sliver collapses onto whichever point of the hull is LOWEST in the heeled frame —
  // which at heel is out on the bilge, not at K. So KN tends to a finite NON-ZERO limit there; it goes to
  // zero only upright, where the lowest point is K itself. Check that the limit exists by convergence rather
  // than by formula, so the test does not depend on how a section is stored.
  {
    const k = [0.01, 0.005, 0.0025].map((f) => cutAt(30 * DEG, h.vol * f).kn);
    ok(
      k.every((v) => Number.isFinite(v) && v > 0) &&
        Math.abs(k[2] - k[1]) < Math.abs(k[1] - k[0]),
      `KN converges to a non-zero limit as ∇ → 0 at heel (${k.map((v) => v.toFixed(1)).join(" → ")})`,
    );
    const up = [0.01, 0.005, 0.0025].map((f) => cutAt(0, h.vol * f).kn);
    ok(
      up.every((v) => Math.abs(v) < 1e-9 * Math.max(1, k[0])),
      "upright, KN is zero all the way down to ∇ → 0",
    );
  }

  let worst = 0,
    at = 0;
  for (const frac of [0.02, 0.05, 0.1, 0.25, 0.5]) {
    for (const phi of [10 * DEG, 30 * DEG, 60 * DEG]) {
      const i = cc.heel.findIndex((v) => Math.abs(v - phi) < 1e-9),
        target = h.vol * frac,
        direct = cutAt(phi, target),
        table = knAt(cc, i, target),
        rel = Math.abs(table - direct.kn) / Math.max(1, Math.abs(direct.kn));
      if (rel > worst) {
        worst = rel;
        at = frac;
      }
    }
  }
  ok(
    worst < 0.01,
    `the table tracks a direct cut down to 2% of design ∇ (worst ${(100 * worst).toFixed(2)}% at ${(100 * at).toFixed(0)}% ∇)`,
  );

  // refining the march must not move the answer — the table has converged, not just settled somewhere
  const fine = crossCurves(model, sample(model), {
    steps: 200,
  })!;
  let worstRef = 0;
  for (const frac of [0.02, 0.1, 0.5]) {
    const i = cc.heel.findIndex((v) => Math.abs(v - 30 * DEG) < 1e-12),
      j = fine.heel.findIndex((v) => Math.abs(v - 30 * DEG) < 1e-12),
      a = knAt(cc, i, h.vol * frac),
      b = knAt(fine, j, h.vol * frac);
    worstRef = Math.max(worstRef, Math.abs(a - b) / Math.max(1, Math.abs(b)));
  }
  ok(
    worstRef < 0.01,
    `5x the sinkage steps moves KN by under 1% (worst ${(100 * worstRef).toFixed(2)}%)`,
  );
}

// ---- past 90°: the curve carries on to a vanishing angle and closes at 180° ----
//
// Nothing in the construction stops at 90°; a full GZ curve wants the range of positive stability, which
// lives past the maximum. 180° is the sharp check — the hull is fully inverted but still y-symmetric, so
// y_B is back on the centerline and sin φ is 0, and KN must be exactly 0 again.
{
  const model = assemble(defaultHull());
  const h = hydrostatics(model, sample(model))!;
  const cc = crossCurves(model, sample(model), {
    steps: 40,
    heel: [0, 20, 40, 60, 80, 100, 120, 140, 160, 180],
  })!;

  ok(
    cc.kn.every((row) => row.every((v) => Number.isFinite(v))),
    "every KN past 90° is finite",
  );
  const i180 = cc.heel.length - 1;
  const knScale = Math.max(...cc.kn.map((r) => Math.max(...r.map(Math.abs))));
  ok(
    Math.abs(knAt(cc, i180, h.vol)) < 1e-9 * knScale,
    `KN is exactly 0 at 180° (${knAt(cc, i180, h.vol).toExponential(1)})`,
  );

  const gz = gzCurve(cc, h.vol, h.kb);
  ok(
    gz.every((p) => Number.isFinite(p.gz)),
    "the GZ curve is defined over the whole 0–180° range",
  );
  // 180° is an equilibrium, not a righting arm: KN and sin φ are both 0, so GZ is exactly 0 there. Testing
  // its SIGN would only be testing rounding noise — what carries meaning is that the arm has already gone
  // negative before it, so the hull is unstable inverted and 180° is the far end of the capsized range.
  const gzScale = Math.max(...gz.map((p) => Math.abs(p.gz)));
  ok(
    Math.abs(gz[i180].gz) < 1e-9 * gzScale,
    `GZ is exactly 0 at 180° — an equilibrium, not an arm (${gz[i180].gz.toExponential(1)})`,
  );
  const i160 = cc.heel.findIndex((v) => Math.abs(v - 160 * DEG) < 1e-12);
  ok(
    gz[i160].gz < 0,
    `GZ is negative approaching 180° — inverted is unstable (${gz[i160].gz.toFixed(2)} at 160°)`,
  );
  // the range of positive stability: over 0–160° the arm starts positive and crosses to negative once
  const signs = gz.slice(1, i160 + 1).map((p) => Math.sign(p.gz));
  const crossings = signs.filter((s, i) => i > 0 && s !== signs[i - 1]).length;
  ok(
    signs[0] > 0 && crossings === 1,
    `GZ crosses zero exactly once over 0–160° — one range of positive stability (${crossings} crossing)`,
  );
  ok(
    cc.deckDown.slice(-3).every((row) => row.some((d) => d)),
    "the deck is flagged as immersed at the extreme angles, where the cap is load-bearing",
  );
}

// ---- a strongly curved sheer plan ----
//
// A station plane is normal to the plan's heading, so the harder the plan turns the more a section tilts in
// x — and at a non-zero deckRake that tilt is what decides where the waterline cuts each vertex. This hull
// turns roughly three times as hard as the default one, which is the case that broke an earlier version
// that used one nominal x per column.
{
  // the authored defaults are in v1 units scaled into the hull's own; reuse that scale so the plan below
  // sits on the same hull rather than a millimetre-sized one
  const S = defaultHull().sheerPlan[4].x / 1000;
  const curved = (rake: number): HullState => ({
    ...defaultHull(),
    sheerPlan: [
      [0, 205],
      [250, 340],
      [500, 330],
      [750, 190],
      [1000, 0],
    ].map(([x, y]) => ({ x: x * S, y: y * S })),
    deckRake: rake,
  });
  for (const rake of [0, 4 * DEG]) {
    const model = assemble(curved(rake));
    const h = hydrostatics(model, sample(model));
    const sec = stationGeometry(model, sample(model));
    const tag = `(curved plan, rake ${Math.round(rake / DEG)}°)`;
    if (!h || !sec) {
      ok(false, `the curved hull builds ${tag}`);
      continue;
    }
    const im = immersedAt(sec, 0, -model.waterline);
    ok(!im.deckDown && h.validWaterplane, `the deck stays clear ${tag}`);
    ok(
      Math.abs(im.vol - h.vol) / h.vol < 3e-3,
      `∇ matches hydro.ts to 0.3% ${tag} — ${im.vol.toFixed(0)} vs ${h.vol.toFixed(0)}`,
    );
    ok(
      Math.abs(im.zB - h.kb) / h.kb < 5e-3,
      `KB matches hydro.ts to 0.5% ${tag} — ${im.zB.toFixed(3)} vs ${h.kb.toFixed(3)}`,
    );
    // 1°, not 5°: GZ = GM·sin φ is the SMALL-angle limit, and this hull is beamy enough (BM ≈ 1100) that
    // the wall-sided term ½·BM·tan²φ·sin φ is already worth ~0.4% of the arm by 5°. Testing at 1° isolates
    // the thing being checked — that hydro's KMt and stability's KN describe the same hull.
    const cc = crossCurves(model, sample(model), {
      steps: 60,
      heel: [0, 1],
    })!;
    const gz = gzCurve(cc, h.vol, h.kb);
    const gm = h.kmt - h.kb,
      p = gz[1];
    ok(
      Math.abs(p.gz - gm * Math.sin(p.heel)) / Math.abs(gm * Math.sin(p.heel)) <
        0.01,
      `GZ at 1° is GM·sin φ to 1% ${tag} — ${p.gz.toFixed(4)} vs ${(gm * Math.sin(p.heel)).toFixed(4)}`,
    );
  }
}

// ---- against an independently integrated 3D mesh ----
//
// The strongest check available: the same hull, reached by a different route. `sweep.ts` integrates a volume
// over station-plane polygons; `meshImmersed` integrates a surface over the 3D triangle mesh the STL exporter
// writes, by the divergence theorem. No shared code — see the warning at the top of that file about keeping it
// that way. It is what caught the fanning-Jacobian error in the first place, when the two disagreed by 6–11%
// on ∇ no matter how finely either was refined.
//
// The mesh has no deck, so it leaks once the deck edge goes under; every case here is skipped unless dry.

{
  const model = assemble(defaultHull());
  const sec = stationGeometry(model, sample(model))!;
  // two waterlines: the design one, where three transom-ended columns are wetted, and a shallow one where
  // none are — so the flat transom closure can be told apart from anything the sweep itself is doing
  const cases: { wlZ: number; phi: number }[] = [];
  for (const wlZ of [-model.waterline, -model.waterline * 1.45])
    for (const phi of [0, 10 * DEG, 25 * DEG, 40 * DEG])
      cases.push({ wlZ, phi });

  let worstKn = 0,
    minVolGap = Infinity,
    maxVolGap = -Infinity,
    ran = 0;
  for (const { wlZ, phi } of cases) {
    const mine = immersedAt(sec, phi, wlZ);
    // the mesh has no deck, so once the deck edge is under it leaks and there is nothing to compare against
    if (mine.deckDown) continue;
    const ref = meshImmersed(model, sample(model), sec.keelZ, phi, wlZ);
    const volGap = (mine.vol - ref.vol) / ref.vol;
    minVolGap = Math.min(minVolGap, volGap);
    maxVolGap = Math.max(maxVolGap, volGap);
    if (Math.abs(ref.kn) > 1e-6)
      worstKn = Math.max(
        worstKn,
        Math.abs(mine.kn - ref.kn) / Math.abs(ref.kn),
      );
    ran++;
  }
  ok(
    ran >= 6,
    `enough deck-dry conditions to compare (${ran}/${cases.length})`,
  );

  ok(
    worstKn < 0.01,
    `KN matches the 3D mesh integral to 1% (worst ${(100 * worstKn).toFixed(2)}%)`,
  );
  // With the fanning Jacobian in `sweep.ts` this is now a real agreement, not a pinned gap. What is left is
  // the flat closure across a transom-ended column — about −0.15% where no transom is wetted, about −0.55%
  // at the design waterline where three are. That is the next approximation to remove, not this one.
  ok(
    minVolGap > -0.01 && maxVolGap < 0.01,
    `∇ matches the 3D mesh integral to 1% (${(100 * minVolGap).toFixed(2)}% … ${(100 * maxVolGap).toFixed(2)}%)`,
  );

  // and the agreement is not an accident of one resolution: refining both together keeps it
  const coarseHs = computeHullSampling(model, 100, 6),
    fineHs = computeHullSampling(model, 500, 32);
  const wlZ = -model.waterline,
    coarse =
      immersedAt(stationGeometry(model, coarseHs)!, 0, wlZ).vol /
      meshImmersed(model, coarseHs, sec.keelZ, 0, wlZ).vol,
    fine =
      immersedAt(stationGeometry(model, fineHs)!, 0, wlZ).vol /
      meshImmersed(model, fineHs, sec.keelZ, 0, wlZ).vol;
  ok(
    Math.abs(coarse - fine) < 5e-3 && Math.abs(fine - 1) < 0.01,
    `both methods converge to the same ∇ under 5x refinement (${((coarse - 1) * 100).toFixed(2)}% → ${((fine - 1) * 100).toFixed(2)}%)`,
  );
}

// ---- the area under GZ: one integration per displacement, exact in VCG ----
//
// `gzAreaTerms` splits A(∇, VCG) into a hull term and a VCG term so the whole (∇, VCG) field — and every
// contour drawn on it — comes off ONE integration per displacement. What has to hold: the split is the
// identity it claims, the integral itself tracks a far finer one, and the inverse really is an inverse.
{
  const model = assemble(defaultHull());
  const h = hydrostatics(model, sample(model))!;
  const cc = crossCurves(model, sample(model), { steps: 40 })!;
  const upTo = 30 * DEG;
  const vcg = h.kb;

  const area = gzArea(cc, h.vol, vcg);
  ok(
    Number.isFinite(area) && area > 0,
    `the area out to 30° is finite and positive (${area.toFixed(3)} units·rad)`,
  );

  // the VCG term is exact: two centres of gravity differ by ΔVCG·(1 − cos φ₁) and by nothing else
  const dv = 0.3 * Math.max(1e-6, h.kb);
  ok(
    Math.abs(gzArea(cc, h.vol, vcg + dv) - area + dv * (1 - Math.cos(upTo))) <
      1e-12 * Math.max(1, Math.abs(area)),
    "raising the VCG costs exactly ΔVCG·(1 − cos φ₁) of area",
  );

  // the inverse is a real inverse, at an area the hull does not otherwise sit at
  const terms = gzAreaTerms(cc, h.vol);
  const target = area * 0.6;
  const needed = vcgForGzArea(terms, target);
  ok(
    Math.abs(gzArea(cc, h.vol, needed) - target) <
      1e-12 * Math.max(1, Math.abs(target)),
    `vcgForGzArea inverts gzArea exactly (VCG ${needed.toFixed(3)} for ${target.toFixed(3)})`,
  );
  ok(
    needed > vcg,
    "a smaller area needs a higher VCG — the field decreases in KG",
  );

  // and the integral tracks a far finer one: 0.5° steps, summed with the trapezoid rule, against the 5°
  // table the panel actually draws from. This is the claim that the shading's contours sit where they say.
  const fine = crossCurves(model, sample(model), {
    steps: 40,
    heel: Array.from({ length: 121 }, (_, i) => i * 0.25),
  })!;
  let worst = 0;
  for (const frac of [0.3, 0.6, 1, 1.4]) {
    const vol = h.vol * frac;
    const gz = gzCurve(fine, vol, vcg).filter((p) => p.heel <= upTo + 1e-12);
    if (gz.length < 2 || gz.some((p) => !Number.isFinite(p.gz))) continue;
    let ref = 0;
    for (let i = 1; i < gz.length; i++)
      ref += ((gz[i].heel - gz[i - 1].heel) * (gz[i].gz + gz[i - 1].gz)) / 2;
    const mine = gzArea(cc, vol, vcg);
    worst = Math.max(
      worst,
      Math.abs(mine - ref) / Math.max(1e-9, Math.abs(ref)),
    );
  }
  ok(
    worst < 0.01,
    `the 5° table's area matches a 0.25° integration to 1% (worst ${(100 * worst).toFixed(2)}%)`,
  );

  // off the table there is no area to report, and none is invented
  ok(
    !Number.isFinite(gzArea(cc, h.vol * 1e6, vcg)),
    "an impossible displacement has no area rather than an extrapolated one",
  );
  // a table that stops short of φ₁ reports nothing rather than a partial area
  const short = crossCurves(model, sample(model), {
    steps: 20,
    heel: [0, 5, 10],
  })!;
  ok(
    !Number.isFinite(gzArea(short, h.vol, vcg)),
    "a table that stops before 30° reports no area rather than a partial one",
  );
  // φ₁ between two heel angles is closed on the chord, not dropped
  const between = gzArea(cc, h.vol, vcg, 27.5 * DEG);
  ok(
    Number.isFinite(between) && between > 0 && between < area,
    `a heel limit between two table angles integrates to just under the 30° area (${between.toFixed(3)} vs ${area.toFixed(3)})`,
  );
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
