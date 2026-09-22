import type { HullState } from "../core/hull";
import type { HullSampling } from "../core/mesh";
import type { SliceShape } from "../core/sheet/book";
import type { BoundaryLeaf, SectionLimits } from "../core/sheet/boundaries";
import type { RepetitionResult } from "../core/sheet/repetitions";
import type {
  RawSliceMeasurement,
  SliceMeasurement,
} from "../core/sheet/slices";

interface GeometryJob {
  readonly key: string;
  readonly shape: SliceShape;
  readonly limits: SectionLimits;
  readonly boundarySensitivities: readonly BoundaryLeaf[];
}
export type WeightGeometryJob = GeometryJob &
  (
    | {
        readonly kind: "cut";
        readonly position: number;
        readonly positionSensitivity: boolean;
      }
    | {
        readonly kind: "repetition";
        readonly start: number;
        readonly end: number;
        readonly pitch: number;
        /** Presentation-owned positions to measure independently of quadrature. */
        readonly previewPositions: readonly number[];
      }
  );
export type WeightGeometryResult =
  | { readonly kind: "cut"; readonly value: SliceMeasurement | null }
  | {
      readonly kind: "repetition";
      readonly result: RepetitionResult;
      /** A preview failure never invalidates the numerical measurement. */
      readonly preview: readonly RawSliceMeasurement[] | null;
    };

/** Send the sampled hull once per worker, not again for every boundary edit. */
export interface WeightGeometryHull {
  readonly type: "hull";
  readonly state: HullState;
  readonly sampling: HullSampling;
}
export interface WeightGeometryRequest {
  /** Omitted by single-pass callers; the editor requests nominal first. */
  readonly phase?: "nominal" | "complete";
  readonly key: string;
  readonly jobs: readonly WeightGeometryJob[];
}
export interface WeightGeometryResponse {
  readonly key: string;
  readonly results: readonly {
    readonly key: string;
    readonly result: WeightGeometryResult;
  }[];
  readonly error?: string;
}

export function uncertaintyPending(result: WeightGeometryResult): boolean {
  return !!(result.kind === "cut"
    ? result.value?.uncertaintyPending
    : result.result.value?.uncertaintyPending);
}
