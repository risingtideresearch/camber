// Geometry-only reduction of unordered, material-oriented boundary segments.
import { V, type Vec3 } from "../math";
import {
  zeroMeasures,
  zeroMeasure,
  type SectionMeasures,
} from "./sectionMeasures";

/** No divisions by signed area until a caller requests a centroid. This keeps
 * cavity cancellation and empty sections well-defined. Euclidean amounts are
 * measured in model coordinates; only moments use the affine reporting frame.
 */
export function createDirectedMeasureAccumulator(
  normal: Vec3,
  offset: number,
  toSheet: (p: Vec3) => Vec3,
  scale: number,
  eps: number,
) {
  const tangent = V.cross(
    normal,
    Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0],
  );
  const length = Math.hypot(...tangent),
    u = tangent.map((x) => x / length) as Vec3,
    v = V.cross(normal, u);
  let origin: Vec3 | undefined;
  let area = 0,
    open = 0,
    closed = 0;
  const areaMoment = [0, 0, 0],
    openMoment = [0, 0, 0],
    closedMoment = [0, 0, 0];
  return {
    add(a: Vec3, b: Vec3, skin: boolean): void {
      if (!origin) {
        const distance = V.dot(a, normal) - offset;
        origin = a.map((x, i) => x - normal[i] * distance) as Vec3;
      }
      const pa = a.map((x, i) => x - origin![i]) as Vec3,
        pb = b.map((x, i) => x - origin![i]) as Vec3;
      const ax = V.dot(pa, u),
        ay = V.dot(pa, v),
        bx = V.dot(pb, u),
        by = V.dot(pb, v);
      const signedArea = ((ax * by - bx * ay) / 2) * scale * scale;
      const centroid = toSheet(
        origin.map(
          (x, i) => x + (u[i] * (ax + bx) + v[i] * (ay + by)) / 3,
        ) as Vec3,
      );
      const length = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * scale;
      const midpoint = toSheet(a.map((x, i) => (x + b[i]) / 2) as Vec3);
      area += signedArea;
      closed += length;
      if (skin) open += length;
      for (let i = 0; i < 3; i++) {
        areaMoment[i] += signedArea * centroid[i];
        closedMoment[i] += length * midpoint[i];
        if (skin) openMoment[i] += length * midpoint[i];
      }
    },
    finish(): SectionMeasures {
      if (!origin) return zeroMeasures();
      const threshold = eps * eps * scale * scale;
      if (area < -threshold)
        throw new Error(
          "Directed cut has negative area; check outward mesh winding",
        );
      return {
        area:
          Math.abs(area) < threshold
            ? zeroMeasure()
            : { amount: area, moment: [...areaMoment] as Vec3 },
        openLength: { amount: open, moment: [...openMoment] as Vec3 },
        closedLength: { amount: closed, moment: [...closedMoment] as Vec3 },
      };
    },
  };
}
