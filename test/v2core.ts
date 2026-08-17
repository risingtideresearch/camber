// Version 2 core: the curve primitive, the sweep, the trim, and the v1 conversion.
//
// These check the properties the format and the meshing are supposed to guarantee, rather than fixed
// numbers — so they still mean something after the geometry is tuned:
//
//   - spline: the curve interpolates its knots; k=0 keeps the tangent continuous; an isolated k=1 breaks it
//     (a corner); two adjacent k=1 points make the segment between them exactly straight.
//   - model: the plan's exact hodograph agrees with finite differences (the sweep's frame reads it); the
//     loft passes exactly through an authored station at that station's own u — a loft that missed its own
//     control sections would mean the interpolation, not the author, decides the shape.
//   - mesh: every kept point is inside all three trims; the converged top row sits ON the sheer trim and the
//     keel row exactly on the centerline; every row has the same width (a quad grid the renderer can use).
//   - json: a build → parse → build round-trip reproduces the geometry exactly (v2 is absolute, so it must).
//   - v1: increments become absolute, and each template lands at the u where its weight peaks — including
//     the symmetric case, where ONE template peaking at both ends must become TWO stations.
//   - promote: lifting a family to one topology leaves every hull's SURFACE where it was (the inserted
//     stations are read off each hull's own loft, so they add a handle without moving anything), and the
//     station correspondence pins the ends together.
//   - blend: the ends of the blend reproduce the input hulls exactly, and every interior blend is a
//     well-formed hull (its plan x, trim x and station u all strictly increasing).
//
// Run with `npm run test:v2` (tsx runs this directly under node). Non-zero exit on any failure.
import { loa, sectionAt, frameAt, bounds, type Model } from "../src/core/model";
import {
  hullGrid,
  sweptSection,
  forwardLimit,
  sheerPointAt,
  keelPointAt,
} from "../src/core/mesh";
import {
  buildJson,
  parseDocument,
  parseHullState,
  type HullData,
} from "../src/core/json";
import { assemble } from "../src/core/runtime";
import { defaultHull, type HullState } from "../src/core/hull";
import { crCurveAuto } from "../src/core/spline";
import { convertV1ToV2 } from "../src/legacy/v1/convert";
import { promoteFamily, autoCorrespondence } from "../src/core/promote";
import { blendState } from "../src/interpolate/blend";

let fails = 0;
const ok = (c: boolean, m: string): void => {
  if (!c) {
    console.log("FAIL: " + m);
    fails++;
  } else console.log("  ok: " + m);
};

// ---- spline: knuckles ----
{
  const pts = [
    [0, 0],
    [1, 1],
    [2, 0],
  ];
  const smooth = crCurveAuto(pts, [0, 0, 0]);
  const sharp = crCurveAuto(pts, [0, 1, 0]);
  ok(Math.abs(smooth.at(1)[1] - 1) < 1e-9, "curve interpolates its knots");
  // two adjacent k=1 points make the segment between them exactly straight
  const st = crCurveAuto(
    [
      [0, 0],
      [1, 1],
      [2, 0],
    ],
    [1, 1, 0],
  );
  const mid = st.at(0.5);
  ok(Math.abs(mid[1] - mid[0]) < 1e-9, "k=1 on both ends → straight segment");
  // an isolated knuckle breaks the tangent; a smooth one does not
  const dL = smooth.d(1 - 1e-6),
    dR = smooth.d(1 + 1e-6);
  const angS = Math.abs(Math.atan2(dL[1], dL[0]) - Math.atan2(dR[1], dR[0]));
  const eL = sharp.d(1 - 1e-6),
    eR = sharp.d(1 + 1e-6);
  const angK = Math.abs(Math.atan2(eL[1], eL[0]) - Math.atan2(eR[1], eR[0]));
  ok(angS < 1e-4, "k=0 keeps the tangent continuous");
  ok(angK > 0.5, "isolated k=1 breaks the tangent (a corner)");
}

// ---- model ----
const m = assemble(defaultHull());
ok(Math.abs(loa(m) - 5000) < 1e-6, "default hull is 5000 mm long");
ok(m.unit === "mm", "default unit is mm");
ok(m.stations.length === 2, "default has 2 stations");
{
  const b = bounds(m);
  ok(b.yMax > 0 && b.nMax > 0, "the drawn panels scale with the hull");
  // the plan curve interpolates its end control points
  const p0 = m.plan.at(0),
    p1 = m.plan.at(1);
  ok(Math.abs(p0[0] - 0) < 1e-6, "plan starts at x=0");
  ok(Math.abs(p1[0] - 5000) < 1e-6, "plan ends at the LOA");
  // exact hodograph vs finite difference
  const h = 1e-5,
    u = 0.37;
  const fd = [
    (m.plan.at(u + h)[0] - m.plan.at(u - h)[0]) / (2 * h),
    (m.plan.at(u + h)[1] - m.plan.at(u - h)[1]) / (2 * h),
  ];
  const an = m.plan.d(u);
  ok(
    Math.hypot(an[0] - fd[0], an[1] - fd[1]) < 1e-3,
    "plan hodograph matches finite differences",
  );
}

