import type { Vec3 } from "../math";
import type { OrientedMeshTopology } from "./orientedMesh";

const BIN_COUNT = 128;
const binOf = (value: number, low: number, width: number) =>
  Math.max(0, Math.min(BIN_COUNT - 1, Math.floor((value - low) / width)));
function project(mesh: OrientedMeshTopology, normal: Vec3): Float64Array {
  const projections = new Float64Array(mesh.vertices.length);
  for (let i = 0; i < projections.length; i++) {
    const p = mesh.vertices[i];
    projections[i] = p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2];
  }
  return projections;
}

function build(mesh: OrientedMeshTopology, normal: Vec3, eps: number) {
  const projections = project(mesh, normal);
  let low = Infinity,
    high = -Infinity;
  const ranges = mesh.faces.map((face) => {
    const [a, b, c] = face.vertices.map((id) => projections[id]);
    // Include snapped contacts and rounding at bucket boundaries. Keep the
    // original mesh-wide epsilon, never one inferred from the candidate set.
    const min = Math.min(a, b, c) - 2 * eps,
      max = Math.max(a, b, c) + 2 * eps;
    low = Math.min(low, min);
    high = Math.max(high, max);
    return [min, max];
  });
  const width = (high - low) / BIN_COUNT || 1;
  const bins: OrientedMeshTopology["faces"][number][][] = Array.from(
    { length: BIN_COUNT },
    () => [],
  );
  mesh.faces.forEach((face, i) => {
    const first = binOf(ranges[i][0], low, width),
      last = binOf(ranges[i][1], low, width);
    // Original order makes indexing a conservative filter, not a new summation
    // order. Each face appears only once in any queried bucket.
    for (let bin = first; bin <= last; bin++) bins[bin].push(face);
  });
  return { projections, low, high, width, bins };
}

/** Per-immutable-mesh cache, keyed by exact unit normal (offset is NOT a key).
 * Keep four orientations with LRU eviction. Opposite normals are separate keys;
 * no quantization may silently change the requested plane. Query-local state
 * lives outside this cache, so callbacks can safely make reentrant queries.
 */
export function createDirectedProjectionLookup(
  mesh: OrientedMeshTopology,
  eps: number,
  indexed = true,
) {
  const cache = new Map<string, ReturnType<typeof build>>();
  return (normal: Vec3, offset: number) => {
    if (!indexed)
      return { projections: project(mesh, normal), faces: mesh.faces };
    const key = normal.join(",");
    let index = cache.get(key);
    if (index) cache.delete(key);
    else index = build(mesh, normal, eps);
    cache.set(key, index);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
    return {
      projections: index.projections,
      faces:
        offset < index.low || offset > index.high
          ? []
          : index.bins[binOf(offset, index.low, index.width)],
    };
  };
}
