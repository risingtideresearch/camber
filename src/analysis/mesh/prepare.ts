// Constrained mesh preparation. No renderer fit/centering and no use of STL facet normals.
import { V, type Vec3 } from "../../core/math";
import type { BoundarySource } from "../sections";
import {
  bounds,
  buildTree,
  overlaps,
  trianglesMeet,
  visit,
  type Face,
  type Tree,
} from "./spatial";

export interface PhysicalSetup {
  metresPerUnit: number;
  /** Signed source axes for hull x/y/z; each absolute axis occurs once. */
  axes: [
    1 | 2 | 3 | -1 | -2 | -3,
    1 | 2 | 3 | -1 | -2 | -3,
    1 | 2 | 3 | -1 | -2 | -3,
  ];
  /** Subtracted AFTER axis remap, scale and optional proper rotation, in metres. */
  origin: Vec3;
  rotation?: { axis: Vec3; radians: number };
}
export const METRE_SETUP: PhysicalSetup = {
  metresPerUnit: 1,
  axes: [1, 2, 3],
  origin: [0, 0, 0],
};
export interface PreparationReport {
  vertices: number;
  triangles: number;
  weldedVertices: number;
  reorientedFaces: number;
  tolerance: number;
  closed: boolean;
  diagnostics: string[];
}
export interface PreparedMesh {
  vertices: Vec3[];
  faces: Face[];
  sources: BoundarySource[];
  tree: Tree;
  boundary: number[][];
  report: PreparationReport;
}
export function physicalPoints(
  positions: ArrayLike<number>,
  setup: PhysicalSetup,
): Vec3[] {
  const { metresPerUnit: s, axes, origin, rotation } = setup;
  if (
    axes.length !== 3 ||
    origin.length !== 3 ||
    !Number.isFinite(s) ||
    s <= 0 ||
    new Set(axes.map(Math.abs)).size !== 3 ||
    axes.some((a) => ![1, 2, 3, -1, -2, -3].includes(a)) ||
    !origin.every(Number.isFinite)
  )
    throw new Error("Invalid physical scale, axis permutation or origin");
  if (
    rotation &&
    (rotation.axis.length !== 3 ||
      !rotation.axis.every(Number.isFinite) ||
      !Number.isFinite(rotation.radians) ||
      Math.abs(V.dot(rotation.axis, rotation.axis) - 1) > 1e-10)
  )
    throw new Error("Rotation needs a unit axis and finite angle");
  if (
    positions.length % 9 ||
    !positions.length ||
    positions.length > 200_000 * 9
  )
    throw new Error("Expected 1…200000 triangles");
  const out: Vec3[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    let p = axes.map(
      (a) => Math.sign(a) * positions[i + Math.abs(a) - 1] * s,
    ) as Vec3;
    if (rotation) {
      const c = Math.cos(rotation.radians),
        sn = Math.sin(rotation.radians),
        n = rotation.axis,
        cross = V.cross(n, p),
        dot = V.dot(n, p);
      p = p.map((v, j) => v * c + cross[j] * sn + n[j] * dot * (1 - c)) as Vec3;
    }
    p = V.sub(p, origin);
    if (!p.every(Number.isFinite))
      throw new Error("Non-finite physical vertex");
    out.push(p);
  }
  return out;
}