// ---- section / loft ----
{
  const s = sectionAt(m, 0.5);
  ok(s.vmax === 4, "section has S-1 = 4 segments");
  ok(
    s.at(0)[1] === 0 || Math.abs(s.at(0)[1]) < 1e-9,
    "section point 0 is at the deck (z=0)",
  );
  // the loft reproduces an authored station exactly at its own u
  const s0 = sectionAt(m, 0);
  const auth = m.stations[0].points;
  let worst = 0;
  for (let i = 0; i < auth.length; i++) {
    const p = s0.at(i);
    worst = Math.max(worst, Math.hypot(p[0] - auth[i].n, p[1] - auth[i].z));
  }
  ok(
    worst < 1e-6,
    `loft passes exactly through station 0's points (err ${worst.toExponential(1)})`,
  );
}

// ---- frame ----
{
  const fr = frameAt(m, 0.5);
  ok(Math.abs(Math.hypot(...fr.n) - 1) < 1e-9, "frame normal is unit");
  ok(
    Math.abs(fr.n[0] * fr.T[0] + fr.n[1] * fr.T[1]) < 1e-9,
    "frame normal ⟂ heading",
  );
  ok(fr.n[1] < 0, "frame normal points inboard (−y)");
}

// ---- trimming ----
{
  const s = sweptSection(m, 0.5, 8, true);
  ok(!s.empty, "midships section exists");
  ok(s.keel, "midships section reaches the keel");
  const top = s.pts[0],
    bot = s.pts[s.pts.length - 1];
  ok(Math.abs(bot[1]) < 1e-9, "the last point is exactly on the centerline");
  ok(
    Math.abs(top[2] - m.trimZ(top[0])) < 1e-6,
    "the first point sits on the sheer trim",
  );
  // every kept point is inside all three trims
  let inside = true;
  for (const p of s.pts)
    if (p[1] < -1e-6 || p[2] > m.trimZ(p[0]) + 1e-6) inside = false;
  ok(inside, "every kept point is inside the trims");
}

// ---- the grid ----
{
  const g = hullGrid(m, 60, 8, true);
  ok(g.rows.length > 40, `grid has ${g.rows.length} columns`);
  const w = new Set(g.rows.map((r) => r.length));
  ok(w.size === 1, `every row has the same width (${[...w]})`);
  ok(g.M === 32, "keel index M = (S−1)·R");
  const bad = g.rows.filter((r, i) => g.keel[i] && Math.abs(r[g.M][1]) >= 1e-9);
  ok(bad.length === 0, "every keel column is on the centerline");
  const nk = g.keel.filter((k) => !k).length;
  console.log(
    `      (${nk}/${g.rows.length} columns bottom out on the transom or run open)`,
  );
  console.log(
    `      u of non-keel columns: ${g.us
      .filter((_, i) => !g.keel[i])
      .map((u) => u.toFixed(3))
      .join(", ")}`,
  );
  const sheet = hullGrid(m, 20, 4, false);
  ok(sheet.rows.length === 21, "the untrimmed sheet keeps every column");
}
{
  const fw = forwardLimit(m);
  ok(fw > 0.5 && fw <= 1, `forward limit ${fw.toFixed(3)}`);
  ok(!!sheerPointAt(m, 0.5), "sheer point exists midships");
  ok(!!keelPointAt(m, 0.5), "keel point exists midships");
}

// ---- json round-trip ----
{
  const text = buildJson(m);
  const p = parseDocument(text);
  ok(p.topology.stationCount === 2, "round-trip keeps the station count");
  ok(p.hull.unit === "mm", "round-trip keeps the unit");
  const m2 = assemble({
    ...p.hull,
    waterline: p.waterline,
    deckRake: p.deckRake,
  });
  let worst = 0;
  for (let i = 0; i <= 20; i++) {
    const a = sectionAt(m, i / 20),
      b = sectionAt(m2, i / 20);
    for (let v = 0; v <= a.vmax; v += 0.25) {
      const pa = a.at(v),
        pb = b.at(v);
      worst = Math.max(worst, Math.hypot(pa[0] - pb[0], pa[1] - pb[1]));
    }
  }
  ok(worst < 1e-9, `round-trip is exact (worst ${worst.toExponential(1)})`);
}

