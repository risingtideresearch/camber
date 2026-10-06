import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Ajv from "ajv";
import {
  buildHydrostaticTable,
  buildHydrostaticTableJson,
} from "../src/core/hydrostaticExport";
import { defaultHull } from "../src/core/hull";
import {
  prepareImmersionSweep,
  sweepBuoyancy,
} from "../src/core/immersionSweep";
import { buildJson, convertUnits, parseDocument } from "../src/core/json";
import {
  computeHullSampling,
  type HullSampling,
  type HullSample,
} from "../src/core/mesh";
import type { Model } from "../src/core/model";
import { assemble } from "../src/core/runtime";
import {
  cut,
  heightSpan,
  prepareBuoyancySweep,
  stationGeometry,
} from "../src/core/sweep";
import type { HydrostaticTable } from "../src/core/hydrostaticTable";

const require = createRequire(import.meta.url);
const contract = "@risingtideresearch/chartroom/formats/hydrostatic-table/v1";
const schema = JSON.parse(
  readFileSync(require.resolve(`${contract}/schema.json`), "utf8"),
);
const validate = new Ajv({ allErrors: true }).compile(schema);
// Exercise a full-contract document as well as Camber's narrower exporter output.
const example = JSON.parse(
  readFileSync(require.resolve(`${contract}/examples/box.json`), "utf8"),
);
assert.ok(validate(example), JSON.stringify(validate.errors));
const RAD = Math.PI / 180;
const near = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);
function check(table: HydrostaticTable) {
  assert.ok(validate(table), JSON.stringify(validate.errors));
  const heels = new Set(table.table.rows.map((r) => r.heelDeg));
  const trims = new Set(table.table.rows.map((r) => r.trimDeg));
  assert.equal(table.table.rows.length, heels.size * trims.size);
  for (const [i, row] of table.table.rows.entries()) {
    if (i) {
      const prev = table.table.rows[i - 1];
      assert.ok(
        row.trimDeg > prev.trimDeg ||
          (row.trimDeg === prev.trimDeg && row.heelDeg > prev.heelDeg),
      );
    }
    for (const [j, s] of row.samples.entries()) {
      assert.ok(
        Number.isFinite(s.waterplaneOffsetM) && Number.isFinite(s.volumeM3),
      );
      assert.equal(s.buoyancyCenterM === null, s.volumeM3 === 0);
      if (j) {
        assert.ok(s.waterplaneOffsetM > row.samples[j - 1].waterplaneOffsetM);
        assert.ok(s.volumeM3 >= row.samples[j - 1].volumeM3);
      }
      if (s.waterplane) {
        const p = row.heelDeg * RAD,
          t = row.trimDeg * RAD;
        const n = [
          Math.sin(t) * Math.cos(p),
          Math.sin(p),
          Math.cos(t) * Math.cos(p),
        ];
        near(
          s.waterplane.centroidM.reduce((sum, v, k) => sum + v * n[k], 0),
          s.waterplaneOffsetM,
        );
        assert.equal("xy" in s.waterplane.secondMomentsM4, false);
      }
    }
  }
}

