import type { Model } from "../core/model";
import type { HullSampling } from "../core/mesh";
import {
  createSectionMeasurer,
  createSliceMeasurer,
} from "../core/sheet/slices";
import { uncertaintyPending } from "./weightGeometryProtocol";
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
  const nominalCache = new Map<string, WeightGeometryResult>();
  const remember = (
    target: Map<string, WeightGeometryResult>,
    key: string,
    result: WeightGeometryResult,
  ) => {
    if (target.size >= 128) target.delete(target.keys().next().value!);
    target.set(key, result);
  };
  const measure = (
    job: WeightGeometryJob,
    nominal: boolean,
  ): WeightGeometryResult => {
    if (job.kind === "cut") {
      cut ??= createSliceMeasurer(model, sampling);
      const value = cut(job.shape, job.position, job.limits, {
        position: nominal ? false : job.positionSensitivity,
        boundaries: nominal ? [] : job.boundarySensitivities,
      });
      return {
        kind: "cut",
        value:
          value &&
          nominal &&
          (job.positionSensitivity || job.boundarySensitivities.length)
            ? { ...value, uncertaintyPending: true }
            : value,
      };
    }

    section ??= createSectionMeasurer(model, sampling);
    const cached = nominalCache.get(job.key);
    const result = measureRepetition(
      section,
      job.shape,
      job.start,
      job.end,
      nominal ? undefined : job.pitch,
      job.limits,
      nominal ? [] : job.boundarySensitivities,
      !nominal && cached?.kind === "repetition"
        ? cached.result.value
        : undefined,
    );
    return {
      kind: "repetition",
      result:
        nominal && result.value
          ? { value: { ...result.value, uncertaintyPending: true } }
          : result,
    };
  };
  return (request: WeightGeometryRequest): WeightGeometryResponse => ({
    key: request.key,
    results: request.jobs.map((job) => {
      let result = cache.get(job.key);
      if (!result && request.phase === "nominal")
        result = nominalCache.get(job.key);
      if (!result) {
        result = measure(job, request.phase === "nominal");
        remember(
          uncertaintyPending(result) ? nominalCache : cache,
          job.key,
          result,
        );
        if (!uncertaintyPending(result)) nominalCache.delete(job.key);
      }
      return { key: job.key, result };
    }),
  });
}