// ---- v1 → v2 ----
{
  // the v1 default hull, in v1's own on-disk form
  const v1 = {
    version: 1,
    length: 1000,
    waterline: 150,
    deckRakeDeg: 0,
    sheerPlan: [
      { dx: 0, y: 205, w: [1, 0] },
      { dx: 250, y: 225, w: [0.75, 0.25] },
      { dx: 250, y: 220, w: [0.5, 0.5] },
      { dx: 250, y: 160, w: [0.25, 0.75] },
      { dx: 250, y: 0, w: [0, 1] },
    ],
    sheerTrim: [
      { dx: 0, depth: 15, k: 0 },
      { dx: 333, depth: 70, k: 0 },
      { dx: 334, depth: 65, k: 0 },
      { dx: 333, depth: 10, k: 0 },
    ],
    transom: { x: 38, depthTop: 14, dDepthBot: 166, transomRake: -0.343 },
    templates: [
      [
        { dd: 0, n: 0, k: 0 },
        { dd: 80, n: 23, k: 0 },
        { dd: 80, n: 65, k: 1 },
        { dd: 60, n: 140, k: 0 },
        { dd: 30, n: 245, k: 0 },
      ],
      [
        { dd: 0, n: 0, k: 0 },
        { dd: 108, n: 38, k: 0 },
        { dd: 102, n: 100, k: 0 },
        { dd: 70, n: 180, k: 0 },
        { dd: 25, n: 255, k: 0 },
      ],
    ],
    keelK: [0, 0],
  };
  const v2 = convertV1ToV2(v1 as never);
  ok(v2.version === 2, "conversion tags v2");
  ok(v2.unit === "mm", "conversion declares mm");
  ok(
    v2.stations.length === 2,
    `linear handoff → 2 stations (got ${v2.stations.length})`,
  );
  ok(
    Math.abs(v2.stations[0].u - 0) < 1e-3,
    `template 0 lands at u=0 (got ${v2.stations[0].u.toFixed(4)})`,
  );
  ok(
    Math.abs(v2.stations[1].u - 1) < 1e-3,
    `template 1 lands at u=1 (got ${v2.stations[1].u.toFixed(4)})`,
  );
  ok(v2.stations[0].points[2].k === 1, "the aft chine knuckle survives");
  ok(
    Math.abs(v2.stations[0].points[2].z + 160) < 1e-9,
    "depth increments became absolute z",
  );
  ok(Math.abs(v2.sheerTrim[1].z + 70) < 1e-9, "trim depth became absolute z");
  ok(Math.abs(v2.sheerTrim[2].x - 667) < 1e-9, "trim dx became absolute x");
  ok(
    Math.abs(v2.transom[0].z + 14) < 1e-9 && v2.transom[1].z < v2.transom[0].z,
    "transom became two points",
  );
  // the converted hull must actually build
  const mv = assemble(parseHullState(JSON.stringify(v2)));
  const g = hullGrid(mv, 40, 6, true);
  ok(g.rows.length > 20, `converted v1 hull meshes (${g.rows.length} columns)`);

  // a SYMMETRIC weight curve: one template peaking at both ends must become two stations
  const sym = structuredClone(v1);
  sym.sheerPlan[0].w = [1, 0];
  sym.sheerPlan[1].w = [0.5, 0.5];
  sym.sheerPlan[2].w = [0, 1];
  sym.sheerPlan[3].w = [0.5, 0.5];
  sym.sheerPlan[4].w = [1, 0];
  const symV2 = convertV1ToV2(sym as never);
  const t0 = symV2.stations.filter((s) => Math.abs(s.points[1].n - 23) < 1e-9);
  ok(
    symV2.stations.length === 3,
    `symmetric hull → 3 stations (got ${symV2.stations.length})`,
  );
  ok(
    t0.length === 2,
    `the doubled template becomes 2 stations (got ${t0.length})`,
  );
}

