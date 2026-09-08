import { V, type Vec3 } from "../../core/math";
import type { Available } from "../api";
import { planeNormal, type PlaneFrame, type SectionResult } from "../sections";
import type { PreparedMesh } from "./prepare";
import { meshSection } from "./section";
import type { Tree } from "./spatial";

export interface MeshImmersion {
  vol: number;
  centroid: Vec3 | null;
  waterplane: Available<SectionResult> | null;
  wettedBySurface: Record<string, number>;
}
interface Integral {
  volume: number;
  first: Vec3;
  normal: Vec3;
  tensor: number[];
  area: Record<string, number>;
}
const zero = (): Integral => ({
  volume: 0,
  first: [0, 0, 0],
  normal: [0, 0, 0],
  tensor: new Array<number>(9).fill(0),
  area: Object.create(null),
});
const addAreas = (to: Record<string, number>, from: Record<string, number>) => {
  for (const key of Object.keys(from)) to[key] = (to[key] ?? 0) + from[key];
};
// Prepared meshes are worker-owned immutable geometry. Weak ownership releases all
// acceleration data when a source/context is disposed; nothing is cached by book revision.
const cache = new WeakMap<
  PreparedMesh,
  { center: Vec3; vertices: Vec3[]; integrals: Map<Tree, Integral> }
>();
function prepareIntegral(mesh: PreparedMesh) {
  const found = cache.get(mesh);
  if (found) return found;
  const center = mesh.tree.min.map(
      (v, i) => (v + mesh.tree.max[i]) / 2,
    ) as Vec3,
    vertices = mesh.vertices.map((p) => V.sub(p, center)),
    integrals = new Map<Tree, Integral>();
  const build = (node: Tree): Integral => {
    const sum = zero();
    if (node.faces)
      for (const id of node.faces) {
        const [a, b, c] = mesh.faces[id].map((i) => vertices[i]),
          n = V.scale(V.cross(V.sub(b, a), V.sub(c, a)), 1 / 6),
          volume = V.dot(a, V.cross(b, c)) / 6,
          s = a.map((v, i) => v + b[i] + c[i]) as Vec3;
        sum.volume += volume;
        for (let j = 0; j < 3; j++) {
          sum.normal[j] += n[j];
          sum.first[j] += (volume * s[j]) / 4;
          for (let k = 0; k < 3; k++)
            sum.tensor[j * 3 + k] += (s[j] * n[k]) / 4;
        }
        const source = mesh.sources[id];
        if (source.kind === "physical")
          sum.area[source.surface] =
            (sum.area[source.surface] ?? 0) + Math.hypot(...n) * 3;
      }
    else
      for (const child of [node.left!, node.right!]) {
        const part = build(child);
        sum.volume += part.volume;
        for (let j = 0; j < 3; j++) {
          sum.normal[j] += part.normal[j];
          sum.first[j] += part.first[j];
        }
        for (let j = 0; j < 9; j++) sum.tensor[j] += part.tensor[j];
        addAreas(sum.area, part.area);
      }
    integrals.set(node, sum);
    return sum;
  };
  build(mesh.tree);
  const prepared = { center, vertices, integrals };
  cache.set(mesh, prepared);
  return prepared;
}

/** Signed tetrahedra with an apex ON the waterplane: the omitted waterplane cap
 * has zero tetrahedral volume/first moment, including holes. No polygon cap fan.
 *
 * For a fully immersed BVH node, aggregate EXACT moving-apex coefficients:
 * V(A)=V(0)−A·N; M(A)=M(0)−T A + A V(A)/4.
 * Only triangles in straddling leaves need clipping. This avoids sampling another
 * approximation of the hull just to accelerate a dense mesh's sinkage march.
 * `accelerated=false` retains the direct path for regression/benchmark comparison. */
