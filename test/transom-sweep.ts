// Regression for the missing aft wedge: geometry, volume moments and waterplane
// moments must describe the same transom-clipped solid, not only agree numerically.
import assert from "node:assert/strict";
import { V, type Vec3 } from "../src/core/math";
import { defaultHull } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import {
  cut,
  stationGeometry,
  stationPolygon,
  type StationGeom,
  type Column,
} from "../src/core/sweep";
import { polygonMoments } from "../src/analysis/sections";
import { meshImmersed } from "./support/meshIntegral";
import { camberPlaneMesh } from "../src/analysis/camber/planeMesh";
import { meshImmersion } from "../src/analysis/mesh/immersion";
import { limitingKgCurve, crossCurves } from "../src/core/stability";

const near = (a: number, b: number, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(a - b) <= tolerance,
    `${a} != ${b} (tolerance ${tolerance})`,
  );
const frame = { px: 0, py: 1, nx: 0.6, ny: -0.8 };
const point = (a: number, z: number): Vec3 => [
  frame.px + a * frame.nx,
  frame.py + a * frame.ny,
  z,
];
const skin = [point(0, 2), point(0, 0), point(1.25, 0)];
const transom = (top: number, bottom: number) => [
  { x: top, z: 2 },
  { x: bottom, z: 0 },
];
const area = (p: ReturnType<typeof stationPolygon>) =>
  Math.abs(polygonMoments(p.map((v) => [v[0], v[1]])).area);
const inclined = stationPolygon(frame, skin, transom(0, 0.6));
near(area(inclined), 1.5); // a >= 1-z/2, 0 <= z <= 2, a <= 1.25
near(area(stationPolygon(frame, skin, transom(0.3, -0.3))), 2.25);
near(area(stationPolygon(frame, skin, transom(0.3, 0.3))), 1.5);
near(area(stationPolygon(frame, skin, transom(0.3 + 1e-13, 0.3))), 1.5);
const other = { px: 0.75, py: 1, nx: -0.6, ny: -0.8 };
const otherSkin = [0, 0, 1.25].map((a, i): Vec3 => [
  other.px + a * other.nx,
  other.py + a * other.ny,
  i === 0 ? 2 : 0,
]);
const noCentreline = stationPolygon(other, otherSkin, transom(0.15, 0.15));
near(area(noCentreline), 2); // vertical transom: a <= 1, BEFORE aC=1.25
assert.ok(noCentreline.every((p) => p[0] <= 1 + 1e-12));
assert.equal(stationPolygon(frame, skin, transom(2, 2)).length, 0);

// A constant-integrand quadrature fixture isolates cut() from loft/tessellation.
// At w=1: V(w)=w/2+w²/2, KB=7/12, A=1.5, I_transverse=0.18.
const column: Column = {
  ...frame,
  u: 0,
  x: 0,
  speed: 1,
  kSpeed: 0,
  aC: 1.25,
  poly: inclined,
  topA: 0,
  topZ: 2,
  topIsSheer: true,
  keel: false,
  f: inclined.map(() => 0),
};
const geom: StationGeom = {
  cols: [column, { ...column, u: 1, f: inclined.map(() => 0) }],
  keelZ: 0,
  lowestSheerZ: 2,
  cosRake: 1,
  sinRake: 0,
};
const analytic = cut(geom, 0, 1, true);
near(analytic.vol, 1);
near(analytic.zB, 7 / 12);
near(analytic.wp!.area, 1.5);
near(analytic.wp!.cx, 0.525);
near(analytic.wp!.cy, 0);
near(analytic.wp!.it, 0.18);
near(analytic.wp!.il, 0.0253125);
near(analytic.wsa, 0.5); // only the surviving bottom skin, not the sloping transom closure
assert.equal(
  analytic.waterlineSkin[0].length,
  0,
  "This waterplane meets a transom, not skin",
);
assert.ok(
  analytic.waterline.length >= 3,
  "The full waterline must still be available",
);
const detached: StationGeom = {
  ...geom,
  cols: geom.cols.map((c) => ({
    ...c,
    ...other,
    poly: noCentreline,
    f: noCentreline.map(() => 0),
  })),
};
const detachedCut = cut(detached, 0, 1, true);
near(detachedCut.wp!.area, 2);
near(detachedCut.wp!.it, 2 * (1 - 0.8 + 0.64 / 3));
assert.equal(
  detachedCut.waterline.length,
  0,
  "Do not invent a join between disconnected mirrored boundaries",
);
// Longitudinal gaps must not be bridged just because every individual section
// has a single waterplane interval. Numerical integration is still available.
const splitGeom: StationGeom = {
  ...geom,
  cols: [0, 0.25, 0.5, 0.75, 1].map((u) => ({
    ...column,
    u,
    poly: u === 0.5 ? [] : inclined,
    f: inclined.map(() => 0),
  })),
};
const split = cut(splitGeom, 0, 1, true);
assert.ok(split.vol > 0 && split.wp!.area > 0);
assert.equal(split.waterline.length, 0, "Do not bridge an empty column");

