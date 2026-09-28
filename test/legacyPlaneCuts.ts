// Orientation-independent cutter retained only as an independent test oracle.
import type { Vec3 } from "../src/core/math";
import type { HullSampling } from "../src/core/mesh";
import {
  sectionFromSegments,
  type CutTriangle,
  type CutSegment,
  type PlaneCut,
} from "../src/core/sheet/planeCuts";
import type { SectionLimits } from "../src/core/sheet/boundaries";
const mirror = (p: Vec3): Vec3 => [p[0], -p[1], p[2]];
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => v - b[i]) as Vec3;
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function closedHullTriangles(sampling: HullSampling): CutTriangle[] {
  const out: CutTriangle[] = [];
  const tri = (a: Vec3, b: Vec3, c: Vec3, skin: boolean) => {
    if (Math.hypot(...cross(sub(b, a), sub(c, a))) > 1e-16)
      out.push({ points: [a, b, c], skin });
  };
  for (const q of sampling.hullQuads)
    for (const reflect of [false, true]) {
      const [a, b, c, d] = q.map((p) => (reflect ? mirror(p.pos) : p.pos));
      tri(a, b, c, true);
      tri(a, c, d, true);
    }
  for (const t of sampling.hullTris)
    for (const reflect of [false, true]) {
      const [a, b, c] = t.map((p) => (reflect ? mirror(p.pos) : p.pos));
      tri(a, b, c, true);
    }
  for (const edge of [sampling.hullSheer, sampling.hullTransom]) {
    for (let i = 1; i < edge.length; i++) {
      const a = edge[i - 1].pos,
        b = edge[i].pos;
      tri(a, mirror(a), mirror(b), false);
      tri(a, mirror(b), b, false);
    }
  }
  return out;
}

const PROJECTION_BINS = 128;

function intersectionTolerance(triangles: readonly CutTriangle[]): number {
  let extent = 1;
  for (const t of triangles)
    for (const p of t.points)
      for (const v of p) extent = Math.max(extent, Math.abs(v));
  return extent * 1e-8;
}

interface ProjectionIndex {
  readonly low: number;
  readonly high: number;
  readonly width: number;
  readonly bins: readonly (readonly CutTriangle[])[];
}

const projectionBin = (value: number, low: number, width: number): number =>
  Math.max(0, Math.min(PROJECTION_BINS - 1, Math.floor((value - low) / width)));

function indexProjection(
  triangles: readonly CutTriangle[],
  normal: Vec3,
  eps: number,
): ProjectionIndex {
  let low = Infinity,
    high = -Infinity;
  const ranges = triangles.map(({ points }) => {
    const values = points.map((p) => dot(p, normal));
    // Conservative padding includes vertex/face contacts within the narrow
    // phase's tolerance, with room for rounding at projection/bin boundaries.
    const min = Math.min(...values) - 2 * eps;
    const max = Math.max(...values) + 2 * eps;
    low = Math.min(low, min);
    high = Math.max(high, max);
    return [min, max];
  });
  const width = (high - low) / PROJECTION_BINS || 1;
  const bins: CutTriangle[][] = Array.from(
    { length: PROJECTION_BINS },
    () => [],
  );
  triangles.forEach((triangle, i) => {
    const first = projectionBin(ranges[i][0], low, width);
    const last = projectionBin(ranges[i][1], low, width);
    // Preserve input order so contours and floating-point sums remain stable.
    for (let bin = first; bin <= last; bin++) bins[bin].push(triangle);
  });
  return { low, high, width, bins };
}

/** Reuse for many cuts of one immutable mesh. Index only triangle candidates;
 * intersection, clipping and tolerances are identical to the full scan below.
 * The mesh-wide tolerance must not shrink to the selected bucket's extent. */
export function createPlaneIntersector(triangles: readonly CutTriangle[]) {
  const eps = intersectionTolerance(triangles);
  const projections = new Map<string, ProjectionIndex>();
  return (
    normal: Vec3,
    offset: number,
    toSheet: (p: Vec3) => Vec3,
    scale: number,
    limits: SectionLimits = {},
    toBoundary: (p: Vec3) => Vec3 = toSheet,
  ): PlaneCut => {
    let candidates = triangles;
    if (
      triangles.length &&
      Number.isFinite(offset) &&
      normal.every(Number.isFinite)
    ) {
      const key = normal.join(",");
      let index = projections.get(key);
      if (!index) {
        index = indexProjection(triangles, normal, eps);
        // Sheet cuts use three fixed orientations. Bound memory for other callers.
        if (projections.size >= 4)
          projections.delete(projections.keys().next().value!);
        projections.set(key, index);
      }
      candidates =
        offset < index.low || offset > index.high
          ? []
          : index.bins[projectionBin(offset, index.low, index.width)];
    }
    return intersectTriangles(
      candidates,
      normal,
      offset,
      toSheet,
      scale,
      limits,
      toBoundary,
      eps,
    );
  };
}

/** A valid non-intersection is empty; broken/non-manifold contours are errors.
 * `normal` is a unit vector in model coordinates; `toSheet` is affine. */
export function intersectPlane(
  triangles: readonly CutTriangle[],
  normal: Vec3,
  offset: number,
  toSheet: (p: Vec3) => Vec3,
  scale: number,
  limits: SectionLimits = {},
  toBoundary: (p: Vec3) => Vec3 = toSheet,
): PlaneCut {
  return intersectTriangles(
    triangles,
    normal,
    offset,
    toSheet,
    scale,
    limits,
    toBoundary,
    intersectionTolerance(triangles),
  );
}

function intersectTriangles(
  triangles: readonly CutTriangle[],
  normal: Vec3,
  offset: number,
  toSheet: (p: Vec3) => Vec3,
  scale: number,
  limits: SectionLimits,
  toBoundary: (p: Vec3) => Vec3,
  eps: number,
): PlaneCut {
  return sectionFromSegments(
    trianglePlaneSegments(triangles, normal, offset, eps),
    normal,
    offset,
    toSheet,
    scale,
    limits,
    toBoundary,
  );
}

/** Unoriented reference narrow phase, also used by the full-scan benchmark. */
export function trianglePlaneSegments(
  triangles: readonly CutTriangle[],
  normal: Vec3,
  offset: number,
  eps = intersectionTolerance(triangles),
): CutSegment[] {
  const segments: CutSegment[] = [];
  for (const triangle of triangles) {
    const p = triangle.points,
      d = p.map((v) => dot(v, normal) - offset);
    // A plane on a boundary face has no unique section perimeter. Refuse rather
    // than count its interior triangulation edges as structural material.
    if (d.every((v) => Math.abs(v) <= eps))
      throw new Error(
        "Cut coincides with a hull boundary face; move it slightly inside the hull",
      );
    const hits: Vec3[] = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if (Math.abs(d[i]) <= eps) hits.push(p[i]);
      if ((d[i] < -eps && d[j] > eps) || (d[i] > eps && d[j] < -eps)) {
        const t = d[i] / (d[i] - d[j]);
        hits.push(p[i].map((v, k) => v + t * (p[j][k] - v)) as Vec3);
      }
    }
    const distinct = hits.filter(
      (p, i) => !hits.slice(0, i).some((q) => Math.hypot(...sub(p, q)) <= eps),
    );
    if (distinct.length === 2) {
      segments.push({
        points: [distinct[0], distinct[1]],
        skin: triangle.skin,
      });
    }
  }
  return segments;
}
