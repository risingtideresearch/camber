// Physical, orthonormal hull-frame coordinates in metres. These are NOT Camber's
// hybrid sheet coordinates and an authored station is not a PlaneFrame.
import type { Vec2, Vec3 } from "../core/math";
import { V } from "../core/math";
import type { Available } from "./api";

export interface PlaneFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
}
export type BoundarySource =
  | { kind: "physical"; surface: string }
  | { kind: "synthetic"; closure: string };
export interface SectionRequest {
  plane: PlaneFrame;
  envelope: "buoyancy";
  /** Absolute intersection tolerance in metres; never a claimed geometry error bound. */
  tolerance?: number;
}
export interface SectionLoop {
  /** No repeated closing point. Outer loops CCW, holes CW, seen along u × v. */
  points: Vec2[];
  /** Source of the edge leaving each point. */
  edges: BoundarySource[];
}
export interface SectionPath {
  points: Vec2[];
  edges: BoundarySource[];
}
export interface SectionRegion {
  outer: SectionLoop;
  holes: SectionLoop[];
}
export interface AccuracyReport {
  method: "triangle-intersection";
  tolerance: number;
  triangles: number;
  /** Tessellation/shape error is unknown, not the weld/intersection tolerance. */
  errorBound: null;
}
export interface SectionResult {
  plane: PlaneFrame;
  regions: SectionRegion[];
  openPaths: SectionPath[];
  measurements: {
    area: Available<number>;
    centroid: Available<Vec2>;
    closedPerimeter: Available<number>;
    perimeterBySurface: Record<string, number>;
    syntheticPerimeter: number;
    /** Centroidal ∫v² dA, ∫u² dA, ∫uv dA, in m⁴. */
    moments: Available<{ uu: number; vv: number; uv: number }>;
  };
  diagnostics: string[];
  accuracy: AccuracyReport;
}
export function planeNormal(plane: PlaneFrame): Vec3 {
  if (
    ![plane.origin, plane.u, plane.v].every((v) => v.length === 3) ||
    ![...plane.origin, ...plane.u, ...plane.v].every(Number.isFinite) ||
    Math.abs(V.dot(plane.u, plane.u) - 1) > 1e-10 ||
    Math.abs(V.dot(plane.v, plane.v) - 1) > 1e-10 ||
    Math.abs(V.dot(plane.u, plane.v)) > 1e-10
  )
    throw new Error(
      "A section needs a finite origin and orthonormal unit basis",
    );
  return V.cross(plane.u, plane.v);
}
export const planePoint = (plane: PlaneFrame, p: Vec3): Vec2 => {
  const d = V.sub(p, plane.origin);
  return [V.dot(d, plane.u), V.dot(d, plane.v)];
};
export const hullPoint = (plane: PlaneFrame, p: Vec2): Vec3 =>
  plane.origin.map((x, i) => x + plane.u[i] * p[0] + plane.v[i] * p[1]) as Vec3;

/** Signed Green integrals, stable relative to a local origin supplied by the caller. */
export function polygonMoments(points: readonly Vec2[]) {
  let area = 0,
    x = 0,
    y = 0,
    xx = 0,
    yy = 0,
    xy = 0;
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length],
      c = a[0] * b[1] - b[0] * a[1];
    area += c / 2;
    x += ((a[0] + b[0]) * c) / 6;
    y += ((a[1] + b[1]) * c) / 6;
    xx += ((a[0] ** 2 + a[0] * b[0] + b[0] ** 2) * c) / 12;
    yy += ((a[1] ** 2 + a[1] * b[1] + b[1] ** 2) * c) / 12;
    xy +=
      ((2 * a[0] * a[1] + a[0] * b[1] + b[0] * a[1] + 2 * b[0] * b[1]) * c) /
      24;
  });
  return { area, x, y, xx, yy, xy };
}
export function containsPoint(loop: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  loop.forEach((a, i) => {
    const b = loop[(i + 1) % loop.length];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    )
      inside = !inside;
  });
  return inside;
}
