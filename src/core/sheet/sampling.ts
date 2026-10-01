import type { HullMetrics } from "../hullMetrics";
import type { Dim } from "./quantity";
import {
  prepareSampleRollup,
  rollupSampleKey,
  type SampleRollup,
} from "./sampleRollup";
import { generateTrial } from "./generateTrials";
import {
  evaluateTrial,
  type TrialGeometry,
  type TrialPlan,
  type Trial,
  type TrialValue,
} from "./trial";

export interface SamplingContext {
  readonly bookRevision: string;
  readonly hullRevision: string;
  readonly geometrySettingsRevision: string;
}
export interface SamplingTarget {
  readonly cellKey: string;
  /** A transient role total, evaluated in each trial rather than from nominal gradients. */
  readonly rollup?: SampleRollup;
  readonly dim: Dim | null;
  readonly nominal: { readonly value: number } | { readonly error: string };
}
export interface SampledOutput extends SamplingTarget {
  readonly validTrials: number;
  readonly invalidTrials: number;
  /** Conditional on valid trials. Interpolated empirical quantiles, not bounds. */
  readonly distribution: {
    readonly mean: number;
    readonly standardDeviation: number;
    /** Counts among valid trials; bin edges are in base units and recalculated at checkpoints. */
    readonly histogram: readonly {
      readonly low: number;
      readonly high: number;
      readonly count: number;
    }[];
    readonly quantiles: {
      readonly p025: number;
      readonly p50: number;
      readonly p975: number;
    };
  } | null;
  readonly failures: readonly {
    readonly message: string;
    readonly trials: number;
  }[];
  readonly precision: { readonly status: "not-assessed" };
}
export type SamplingExecution =
  | { readonly status: "running" }
  | { readonly status: "finished"; readonly reason: "sample-budget" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly message: string };
export interface SampledResults {
  readonly runId: string;
  readonly sequence: number;
  readonly context: SamplingContext;
  readonly method: {
    readonly sampler: "keyed-input-shapes-v2";
    readonly seed: number;
    readonly inputDistribution: "per-literal-uniform-triangular-or-normal";
    readonly repetitionPhases: "independent-uniform";
    readonly geometry: "direct";
  };
  readonly execution: SamplingExecution;
  readonly progress: {
    readonly requestedTrials: number;
    readonly completedTrials: number;
    readonly nextCheckpoint: number | null;
    readonly elapsedMs: number;
  };
  readonly outputs: readonly SampledOutput[];
}
export interface SamplingRequest {
  readonly runId: string;
  readonly context: SamplingContext;
  readonly seed: number;
  readonly checkpoints: readonly number[];
  readonly targets: readonly SamplingTarget[];
}
export const MAX_SAMPLING_TRIALS = 4096;
export const MAX_SAMPLING_TARGETS = 32;
export function validateCheckpoints(
  checkpoints: readonly number[],
  after = 0,
): void {
  if (!checkpoints.length)
    throw new Error("At least one checkpoint is required");
  let previous = after;
  for (const n of checkpoints) {
    if (!Number.isSafeInteger(n) || n <= previous || n > MAX_SAMPLING_TRIALS)
      throw new Error(
        `Checkpoints must increase and not exceed ${MAX_SAMPLING_TRIALS}`,
      );
    previous = n;
  }
}

/** A cumulative prefix of deterministic trials. Execution scheduling belongs to the worker.
 * This reducer retains at most 4096 × 32 output values; the worker owns the
 * separately bounded cache of mapped trial worlds. */