export function prepareMesh(
  positions: ArrayLike<number>,
  setup: PhysicalSetup = METRE_SETUP,
  options: {
    tolerance?: number;
    allowOpen?: boolean;
    sources?: readonly BoundarySource[];
  } = {},
): PreparedMesh {
  const raw = physicalPoints(positions, setup),
    box = bounds(raw),
    size = Math.hypot(...V.sub(box.max, box.min));
  // Explicit modelling tolerance, not an estimate of the source mesh's shape error.
  const tolerance = options.tolerance ?? Math.max(1e-10, size * 1e-8);
  if (
    !Number.isFinite(size) ||
    size <= 1e-9 ||
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    tolerance > size * 1e-4 ||
    tolerance <
      Math.max(...box.min.map(Math.abs), ...box.max.map(Math.abs)) *
        Number.EPSILON *
        16
  )
    throw new Error("Unsupported mesh scale/datums or weld tolerance");
  const vertices: Vec3[] = [],
    buckets = new Map<string, number[]>();
  const indices = raw.map((p) => {
    const cell = p.map((v, j) => Math.floor((v - box.min[j]) / tolerance));
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          const bucket = buckets.get(
            `${cell[0] + x}/${cell[1] + y}/${cell[2] + z}`,
          );
          for (const id of bucket ?? [])
            if (Math.hypot(...V.sub(p, vertices[id])) <= tolerance) return id;
        }
    const key = cell.join("/"),
      id = vertices.length;
    vertices.push(p);
    const bucket = buckets.get(key) ?? [];
    bucket.push(id);
    buckets.set(key, bucket);
    return id;
  });
  const faces: Face[] = [],
    unique = new Set<string>();
  for (let i = 0; i < indices.length; i += 3) {
    const f = indices.slice(i, i + 3) as Face,
      [a, b, c] = f.map((id) => vertices[id]);
    if (
      new Set(f).size < 3 ||
      Math.hypot(...V.cross(V.sub(b, a), V.sub(c, a))) <=
        tolerance *
          Math.max(Math.hypot(...V.sub(b, a)), Math.hypot(...V.sub(c, a)))
    )
      throw new Error(`Degenerate triangle ${i / 3}`);
    const key = f
      .slice()
      .sort((a, b) => a - b)
      .join("/");
    if (unique.has(key)) throw new Error(`Duplicate triangle ${i / 3}`);
    unique.add(key);
    faces.push(f);
  }
  const sources =
    options.sources?.map((s) => ({ ...s })) ??
    faces.map(() => ({ kind: "physical", surface: "unclassified" }) as const);
  if (
    sources.some((s) =>
      s.kind === "physical"
        ? typeof s.surface !== "string" || !s.surface
        : s.kind === "synthetic"
          ? typeof s.closure !== "string" || !s.closure
          : true,
    )
  )
    throw new Error("Invalid boundary source tag");
  if (sources.length !== faces.length)
    throw new Error("One boundary source per triangle is required");
  const edges = new Map<string, { face: number; a: number; b: number }[]>(),
    incident: number[][] = vertices.map(() => []);
  faces.forEach((f, i) =>
    f.forEach((a, j) => {
      incident[a].push(i);
      const b = f[(j + 1) % 3],
        key = a < b ? `${a}/${b}` : `${b}/${a}`,
        list = edges.get(key) ?? [];
      list.push({ face: i, a, b });
      if (list.length > 2) throw new Error("Non-manifold edge");
      edges.set(key, list);
    }),
  );
  const adjacent: { id: number; sign: number }[][] = faces.map(() => []);
  for (const list of edges.values())
    if (list.length === 2) {
      const [a, b] = list,
        sign = a.a === b.a ? -1 : 1;
      adjacent[a.face].push({ id: b.face, sign });
      adjacent[b.face].push({ id: a.face, sign });
    }
  const orientation = new Int8Array(faces.length);
  orientation[0] = 1;
  const queue = [0];
  for (let k = 0; k < queue.length; k++)
    for (const next of adjacent[queue[k]]) {
      const sign = orientation[queue[k]] * next.sign;
      if (orientation[next.id] && orientation[next.id] !== sign)
        throw new Error("Non-orientable surface");
      if (!orientation[next.id]) {
        orientation[next.id] = sign;
        queue.push(next.id);
      }
    }
  if (queue.length !== faces.length)
    throw new Error(
      "Multiple components: select one connected envelope before analysis",
    );
  // An edge-manifold surface can still pinch at a non-manifold vertex.
  incident.forEach((ids, v) => {
    const reached = new Set([ids[0]]),
      todo = [ids[0]],
      at = new Set(ids);
    for (let i = 0; i < todo.length; i++)
      for (const n of adjacent[todo[i]])
        if (at.has(n.id) && !reached.has(n.id)) {
          reached.add(n.id);
          todo.push(n.id);
        }
    if (reached.size !== ids.length)
      throw new Error(`Non-manifold vertex ${v}`);
  });
  faces.forEach((f, i) => {
    if (orientation[i] < 0) [f[1], f[2]] = [f[2], f[1]];
  });
  const boundaryEdges = [...edges.values()]
    .filter((e) => e.length === 1)
    .map(([e]) => (orientation[e.face] > 0 ? [e.a, e.b] : [e.b, e.a]));
  if (boundaryEdges.length && !options.allowOpen)
    throw new Error("Open envelope: explicit supported closure is required");
  const next = new Map<number, number>(),
    incoming = new Set<number>();
  for (const [a, b] of boundaryEdges) {
    if (next.has(a) || incoming.has(b)) throw new Error("Branched boundary");
    next.set(a, b);
    incoming.add(b);
  }
  const boundary: number[][] = [];
  while (next.size) {
    const start = next.keys().next().value!,
      loop: number[] = [];
    let at = start;
    do {
      loop.push(at);
      const n = next.get(at);
      if (n === undefined) throw new Error("Unclosed boundary");
      next.delete(at);
      at = n;
    } while (at !== start);
    boundary.push(loop);
  }
  const tree = buildTree(vertices, faces);
  // Broad-phase BVH and triangle SAT, including coplanar overlap. Adjacent faces
  // are inset only by modelling tolerance to exclude their permitted shared contact.
  faces.forEach((f, i) => {
    const a = f.map((v) => vertices[v]),
      ab = bounds(a);
    visit(
      tree,
      (b) => overlaps(ab, b, tolerance),
      (j) => {
        if (j <= i) return;
        const g = faces[j],
          b = g.map((v) => vertices[v]);
        if (!overlaps(ab, bounds(b), tolerance)) return;
        const shared = f.some((v) => g.includes(v));
        const inset = (p: Vec3[]) => {
          const center = p[0].map(
            (_, k) => (p[0][k] + p[1][k] + p[2][k]) / 3,
          ) as Vec3;
          return p.map((v) =>
            V.lerp(
              v,
              center,
              Math.min(
                0.01,
                (tolerance * 8) /
                  Math.max(tolerance, Math.hypot(...V.sub(v, center))),
              ),
            ),
          );
        };
        if (
          trianglesMeet(
            shared ? inset(a) : a,
            shared ? inset(b) : b,
            shared ? 0 : tolerance,
          )
        )
          throw new Error(
            `Self-intersection or ambiguous contact at triangles ${i}/${j}`,
          );
      },
    );
  });
  let flipped = orientation.reduce((n, v) => n + (v < 0 ? 1 : 0), 0);
  if (!boundary.length) {
    const anchor = vertices[0];
    let vol = 0;
    for (const f of faces) {
      const [a, b, c] = f.map((v) => V.sub(vertices[v], anchor));
      vol += V.dot(a, V.cross(b, c)) / 6;
    }
    if (Math.abs(vol) <= tolerance ** 3)
      throw new Error("Zero-volume envelope");
    if (vol < 0) {
      faces.forEach((f) => {
        [f[1], f[2]] = [f[2], f[1]];
      });
      flipped = faces.length - flipped;
    }
  }
  return {
    vertices,
    faces,
    sources,
    tree,
    boundary,
    report: {
      vertices: vertices.length,
      triangles: faces.length,
      weldedVertices: raw.length - vertices.length,
      reorientedFaces: flipped,
      tolerance,
      closed: !boundary.length,
      diagnostics: [
        ...(flipped
          ? [
              `${flipped} faces reoriented using adjacency and signed volume (not STL normals)`,
            ]
          : []),
      ],
    },
  };
}
