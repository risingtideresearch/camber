// Material side comes from face winding, not contour nesting. Cached normal
// projections and shared topology avoid welding on each cut.
import { createDirectedProjectionLookup } from "./directedProjection";
import type { Vec3 } from "../math";
import { BOUNDARIES, validateLimits, type SectionLimits } from "./boundaries";
import { indexOrientedMesh, type OrientedMeshTopology } from "./orientedMesh";
import type { CutTriangle, CutSegment, PlaneCut } from "./planeCuts";
import { createDirectedMeasureAccumulator } from "./directedMeasures";
import {
  clipDirectedSegments,
  validateDirectedSegments,
  directedContours,
  copyDirectedSegments,
} from "./directedSegments";

const tolerance = (points: Iterable<Vec3>) => {
  let extent = 1;
  for (const p of points)
    for (const value of p) extent = Math.max(extent, Math.abs(value));
  return extent * 1e-8;
};
interface Edge {
  a: number;
  b: number;
  skin: boolean;
}
/** Each crossing belongs to a mesh edge, and each on-plane contact belongs to
 * a mesh vertex. Neighbouring faces share node IDs and exactly one computation.
 * There is no coordinate search or distance-based endpoint merging here.
 */
function visitIntersections(
  mesh: OrientedMeshTopology,
  normal: Vec3,
  offset: number,
  eps: number,
  selection: ReturnType<ReturnType<typeof createDirectedProjectionLookup>>,
  emit: (a: Vec3, b: Vec3, skin: boolean) => void,
): void {
  // Projection dot products are cached per normal. Subtracting the offset and
  // snapping directly is cheaper than a per-query distance Map, and touches
  // only candidate vertices. All incident faces evaluate exactly the same value.
  const distance = (id: number) => {
    const d = selection.projections[id] - offset;
    return Math.abs(d) <= eps ? 0 : d;
  };
  // Sparse hit caches keep state query-local (including reentrant callbacks),
  // without allocating or clearing mesh-sized node-ID arrays on every cut.
  const vertexNodes = new Map<number, number>();
  const edgeNodes = new Map<number, number>();
  const nodes: Vec3[] = [];
  const vertexNode = (vertex: number) => {
    if (!vertexNodes.has(vertex)) {
      vertexNodes.set(vertex, nodes.length);
      nodes.push(mesh.vertices[vertex]);
    }
    return vertexNodes.get(vertex)!;
  };
  const edgeNode = (edge: number) => {
    if (!edgeNodes.has(edge)) {
      const [a, b] = mesh.edges[edge],
        p = mesh.vertices[a],
        q = mesh.vertices[b];
      const t = distance(a) / (distance(a) - distance(b));
      edgeNodes.set(edge, nodes.length);
      nodes.push([
        p[0] + t * (q[0] - p[0]),
        p[1] + t * (q[1] - p[1]),
        p[2] + t * (q[2] - p[2]),
      ]);
    }
    return edgeNodes.get(edge)!;
  };
  // Only an on-plane mesh EDGE can be emitted by both incident faces. Ordinary
  // crossings never need an edge-dedup map. Same-direction contacts share one
  // contribution (skin wins); opposite directions are an ambiguous tangent.
  const contacts = new Map<number, Edge>();
  for (const face of selection.faces) {
    const ids = face.vertices;
    const da = distance(ids[0]),
      db = distance(ids[1]),
      dc = distance(ids[2]);
    if (da === 0 && db === 0 && dc === 0)
      throw new Error(
        "Cut coincides with a hull boundary face; move it slightly inside the hull",
      );
    if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;
    let a = -1,
      b = -1,
      onEdge = -1;
    const hit = (id: number) => {
      if (a === -1) a = id;
      else b = id;
    };
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3,
        d = distance(ids[i]),
        next = distance(ids[j]);
      if (d === 0) hit(vertexNode(ids[i]));
      if ((d < 0 && next > 0) || (d > 0 && next < 0))
        hit(edgeNode(face.edges[i]));
      if (d === 0 && next === 0) onEdge = face.edges[i];
    }
    if (b === -1) continue; // a vertex touch alone contributes no boundary
    const p = nodes[a],
      q = nodes[b],
      N = face.normal;
    const direction =
      (q[0] - p[0]) * (normal[1] * N[2] - normal[2] * N[1]) +
      (q[1] - p[1]) * (normal[2] * N[0] - normal[0] * N[2]) +
      (q[2] - p[2]) * (normal[0] * N[1] - normal[1] * N[0]);
    if (direction < 0) [a, b] = [b, a];
    const previous = contacts.get(onEdge);
    if (previous) {
      if (previous.a !== a || previous.b !== b)
        throw new Error("Directed cut has an ambiguous opposing edge contact");
      previous.skin ||= face.skin;
      continue;
    }
    if (onEdge !== -1) contacts.set(onEdge, { a, b, skin: face.skin });
    else emit(nodes[a], nodes[b], face.skin);
  }
  // Defer only exact mesh-edge contacts until both incident skin tags are known.
  for (const { a, b, skin } of contacts.values())
    emit(nodes[a], nodes[b], skin);
}