// ---- promote + blend ----
{
  // a hull's surface, densely sampled — the yardstick for "promotion didn't move anything"
  const surface = (d: HullData): number[] => {
    const mm = assemble({ ...structuredClone(d), waterline: 0, deckRake: 0 });
    const out: number[] = [];
    for (let i = 0; i <= 24; i++) {
      const s = sweptSection(mm, i / 24, 4, true);
      if (s.empty) out.push(NaN);
      else for (const p of s.pts) out.push(p[0], p[1], p[2]);
    }
    return out;
  };
  // NaN marks a column with no hull; two surfaces agree there iff BOTH are empty
  const worstDiff = (a: number[], b: number[]): number => {
    if (a.length !== b.length) return Infinity;
    let w = 0;
    for (let i = 0; i < a.length; i++) {
      const na = Number.isNaN(a[i]),
        nb = Number.isNaN(b[i]);
      if (na !== nb) return Infinity;
      if (!na) w = Math.max(w, Math.abs(a[i] - b[i]));
    }
    return w;
  };
  const hullOf = (m2: Model): HullData => parseDocument(buildJson(m2)).hull;

  // hull A: the default (2 stations, mm). hull B: 3 stations, authored in metres — so the family exercises
  // both the station correspondence AND the unit normalization at once.
  const A = hullOf(m);
  const bStations = [
    structuredClone(m.stations[0]),
    { ...structuredClone(m.stations[0]), u: 0.5 },
    structuredClone(m.stations[1]),
  ];
  // a fuller midship, so B is really a different hull
  bStations[1] = {
    ...bStations[1],
    points: bStations[1].points.map((p) => ({ ...p, n: p.n * 1.15 })),
  };
  const mB = assemble({ ...defaultHull(), stations: bStations });
  const B = hullOf(mB);
  // rescale every length-dimensioned coordinate of a hull in place (the dimensionless u / k / keelK stay)
  const rescale = (d: HullData, s: number): HullData => {
    for (const p of d.sheerPlan) {
      p.x *= s;
      p.y *= s;
    }
    for (const p of d.sheerTrim) {
      p.x *= s;
      p.z *= s;
    }
    for (const p of d.transom) {
      p.x *= s;
      p.z *= s;
    }
    for (const st of d.stations)
      for (const p of st.points) {
        p.n *= s;
        p.z *= s;
      }
    return d;
  };
  // restate B in metres: the SAME boat, different numbers — promotion must put it back on A's scale
  rescale(B, 1 / 1000);
  B.unit = "m";

  const surfA = surface(A);
  // B's surface as it should read once normalized back to mm — the yardstick promotion must reproduce
  const bMm = rescale(structuredClone(B), 1000);
  bMm.unit = "mm";
  const surfB = surface(bMm);

  const corr = autoCorrespondence([A, B]);
  ok(
    corr.length === 3,
    `auto-correspondence merges 2+3 stations → 3 places (got ${corr.length})`,
  );
  ok(
    corr[0][0] === A.stations[0].u && corr[0][1] === B.stations[0].u,
    "the first station of every hull is one place",
  );
  ok(
    corr[corr.length - 1][0] === A.stations[1].u &&
      corr[corr.length - 1][1] === B.stations[2].u,
    "the last station of every hull is one place",
  );
  ok(
    corr[1][0] === null,
    "A has no station at B's midship — promotion must insert one",
  );

  const fam = [A, B];
  const changed = promoteFamily(fam);
  ok(changed, "promoteFamily reports it changed the family");
  ok(
    fam[0].unit === "mm" && fam[1].unit === "mm",
    "the family is normalized to hull[0]'s unit",
  );
  ok(
    fam[0].stations.length === 3 && fam[1].stations.length === 3,
    `both hulls end index-aligned (${fam[0].stations.length} vs ${fam[1].stations.length})`,
  );
  // THE point of reading an inserted station off the hull's own loft: the surface must not move
  const dA = worstDiff(surfA, surface(fam[0])),
    dB = worstDiff(surfB, surface(fam[1]));
  ok(
    dA < 1e-6,
    `promotion leaves hull A's surface where it was (worst ${dA.toExponential(1)})`,
  );
  ok(
    dB < 1e-6,
    `promotion leaves hull B's surface where it was (worst ${dB.toExponential(1)})`,
  );

  // the blend's ends must reproduce the inputs, and every interior blend must be well formed
  const hulls = [
    { name: "A", data: fam[0] },
    { name: "B", data: fam[1] },
  ];
  const d0 = defaultHull();
  const TRIM = { waterline: d0.waterline, deckRake: d0.deckRake };
  const at = (w: number[]): HullState => blendState(hulls, w, TRIM);
  ok(
    worstDiff(surfA, surface(hullOf(assemble(at([1, 0]))))) < 1e-6,
    "blend at t=0 IS hull A",
  );
  ok(
    worstDiff(surfB, surface(hullOf(assemble(at([0, 1]))))) < 1e-6,
    "blend at t=1 IS hull B",
  );
  let wellFormed = true;
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const b = at([1 - t, t]);
    const inc = (xs: number[]): boolean =>
      xs.every((v, j) => j === 0 || v > xs[j - 1]);
    if (
      !inc(b.sheerPlan.map((p) => p.x)) ||
      !inc(b.sheerTrim.map((p) => p.x)) ||
      !inc(b.stations.map((s) => s.u))
    )
      wellFormed = false;
  }
  ok(
    wellFormed,
    "every interior blend is strictly increasing in plan x, trim x and station u",
  );
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
