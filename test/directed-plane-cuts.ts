import assert from "node:assert/strict";
import { defaultHull } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import type { Vec3 } from "../src/core/math";
import { createDirectedProjectionLookup } from "../src/core/sheet/directedProjection";
import {
  clipDirectedSegments,
  validateDirectedSegments,
} from "../src/core/sheet/directedSegments";
import type { SectionLimits } from "../src/core/sheet/boundaries";
import {
  indexOrientedMesh,
  orientedHullTriangles,
  validateOrientedMesh,
} from "../src/core/sheet/orientedMesh";
import {
  createDirectedPlaneIntersector as createGraphPlaneIntersector,
  createDirectedPlaneMeasurer,
} from "../src/core/sheet/directedPlaneCuts";
import { type CutTriangle, type PlaneCut } from "../src/core/sheet/planeCuts";
import { closedHullTriangles, intersectPlane } from "./legacyPlaneCuts";
import {
  MEASURE_NAMES,
  type SectionMeasures,
} from "../src/core/sheet/sectionMeasures";

import {
  createSectionMeasurer,
  createSliceMeasurer,
} from "../src/core/sheet/slices";
import { measureRepetition } from "../src/core/sheet/repetitions";

const identity = (p: Vec3) => p;
function box(origin: Vec3 = [0, 0, 0], size = 1): CutTriangle[] {
  const points: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ].map((p) => p.map((v, i) => origin[i] + v * size) as Vec3);
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
const reverse = (triangles: readonly CutTriangle[]): CutTriangle[] =>
  triangles.map(({ points: [a, b, c], skin }) => ({ points: [a, c, b], skin }));
function near(a: number, b: number, label: string): void {
  assert.ok(
    Math.abs(a - b) <= 2e-8 * Math.max(1, Math.abs(a), Math.abs(b)),
    `${label}: ${a} != ${b}`,
  );
}
function compareMeasures(a: SectionMeasures, b: SectionMeasures): void {
  for (const name of MEASURE_NAMES) {
    near(a[name].amount, b[name].amount, `buffered ${name}`);
    a[name].moment.forEach((v, i) =>
      near(v, b[name].moment[i], `buffered ${name}.moment.${i}`),
    );
  }
}
// Exercise every graph-path fixture through the measures-only implementation,
// including every rejection. Drawing geometry still gets independently compared
// against the legacy classifier below; analytic checks do not share reducers.
function createDirectedPlaneIntersector(
  ...setup: Parameters<typeof createGraphPlaneIntersector>
) {
  const graph = createGraphPlaneIntersector(...setup),
    buffered = createDirectedPlaneMeasurer(setup[0]),
    fullScan = createDirectedPlaneMeasurer(setup[0], {
      projectionIndex: false,
      cutCacheSize: 0,
    });
  return (...query: Parameters<typeof graph>) => {
    let result: PlaneCut;
    try {
      result = graph(...query);
    } catch (error) {
      assert.throws(() => buffered(...query));
      assert.throws(() => fullScan(...query));
      throw error;
    }
    const measured = buffered(...query);
    compareMeasures(measured, result.measures);
    assert.deepEqual(
      measured,
      fullScan(...query),
      "index must only filter misses, not reorder contributions",
    );
    return result;
  };
}
function compare(a: PlaneCut, b: PlaneCut): void {
  for (const name of MEASURE_NAMES) {
    near(a.measures[name].amount, b.measures[name].amount, name);
    a.measures[name].moment.forEach((v, i) =>
      near(v, b.measures[name].moment[i], `${name}.moment.${i}`),
    );
  }
  assert.equal(a.contours.length, b.contours.length);
  // Closure ladders may choose the opposite diagonal, subdividing identical
  // straight boundaries differently. Compare measures, not closure edge counts.
  assert.equal(a.skinSegments.length, b.skinSegments.length);
}
const cut = createDirectedPlaneIntersector(box());
const center = cut([1, 0, 0], 0.4, identity, 1);
near(center.measures.area.amount, 1, "box area");
near(center.measures.area.moment[0], 0.4, "box moment x");
near(center.measures.area.moment[1], 0.5, "box moment y");
near(center.measures.openLength.amount, 3, "skin only");
near(center.measures.closedLength.amount, 4, "closed");
const clipped = cut([1, 0, 0], 0.4, identity, 1, {
  topHeight: 0.7,
  portOffset: 0.2,
  starboardOffset: 0.8,
});
near(clipped.measures.area.amount, 0.42, "trim area");
near(clipped.measures.area.moment[2], 0.42 * 0.35, "trim moment");
near(clipped.measures.openLength.amount, 0.6, "trim skin excludes closures");
near(clipped.measures.closedLength.amount, 2.6, "trim closed");

