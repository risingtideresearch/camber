import type { HullState } from "../core/hull";
import type { HullSampling } from "../core/mesh";
import type { SliceShape } from "../core/sheet/book";
import type { BoundaryLeaf, SectionLimits } from "../core/sheet/boundaries";
import type { RepetitionResult } from "../core/sheet/repetitions";
import type { SliceMeasurement } from "../core/sheet/slices";

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
      }
  );
export type WeightGeometryResult =
  | { readonly kind: "cut"; readonly value: SliceMeasurement | null }
  | { readonly kind: "repetition"; readonly result: RepetitionResult };

/** Send the sampled hull once per worker, not again for every boundary edit. */
export interface WeightGeometryHull {
  readonly type: "hull";
  readonly state: HullState;
  readonly sampling: HullSampling;
}
export interface WeightGeometryRequest {
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
