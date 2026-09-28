import { BOUNDARIES, validateLimits, type SectionLimits } from "./boundaries";
// Assemble and clip the two authored sweep-station halves. Planar mesh cuts
// use the directed cutter; this contour builder is only for sweep stations.
import type { Vec3 } from "../math";
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
  readonly segments: readonly CutSegment[];
  readonly measures: SectionMeasures;
  readonly skinSegments: readonly (readonly [Vec3, Vec3])[];
  readonly contours: readonly (readonly Vec3[])[];
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => v - b[i]) as Vec3;
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export interface CutSegment {
  readonly points: readonly [Vec3, Vec3];
  readonly skin: boolean;
}

/** Close a planar section's tagged boundary, clipped by the active directional limits. Pair exposed ends along the trim line, so disconnected
 * contours and holes close without adding overlapping fictitious trim edges. */
export function sectionFromSegments(
  input: readonly CutSegment[],
  normal: Vec3,
  offset: number,
  toSheet: (p: Vec3) => Vec3,
  scale: number,
  limits: SectionLimits = {},
  toBoundary: (p: Vec3) => Vec3 = toSheet,
): PlaneCut {
  return clipPlaneCut(
    sectionFromSegmentsAt(input, normal, offset, toSheet, scale),
    normal,
    offset,
    toSheet,
    scale,
    limits,
    toBoundary,
  );
}

/** Reuse an untrimmed intersection when only its clipping planes change. */
export function clipPlaneCut(
  cut: PlaneCut,
  normal: Vec3,
  offset: number,
  toSheet: (p: Vec3) => Vec3,
  scale: number,
  limits: SectionLimits = {},
  toBoundary: (p: Vec3) => Vec3 = toSheet,
): PlaneCut {
  validateLimits(limits);
  let result = cut;
  for (const boundary of BOUNDARIES) {
    const value = limits[boundary.leaf];
    if (value === undefined) continue;
    if (
      result.segments.every((segment) =>
        segment.points.every(
          (p) => (toBoundary(p)[boundary.axis] - value) * boundary.sign <= 0,
        ),
      )
    )
      continue;
    result = sectionFromSegmentsAt(
      result.segments,
      normal,
      offset,
      toSheet,
      scale,
      value * boundary.sign,
      (p) => toBoundary(p)[boundary.axis] * boundary.sign,
    );
  }
  return result;
}

function sectionFromSegmentsAt(
  input: readonly CutSegment[],
  normal: Vec3,
  offset: number,
  toSheet: (p: Vec3) => Vec3,
  scale: number,
  clipOffset?: number,
  coordinate: (p: Vec3) => number = (p) => toSheet(p)[2],
): PlaneCut {
  if (clipOffset !== undefined && !Number.isFinite(clipOffset))
    throw new Error("Clip offset must be finite");
  let extent = 1;
  for (const segment of input)
    for (const p of segment.points)
      for (const value of p) extent = Math.max(extent, Math.abs(value));
  const eps = extent * 1e-8;
  const nodes: Vec3[] = [];
  const buckets = new Map<string, number[]>();
  // Shared endpoints recur during contour assembly and successive clips. Only
  // cache actual nodes, not approximate matches: later insertions can change
  // which neighbour the tolerance search finds for an approximate point.
  const exactNodes = new Map<string, number>();
  const node = (p: Vec3) => {
    const exactKey = p.join(",");
    const known = exactNodes.get(exactKey);
    if (known !== undefined) return known;
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
    exactNodes.set(exactKey, i);
    buckets.set(key, [...(buckets.get(key) ?? []), i]);
    return i;
  };
  const edges = new Map<string, { a: number; b: number; skin: boolean }>();
  const addEdge = (p: Vec3, q: Vec3, skin: boolean) => {
    const [a, b] = [node(p), node(q)].sort((x, y) => x - y);
    if (a === b) return;
    const key = `${a},${b}`;
    edges.set(key, { a, b, skin: skin || !!edges.get(key)?.skin });
  };
  const clipped =
    clipOffset !== undefined &&
    input.some((e) =>
      e.points.some((p) => coordinate(p) > clipOffset + eps * scale),
    );
  for (const segment of input) {
    let [a, b] = segment.points;
    if (clipped) {
      const da = coordinate(a) - clipOffset!,
        db = coordinate(b) - clipOffset!;
      // Edges on the trim line are reconstructed from retained endpoints.
      if (da >= -eps * scale && db >= -eps * scale) continue;
      if (da > 0 || db > 0) {
        const t = da / (da - db);
        const hit = a.map((v, i) => v + t * (b[i] - v)) as Vec3;
        if (da > 0) a = hit;
        else b = hit;
      }
    }
    addEdge(a, b, segment.skin);
  }
  if (clipped) {
    const degree = new Map<number, number>();
    for (const { a, b } of edges.values()) {
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    const ends = [...degree].filter(([, n]) => n === 1).map(([id]) => id);
    if (
      ends.some(
        (id) => Math.abs(coordinate(nodes[id]) - clipOffset!) > 2 * eps * scale,
      )
    )
      throw new Error("Cut boundary is open away from its clipping boundary");
    // All exposed ends are collinear for a planar section. Choose the longest
    // coordinate span to avoid dividing by a near-parallel orientation.
    const spans = [0, 1, 2].map(
      (axis) =>
        Math.max(...ends.map((id) => nodes[id][axis])) -
        Math.min(...ends.map((id) => nodes[id][axis])),
    );
    const axis = spans.indexOf(Math.max(...spans));
    ends.sort((a, b) => nodes[a][axis] - nodes[b][axis]);
    if (ends.length % 2)
      throw new Error("Clipping boundary leaves an unmatched section endpoint");
    for (let i = 0; i < ends.length; i += 2)
      addEdge(nodes[ends[i]], nodes[ends[i + 1]], false);
  }
  if (!edges.size)
    return {
      measures: zeroMeasures(),
      contours: [],
      skinSegments: [],
      segments: [],
    };
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
    segments: segments.map((e) => ({
      points: [nodes[e.a], nodes[e.b]],
      skin: e.skin,
    })),
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
