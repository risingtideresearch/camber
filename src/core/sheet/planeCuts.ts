// Intersect the sampled hull, closed by deck and transom ladders. Skin tags survive
// intersection so closure contributes to area/closed length, never to open length.
import type { Vec3 } from "../math";
import type { HullSampling } from "../mesh";
import {
  lineMeasure,
  measureAt,
  sumMeasure,
  zeroMeasures,
  type SectionMeasures,
} from "./sectionMeasures";

export interface CutTriangle {
  readonly points: readonly [Vec3, Vec3, Vec3];
  readonly skin: boolean;
}
export interface PlaneCut {
  readonly measures: SectionMeasures;
  readonly skinSegments: readonly (readonly [Vec3, Vec3])[];
  readonly contours: readonly (readonly Vec3[])[];
}
const mirror = (p: Vec3): Vec3 => [p[0], -p[1], p[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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

/** A valid non-intersection is empty; broken/non-manifold contours are errors.
 * `normal` is a unit vector in model coordinates; `toSheet` is affine. */
export function intersectPlane(
  triangles: readonly CutTriangle[],
  normal: Vec3,
  offset: number,
  toSheet: (p: Vec3) => Vec3,
  scale: number,
): PlaneCut {
  let extent = 1;
  for (const t of triangles)
    for (const p of t.points)
      for (const v of p) extent = Math.max(extent, Math.abs(v));
  const eps = extent * 1e-8;
  const nodes: Vec3[] = [];
  const buckets = new Map<string, number[]>();
  const node = (p: Vec3) => {
    const cell = p.map((v) => Math.floor(v / eps));
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          for (const i of buckets.get(
            `${cell[0] + x},${cell[1] + y},${cell[2] + z}`,
          ) ?? [])
            if (Math.hypot(...sub(p, nodes[i])) <= eps) return i;
        }
    const key = cell.join(","),
      i = nodes.length;
    nodes.push(p);
    buckets.set(key, [...(buckets.get(key) ?? []), i]);
    return i;
  };
  const edges = new Map<string, { a: number; b: number; skin: boolean }>();
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
    const ids = [...new Set(hits.map(node))];
    if (ids.length !== 2) continue;
    const [a, b] = ids.sort((x, y) => x - y),
      key = `${a},${b}`;
    const old = edges.get(key);
    edges.set(key, { a, b, skin: triangle.skin || !!old?.skin });
  }
  if (!edges.size)
    return { measures: zeroMeasures(), contours: [], skinSegments: [] };
  const adjacency = new Map<number, number[]>();
  for (const { a, b } of edges.values()) {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  if ([...adjacency.values()].some((a) => a.length !== 2))
    throw new Error(
      "Cut boundary is open or branched at this position; refine the hull sampling or move the cut",
    );
  const remaining = new Set(edges.keys()),
    contours: Vec3[][] = [];
  while (remaining.size) {
    const first = edges.get(remaining.values().next().value!)!;
    const ids = [first.a];
    let previous = first.a,
      current = first.b;
    remaining.delete(
      `${Math.min(previous, current)},${Math.max(previous, current)}`,
    );
    while (current !== first.a) {
      ids.push(current);
      const next = adjacency.get(current)!.find((i) => i !== previous)!;
      const key = `${Math.min(current, next)},${Math.max(current, next)}`;
      if (!remaining.delete(key))
        throw new Error("Cut boundary does not form simple contours");
      previous = current;
      current = next;
    }
    contours.push(ids.map((i) => nodes[i]));
  }
  const tangent = cross(
    normal,
    Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0],
  );
  const length = Math.hypot(...tangent),
    u = tangent.map((v) => v / length) as Vec3,
    v = cross(normal, u);
  const projected = contours.map((c) =>
    c.map((p) => [dot(p, u), dot(p, v)] as [number, number]),
  );
  const inside = (
    p: readonly number[],
    polygon: readonly (readonly number[])[],
  ) => {
    let yes = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i],
        b = polygon[j];
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        yes = !yes;
    }
    return yes;
  };
  let area = zeroMeasures().area;
  projected.forEach((polygon, index) => {
    let twice = 0,
      cx = 0,
      cy = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length],
        w = a[0] * b[1] - b[0] * a[1];
      twice += w;
      cx += (a[0] + b[0]) * w;
      cy += (a[1] + b[1]) * w;
    }
    if (Math.abs(twice) < eps * eps) return;
    const depth = projected.filter(
      (other, j) => j !== index && inside(polygon[0], other),
    ).length;
    const centroid = normal.map(
      (n, i) =>
        n * offset + (u[i] * cx) / (3 * twice) + (v[i] * cy) / (3 * twice),
    ) as Vec3;
    area = sumMeasure(
      area,
      measureAt(
        (((depth % 2 ? -1 : 1) * Math.abs(twice)) / 2) * scale * scale,
        toSheet(centroid),
      ),
    );
  });
  const segments = [...edges.values()];
  return {
    contours,
    skinSegments: segments
      .filter((e) => e.skin)
      .map((e) => [nodes[e.a], nodes[e.b]]),
    measures: {
      area,
      openLength: lineMeasure(
        segments.filter((e) => e.skin).map((e) => [nodes[e.a], nodes[e.b]]),
        toSheet,
        scale,
      ),
      closedLength: lineMeasure(
        segments.map((e) => [nodes[e.a], nodes[e.b]]),
        toSheet,
        scale,
      ),
    },
  };
}