// Independent rectangular-section fixture: x=[0,4], y=[-1,1], z=[-2,0].
// The real sweep integrates these planar polygons, whose buoyancy is analytic.
const BOX_INTERVALS = 100;
const BOX_VARIANCE_X = 4 / 3 + 16 / (6 * BOX_INTERVALS ** 2); // exact trapezoidal x² integral
function box(
  scale = 1,
  unit: "m" | "mm" = "m",
): { model: Model; sampling: HullSampling } {
  const runtime = assemble({ ...defaultHull(), unit, waterline: scale });
  const model: Model = {
    ...runtime,
    plan: {
      ...runtime.plan,
      at: (u: number) => [4 * u * scale, scale],
      d: () => [4 * scale, 0],
    },
    trimZ: () => 0,
  };
  const base = computeHullSampling(assemble(defaultHull()), 8, 2);
  const vertex = (x: number, y: number, z: number): HullSample => ({
    ...base.sheet[0][0],
    pos: [x * scale, y * scale, z * scale],
  });
  const xs = Array.from(
    { length: BOX_INTERVALS + 1 },
    (_, i) => (4 * i) / BOX_INTERVALS,
  );
  const top = xs.map((x) => vertex(x, 1, 0));
  return {
    model,
    sampling: {
      ...base,
      uParams: xs.map((x) => x / 4),
      hullSheer: top,
      columns: xs.map((x, i) => ({
        i,
        keel: true,
        transom: false,
        pts: [top[i], vertex(x, 1, -2), vertex(x, 0, -2)],
      })),
    },
  };
}
const b = box();
const table = buildHydrostaticTable(
  b.model,
  { heelDeg: [10, 0, -10], trimDeg: [2, 0, -2], immersionSteps: 32 },
  undefined,
  b.sampling,
);
check(table);
assert.deepEqual(table.frame.knReferenceM, [0, 0, -2]);
for (const row of table.table.rows) {
  assert.equal(row.samples[0].volumeM3, 0);
  const full = row.samples[row.samples.length - 1];
  near(full.volumeM3, 16);
  full.buoyancyCenterM!.forEach((v, i) => near(v, [2, 0, -1][i]));
  const middle = row.samples.find((s) => Math.abs(s.volumeM3 - 8) < 1e-9)!;
  const p = row.heelDeg * RAD,
    t = row.trimDeg * RAD;
  const a = Math.sin(t) * Math.cos(p),
    bb = Math.sin(p),
    c = Math.cos(t) * Math.cos(p);
  near(middle.waterplaneOffsetM, 2 * a - c);
  near(middle.buoyancyCenterM![0], 2 - (a * BOX_VARIANCE_X) / c);
  near(middle.buoyancyCenterM![1], (-bb * (1 / 3)) / c);
  near(
    middle.buoyancyCenterM![2],
    -1.5 + (a * a * BOX_VARIANCE_X + bb * bb * (1 / 3)) / (2 * c * c),
  );
}
const upright = table.table.rows.find(
  (r) => r.heelDeg === 0 && r.trimDeg === 0,
)!;
const design = upright.samples.find((s) => s.waterplaneOffsetM === -1)!;
near(design.volumeM3, 8);
design.buoyancyCenterM!.forEach((v, i) => near(v, [2, 0, -1.5][i]));
near(design.waterplane!.areaM2, 8);
near(design.waterplane!.secondMomentsM4.xx, 8 * BOX_VARIANCE_X);
near(design.waterplane!.secondMomentsM4.xx, 32 / 3, 3e-4); // converges to the continuous box
near(design.waterplane!.secondMomentsM4.yy, 8 / 3);
assert.deepEqual(table.referenceState, {
  heelDeg: 0,
  trimDeg: 0,
  waterplaneOffsetM: -1,
});
assert.ok(table.immersionMarkers![0].pointsM.some((p) => p[1] === -1));
assert.ok(table.immersionMarkers![0].pointsM.some((p) => p[1] === 1));
assert.ok(table.notes.some((n) => n.includes("downflooding")));
assert.equal("wettedAreaM2" in design, false);
// Known volume does not imply a measurable waterplane, especially with a loaded
// deck cap. Do not serialize null or a made-up zero moment for those states.
assert.equal(
  "waterplane" in upright.samples[upright.samples.length - 1],
  false,
);
const inverted = buildHydrostaticTable(
  b.model,
  { heelDeg: [-180, -90, 0, 90, 180], trimDeg: [0], immersionSteps: 16 },
  undefined,
  b.sampling,
);
check(inverted);
const upsideDown = inverted.table.rows[
  inverted.table.rows.length - 1
].samples.find((s) => Math.abs(s.volumeM3 - 8) < 1e-8)!;
near(upsideDown.buoyancyCenterM![2], -0.5);
assert.equal("waterplane" in upsideDown, false);
const mm = box(1000, "mm");
const millimetres = buildHydrostaticTable(
  mm.model,
  { heelDeg: [-10, 0, 10], trimDeg: [-2, 0, 2], immersionSteps: 32 },
  undefined,
  mm.sampling,
);
check(millimetres);
for (const [i, row] of table.table.rows.entries())
  for (const [j, s] of row.samples.entries()) {
    const converted = millimetres.table.rows[i].samples[j];
    near(converted.waterplaneOffsetM, s.waterplaneOffsetM);
    near(converted.volumeM3, s.volumeM3);
    s.buoyancyCenterM?.forEach((v, k) =>
      near(converted.buoyancyCenterM![k], v),
    );
    if (s.waterplane) {
      near(converted.waterplane!.areaM2, s.waterplane.areaM2);
      near(
        converted.waterplane!.secondMomentsM4.yy,
        s.waterplane.secondMomentsM4.yy,
      );
    }
  }

