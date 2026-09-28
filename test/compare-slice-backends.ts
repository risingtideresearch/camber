import { prepareBook } from "../src/core/sheet/evaluate";
import {
  directTrialGeometry,
  evaluateTrial,
  prepareTrials,
  type TrialGeometry,
} from "../src/core/sheet/trial";
import {
  precomputedSliceGeometry,
  type SliceInterpolationTolerance,
  type SliceSample,
  type SliceTableSpec,
} from "../src/core/sheet/precomputedSlices";
import type { WeightBook } from "../src/core/sheet/book";
import { generateTrial } from "./generate-trials";
import { sampleStatistics } from "./compare-sampling";

export interface SliceComparisonFixture {
  readonly name: string;
  readonly book: WeightBook;
  readonly targets: readonly string[];
  /** New direct-measurement context/cache for each backend. Fixed hull shared. */
  readonly createMeasure: () => (
    request: Parameters<TrialGeometry["section"]>[0],
  ) => SliceSample;
  readonly table: Omit<SliceTableSpec, "intervals">;
}
export function compareSliceBackends(
  fixture: SliceComparisonFixture,
  options: {
    readonly samples: number;
    readonly seed: number;
    readonly resolutions: readonly number[];
    readonly tolerance: SliceInterpolationTolerance;
  },
) {
  if (!Number.isSafeInteger(options.samples) || options.samples < 1)
    throw new Error("samples must be a positive safe integer");
  const plan = prepareTrials(prepareBook(fixture.book));
  // Generate once. Every backend receives these exact objects in the same order.
  const trials = Array.from({ length: options.samples }, (_, index) =>
    generateTrial(plan, options.seed, index),
  );
  let referenceCalls = 0;
  const preparedAt = performance.now();
  const measure = fixture.createMeasure();
  const direct = directTrialGeometry((request) => {
    referenceCalls++;
    return measure(request).measures;
  });
  const referencePreparationMs = performance.now() - preparedAt;
  const run = (geometry: TrialGeometry) => {
    const started = performance.now();
    const results = trials.map((trial) => {
      const result = evaluateTrial(plan, trial, geometry);
      return fixture.targets.map((key) => {
        const cell = result.values.get(key);
        if (!cell) throw new Error(`Missing target ${key}`);
        return cell;
      });
    });
    return { results, evaluationMs: performance.now() - started };
  };
  const reference = run(direct);
  const approximations = options.resolutions.map((intervals) => {
    const started = performance.now();
    const backend = precomputedSliceGeometry(
      fixture.createMeasure(),
      [{ ...fixture.table, intervals }],
      options.tolerance,
    );
    const preparationMs = performance.now() - started;
    const approximate = run(backend.geometry);
    return {
      intervals,
      preparationMs,
      evaluationMs: approximate.evaluationMs,
      totalMs: preparationMs + approximate.evaluationMs,
      speedupIncludingPreparation:
        (referencePreparationMs + reference.evaluationMs) /
        (preparationMs + approximate.evaluationMs),
      tables: backend.tables,
      geometry: backend.stats(),
      outputs: fixture.targets.map((key, column) => {
        const differences: number[] = [],
          values: number[] = [];
        let referenceInvalid = 0,
          approximateInvalid = 0,
          validityMismatches = 0,
          errorMismatches = 0,
          maxAbsoluteDifference = 0;
        let firstMismatch: null | {
          trial: (typeof trials)[number];
          referenceError: string | null;
          approximateError: string | null;
        } = null;
        approximate.results.forEach((row, index) => {
          const a = row[column],
            r = reference.results[index][column];
          const validA = !a.error && a.value !== null,
            validR = !r.error && r.value !== null;
          if (!validR) referenceInvalid++;
          if (!validA) approximateInvalid++;
          else values.push(a.value!);
          if (validA !== validR) validityMismatches++;
          if (a.error !== r.error) errorMismatches++;
          if ((validA !== validR || a.error !== r.error) && !firstMismatch)
            firstMismatch = {
              trial: trials[index],
              referenceError: r.error,
              approximateError: a.error,
            };
          if (validA && validR) {
            const difference = a.value! - r.value!;
            differences.push(difference);
            maxAbsoluteDifference = Math.max(
              maxAbsoluteDifference,
              Math.abs(difference),
            );
          }
        });
        return {
          key,
          pairedValid: differences.length,
          referenceInvalid,
          approximateInvalid,
          validityMismatches,
          errorMismatches,
          firstMismatch,
          maxAbsoluteDifference,
          difference: sampleStatistics(differences, 0),
          values: sampleStatistics(values, 0),
          rmsReference: "zero; only difference RMS is an approximation error",
        };
      }),
    };
  });
  return {
    fixture: fixture.name,
    samples: options.samples,
    seed: options.seed,
    generator: "keyed-uniform-v1",
    tolerance: options.tolerance,
    firstTrial: trials[0],
    timingScope:
      "Same pre-generated trials. Includes fresh per-backend section context and table build; excludes shared hull mesh, book preparation and trial generation. Single runs, not warmed-up benchmarks.",
    reference: {
      preparationMs: referencePreparationMs,
      evaluationMs: reference.evaluationMs,
      totalMs: referencePreparationMs + reference.evaluationMs,
      sectionCalls: referenceCalls,
    },
    approximations,
  };
}