export function meshImmersion(
  mesh: PreparedMesh,
  plane: PlaneFrame,
  moments = false,
  accelerated = true,
): MeshImmersion {
  if (!mesh.report.closed)
    throw new Error(
      "Immersed integration requires a validated closed envelope",
    );
  const n = planeNormal(plane),
    { center, vertices, integrals } = prepareIntegral(mesh),
    height = V.dot(V.sub(plane.origin, center), n);
  if (!Number.isFinite(height))
    throw new Error("Plane height exceeds the numerical coordinate range");
  const apex = V.scale(n, height),
    first: Vec3 = [0, 0, 0],
    wettedBySurface: Record<string, number> = Object.create(null);
  let vol = 0;
  const sumNode = (node: Tree) => {
    const p = integrals.get(node)!,
      volume = p.volume - V.dot(apex, p.normal);
    vol += volume;
    for (let j = 0; j < 3; j++)
      first[j] +=
        p.first[j] -
        V.dot(p.tensor.slice(j * 3, j * 3 + 3) as Vec3, apex) +
        (apex[j] * volume) / 4;
    addAreas(wettedBySurface, p.area);
  };
  const face = (id: number) => {
    const triangle = mesh.faces[id].map((i) => vertices[i]),
      d = triangle.map((p) => V.dot(p, n) - height);
    if (d.every((v) => v > 0)) return;
    const polygon: Vec3[] = [];
    triangle.forEach((a, i) => {
      const j = (i + 1) % 3,
        b = triangle[j];
      if (d[i] <= 0) polygon.push(a);
      if ((d[i] < 0 && d[j] > 0) || (d[i] > 0 && d[j] < 0))
        polygon.push(V.lerp(a, b, d[i] / (d[i] - d[j])));
    });
    for (let i = 1; i + 1 < polygon.length; i++) {
      const a = polygon[0],
        b = polygon[i],
        c = polygon[i + 1],
        v = V.dot(V.sub(a, apex), V.cross(V.sub(b, apex), V.sub(c, apex))) / 6;
      vol += v;
      for (let j = 0; j < 3; j++)
        first[j] += (v * (apex[j] + a[j] + b[j] + c[j])) / 4;
      const source = mesh.sources[id];
      if (source.kind === "physical")
        wettedBySurface[source.surface] =
          (wettedBySurface[source.surface] ?? 0) +
          Math.hypot(...V.cross(V.sub(b, a), V.sub(c, a))) / 2;
    }
  };
  const walk = (node: Tree) => {
    let lo = 0,
      hi = 0;
    for (let j = 0; j < 3; j++) {
      const a = (node.min[j] - center[j]) * n[j],
        b = (node.max[j] - center[j]) * n[j];
      lo += Math.min(a, b);
      hi += Math.max(a, b);
    }
    if (lo > height) return;
    if (hi <= height && node === mesh.tree) {
      // Entire closed solid: use the central apex, even for far-away planes.
      const p = integrals.get(node)!;
      vol = p.volume;
      first.splice(0, 3, ...p.first);
      addAreas(wettedBySurface, p.area);
      return;
    }
    if (accelerated && hi < height) {
      sumNode(node);
      return;
    }
    if (node.faces) node.faces.forEach(face);
    else {
      walk(node.left!);
      walk(node.right!);
    }
  };
  walk(mesh.tree);
  const epsilon = Math.max(
    mesh.report.tolerance ** 3,
    Math.hypot(...V.sub(mesh.tree.max, mesh.tree.min)) ** 3 *
      Number.EPSILON *
      64,
  );
  if (!Number.isFinite(vol) || !first.every(Number.isFinite) || vol < -epsilon)
    throw new Error("Invalid immersed integral in an oriented envelope");
  return {
    vol: vol > epsilon ? vol : 0,
    centroid:
      vol > epsilon ? (first.map((v, i) => center[i] + v / vol) as Vec3) : null,
    waterplane: moments
      ? meshSection(mesh, { plane, envelope: "buoyancy" })
      : null,
    wettedBySurface,
  };
}