// A real cavity is inward-wound. Two nested outward shells are NOT a cavity:
// preserving material orientation is intentional, rather than guessing by nesting.
const hollow = [...box([0, 0, 0], 4), ...reverse(box([1, 1, 1], 2))];
const hollowCut = createDirectedPlaneIntersector(hollow);
const hole = hollowCut([1, 0, 0], 2.13, identity, 1);
near(hole.measures.area.amount, 12, "cavity subtraction");
near(hole.measures.area.moment[1], 24, "cavity moment");
assert.equal(hole.contours.length, 2);
const holeOpened = hollowCut([1, 0, 0], 2.13, identity, 1, { topHeight: 2.5 });
near(holeOpened.measures.area.amount, 7, "opened hole");
assert.equal(holeOpened.contours.length, 1);

const meshes = [
  box(),
  [...box(), ...box([0, 2, 0])],
  hollow,
  [...hollow, ...box([1.5, 1.5, 1.5])],
];
const normals: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.6, 0, 0.8],
  [0, -0.8, 0.6],
];
let comparisons = 0;
for (const mesh of meshes) {
  const directed = createDirectedPlaneIntersector(mesh);
  for (const normal of normals)
    for (const offset of [
      -10, -0.213, 0.137, 0.413, 0.731, 1.137, 2.137, 3.713, 10,
    ])
      for (const limits of [
        {},
        { topHeight: 0.63 },
        {
          topHeight: 2.5,
          bottomHeight: 0.3,
          portOffset: 0.2,
          starboardOffset: 3.7,
        },
      ] satisfies SectionLimits[]) {
        let reference: PlaneCut;
        try {
          reference = intersectPlane(mesh, normal, offset, identity, 1, limits);
        } catch {
          assert.throws(() => directed(normal, offset, identity, 1, limits));
          continue;
        }
        compare(directed(normal, offset, identity, 1, limits), reference);
        comparisons++;
      }
}

