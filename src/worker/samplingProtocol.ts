import type { HullState } from "../core/hull";
import type { HullSampling } from "../core/mesh";
import type { HullMetrics } from "../core/hullMetrics";
import type { WeightBook } from "../core/sheet/book";
import type { SampledResults, SamplingRequest } from "../core/sheet/sampling";

export type SamplingCommand =
  | {
      readonly type: "start";
      readonly request: SamplingRequest;
      /** Only the first request in a worker needs the immutable context. */
      readonly book?: WeightBook;
      readonly hull?: HullState;
      readonly sampling?: HullSampling;
      readonly metrics?: HullMetrics | null;
    }
  | { readonly type: "cancel"; readonly runId: string }
  | { readonly type: "prioritize"; readonly runId: string }
  | {
      readonly type: "extend";
      readonly runId: string;
      readonly checkpoints: readonly number[];
    };
export type SamplingEvent =
  | {
      readonly kind: "progress";
      readonly runId: string;
      readonly completedTrials: number;
    }
  | { readonly kind: "snapshot"; readonly result: SampledResults }
  | {
      readonly kind: "error";
      readonly runId: string;
      readonly message: string;
    };