export interface DirectedPlaneOptions {
  /** Disable only for full-scan comparison/debugging. */
  readonly projectionIndex?: boolean;
  /** Untrimmed model-space boundaries retained per factory (LRU). Default 64;
   * zero disables cut caching, independently of the projection cache. */
  readonly cutCacheSize?: number;
}

/** Shared preparation for BOTH output APIs. Only validated untrimmed boundaries
 * enter the cache. Limits, scale and transforms are deliberately not cache keys:
 * they are applied afresh to the retained model-space segment list.
 */
function createPreparedCuts(
  triangles: readonly CutTriangle[],
  options: DirectedPlaneOptions,
) {
  const capacity = options.cutCacheSize ?? 64;
  if (!Number.isSafeInteger(capacity) || capacity < 0)
    throw new Error(
      "Directed cut cache size must be a non-negative safe integer",
    );
  const mesh = indexOrientedMesh(triangles),
    eps = tolerance(mesh.vertices);
  const select = createDirectedProjectionLookup(
    mesh,
    eps,
    options.projectionIndex,
  );
  const cache = new Map<string, readonly CutSegment[]>();
  return (
    normal: Vec3,
    offset: number,
    toSheet: (p: Vec3) => Vec3,
    scale: number,
    limits: SectionLimits = {},
    toBoundary: (p: Vec3) => Vec3 = toSheet,
  ) => {
    validateQuery(normal, offset, scale, limits);
    const key = `${normal.join(",")}:${offset}`;
    let segments = cache.get(key);
    if (segments) {
      cache.delete(key);
      cache.set(key, segments);
    } else {
      const collected: CutSegment[] = [];
      visitIntersections(
        mesh,
        normal,
        offset,
        eps,
        select(normal, offset),
        (a, b, skin) => collected.push({ points: [a, b], skin }),
      );
      // Validate before any clipping, even if limits will erase the whole cut.
      validateDirectedSegments(collected);
      segments = collected;
      if (capacity > 0) {
        cache.set(key, segments);
        if (cache.size > capacity) cache.delete(cache.keys().next().value!);
      }
    }
    for (const boundary of BOUNDARIES) {
      const limit = limits[boundary.leaf];
      if (limit !== undefined)
        segments = clipDirectedSegments(
          segments,
          (p) => toBoundary(p)[boundary.axis] * boundary.sign,
          limit * boundary.sign,
          eps * scale,
        );
    }
    const accumulator = createDirectedMeasureAccumulator(
      normal,
      offset,
      toSheet,
      scale,
      eps,
    );
    for (const {
      points: [a, b],
      skin,
    } of segments)
      accumulator.add(a, b, skin);
    return { segments, measures: accumulator.finish() };
  };
}

/** Share topology, projections and untrimmed boundaries between numerical cuts
 * and their occasional drawing previews. Both outputs clip and reduce through
 * the same preparation; only drawing copies segments and builds contours. */
export function createDirectedPlaneCuts(
  triangles: readonly CutTriangle[],
  options: DirectedPlaneOptions = {},
) {
  const prepare = createPreparedCuts(triangles, options);
  return {
    measure: (...query: Parameters<typeof prepare>) =>
      prepare(...query).measures,
    intersect: (...query: Parameters<typeof prepare>): PlaneCut => {
      const result = prepare(...query),
        segments = copyDirectedSegments(result.segments);
      return {
        segments,
        skinSegments: segments.filter((e) => e.skin).map((e) => e.points),
        contours: directedContours(segments),
        measures: result.measures,
      };
    },
  };
}

/** Geometry output for an immutable, closed, material-oriented mesh. Returned
 * geometry is detached from cached state. Callbacks must be pure and affine. */
export function createDirectedPlaneIntersector(
  triangles: readonly CutTriangle[],
  options: DirectedPlaneOptions = {},
) {
  return createDirectedPlaneCuts(triangles, options).intersect;
}

function validateQuery(
  normal: Vec3,
  offset: number,
  scale: number,
  limits: SectionLimits,
): void {
  if (
    !normal.every(Number.isFinite) ||
    Math.abs(Math.hypot(...normal) - 1) > 1e-10 ||
    !Number.isFinite(offset) ||
    !Number.isFinite(scale) ||
    scale <= 0
  )
    throw new Error(
      "Directed cut needs a unit normal, finite offset and positive scale",
    );
  validateLimits(limits);
}

/** Measures-only output: no contour assembly or public geometry copies. */
export function createDirectedPlaneMeasurer(
  triangles: readonly CutTriangle[],
  options: DirectedPlaneOptions = {},
) {
  return createDirectedPlaneCuts(triangles, options).measure;
}