// Orientation and signed reductions are independent of face enumeration.
const shuffled = [...hollow.slice(7), ...hollow.slice(0, 7)].reverse();
compare(
  createDirectedPlaneIntersector(shuffled)([1, 0, 0], 2.13, identity, 1),
  hole,
);
// Rake-like affine reporting is deliberately NOT a rigid frame. Amounts remain
// physical; only centroids/moments transform. Also exercise millimetre scaling.
for (const [n, r] of [
  [40, 4],
  [60, 6],
]) {
  const sampling = computeHullSampling(assemble(defaultHull()), n, r);
  const oriented = orientedHullTriangles(sampling),
    legacy = closedHullTriangles(sampling);
  validateOrientedMesh(oriented);
  const directed = createDirectedPlaneIntersector(oriented);
  const scale = 0.001,
    sin = 0.2,
    cos = Math.sqrt(1 - sin * sin);
  const toSheet = (p: Vec3): Vec3 => [
    (p[0] - 123) * scale,
    p[1] * scale,
    (p[0] * sin + p[2] * cos + 456) * scale,
  ];
  const toBoundary = (p: Vec3): Vec3 => [
    (p[0] - (p[2] * sin) / cos - 123) * scale,
    p[1] * scale,
    toSheet(p)[2],
  ];
  const orientations: Vec3[] = [
    [cos, 0, -sin],
    [sin, 0, cos],
    [0, 1, 0],
  ];
  for (const normal of orientations)
    for (let i = 0; i < 31; i++) {
      const offset = -1731.3 + i * 281.37;
      for (const limits of [
        {},
        { topHeight: 0.67 },
        {
          topHeight: 0.87,
          bottomHeight: 0.13,
          aftPosition: 0.3,
          forwardPosition: 5.7,
          portOffset: -0.4,
          starboardOffset: 0.7,
        },
      ] satisfies SectionLimits[]) {
        let reference: PlaneCut;
        try {
          reference = intersectPlane(
            legacy,
            normal,
            offset,
            toSheet,
            scale,
            limits,
            toBoundary,
          );
        } catch {
          assert.throws(() =>
            directed(normal, offset, toSheet, scale, limits, toBoundary),
          );
          continue;
        }
        compare(
          directed(normal, offset, toSheet, scale, limits, toBoundary),
          reference,
        );
        comparisons++;
      }
    }
}

// Exact vertex and edge contacts on a tetrahedron, away from coplanar faces.
const vertices: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const tetra: CutTriangle[] = [
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
].map((ids) => ({
  points: ids.map((i) => vertices[i]) as [Vec3, Vec3, Vec3],
  skin: true,
}));
const tetraCut = createDirectedPlaneIntersector(tetra);
for (const direction of [
  [0, 1, -1],
  [1, 1, -1],
] as Vec3[]) {
  const n = direction.map((v) => v / Math.hypot(...direction)) as Vec3;
  compare(
    tetraCut(n, 0, identity, 1),
    intersectPlane(tetra, n, 0, identity, 1),
  );
}
// A tangent contact along an edge has opposing segment directions and is not
// silently counted twice (nor converted into structural length).
const tangent: Vec3 = [Math.SQRT1_2, Math.SQRT1_2, 0];
assert.throws(
  () => tetraCut(tangent, Math.SQRT1_2, identity, 1),
  /opposing edge contact/,
);

// Coordinate interning occurs once, exactly, at the mesh boundary. Vec3 object
// sharing is not required from callers, but near coordinates are never welded.
const fresh = box().map(({ points, skin }) => ({
  points: points.map((p) => [...p] as Vec3) as [Vec3, Vec3, Vec3],
  skin,
}));
const topology = indexOrientedMesh(fresh);
assert.equal(topology.vertices.length, 8);
assert.equal(topology.edges.length, 18);
assert.equal(topology.faces.length, 12);
compare(
  createDirectedPlaneIntersector(fresh)([1, 0, 0], 0.4, identity, 1),
  center,
);
const crack = fresh.map((t) => ({ ...t }));
const [cracked, b, c] = crack[0].points;
crack[0] = {
  ...crack[0],
  points: [[cracked[0] + 1e-10, cracked[1], cracked[2]], b, c],
};
assert.throws(() => indexOrientedMesh(crack), /oppositely directed/);

// Separate islands closer than the old welding tolerance must remain separate,
// before and after multiple clips. Proximity is not connectivity.
const gap = 1e-10;
const adjacent = createDirectedPlaneIntersector([
  ...box(),
  ...box([0, 1 + gap, 0]),
]);
for (const limits of [
  {},
  { topHeight: 0.8 },
  { topHeight: 0.8, bottomHeight: 0.2, portOffset: 0.1, starboardOffset: 1.9 },
] satisfies SectionLimits[]) {
  const result = adjacent([1, 0, 0], 0.4, identity, 1, limits);
  assert.equal(result.contours.length, 2);
  const width = limits.portOffset === undefined ? 2 : 1.8 - gap;
  const height = (limits.topHeight ?? 1) - (limits.bottomHeight ?? 0);
  near(result.measures.area.amount, width * height, "nearby distinct islands");
  // Endpoint objects really are shared, not just equal within a tolerance.
  const degree = new Map<Vec3, number>();
  for (const segment of result.segments)
    for (const p of segment.points) degree.set(p, (degree.get(p) ?? 0) + 1);
  assert.ok([...degree.values()].every((n) => n === 2));
}

