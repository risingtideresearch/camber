import assert from "node:assert/strict";
import { defaultHull } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import type { Vec3 } from "../src/core/math";
import type { SectionLimits } from "../src/core/sheet/boundaries";
import {
  closedHullTriangles,
  createPlaneIntersector,
  intersectPlane,
  sectionFromSegments,
  type CutTriangle,
} from "../src/core/sheet/planeCuts";

const identity = (p: Vec3) => p;
function box(x = 0, y = 0, size = 1): CutTriangle[] {
  const points: Vec3[] = [
    [x, y, 0],
    [x + size, y, 0],
    [x + size, y + size, 0],
    [x, y + size, 0],
    [x, y, size],
    [x + size, y, size],
    [x + size, y + size, size],
    [x, y + size, size],
  ];
  return [
    [0, 3, 2, 1],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
    [4, 5, 6, 7],
  ].flatMap(([a, b, c, d], i) => [
    { points: [points[a], points[b], points[c]] as const, skin: i !== 5 },
    { points: [points[a], points[c], points[d]] as const, skin: i !== 5 },
  ]);
}

// Compare full results (including contour order and skin tags), or the exact
// error. Broad-phase filtering must never suppress coplanar/open-boundary errors.
function compare(triangles: readonly CutTriangle[], scale = 1) {
  const indexed = createPlaneIntersector(triangles);
  const toSheet = (p: Vec3): Vec3 => [
    p[0] * scale + 1,
    p[1] * scale,
    p[2] * scale - 2,
  ];
  const toBoundary = (p: Vec3): Vec3 => [
    p[0] * scale,
    p[1] * scale,
    p[2] * scale,
  ];
  return (normal: Vec3, offset: number, limits: SectionLimits = {}) => {
    const args = [normal, offset, toSheet, scale, limits, toBoundary] as const;
    let expected;
    try {
      expected = intersectPlane(triangles, ...args);
    } catch (error) {
      assert.throws(() => indexed(...args), {
        message: (error as Error).message,
      });
      return;
    }
    assert.deepEqual(indexed(...args), expected);
  };
}

const normals: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
  [0.6, 0, 0.8],
  [0, -0.8, 0.6],
  [1, 0, 0], // revisit after cache eviction
];
for (const mesh of [
  [],
  box(),
  box().slice(2),
  [...box(), ...box(0, 2)],
  [...box(0, 0, 3), ...box(0, 1)],
]) {
  const check = compare(mesh);
  for (const normal of normals)
    for (const offset of [
      -5,
      -1e-8,
      0,
      0.5e-8,
      1e-8,
      2e-8,
      0.125,
      0.5,
      1 - 1e-8,
      1,
      1 + 1e-8,
      5,
    ]) {
      check(normal, offset);
      check(normal, offset, {
        topHeight: 0.8,
        bottomHeight: 0.2,
        starboardOffset: 0.6,
      });
    }
}

// Bin boundaries and mesh-global epsilon, including cuts close to a small box
// alongside a distant, much larger extent. Candidate-local epsilon is wrong.
const mixed = [...box(), ...box(10000, 0, 100)];
const mixedCheck = compare(mixed);
const eps = 10100 * 1e-8;
for (const offset of [
  -2 * eps,
  -eps,
  -eps / 2,
  0,
  eps / 2,
  eps,
  2 * eps,
  1 - eps,
  1,
  1 + eps,
])
  mixedCheck([1, 0, 0], offset);
const low = -2 * eps,
  high = 10100 + 2 * eps;
for (let i = 0; i <= 128; i++) {
  const edge = low + ((high - low) * i) / 128;
  for (const delta of [-eps, 0, eps]) mixedCheck([1, 0, 0], edge + delta);
}

// Real hull geometry, multiple orientations, unit conversion and active limits.
const model = assemble(defaultHull());
const hull = closedHullTriangles(computeHullSampling(model, 40, 4));
const hullCheck = compare(hull, 0.001);
for (const normal of normals)
  for (let i = 0; i <= 24; i++) {
    const offset = -1500 + i * 300;
    hullCheck(normal, offset);
    hullCheck(normal, offset, {
      topHeight: -0.1,
      bottomHeight: -0.8,
      aftPosition: 0.2,
    });
  }

// Deterministic work regression: after indexing, distant triangles must not be
// read at all. This avoids timing assertions sensitive to machine load.
let reads = 0;
const separated = Array.from({ length: 128 }, (_, i) => box(i * 2)).flat();
const counted = separated.map((triangle) => ({
  skin: triangle.skin,
  get points() {
    reads++;
    return triangle.points;
  },
}));
const intersect = createPlaneIntersector(counted);
intersect([1, 0, 0], 0.4, identity, 1);
reads = 0;
const result = intersect([1, 0, 0], 0.6, identity, 1);
assert.equal(result.measures.area.amount, 1);
assert.ok(
  reads > 0 && reads < separated.length / 10,
  `${reads} candidate reads of ${separated.length} triangles`,
);

// Endpoint fast path must still weld near-but-not-exact coordinates via the
// tolerance search; fresh Vec3 objects must also match exactly by coordinates.
const contour: Vec3[] = [
  [0, 0, 0],
  [0, 1, 0],
  [0, 1, 1],
  [0, 0, 1],
];
const segments = contour.map((p, i) => ({
  points: [[...p] as Vec3, [...contour[(i + 1) % 4]] as Vec3] as const,
  skin: true,
}));
const exact = sectionFromSegments(segments, [1, 0, 0], 0, identity, 1);
const perturbed = segments.map((segment) => ({
  ...segment,
  points: [
    segment.points[0],
    segment.points[1].map((v, axis) => v + (axis === 1 ? 1e-10 : 0)) as Vec3,
  ] as const,
}));
const welded = sectionFromSegments(perturbed, [1, 0, 0], 0, identity, 1);
assert.equal(welded.contours.length, 1);
assert.equal(welded.segments.length, 4);
assert.ok(
  Math.abs(welded.measures.area.amount - exact.measures.area.amount) < 1e-8,
);
console.log(
  "Indexed plane cuts: full-scan equivalence, tolerances, clipping, errors and candidate work passed",
);
