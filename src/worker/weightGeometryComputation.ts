import type { Model } from "../core/model";
import type { HullSampling } from "../core/mesh";
import {
  createSectionMeasurer,
  createSliceMeasurer,
} from "../core/sheet/slices";
import { measureRepetition } from "../core/sheet/repetitions";
import type {
  WeightGeometryJob,
  WeightGeometryRequest,
  WeightGeometryResponse,
  WeightGeometryResult,
} from "./weightGeometryProtocol";

/** Kept alive for one sampled hull. Both final results and untrimmed plane
 * intersections survive boundary edits; neither cache changes numerical accuracy. */
export function createWeightGeometryProcessor(
  model: Model,
  sampling: HullSampling,
) {
  let cut: ReturnType<typeof createSliceMeasurer> | undefined;
  let section: ReturnType<typeof createSectionMeasurer> | undefined;
  const cache = new Map<string, WeightGeometryResult>();
  const measure = (job: WeightGeometryJob): WeightGeometryResult => {
    if (job.kind === "cut") {
      cut ??= createSliceMeasurer(model, sampling);
      return {
        kind: "cut",
        value: cut(job.shape, job.position, job.limits, {
          position: job.positionSensitivity,
          boundaries: job.boundarySensitivities,
        }),
      };
    }
    section ??= createSectionMeasurer(model, sampling);
    return {
      kind: "repetition",
      result: measureRepetition(
        section,
        job.shape,
        job.start,
        job.end,
        job.pitch,
        job.limits,
        job.boundarySensitivities,
      ),
    };
  };
  return (request: WeightGeometryRequest): WeightGeometryResponse => ({
    key: request.key,
    results: request.jobs.map((job) => {
      let result = cache.get(job.key);
      if (!result) {
        result = measure(job);
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(job.key, result);
      }
      return { key: job.key, result };
    }),
  });
}