// Clip through existing vertices, mesh-diagonal crossings and previous closure
// edges; repeated calls cannot reuse stale node IDs from a previous cut.
for (const top of [0.4, 0.4 + 1e-10, 0.4 - 1e-10, 0.8, 1])
  for (const limits of [
    { topHeight: top },
    {
      topHeight: top,
      portOffset: 0.4,
      starboardOffset: 0.8,
      bottomHeight: 0.1,
    },
  ] satisfies SectionLimits[])
    compare(
      cut([1, 0, 0], 0.4, identity, 1, limits),
      intersectPlane(box(), [1, 0, 0], 0.4, identity, 1, limits),
    );

// Shared on-plane edges are counted once, even if their two faces have different
// skin tags. The result must not depend on which incident face gets there first.
const taggedTetra = tetra.map((t, i) => ({ ...t, skin: i !== 0 }));
const edgeNormal: Vec3 = [0, Math.SQRT1_2, -Math.SQRT1_2];
for (const mesh of [taggedTetra, [...taggedTetra].reverse()])
  for (const offset of [0, -1e-10, 1e-10])
    compare(
      createDirectedPlaneIntersector(mesh)(edgeNormal, offset, identity, 1),
      intersectPlane(mesh, edgeNormal, offset, identity, 1),
    );

// Two shells sharing one vertex pass edge-incidence validation, but their cut
// can be branched. Retain the per-cut connectivity check after removing welding.
const touching = [
  ...tetra,
  ...reverse(
    tetra.map((t) => ({
      ...t,
      points: t.points.map((p) => p.map((v) => -v) as Vec3) as [
        Vec3,
        Vec3,
        Vec3,
      ],
    })),
  ),
];
const vertexNormal: Vec3 = [
  1 / Math.sqrt(3),
  1 / Math.sqrt(3),
  -1 / Math.sqrt(3),
];
assert.throws(
  () => createDirectedPlaneIntersector(touching)(vertexNormal, 0, identity, 1),
  /branched/,
);