// Prepared buoyancy sweeps must preserve the full cut's numerical results, not
// merely schema conformance. Include tangent planes, dry/full plateaus, extreme
// trim, station-parallel cuts, inversion and re-entrant skin crossings. Interleave
// other cuts to ensure reuse does not depend on the column's mutable f scratch.
function compareSweeps(model: Model, sampling: HullSampling) {
  const base = stationGeometry(model, sampling)!;
  const lengthScale = Math.max(
    ...base.cols.flatMap((c) => [
      Math.abs(c.px),
      Math.abs(c.py),
      ...c.poly.flatMap((v) => [Math.abs(v[0]), Math.abs(v[1])]),
    ]),
  );
  for (const trimDeg of [-89, -5, 0, 3, 89]) {
    const g = {
      ...base,
      cosTrim: Math.cos(trimDeg * RAD),
      sinTrim: Math.sin(trimDeg * RAD),
    };
    for (const heelDeg of [-180, -120, -90, -30, 0, 30, 90, 120, 180]) {
      const heel = heelDeg * RAD;
      const sweep = prepareBuoyancySweep(g, heel);
      assert.deepEqual(sweep.heightSpan, heightSpan(g, heel));
      const [lo, hi] = sweep.heightSpan;
      const span = hi - lo;
      const offsets = [
        ...new Set([
          lo - span * 1e-8,
          lo,
          lo + span * 1e-12,
          lo + span * 1e-10,
          lo + span * 1e-8,
          ...Array.from({ length: 7 }, (_, i) => lo + (span * (i + 1)) / 8),
          hi - span * 1e-8,
          hi - span * 1e-10,
          hi - span * 1e-12,
          hi,
          hi + span * 1e-8,
        ]),
      ].sort((a, b) => a - b);
      const middleBefore = sweep.cut(offsets[4]);
      const incremental = sweepBuoyancy(g, heel, offsets);
      for (const [sample, h] of offsets.entries()) {
        const expected = cut(g, heel, h, true);
        const actual = sweep.cut(h);
        const inc = incremental[sample];
        near(inc.vol / lengthScale ** 3, expected.vol / lengthScale ** 3);
        assert.equal(inc.vol > 0, expected.vol > 0);
        for (const key of ["xB", "yB", "zB"] as const)
          near(inc[key] / lengthScale, expected[key] / lengthScale);
        assert.equal(inc.deckDown, expected.deckDown);
        const wp = expected.deckDown ? null : expected.wp;
        assert.equal(inc.wp === null, wp === null);
        if (inc.wp && wp) {
          near(inc.wp.area / lengthScale ** 2, wp.area / lengthScale ** 2);
          for (const key of ["cx", "cy"] as const)
            near(inc.wp[key] / lengthScale, wp[key] / lengthScale);
          for (const key of ["it", "il"] as const)
            near(inc.wp[key] / lengthScale ** 4, wp[key] / lengthScale ** 4);
        }
        for (const key of ["vol", "xB", "yB", "zB", "deckDown"] as const)
          assert.equal(
            actual[key],
            expected[key],
            `${key}: ${heelDeg}/${trimDeg}/${h}`,
          );
        assert.deepEqual(actual.wp, expected.deckDown ? null : expected.wp);
      }
      // Evaluate a previously queried partial cut after the fully immersed one.
      assert.deepEqual(sweep.cut(offsets[4]), middleBefore);
    }
  }
}
compareSweeps(b.model, b.sampling);
compareSweeps(mm.model, mm.sampling);
const reentrant = {
  ...b.sampling,
  columns: b.sampling.columns.map((c) => ({
    ...c,
    pts: [
      c.pts[0],
      {
        ...c.pts[0],
        pos: [c.pts[0].pos[0], 0.3, -0.4] as [number, number, number],
      },
      {
        ...c.pts[0],
        pos: [c.pts[0].pos[0], 0.9, -1.2] as [number, number, number],
      },
      c.pts[c.pts.length - 1],
    ],
  })),
};
compareSweeps(b.model, reentrant);