// If the inner boundary leaves and returns to the centreline, joining just its
// first/last centreline points fills a hole. The single-loop DTO cannot draw it.
const holeGeom: StationGeom = {
  ...geom,
  cols: [column, { ...detached.cols[0], u: 0.5 }, geom.cols[1]],
};
const hole = cut(holeGeom, 0, 1, true);
assert.ok(hole.vol > 0 && hole.wp!.area > 0);
assert.equal(hole.waterline.length, 0, "Do not fill an interior boundary gap");

// A re-entrant section crosses the waterplane four times: integrate two
// intervals, not the entire outermost-crossing-to-centreline width.
const reentrant: Column["poly"] = [
  [0, 0, 1],
  [4, 0, 0],
  [4, 2, 1],
  [3, 2, 1],
  [3, 1, 1],
  [1, 1, 1],
  [1, 2, 1],
  [0, 2, 1],
];
const reentrantGeom: StationGeom = {
  ...geom,
  cols: geom.cols.map((c) => ({
    ...c,
    px: 0,
    py: 4,
    nx: 0,
    ny: -1,
    aC: 4,
    poly: reentrant,
    f: reentrant.map(() => 0),
  })),
};
const gaps = cut(reentrantGeom, 0, 1.5, true);
near(gaps.vol, 10);
near(gaps.wp!.area, 4);
near(gaps.wp!.it, 76 / 3);
assert.equal(
  gaps.waterline.length,
  0,
  "A single-loop outline cannot represent gaps",
);
console.log(
  "  ok: analytic inclined/reversed/vertical closures, transom-only waterplanes and skin provenance",
);