// Projection caching depends on normal, not position, reporting frame or limits.
// Exercise LRU eviction, opposite normals and an empty mesh independently of the
// cutter. Candidate sets must contain every epsilon-contact face at bin seams.
const projectedMesh = indexOrientedMesh(hollow);
const lookup = createDirectedProjectionLookup(projectedMesh, 4e-8);
const firstProjection = lookup([1, 0, 0], 0).projections;
assert.equal(lookup([1, 0, 0], 3).projections, firstProjection);
const secondProjection = lookup([0, 1, 0], 0).projections;
lookup([0, 0, 1], 0);
lookup([-1, 0, 0], 0);
assert.equal(lookup([1, 0, 0], 2).projections, firstProjection); // refresh LRU
lookup([0, -1, 0], 0);
assert.equal(lookup([1, 0, 0], 2).projections, firstProjection);
assert.notEqual(lookup([0, 1, 0], 0).projections, secondProjection); // evicted
assert.equal(lookup([1, 0, 0], 100).faces.length, 0);
assert.equal(
  createDirectedProjectionLookup(indexOrientedMesh([]), 1e-8)([1, 0, 0], 0)
    .faces.length,
  0,
);
for (const normal of normals) {
  const projections = lookup(normal, 0).projections;
  const low = Math.min(...projections) - 8e-8,
    high = Math.max(...projections) + 8e-8;
  for (let bin = 0; bin <= 128; bin++)
    for (const delta of [-1e-12, 0, 1e-12]) {
      const offset = low + ((high - low) * bin) / 128 + delta;
      const selected = lookup(normal, offset);
      const candidates = new Set(selected.faces);
      assert.equal(candidates.size, selected.faces.length);
      for (const face of projectedMesh.faces) {
        const values = face.vertices.map((id) => projections[id]);
        if (
          Math.min(...values) - 4e-8 <= offset &&
          Math.max(...values) + 4e-8 >= offset
        )
          assert.ok(
            candidates.has(face),
            "projection bucket lost an epsilon contact",
          );
      }
    }
}
for (const offset of [
  -2e-8,
  -1e-8,
  -0.5e-8,
  0,
  0.5e-8,
  1e-8,
  2e-8,
  1 - 2e-8,
  1 - 0.5e-8,
  1,
  1 + 0.5e-8,
  1 + 2e-8,
]) {
  const full = createDirectedPlaneMeasurer(box(), { projectionIndex: false });
  let expected: SectionMeasures;
  try {
    expected = full([1, 0, 0], offset, identity, 1);
  } catch {
    assert.throws(() => cut([1, 0, 0], offset, identity, 1));
    continue;
  }
  compareMeasures(cut([1, 0, 0], offset, identity, 1).measures, expected);
}
// Callback reentrancy must not corrupt hit IDs, candidate lists or clipping state,
// even when nested queries evict the outer normal from the cache.
const reentrant = createDirectedPlaneMeasurer(hollow, { cutCacheSize: 0 });
const expectedReentrant = reentrant([1, 0, 0], 2.13, identity, 1, {
  topHeight: 2.5,
});
let entered = false;
const reporting = (p: Vec3): Vec3 => {
  if (!entered) {
    entered = true;
    for (const normal of [
      [0, 1, 0],
      [0, 0, 1],
      [-1, 0, 0],
      [0, -1, 0],
    ] as Vec3[])
      reentrant(normal, 0.413, identity, 1);
  }
  return p;
};
assert.deepEqual(
  reentrant([1, 0, 0], 2.13, reporting, 1, { topHeight: 2.5 }, identity),
  expectedReentrant,
);

// Analytic measures-only checks cover the accumulator independently of both
// directed paths, which intentionally share their reduction implementation.
const measureBox = createDirectedPlaneMeasurer(box());
compareMeasures(measureBox([1, 0, 0], 0.4, identity, 1), {
  area: { amount: 1, moment: [0.4, 0.5, 0.5] },
  openLength: { amount: 3, moment: [1.2, 1.5, 1] },
  closedLength: { amount: 4, moment: [1.6, 2, 2] },
});
compareMeasures(
  measureBox([1, 0, 0], 0.4, identity, 1, {
    topHeight: 0.7,
    portOffset: 0.2,
    starboardOffset: 0.8,
  }),
  {
    area: { amount: 0.42, moment: [0.168, 0.21, 0.147] },
    openLength: { amount: 0.6, moment: [0.24, 0.3, 0] },
    closedLength: { amount: 2.6, moment: [1.04, 1.3, 0.91] },
  },
);
// Entire section on a trim plane: a no-op must keep skin ownership. All six
// limits also exercise corners formed solely from earlier trim closures.
for (const limits of [
  { aftPosition: 0.4 },
  { forwardPosition: 0.4 },
  { topHeight: 1 },
  { topHeight: 0 },
  {
    topHeight: 0.8,
    bottomHeight: 0.2,
    portOffset: 0.2,
    starboardOffset: 0.8,
    aftPosition: 0.4,
    forwardPosition: 0.5,
  },
  {
    topHeight: 0.8,
    bottomHeight: 0.2,
    portOffset: 0.2,
    starboardOffset: 0.8,
    forwardPosition: 0.3,
  },
] satisfies SectionLimits[])
  cut([1, 0, 0], 0.4, identity, 1, limits);