// Cached outlines are immutable; each row has fresh event state, and invalid
// offset order must fail instead of accidentally reusing a later immersion.
const boxGeom = stationGeometry(b.model, b.sampling)!;
const boxRow = prepareImmersionSweep(boxGeom);
const boxOffsets = Object.freeze([
  -3, -2, -1.999999999, -1.8, -1.2, -0.2, 0, 1,
]);
const geometryBefore = structuredClone(boxGeom);
const boxRowBefore = boxRow(0, boxOffsets);
boxRow(120 * RAD, boxOffsets);
assert.deepEqual(boxRow(0, boxOffsets), boxRowBefore);
assert.deepEqual(boxGeom, geometryBefore);
assert.deepEqual(boxRow(0, []), []);
for (const offsets of [[0, 0], [1, 0], [NaN], [Infinity]])
  assert.throws(() => boxRow(0, offsets));
assert.throws(() => boxRow(NaN, [-1, 0]));

// Boundary moments must not assume a winding direction. Reverse the polygon
// and transfer each leaving-edge skin flag to the reversed edge's start.
const reversedGeom = {
  ...boxGeom,
  cols: boxGeom.cols.map((c) => ({
    ...c,
    poly: c.poly.map((_, i) => {
      const j = c.poly.length - 1 - i;
      return [
        c.poly[j][0],
        c.poly[j][1],
        c.poly[(j + c.poly.length - 1) % c.poly.length][2],
      ] as [number, number, number];
    }),
  })),
};
for (const heel of [-120, -30, 0, 30, 120].map((v) => v * RAD)) {
  const offsets = [-3, -2, -1.9, -1.7, -1, -0.2, 0, 1, 2];
  const incremental = sweepBuoyancy(reversedGeom, heel, offsets);
  for (const [i, h] of offsets.entries()) {
    const expected = cut(reversedGeom, heel, h, true);
    const actual = incremental[i];
    for (const key of ["vol", "xB", "yB", "zB"] as const)
      near(actual[key], expected[key]);
    assert.deepEqual(actual.deckDown, expected.deckDown);
    const wp = expected.deckDown ? null : expected.wp;
    assert.equal(actual.wp === null, wp === null);
    if (actual.wp && wp)
      for (const key of ["area", "cx", "cy", "it", "il"] as const)
        near(actual.wp[key], wp[key]);
  }
}

// The default full angular grid also conforms, including heels beyond 90°.
const fullGrid = buildHydrostaticTable(assemble(defaultHull()), {
  immersionSteps: 8,
  numSections: 40,
  girthSteps: 4,
});
check(fullGrid);
assert.equal(fullGrid.table.rows.length, 219);
assert.equal(fullGrid.table.rows[0].heelDeg, -180);
assert.equal(fullGrid.table.rows[218].heelDeg, 180);

// Real authored model, nonzero trim, source metadata and pure exported state.
const hull = { ...defaultHull(), name: "Export test", deckTrim: 3 * RAD };
const model = assemble(hull);
const before = buildJson(hull);
const updates: [number, number][] = [];
const real = buildHydrostaticTable(
  model,
  {
    heelDeg: [0, 10],
    trimDeg: [0, 3],
    immersionSteps: 16,
    numSections: 80,
    girthSteps: 6,
    generatedAt: "2026-01-01T00:00:00.000Z",
  },
  (done, total) => updates.push([done, total]),
);
check(real);
assert.equal(buildJson(hull), before);
assert.deepEqual(updates, [
  [0, 4],
  [1, 4],
  [2, 4],
  [3, 4],
  [4, 4],
]);
assert.equal(real.source.generatedAt, "2026-01-01T00:00:00.000Z");
assert.equal("density" in real, false);
assert.equal("cg" in real, false);
assert.equal("mesh" in real, false);
const sampling = computeHullSampling(model, 80, 6),
  geom = stationGeometry(model, sampling)!;
