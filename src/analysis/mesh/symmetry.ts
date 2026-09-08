import { V, type Vec2, type Vec3 } from "../../core/math";
import { polygonMoments } from "../sections";
import type { PreparedMesh } from "./prepare";
import { bounds, overlaps, visit } from "./spatial";

/** Check mirrored triangle AREA coverage, not merely mirrored vertices or a bounding box.
 * Coplanar faces may use different diagonals. Noncoplanar mirrored tessellations must agree. */
export function symmetricAboutCentreline(mesh: PreparedMesh): boolean {
  const tolerance = mesh.report.tolerance;
  for (const face of mesh.faces) {
    const a = face.map((i) => {
        const p = mesh.vertices[i];
        return [p[0], -p[1], p[2]] as Vec3;
      }),
      box = bounds(a);
    const u = V.norm(V.sub(a[1], a[0])),
      normal = V.norm(V.cross(V.sub(a[1], a[0]), V.sub(a[2], a[0]))),
      v = V.cross(normal, u);
    const project = (p: Vec3): Vec2 => {
        const d = V.sub(p, a[0]);
        return [V.dot(d, u), V.dot(d, v)];
      },
      local = a.map(project),
      area = polygonMoments(local).area;
    let covered = 0;
    visit(
      mesh.tree,
      (b) => overlaps(box, b, tolerance),
      (i) => {
        const b = mesh.faces[i].map((j) => mesh.vertices[j]);
        if (b.some((p) => Math.abs(V.dot(V.sub(p, a[0]), normal)) > tolerance))
          return;
        let poly = b.map(project);
        for (let edge = 0; edge < 3 && poly.length; edge++) {
          const p = local[edge],
            q = local[(edge + 1) % 3],
            dist = (r: Vec2) =>
              (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
          const out: Vec2[] = [];
          poly.forEach((r, k) => {
            const s = poly[(k + 1) % poly.length],
              dr = dist(r),
              ds = dist(s);
            if (dr >= 0) out.push(r);
            if ((dr < 0 && ds > 0) || (dr > 0 && ds < 0)) {
              const t = dr / (dr - ds);
              out.push([r[0] + (s[0] - r[0]) * t, r[1] + (s[1] - r[1]) * t]);
            }
          });
          poly = out;
        }
        covered += Math.abs(polygonMoments(poly).area);
      },
    );
    const perimeter = a.reduce(
      (sum, p, i) => sum + Math.hypot(...V.sub(p, a[(i + 1) % 3])),
      0,
    );
    if (Math.abs(covered - area) > tolerance * perimeter * 4) return false;
  }
  return true;
}