// Some faces of one island lie on the trim while another island is outside:
// on-line contacts must become non-skin closures, even if they occur in the list
// before the first outside segment. Conversely, a tangent vertex produces no
// unmatched event. Reordering cannot change these policies.
for (const mesh of [
  [...box(), ...box([0, 2, 0])],
  [...box(), ...box([0, 2, 0])].reverse(),
]) {
  const intersect = createDirectedPlaneIntersector(mesh);
  for (const limits of [
    { starboardOffset: 1 },
    { starboardOffset: 1, topHeight: 0.7 },
  ])
    intersect([1, 0, 0], 0.4, identity, 1, limits);
}
for (const mesh of [box().slice(1), brokenMesh(), [...tetra, ...tetra]])
  assert.throws(() => createDirectedPlaneMeasurer(mesh));
function brokenMesh() {
  const mesh = box();
  mesh[0] = reverse([mesh[0]])[0];
  return mesh;
}

// Connectivity errors must not disappear because a later trim discards the
// whole offending section. Failed queries must not poison the retained factory.
assert.throws(
  () =>
    createDirectedPlaneMeasurer(touching)(vertexNormal, 0, identity, 1, {
      topHeight: -10,
    }),
  /branched/,
);
const reusable = createDirectedPlaneMeasurer(tetra);
assert.throws(
  () => reusable(tangent, Math.SQRT1_2, identity, 1, { topHeight: -10 }),
  /opposing edge contact/,
);
compareMeasures(
  reusable(edgeNormal, 0, identity, 1),
  tetraCut(edgeNormal, 0, identity, 1).measures,
);
// Both directed paths now consistently use the mesh-wide epsilon for clipping,
// not a tolerance recomputed from a partly constructed section. A distant
// component makes the policy observable even though it misses this cut.
const distant = createDirectedPlaneIntersector([...box(), ...box([100, 0, 0])]);
near(
  distant([1, 0, 0], 0.4, identity, 1, { starboardOffset: 1 - 1e-7 }).measures
    .area.amount,
  1,
  "fixed clipping epsilon",
);

// Deterministic oblique cuts through holes/islands with six independently active
// limits. Compare against the independent legacy math where its cut succeeds.
let seed = 0x45e3c12;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
let randomComparisons = 0;
for (const mesh of meshes) {
  const intersect = createDirectedPlaneIntersector(mesh);
  for (let i = 0; i < 100; i++) {
    const raw = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
    const normal = raw.map((x) => x / Math.hypot(...raw)) as Vec3,
      offset = random() * 3 - 0.5;
    const limits: SectionLimits = {
      bottomHeight: random() * 0.4,
      topHeight: 0.6 + random() * 3,
      portOffset: random() * 0.4,
      starboardOffset: 0.6 + random() * 3,
      aftPosition: random() * 0.4,
      forwardPosition: 0.6 + random() * 3,
    };
    const result = intersect(normal, offset, identity, 1, limits);
    const reference = intersectPlane(mesh, normal, offset, identity, 1, limits);
    compareMeasures(result.measures, reference.measures);
    randomComparisons++;
  }
}

// Every clipping stage returns a complete boundary and leaves its input intact.
const stageInput = createGraphPlaneIntersector(box())(
  [1, 0, 0],
  0.4,
  identity,
  1,
).segments;
const untouched = structuredClone(stageInput);
assert.equal(
  clipDirectedSegments(stageInput, (p) => p[2], 1, 1e-8),
  stageInput,
);
let stage = stageInput;
for (const [axis, sign, limit] of [
  [2, 1, 0.8],
  [2, -1, -0.2],
  [1, -1, -0.1],
  [1, 1, 0.7],
]) {
  stage = clipDirectedSegments(stage, (p) => p[axis] * sign, limit, 1e-8);
  validateDirectedSegments(stage);
}
assert.deepEqual(stageInput, untouched);

