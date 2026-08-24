// What a window and its private hull sampler say to each other. Two messages, both plain data.
//
// `key` is opaque to the worker: the window mints it from everything the sweep depends on (the geometry slice
// revisions and the resolution) and the worker hands it straight back, so a reply can be matched to the
// request that asked for it and a late answer to a superseded one can be recognised for what it is.

import type { HullSampling } from "../core/mesh";
import type { HullComputationRequest } from "./hullComputation";

export type SamplingRequest = HullComputationRequest;

export interface SamplingResponse {
  readonly key: string;
  readonly sampling: HullSampling;
}
