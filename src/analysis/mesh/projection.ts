import { V, type Vec2, type Vec3 } from "../../core/math";
import { available, unavailable, type Available } from "../api";
import type {
  DisplayGeometry,
  ProjectionRequest,
  ProjectionResult,
} from "../projections";
import { planeNormal, polygonMoments } from "../sections";
import type { PreparedMesh } from "./prepare";
import { bounds } from "./spatial";

export function meshProjection(
  mesh: PreparedMesh,
  query: ProjectionRequest,
): Available<ProjectionResult> {
  let normal: Vec3;
  try {
    normal = planeNormal(query.view);
  } catch (reason) {
    return unavailable(String(reason));
  }
  const selected = query.surfaces ? new Set(query.surfaces) : null;
  const present = new Set(
    mesh.sources.flatMap((s) => (s.kind === "physical" ? [s.surface] : [])),
  );
  if (selected && [...selected].some((s) => !present.has(s)))
    return unavailable("Projection names an unknown physical surface");
  const points = mesh.vertices.map((p) => {
    const d = V.sub(p, query.view.origin);
    return [
      V.dot(d, query.view.u),
      V.dot(d, query.view.v),
      V.dot(d, normal),
    ] as Vec3;
  });
  const coverage: Vec2[][] = [],
    used = new Set<number>();
  mesh.faces.forEach((f, i) => {
    const source = mesh.sources[i];
    if (
      selected &&
      (source.kind !== "physical" || !selected.has(source.surface))
    )
      return;
    f.forEach((j) => used.add(j));
    const triangle = f.map((j) => points[j].slice(0, 2) as Vec2);
    const area = polygonMoments(triangle).area;
    if (Math.abs(area) <= mesh.report.tolerance ** 2) return;
    if (area < 0) triangle.reverse();
    coverage.push(triangle);
  });
  return available({
    view: query.view,
    coverage,
    bounds: used.size ? bounds([...used].map((i) => points[i])) : null,
    diagnostics: [
      "Visual union of projected triangles; not a measured planar section",
    ],
    accuracy: {
      method: "projected-triangle-union",
      triangles: mesh.faces.length,
      errorBound: null,
    },
  });
}
export function meshDisplayGeometry(mesh: PreparedMesh): DisplayGeometry {
  const positions = new Float32Array(mesh.faces.length * 9);
  mesh.faces.forEach((face, i) =>
    face.forEach((j, k) => positions.set(mesh.vertices[j], i * 9 + k * 3)),
  );
  return {
    positions,
    sources: mesh.sources,
    bounds: { min: mesh.tree.min, max: mesh.tree.max },
  };
}