export function createSamplingRun(
  request: SamplingRequest,
  plan: TrialPlan,
  geometry?: TrialGeometry,
  metrics: HullMetrics | null = null,
  evaluateTargets:
    | ((
        trial: Trial,
        targets: readonly string[],
      ) => ReadonlyMap<string, TrialValue>)
    | null = null,
) {
  validateCheckpoints(request.checkpoints);
  if (
    !request.targets.length ||
    request.targets.length > MAX_SAMPLING_TARGETS ||
    new Set(request.targets.map((t) => t.cellKey)).size !==
      request.targets.length
  )
    throw new Error("Choose 1–32 distinct output cells");
  for (const target of request.targets) {
    if (target.rollup) {
      if (target.cellKey !== rollupSampleKey(target.rollup))
        throw new Error(`Invalid roll-up target: ${target.cellKey}`);
      prepareSampleRollup(plan.prepared.book, target.rollup);
    } else if (!plan.prepared.cells.has(target.cellKey))
      throw new Error(`Unknown target: ${target.cellKey}`);
  }
  // Validate the seed even before the first batch.
  generateTrial(plan, request.seed, 0);
  let checkpoints = [...request.checkpoints];
  let completed = 0,
    sequence = 0,
    elapsedMs = 0;
  const values = request.targets.map(() => [] as number[]);
  const dimensions = request.targets.map((target) => target.dim);
  const failures = request.targets.map(() => new Map<string, number>());
  const nextCheckpoint = () => checkpoints.find((n) => n > completed) ?? null;
  return {
    get completed() {
      return completed;
    },
    get done() {
      return nextCheckpoint() === null;
    },
    extend(more: readonly number[]) {
      validateCheckpoints(more, checkpoints[checkpoints.length - 1]);
      checkpoints = [...checkpoints, ...more];
    },
    /** Stop at checkpoints even when the requested batch would cross one. */
    advance(maxTrials = 8, maxMs = 12) {
      if (
        !Number.isSafeInteger(maxTrials) ||
        maxTrials < 1 ||
        !Number.isFinite(maxMs) ||
        maxMs <= 0
      )
        throw new Error("Invalid sampling batch budget");
      const start = performance.now();
      const end = Math.min(
        nextCheckpoint() ?? completed,
        completed + maxTrials,
      );
      try {
        while (completed < end) {
          const trial = generateTrial(plan, request.seed, completed);
          const keys = request.targets.map((target) => target.cellKey);
          const sampled = evaluateTargets
            ? evaluateTargets(trial, keys)
            : evaluateTrial(plan, trial, geometry, metrics, keys).values;
          request.targets.forEach((target, i) => {
            const cell = sampled.get(target.cellKey);
            dimensions[i] ??= cell?.dim ?? null;
            if (
              cell?.value !== null &&
              cell?.value !== undefined &&
              !cell.error &&
              Number.isFinite(cell.value)
            )
              values[i].push(cell.value);
            else {
              const message = cell?.error ?? "Missing or non-finite value";
              failures[i].set(message, (failures[i].get(message) ?? 0) + 1);
            }
          });
          completed++;
          if (performance.now() - start >= maxMs) break;
        }
      } finally {
        elapsedMs += performance.now() - start;
      }
      return checkpoints.includes(completed);
    },
    snapshot(execution?: SamplingExecution): SampledResults {
      return {
        runId: request.runId,
        sequence: ++sequence,
        context: request.context,
        method: {
          sampler: "keyed-input-shapes-v2",
          seed: request.seed,
          inputDistribution: "per-literal-uniform-triangular-or-normal",
          repetitionPhases: "independent-uniform",
          geometry: "direct",
        },
        execution:
          execution ??
          (nextCheckpoint() === null
            ? { status: "finished", reason: "sample-budget" }
            : { status: "running" }),
        progress: {
          requestedTrials: checkpoints[checkpoints.length - 1],
          completedTrials: completed,
          nextCheckpoint: nextCheckpoint(),
          elapsedMs,
        },
        outputs: request.targets.map((target, i) => ({
          ...target,
          dim: dimensions[i],
          validTrials: values[i].length,
          invalidTrials: completed - values[i].length,
          distribution: summarize(values[i]),
          failures: [...failures[i]].map(([message, trials]) => ({
            message,
            trials,
          })),
          precision: { status: "not-assessed" },
        })),
      };
    },
  };
}
function summarize(values: readonly number[]): SampledOutput["distribution"] {
  if (!values.length) return null;
  const scale = values.reduce((s, v) => Math.max(s, Math.abs(v)), 0) || 1;
  const mean = values.reduce((s, v) => s + v / scale / values.length, 0);
  const variance = values.reduce(
    (s, v) => s + (v / scale - mean) ** 2 / values.length,
    0,
  );
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number) => {
    const index = p * (sorted.length - 1),
      low = Math.floor(index),
      t = index - low;
    return sorted[low] * (1 - t) + sorted[Math.ceil(index)] * t;
  };
  return {
    mean: mean * scale,
    standardDeviation: Math.sqrt(variance) * scale,
    histogram: histogram(sorted),
    quantiles: {
      p025: quantile(0.025),
      p50: quantile(0.5),
      p975: quantile(0.975),
    },
  };
}

function histogram(
  sorted: readonly number[],
): NonNullable<SampledOutput["distribution"]>["histogram"] {
  const min = sorted[0],
    max = sorted[sorted.length - 1];
  if (min === max) return [{ low: min, high: max, count: sorted.length }];
  const count = 32;
  // Scale before finding bin positions so a finite range straddling zero
  // cannot overflow when max - min exceeds Number.MAX_VALUE.
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  const lower = min / scale,
    upper = max / scale;
  if (lower === upper) return [{ low: min, high: max, count: sorted.length }];
  const edge = (i: number) => (lower + ((upper - lower) * i) / count) * scale;
  const bins = Array.from({ length: count }, (_, index) => ({
    low: index === 0 ? min : edge(index),
    high: index === count - 1 ? max : edge(index + 1),
    count: 0,
  }));
  for (const value of sorted) {
    const index = Math.min(
      count - 1,
      Math.floor(((value / scale - lower) / (upper - lower)) * count),
    );
    bins[index].count++;
  }
  return bins;
}