// Complete models: the new polygon construction must also handle top cuts,
// transom-only interior columns, opposite rake and the vertical-transom limit.
for (const [top, bottom] of [
  [190, 475],
  [350, 350],
  [475, 190],
  [350, 350.00001],
])
  for (const rake of [0, 0.07]) {
    const hull = defaultHull(),
      model = assemble({
        ...hull,
        deckRake: rake,
        transom: hull.transom.map((p, i) => ({
          ...p,
          x: i === 0 ? top : bottom,
        })),
      });
    const sampling = computeHullSampling(model, 320, 10),
      g = stationGeometry(model, sampling)!,
      w = -model.waterline;
    assert.equal(
      g.cols.length,
      sampling.columns.length,
      "Keep empty columns as zero quadrature endpoints",
    );
    if (top === 190 && bottom === 475) {
      const closureOnly = g.cols.filter(
        (c, i) => c.poly.length >= 3 && sampling.columns[i].pts.length < 2,
      );
      assert.ok(
        closureOnly.length > 0,
        "Do not omit interior columns just because their skin was trimmed away",
      );
      assert.ok(
        closureOnly.every((c) => c.poly.every((p) => p[2] === 0)),
        "Closure-only columns contribute no shell area",
      );
    }
    for (const c of g.cols)
      for (const p of c.poly) {
        const x = c.px + p[0] * c.nx,
          [a, b] = model.transom,
          xt = a.x + ((b.x - a.x) * (p[1] - a.z)) / (b.z - a.z);
        assert.ok(x >= xt - 1e-7, "No solid vertex is behind the transom");
      }
    for (const heel of [0, 0.15]) {
      const actual = cut(g, heel, w, true),
        oracle = meshImmersed(model, sampling, g.keelZ, heel, w);
      assert.equal(actual.deckDown, false);
      assert.ok(
        actual.waterline.length >= 3,
        "A connected dry-deck waterplane must retain its outline",
      );
      near(actual.vol / oracle.vol, 1, 1e-4); // 0.01%, including vertical transom quadrature
      near(
        actual.yB * Math.cos(heel) +
          (actual.zBWorld - g.keelZ) * Math.sin(heel),
        oracle.kn,
        0.025,
      ); // mm
    }
    const actual = cut(g, 0, w, true),
      h = 0.01,
      below = cut(g, 0, w - h),
      above = cut(g, 0, w + h),
      wp = actual.wp!;
    near((above.vol - below.vol) / (2 * h) / wp.area, 1, 2e-7);
    const worldX = (c: ReturnType<typeof cut>) =>
      c.xB * g.cosRake - c.zB * g.sinRake;
    near(
      (above.vol * worldX(above) - below.vol * worldX(below)) /
        (2 * h) /
        (wp.area * wp.cx),
      1,
      2e-7,
    );
    // Initial KMt must agree with a fixed-volume small-angle KN derivative.
    const phi = 1e-4;
    let lo = w - 10,
      hi = w + 10;
    for (let i = 0; i < 45; i++) {
      const mid = (lo + hi) / 2;
      if (cut(g, phi, mid).vol < actual.vol) lo = mid;
      else hi = mid;
    }
    const heeled = cut(g, phi, (lo + hi) / 2);
    const kmt = actual.zBWorld - g.keelZ + wp.it / actual.vol;
    near(
      (heeled.yB * Math.cos(phi) + (heeled.zBWorld - g.keelZ) * Math.sin(phi)) /
        Math.sin(phi),
      kmt,
      0.002,
    );
    console.log(
      `  ok: transom ${top}/${bottom}, trim ${rake}: mesh agreement, dV/dw, first moment and KMt`,
    );
  }

// Detailed independent geometry comparison: CB, both waterplane moments, and
// convergence. The triangle kernel and the sweep do not share integration math.
for (const rake of [0, 0.07])
  for (const n of [160, 640]) {
    const model = assemble({ ...defaultHull(), deckRake: rake }),
      sampling = computeHullSampling(model, n, 10),
      g = stationGeometry(model, sampling)!;
    const w = -model.waterline,
      actual = cut(g, 0, w, true),
      oracle = meshImmersed(model, sampling, g.keelZ, 0, w);
    near(actual.vol / oracle.vol, 1, n === 640 ? 3e-6 : 1.1e-4);
    if (n !== 160) continue;
    const mesh = camberPlaneMesh(model, sampling),
      sr = Math.sin(rake),
      cr = Math.cos(rake);
    const im = meshImmersion(
      mesh,
      {
        origin: V.scale([sr, 0, cr], w * 0.001),
        u: [cr, 0, -sr],
        v: [0, 1, 0],
      },
      true,
    );
    assert.ok(im.centroid);
    near(actual.xB * 0.001, im.centroid[0], 0.0003);
    near(actual.zB * 0.001, im.centroid[2], 0.0001);
    assert.ok(im.waterplane);
    assert.equal(im.waterplane.status, "available");
    if (im.waterplane.status !== "available") throw Error("No mesh waterplane");
    const m = im.waterplane.value.measurements;
    assert.ok(
      m.area.status === "available" && m.moments.status === "available",
    );
    if (m.area.status !== "available" || m.moments.status !== "available")
      throw Error("No mesh moments");
    near((actual.wp!.area * 1e-6) / m.area.value, 1, 0.001);
    near((actual.wp!.it * 1e-12) / m.moments.value.uu, 1, 0.002);
    near((actual.wp!.il * 1e-12) / m.moments.value.vv, 1, 0.003);
    const table = crossCurves(model, sampling)!;
    assert.ok(limitingKgCurve(g, table).length > 2);
  }
console.log(
  "  ok: independent CB/waterplane moments and dry-volume convergence below 0.0003%",
);
