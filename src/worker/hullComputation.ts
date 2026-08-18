// Worker-side half shared by every computation that starts from a swept hull. Runtime models carry functions
// and cannot cross postMessage, so each dedicated worker assembles and meshes from this plain request.

import type { HullState } from "../core/hull";
import { computeHullSampling, type HullSampling } from "../core/mesh";
import { assemble } from "../core/runtime";
import type { Model } from "../core/model";
import type { SessionState, SliceRevs } from "../core/runtime";

export interface HullComputationRequest {
  readonly key: string;
  readonly state: HullState;
  readonly session: SessionState;
  readonly sliceRevs: SliceRevs;
  readonly numSections: number;
  readonly girthSteps: number;
}

export function requestedHull(
  request: HullComputationRequest,
  cacheKey: object,
): { model: Model; sampling: HullSampling } {
  const model = assemble(request.state, request.session, {
    sliceRevs: request.sliceRevs,
    cacheKey,
  });
  return {
    model,
    sampling: computeHullSampling(
      model,
      request.numSections,
      request.girthSteps,
    ),
  };
}