// Instrument reads of original vertex coordinates to prove cut-cache reuse,
// without exposing counters/debug hooks in the production API. Disable the
// projection index so a cache miss necessarily reads the source vertices.
let sourceReads = 0;
const observedPoints = new Map<Vec3, Vec3>();
const observedMesh = box().map((t) => ({
  ...t,
  points: t.points.map((p) => {
    let observed = observedPoints.get(p);
    if (!observed) {
      observed = new Proxy(p, {
        get(target, key, receiver) {
          if (key === "0" || key === "1" || key === "2") sourceReads++;
          return Reflect.get(target, key, receiver);
        },
      });
      observedPoints.set(p, observed);
    }
    return observed;
  }) as [Vec3, Vec3, Vec3],
}));
const cached = createDirectedPlaneMeasurer(observedMesh, {
  projectionIndex: false,
  cutCacheSize: 2,
});
const uncached = createDirectedPlaneMeasurer(box(), {
  projectionIndex: false,
  cutCacheSize: 0,
});
const cacheQuery = (position: number, limits: SectionLimits = {}) =>
  cached([1, 0, 0], position, identity, 1, limits);
sourceReads = 0;
cacheQuery(0.4);
assert.ok(sourceReads > 0);
sourceReads = 0;
compareMeasures(
  cacheQuery(0.4, { topHeight: 0.7 }),
  uncached([1, 0, 0], 0.4, identity, 1, { topHeight: 0.7 }),
);
assert.equal(sourceReads, 0, "changing limits must reuse the untrimmed source");
compareMeasures(cacheQuery(0.4), uncached([1, 0, 0], 0.4, identity, 1)); // previous trim did not damage it
const affine = (p: Vec3): Vec3 => [p[0] * 2 + 3, p[1] * 2 - 4, p[2] * 2 + 5];
compareMeasures(
  cached([1, 0, 0], 0.4, affine, 2, { topHeight: 6.4 }),
  uncached([1, 0, 0], 0.4, affine, 2, { topHeight: 6.4 }),
);
assert.equal(
  sourceReads,
  0,
  "reporting frame, clipping frame and scale are not source-cache keys",
);
cacheQuery(0.6);
cacheQuery(0.4);
cacheQuery(0.8); // .6 evicted, .4 refreshed
sourceReads = 0;
cacheQuery(0.4);
assert.equal(sourceReads, 0);
cacheQuery(0.6);
assert.ok(sourceReads > 0, "LRU evicted cut must be recomputed");
cacheQuery(10);
sourceReads = 0;
cacheQuery(10);
assert.equal(sourceReads, 0, "empty cuts are cached");
for (let i = 0; i < 2; i++) {
  sourceReads = 0;
  assert.throws(() => cacheQuery(0), /coincides/);
  assert.ok(sourceReads > 0, "failed source cut must not enter cache");
}
assert.throws(
  () => cacheQuery(0.6, { topHeight: 0, bottomHeight: 1 }),
  /must be less/,
);
compareMeasures(cacheQuery(0.6), uncached([1, 0, 0], 0.6, identity, 1));
assert.throws(
  () =>
    cached([1, 0, 0], 0.6, identity, 1, { topHeight: 0.7 }, () => {
      throw new Error("bad callback");
    }),
  /bad callback/,
);
compareMeasures(cacheQuery(0.6), uncached([1, 0, 0], 0.6, identity, 1));
for (const size of [-1, 0.5, NaN, Infinity])
  assert.throws(
    () => createDirectedPlaneMeasurer(box(), { cutCacheSize: size }),
    /cache size/,
  );
const disabled = createDirectedPlaneMeasurer(observedMesh, {
  projectionIndex: false,
  cutCacheSize: 0,
});
for (let i = 0; i < 2; i++) {
  sourceReads = 0;
  disabled([1, 0, 0], 0.4, identity, 1);
  assert.ok(sourceReads > 0);
}