compareSweeps(model, sampling);
for (const s of real.table.rows.find(
  (r) => r.heelDeg === 10 && r.trimDeg === 3,
)!.samples)
  if (s.volumeM3 > 0) {
    const expected = cut(geom, 10 * RAD, s.waterplaneOffsetM * 1000);
    near(s.volumeM3, expected.vol / 1e9);
    near(s.buoyancyCenterM![0], expected.xB / 1000);
    near(s.buoyancyCenterM![1], -expected.yB / 1000);
    near(s.buoyancyCenterM![2], expected.zB / 1000);
  }
// K stays body-fixed, even when the authored trim changes.
const neutral = buildHydrostaticTable(assemble({ ...hull, deckTrim: 0 }), {
  heelDeg: [0],
  trimDeg: [0],
  immersionSteps: 16,
  numSections: 80,
  girthSteps: 6,
});
assert.deepEqual(real.frame.knReferenceM, neutral.frame.knReferenceM);
assert.deepEqual(real.referenceState, {
  heelDeg: 0,
  trimDeg: 3,
  waterplaneOffsetM: -hull.waterline / 1000,
});
const uprightOnly = buildHydrostaticTable(model, {
  heelDeg: [0],
  trimDeg: [0],
  immersionSteps: 16,
  numSections: 80,
  girthSteps: 6,
});
assert.equal(uprightOnly.referenceState, undefined); // design trim is outside coverage
const defaultTrim = buildHydrostaticTable(model, {
  heelDeg: [0],
  immersionSteps: 16,
  numSections: 80,
  girthSteps: 6,
});
assert.ok(defaultTrim.referenceState);
check(defaultTrim);
// A design waterplane outside coverage is omitted, not silently clamped.
const outside = buildHydrostaticTable(
  { ...b.model, waterline: 100 },
  { heelDeg: [0], trimDeg: [0], immersionSteps: 4 },
  undefined,
  b.sampling,
);
assert.equal(outside.referenceState, undefined);

// Real unit conversion, in addition to the independent box fixture.
const parsed = parseDocument(before),
  metreHull = structuredClone(parsed.hull);
convertUnits(metreHull, "m");
const metreState = {
  ...metreHull,
  waterline: hull.waterline / 1000,
  deckTrim: 0,
};
const metreExport = buildHydrostaticTable(assemble(metreState), {
  heelDeg: [0],
  trimDeg: [0],
  immersionSteps: 16,
  numSections: 80,
  girthSteps: 6,
});
for (const [i, s] of neutral.table.rows[0].samples.entries()) {
  near(metreExport.table.rows[0].samples[i].volumeM3, s.volumeM3, 1e-6);
  near(
    metreExport.table.rows[0].samples[i].waterplaneOffsetM,
    s.waterplaneOffsetM,
    1e-6,
  );
}
assert.ok(
  JSON.parse(
    buildHydrostaticTableJson(model, {
      heelDeg: [0],
      trimDeg: [0],
      immersionSteps: 4,
      numSections: 20,
      girthSteps: 2,
    }),
  ).format === "hydrostatic-table",
);
for (const opts of [
  { heelDeg: [] },
  { heelDeg: [181] },
  { heelDeg: [NaN] },
  { trimDeg: [90] },
  { trimDeg: [-90] },
  { trimDeg: [] },
  { immersionSteps: 1 },
  { numSections: NaN },
  { girthSteps: 0 },
])
  assert.throws(() => buildHydrostaticTable(model, opts));
console.log(
  "Hydrostatic export: schema, analytical box, coordinate rotation, SI units, dry/full states, availability, metadata and invalid requests passed.",
);
