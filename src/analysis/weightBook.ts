// Shared two-pass orchestration: formulas resolve requests; the backend only measures them.
import type { WeightBook } from "../core/sheet/book";
import {
  evaluateBook,
  resultAt,
  type BookResults,
} from "../core/sheet/evaluate";
import type { HullMetrics } from "./hullMetrics";
import {
  sliceMeasurementKey,
  type SliceMeasurements,
  type SliceMeasurement,
} from "./geometry";
import type { Available, SliceQuery } from "./api";

export interface WeightPlan {
  readonly positions: BookResults;
  readonly queries: readonly SliceQuery[];
  readonly bindings: readonly { key: string; query: number }[];
}
export interface WeightBookResults {
  readonly positions: BookResults;
  readonly measurements: SliceMeasurements;
  readonly results: BookResults;
  readonly measurementProblems: ReadonlyMap<string, string>;
}

export function planWeightBook(
  book: WeightBook,
  metrics: HullMetrics | null,
): WeightPlan {
  const positions = evaluateBook(book, metrics);
  const queries: SliceQuery[] = [];
  const indices = new Map<string, number>();
  const bindings: { key: string; query: number }[] = [];
  for (const item of book.items)
    for (const [fieldKey, field] of Object.entries(item.fields)) {
      if (field.k !== "cut") continue;
      const result = resultAt(positions, item.id, fieldKey, "pos");
      if (
        result?.error ||
        !result?.reading ||
        !Number.isFinite(result.reading.v)
      )
        continue;
      const query = { shape: field.shape, position: result.reading.v };
      const signature = JSON.stringify(query);
      let index = indices.get(signature);
      if (index === undefined) {
        index = queries.length;
        indices.set(signature, index);
        queries.push(query);
      }
      bindings.push({
        key: sliceMeasurementKey(item.id, fieldKey),
        query: index,
      });
    }
  return { positions, queries, bindings };
}

export function finishWeightBook(
  book: WeightBook,
  metrics: HullMetrics | null,
  plan: WeightPlan,
  answers: readonly Available<SliceMeasurement>[],
): WeightBookResults {
  const measurements = new Map<string, SliceMeasurement>();
  const measurementProblems = new Map<string, string>();
  for (const binding of plan.bindings) {
    const answer = answers[binding.query];
    if (answer?.status === "available")
      measurements.set(binding.key, answer.value);
    else
      measurementProblems.set(
        binding.key,
        answer?.reason ?? "Measurement pending",
      );
  }
  return {
    positions: plan.positions,
    measurements,
    measurementProblems,
    results: evaluateBook(book, metrics, measurements),
  };
}
