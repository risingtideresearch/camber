/** Paired layout experiment. Exact authored inputs; one repetition per fixture. */
import { activeBoundaries } from "../src/core/sheet/boundaries";
import type { WeightBook } from "../src/core/sheet/book";
import {
  cellKey,
  evaluatePreparedBook,
  prepareBook,
} from "../src/core/sheet/evaluate";
import {
  measureRepetition,
  measureRepetitionLayout,
} from "../src/core/sheet/repetitions";
import { sliceMeasurementKey } from "../src/core/sheet/slices";
import { sampleStatistics } from "./compare-sampling";
import { generateTrial, existingPhaseTrials } from "./generate-trials";
import { evaluateTrial, prepareTrials } from "../src/core/sheet/trial";
import { weightedSampleStatistics } from "./weighted-sampling-statistics";
import type { RepetitionLayout } from "../src/core/sheet/repetitions";

type ComparisonOptions = { readonly targets: readonly string[] } & (
  | {
      readonly mode?: "random";
      readonly samples: number;
      readonly seed: number;
    }
  | { readonly mode: "existing" }
);

export function compareRepetitionSampling(
  book: WeightBook,
  measure: Parameters<typeof measureRepetition>[0],
  options: ComparisonOptions,
) {
  const existing = options.mode === "existing";
  if (
    !existing &&
    (!Number.isSafeInteger(options.samples) || options.samples < 1)
  )
    throw new Error("samples must be a positive safe integer");
  if (
    !existing &&
    (!Number.isInteger(options.seed) ||
      options.seed < 0 ||
      options.seed > 0xffffffff)
  )
    throw new Error("seed must be an unsigned 32-bit integer");
  const started = performance.now();
  const prepared = prepareBook(book);
  const plan = prepareTrials(prepared);
  const fields = book.items.flatMap((item) =>
    Object.entries(item.fields).map(([key, field]) => ({ item, key, field })),
  );
  if (fields.some(({ field }) => field.k === "cut"))
    throw new Error("Cuts are not supported in this experiment");
  const repetitions = fields.filter(({ field }) => field.k === "repetition");
  if (repetitions.length !== 1)
    throw new Error("This experiment requires exactly one repetition");
  const { item, key, field } = repetitions[0];
  if (field.k !== "repetition") throw new Error("Missing repetition");
  const inputs = evaluatePreparedBook(prepared, null);
  if (inputs.sources.size)
    throw new Error("This experiment requires exact authored inputs");
  const input = (leaf: string) => {
    const cell = inputs.cells.get(cellKey(item.id, key, leaf));
    if (!cell?.quantity || cell.error || !Number.isFinite(cell.quantity.v))
      throw new Error(`Invalid repetition input ${leaf}: ${cell?.error}`);
    return cell.quantity.v;
  };
  const start = input("start"),
    end = input("end");
  const pitch =
    field.repetition === "spacing"
      ? input("spacing")
      : (end - start) / input("count");
  const limits = Object.fromEntries(
    activeBoundaries(field).map((b) => [b.leaf, input(b.leaf)]),
  );
  const geometryKey = sliceMeasurementKey(item.id, key);
  let sectionCalls = 0;
  const countedMeasure = (...args: Parameters<typeof measure>) => {
    sectionCalls++;
    return measure(...args);
  };
  const preparedAt = performance.now();
  const base = measureRepetition(
    countedMeasure,
    field.shape,
    start,
    end,
    undefined,
    limits,
    [],
  );
  if (!base.value) throw new Error(base.error);
  const nominalGeometryAt = performance.now();
  const nominalSectionCalls = sectionCalls;
  const baseMeasurements = new Map([[geometryKey, base]]);
  const nominal = evaluatePreparedBook(
    prepared,
    null,
    undefined,
    baseMeasurements,
  );
  for (const [cellKey, cell] of nominal.cells) {
    if (cell.error || (cell.quantity && !Number.isFinite(cell.quantity.v)))
      throw new Error(
        `Invalid nominal cell ${cellKey}: ${cell.error ?? "non-finite value"}`,
      );
  }
  if (nominal.sources.size)
    throw new Error("This experiment requires exact authored inputs");
  const targets = [...new Set(options.targets)].map((key) => {
    const quantity = nominal.cells.get(key)?.quantity;
    if (!quantity) throw new Error(`Missing target ${key}`);
    return {
      key,
      quantity,
      direct: [] as number[],
      linear: [] as number[],
      differences: [] as number[],
      failures: new Map<string, number>(),
      weights: [] as number[],
      failureProbabilities: new Map<string, number>(),
    };
  });
  const nominalAt = performance.now();
  // Existing adaptive, stratified placement estimate: report separately from paired RNG draws.
  const currentGeometry = measureRepetition(
    countedMeasure,
    field.shape,
    start,
    end,
    pitch,
    limits,
    [],
    base.value,
  );
  const current = evaluatePreparedBook(
    prepared,
    null,
    undefined,
    new Map([[geometryKey, currentGeometry]]),
  );
  const currentAt = performance.now();
  const currentSectionCalls = sectionCalls - nominalSectionCalls;
  const phases = currentGeometry.value?.phaseTotals;
  if (existing && !phases?.length)
    throw new Error(
      `Existing phase layouts unavailable: ${currentGeometry.error ?? "no phases"}`,
    );
  const samples = existing ? phases!.length : options.samples;
  const weightedTrials = existing
    ? existingPhaseTrials(plan, geometryKey, phases!)
    : null;
  let layoutMs = 0,
    directEvaluationMs = 0,
    pairedLinearEvaluationMs = 0;
  const counts: number[] = [];
  for (let i = 0; i < samples; i++) {
    const trial = existing
      ? weightedTrials![i].trial
      : generateTrial(plan, options.seed, i);
    const weight = existing ? weightedTrials![i].weight : 1 / samples;
    let time = performance.now();
    let layout: Pick<RepetitionLayout, "measures"> | undefined;
    let layoutError = "Layout measurement failed";
    try {
      if (existing) {
        layout = { measures: phases![i].measures };
      } else {
        const measured = measureRepetitionLayout(countedMeasure, {
          shape: field.shape,
          start,
          end,
          pitch,
          phase: trial.repetitionPhases[geometryKey],
          limits,
        });
        layout = measured;
        counts.push(measured.count);
      }
    } catch (error) {
      layoutError = `layout: ${error instanceof Error ? error.message : String(error)}`;
    }
    layoutMs += performance.now() - time;
    time = performance.now();
    // A deterministic exact cache: replay the measured request, not a hidden
    // phase choice. Its key includes all geometry inputs, including clipping.
    const expectedRequest = JSON.stringify({
      shape: field.shape,
      start,
      end,
      pitch,
      phase: trial.repetitionPhases[geometryKey],
      limits,
    });
    const direct = evaluateTrial(plan, trial, {
      section: ({ shape, position, limits }) =>
        countedMeasure(shape, position, limits).measures,
      layout: (request) => {
        if (JSON.stringify(request) !== expectedRequest)
          throw new Error("Layout cache request mismatch");
        if (!layout) throw new Error(layoutError);
        return layout;
      },
    });
    directEvaluationMs += performance.now() - time;
    time = performance.now();
    // Feed THIS layout to the existing discrepancy algebra. Its single gradient
    // coefficient is the first-order deviation for this world, not a random source.
    const linear = evaluatePreparedBook(
      prepared,
      null,
      undefined,
      new Map([
        [
          geometryKey,
          layout
            ? {
                value: {
                  ...base.value,
                  phaseTotals: [{ measures: layout.measures, weight: 1 }],
                },
              }
            : { error: layoutError },
        ],
      ]),
    );
    const predictions = targets.map(({ key }) => {
      const q = linear.cells.get(key)?.quantity;
      return q
        ? q.v + Object.values(q.d).reduce((a, b) => a + b, 0)
        : undefined;
    });
    pairedLinearEvaluationMs += performance.now() - time;
    targets.forEach((target, j) => {
      const cell = direct.values.get(target.key),
        linearCell = linear.cells.get(target.key);
      const value = cell?.value ?? undefined,
        prediction = predictions[j];
      const failure = cell?.error
        ? `direct: ${cell.error}`
        : linearCell?.error
          ? `linear: ${linearCell.error}`
          : value === undefined || prediction === undefined
            ? "missing result"
            : !Number.isFinite(value) || !Number.isFinite(prediction)
              ? "non-finite result"
              : null;
      if (failure) {
        target.failures.set(failure, (target.failures.get(failure) ?? 0) + 1);
        target.failureProbabilities.set(
          failure,
          (target.failureProbabilities.get(failure) ?? 0) + weight,
        );
      } else {
        target.weights.push(weight);
        target.direct.push(value!);
        target.linear.push(prediction!);
        target.differences.push(value! - prediction!);
      }
    });
  }
  return {
    distribution: "uniform regular-grid phase; all authored inputs exact",
    mode: existing ? "existing weighted phases" : "random phases",
    samples,
    seed: existing ? null : options.seed,
    pitch,
    statistics: existing
      ? "conditional weighted moments and inverse empirical-CDF quantiles; not bounds"
      : "conditional on paired valid layouts; empirical quantiles are not bounds",
    convergence:
      "Existing phase refinement checks geometry amounts/moments, not nonlinear output statistics",
    targets: targets.map((target) => ({
      key: target.key,
      nominal: target.quantity.v,
      dim: target.quantity.dim,
      current: {
        reading: current.cells.get(target.key)?.reading,
        error: current.cells.get(target.key)?.error,
      },
      valid: target.direct.length,
      invalid: samples - target.direct.length,
      validProbability: target.weights.reduce((sum, w) => sum + w, 0),
      invalidProbability: [...target.failureProbabilities.values()].reduce(
        (sum, w) => sum + w,
        0,
      ),
      failureProbabilities: Object.fromEntries(target.failureProbabilities),
      failures: Object.fromEntries(target.failures),
      direct: existing
        ? weightedSampleStatistics(
            target.direct,
            target.weights,
            target.quantity.v,
          )
        : sampleStatistics(target.direct, target.quantity.v),
      linear: existing
        ? weightedSampleStatistics(
            target.linear,
            target.weights,
            target.quantity.v,
          )
        : sampleStatistics(target.linear, target.quantity.v),
      difference: existing
        ? weightedSampleStatistics(target.differences, target.weights, 0)
        : sampleStatistics(target.differences, 0),
    })),
    layoutCounts: sampleStatistics(counts, (end - start) / pitch),
    geometryCalls: {
      nominal: nominalSectionCalls,
      currentPlacement: currentSectionCalls,
      sampledLayouts: sectionCalls - nominalSectionCalls - currentSectionCalls,
    },
    timings: {
      preparationMs: preparedAt - started,
      nominalGeometryMs: nominalGeometryAt - preparedAt,
      nominalEvaluationMs: nominalAt - nominalGeometryAt,
      currentPlacementMs: currentAt - nominalAt,
      layoutMs,
      directEvaluationMs,
      pairedLinearEvaluationMs,
      totalMs: performance.now() - started,
    },
  };
}