// Public drawing geometry must not provide a back door into a cached boundary
// (or the original mesh). Endpoint sharing within each returned cut survives.
const drawing = createGraphPlaneIntersector(box());
const clean = drawing([1, 0, 0], 0.4, identity, 1),
  saved = structuredClone(clean);
clean.segments[0].points[0][1] = 1234;
assert.deepEqual(drawing([1, 0, 0], 0.4, identity, 1), saved);
const freshTetra = structuredClone(tetra),
  savedTetra = structuredClone(freshTetra);
const onVertex = createGraphPlaneIntersector(freshTetra)(
  edgeNormal,
  0,
  identity,
  1,
);
onVertex.contours[0][0][0] = 9876;
assert.deepEqual(freshTetra, savedTetra);

// Numerical callers avoid drawing assembly; the public slice path still draws
// the same directed boundary. Sweep stations retain their authored algorithm.
const model = assemble(defaultHull()),
  sampling = computeHullSampling(model, 40, 4);
const section = createSectionMeasurer(model, sampling);
const draw = createSliceMeasurer(model, sampling);
for (const shape of [
  "plane",
  "transverse",
  "longitudinal",
  "station",
] as const) {
  const pos = shape === "plane" ? 0.4 : shape === "longitudinal" ? 0.2 : 2;
  const limits = { topHeight: 0.7, starboardOffset: 0.5 };
  const measured = section(shape, pos, limits);
  const drawn = draw(shape, pos, limits, { position: false, boundaries: [] });
  assert.ok(drawn);
  compareMeasures(measured.measures, drawn.measures);
  if (shape !== "station") {
    assert.deepEqual(measured.contours, []);
    assert.deepEqual(measured.sheetSkinSegments, []);
    assert.ok(drawn.contours.length);
    assert.ok(drawn.sheetSkinSegments.length);
  }
}
// Drawing and numerical clients share cached boundaries without exposing
// mutable cached points to either consumer.
const beforePreview = section("transverse", 2, { topHeight: 0.7 }).measures;
const preview = draw(
  "transverse",
  2,
  { topHeight: 0.7 },
  {
    position: false,
    boundaries: [],
  },
)!;
preview.curve[0][0] = 123456;
compareMeasures(
  section("transverse", 2, { topHeight: 0.7 }).measures,
  beforePreview,
);

const repetition = measureRepetition(
  section,
  "transverse",
  1,
  3,
  undefined,
  {},
  [],
);
assert.ok(repetition.value, repetition.error ?? "repetition");

// Refuse broken input instead of using nesting to mask orientation defects.
assert.throws(
  () => createDirectedPlaneIntersector(box().slice(1)),
  /oppositely directed/,
);
const broken = box();
broken[0] = reverse([broken[0]])[0];
assert.throws(
  () => createDirectedPlaneIntersector(broken),
  /oppositely directed/,
);
assert.throws(
  () =>
    createDirectedPlaneIntersector(reverse(box()))([1, 0, 0], 0.4, identity, 1),
  /negative area/,
);
assert.throws(() => cut([1, 0, 0], 0, identity, 1), /coincides/);
assert.throws(() => cut([2, 0, 0], 0.4, identity, 1), /unit normal/);
assert.throws(
  () => cut([1, 0, 0], 0.4, identity, 1, { bottomHeight: 1, topHeight: 0 }),
  /must be less/,
);
assert.deepEqual(cut([1, 0, 0], 10, identity, 1).contours, []);
assert.equal(
  cut([1, 0, 0], 0.4, identity, 1, { topHeight: -1 }).measures.area.amount,
  0,
);
console.log(
  `Directed plane cuts: ${comparisons} grid and ${randomComparisons} random reference comparisons, mesh winding, holes, islands, clipping, shared topology, contact ownership, moments, rake, contour-free and buffered measurement and cache reuse passed`,
);
