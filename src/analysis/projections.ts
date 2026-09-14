// Visual projections, deliberately separate from measured sections. A silhouette is
// the UNION of positively wound projected triangle coverage, not a centreline cut.
import type { Vec2, Vec3 } from "../core/math";
import type { BoundarySource, PlaneFrame } from "./sections";
export interface ProjectionRequest {
  view: PlaneFrame;
  /** Omitted selects the whole envelope. Synthetic closures may be shown, never weighed. */
  surfaces?: string[];
}
export interface ProjectionResult {
  view: PlaneFrame;
  /** Overlapping CCW coverage polygons. Render as one nonzero-filled compound path
   * without internal strokes; these are NOT disjoint measured SectionRegions. */
  coverage: Vec2[][];
  /** In (view.u, view.v, view.u × view.v), relative to the requested origin. */
  bounds: { min: Vec3; max: Vec3 } | null;
  diagnostics: string[];
  accuracy: {
    method: "projected-triangle-union";
    triangles: number;
    errorBound: null;
  };
}
export interface DisplayGeometry {
  /** Body-frame SI triangle soup, independent of Model/Three.js. */
  positions: Float32Array;
  sources: BoundarySource[];
  bounds: { min: Vec3; max: Vec3 };
}
