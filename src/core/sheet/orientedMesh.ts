// Measuring mesh: orientation is inherited from the parameter-grid
// winding, reflected with reversed winding, and extended across closure ladders.
import { V, type Vec3 } from "../math";
import type { HullSampling } from "../mesh";
import type { CutTriangle } from "./planeCuts";

const vertexKey = (p: Vec3) => p.join(",");
const edgeKey = (a: string, b: string) => JSON.stringify([a, b].sort());
const mirror = (p: Vec3): Vec3 => [p[0], -p[1], p[2]];
export interface OrientedMeshTopology {
  readonly vertices: readonly Vec3[];
  readonly edges: readonly (readonly [number, number])[];
  readonly faces: readonly {
    readonly vertices: readonly [number, number, number];
    readonly edges: readonly [number, number, number];
    readonly normal: Vec3;
    readonly skin: boolean;
  }[];
}

/** Intern EXACT shared coordinates once at the mesh boundary, not approximately
 * at every cut. Mirrored skin/closure Vec3 objects can differ by identity while
 * still representing the same authored vertex. Near coordinates stay distinct.
 * Every edge must have two opposite incident faces; this is not a geometric
 * self-intersection or vertex-manifold proof. Cavity faces must point out of
 * material (into the cavity); orientation is never inferred from nesting.
 */
export function indexOrientedMesh(
  triangles: readonly CutTriangle[],
): OrientedMeshTopology {
  const vertices: Vec3[] = [],
    vertexIds = new Map<string, number>();
  const edges: [number, number][] = [],
    edgeIds = new Map<string, number>();
  const counts: number[] = [],
    directions: number[] = [];
  const vertex = (p: Vec3) => {
    const key = vertexKey(p);
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = vertices.length;
      vertices.push(p);
      vertexIds.set(key, id);
    }
    return id;
  };
  const faces = triangles.map(({ points: p, skin }) => {
    const normal = V.cross(V.sub(p[1], p[0]), V.sub(p[2], p[0]));
    if (
      p.some((v) => !v.every(Number.isFinite)) ||
      !Number.isFinite(Math.hypot(...normal)) ||
      Math.hypot(...normal) <= 1e-16
    )
      throw new Error("Oriented mesh has a non-finite or degenerate face");
    const ids = p.map(vertex) as [number, number, number];
    const faceEdges = ids.map((a, i) => {
      const b = ids[(i + 1) % 3];
      const lo = Math.min(a, b),
        hi = Math.max(a, b),
        key = `${lo},${hi}`;
      let id = edgeIds.get(key);
      if (id === undefined) {
        id = edges.length;
        edges.push([lo, hi]);
        edgeIds.set(key, id);
        counts.push(0);
        directions.push(0);
      }
      counts[id]++;
      directions[id] += a < b ? 1 : -1;
      return id;
    }) as [number, number, number];
    return { vertices: ids, edges: faceEdges, normal, skin };
  });
  if (counts.some((count, id) => count !== 2 || directions[id] !== 0))
    throw new Error(
      "Oriented mesh requires two oppositely directed faces at every edge",
    );
  return { vertices, edges, faces };
}

export function validateOrientedMesh(triangles: readonly CutTriangle[]): void {
  indexOrientedMesh(triangles);
}

/** Build one authored hull's measuring surface, not a generic cavity orienter.
 * Skin winding comes from mesh.ts's CCW (u,v) cells. Closures oppose the skin's
 * directed boundary edges. Signed volume selects the global outward convention.
 */
export function orientedHullTriangles(sampling: HullSampling): CutTriangle[] {
  let triangles: CutTriangle[] = [];
  const add = (a: Vec3, b: Vec3, c: Vec3, skin: boolean) => {
    if (Math.hypot(...V.cross(V.sub(b, a), V.sub(c, a))) > 1e-16)
      triangles.push({ points: [a, b, c], skin });
  };
  const skin = (a: Vec3, b: Vec3, c: Vec3) => {
    add(a, b, c, true);
    add(mirror(a), mirror(c), mirror(b), true);
  };
  for (const q of sampling.hullQuads) {
    const [a, b, c, d] = q.map((p) => p.pos);
    skin(a, b, c);
    skin(a, c, d);
  }
  for (const t of sampling.hullTris) skin(t[0].pos, t[1].pos, t[2].pos);
  // Retain only unpaired skin edges, not the entire interior adjacency. The
  // full topology validation below still rejects non-manifold incidence.
  const boundary = new Map<string, { a: Vec3; b: Vec3 }>();
  for (const { points } of triangles)
    for (let i = 0; i < 3; i++) {
      const a = points[i],
        b = points[(i + 1) % 3],
        key = edgeKey(vertexKey(a), vertexKey(b));
      if (boundary.has(key)) boundary.delete(key);
      else boundary.set(key, { a, b });
    }
  for (const edge of [sampling.hullSheer, sampling.hullTransom])
    for (let i = 1; i < edge.length; i++) {
      const p = edge[i - 1].pos,
        q = edge[i].pos;
      // Collapsed centerline ladder contributes no face.
      if (p[1] === 0 && q[1] === 0) continue;
      const incident = boundary.get(edgeKey(vertexKey(p), vertexKey(q)));
      if (!incident)
        throw new Error(
          "Hull closure does not follow a unique skin boundary edge",
        );
      const { a, b } = incident;
      add(b, a, mirror(a), false);
      add(b, mirror(a), mirror(b), false);
    }
  boundary.clear();
  validateOrientedMesh(triangles);
  if (!triangles.length) return triangles;
  // Shift the volume origin to reduce cancellation for translated geometry.
  const origin = triangles[0].points[0];
  const sixVolume = triangles.reduce(
    (sum, { points: [a, b, c] }) =>
      sum +
      V.dot(V.sub(a, origin), V.cross(V.sub(b, origin), V.sub(c, origin))),
    0,
  );
  if (!Number.isFinite(sixVolume) || sixVolume === 0)
    throw new Error("Oriented hull has no finite enclosed volume");
  if (sixVolume < 0)
    triangles = triangles.map(({ points: [a, b, c], skin }) => ({
      points: [a, c, b],
      skin,
    }));
  return triangles;
}
