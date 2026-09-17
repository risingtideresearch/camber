import type { WeightBook } from "../core/sheet/book";
import { activeBoundaries, validateLimits } from "../core/sheet/boundaries";
import { resultAt, type BookResults } from "../core/sheet/evaluate";
import {
  sliceMeasurementKey,
  type SliceMeasurements,
  type SliceMeasurement,
} from "../core/sheet/slices";
import type {
  RepetitionMeasurements,
  RepetitionResult,
} from "../core/sheet/repetitions";
import { uncertaintyPending } from "../worker/weightGeometryProtocol";
import type {
  WeightGeometryJob,
  WeightGeometryResult,
} from "../worker/weightGeometryProtocol";

export interface WeightGeometryPlan {
  readonly jobs: readonly WeightGeometryJob[];
  readonly fields: readonly { key: string; job: WeightGeometryJob }[];
}

/** Resolve only authored inputs here. No hull intersections or quadrature in
 * render. Uncertainty source identities do not enter geometry cache keys. */
export function planWeightGeometry(
  book: WeightBook,
  positions: BookResults,
): WeightGeometryPlan {
  const jobs = new Map<string, WeightGeometryJob>();
  const fields: { key: string; job: WeightGeometryJob }[] = [];
  for (const item of book.items)
    for (const [key, field] of Object.entries(item.fields)) {
      if (field.k !== "cut" && field.k !== "repetition") continue;
      const inputs = activeBoundaries(field).map((b) => ({
        boundary: b,
        result: resultAt(positions, item.id, key, b.leaf),
      }));
      if (
        inputs.some(
          ({ result }) => !result?.quantity || result.error || result.empty,
        )
      )
        continue;
      const limits = Object.fromEntries(
        inputs.map(({ boundary, result }) => [
          boundary.leaf,
          result!.quantity!.v,
        ]),
      );
      try {
        validateLimits(limits);
      } catch {
        continue;
      }
      const boundarySensitivities = inputs
        .filter(({ result }) => Object.keys(result!.quantity!.d).length > 0)
        .map(({ boundary }) => boundary.leaf);
      const common = { shape: field.shape, limits, boundarySensitivities };
      let job: WeightGeometryJob;
      if (field.k === "cut") {
        const position = resultAt(positions, item.id, key, "pos");
        if (!position?.quantity || position.error || position.empty) continue;
        const data = {
          ...common,
          kind: "cut" as const,
          position: position.quantity.v,
          positionSensitivity: Object.keys(position.quantity.d).length > 0,
        };
        job = { ...data, key: JSON.stringify(data) };
      } else {
        const start = resultAt(positions, item.id, key, "start"),
          end = resultAt(positions, item.id, key, "end"),
          repeat = resultAt(positions, item.id, key, field.repetition);
        if (
          !start?.quantity ||
          !end?.quantity ||
          !repeat?.quantity ||
          start.error ||
          end.error ||
          repeat.error
        )
          continue;
        const pitch =
          field.repetition === "spacing"
            ? repeat.quantity.v
            : (end.quantity.v - start.quantity.v) / repeat.quantity.v;
        if (
          !(pitch > 0) ||
          !Number.isFinite(pitch) ||
          end.quantity.v <= start.quantity.v
        )
          continue;
        const data = {
          ...common,
          kind: "repetition" as const,
          start: start.quantity.v,
          end: end.quantity.v,
          pitch,
        };
        job = { ...data, key: JSON.stringify(data) };
      }
      jobs.set(job.key, job);
      fields.push({ key: sliceMeasurementKey(item.id, key), job });
    }
  return { jobs: [...jobs.values()], fields };
}

export function resolveWeightGeometry(
  plan: WeightGeometryPlan,
  values: ReadonlyMap<string, WeightGeometryResult>,
): {
  measurements: SliceMeasurements;
  repetitions: RepetitionMeasurements;
  pending: boolean;
  uncertaintyPending: boolean;
} {
  const measurements = new Map<string, SliceMeasurement>();
  const repetitions = new Map<string, RepetitionResult>();
  let pending = false;
  let pendingUncertainty = false;
  for (const { key, job } of plan.fields) {
    const result = values.get(job.key);
    if (!result) {
      pending = true;
      continue;
    }
    pendingUncertainty ||= uncertaintyPending(result);
    if (result.kind === "cut") {
      if (result.value) measurements.set(key, result.value);
    } else repetitions.set(key, result.result);
  }
  return {
    measurements,
    repetitions,
    pending,
    uncertaintyPending: pendingUncertainty,
  };
}
