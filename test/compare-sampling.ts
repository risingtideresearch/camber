/** Headless propagation experiment. Geometry is deliberately excluded in this first version. */
import type { WeightBook } from "../src/core/sheet/book";
import type { HullMetrics } from "../src/core/hullMetrics";
import { evaluatePreparedBook, prepareBook } from "../src/core/sheet/evaluate";

export interface SampleStatistics {
  readonly count: number;
  readonly mean: number;
  readonly standardDeviation: number;
  readonly rmsFromNominal: number;
  readonly p025: number;
  readonly median: number;
  readonly p975: number;
}

export function sampleStatistics(
  values: readonly number[],
  nominal: number,
): SampleStatistics | null {
  if (!values.length) return null;
  // Normalize before squaring: finite large draws (e.g. exp(x)) must not
  // overflow the variance accumulator merely because their squares do.
  const scale =
    values.reduce((s, v) => Math.max(s, Math.abs(v)), Math.abs(nominal)) || 1;
  let mean = 0,
    m2 = 0,
    squaredDeviation = 0;
  values.forEach((v, i) => {
    const normalized = v / scale;
    const delta = normalized - mean;
    mean += delta / (i + 1);
    m2 += delta * (normalized - mean);
    squaredDeviation += (normalized - nominal / scale) ** 2;
  });
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number) => {
    const index = p * (sorted.length - 1),
      lo = Math.floor(index);
    return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
  };
  return {
    count: values.length,
    mean: mean * scale,
    standardDeviation: Math.sqrt(Math.max(0, m2 / values.length)) * scale,
    rmsFromNominal: Math.sqrt(squaredDeviation / values.length) * scale,
    p025: quantile(0.025),
    median: quantile(0.5),
    p975: quantile(0.975),
  };
}

/** Mulberry32: reproducible unsigned 32-bit seed; no global random state. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SamplingComparisonOptions {
  readonly samples: number;
  readonly seed: number;
  /** Cell keys, including OUT cells. Only these samples are retained. */
  readonly targets: readonly string[];
  /** Fixed, exact hull metrics; no geometry is recomputed. */
  readonly metrics?: HullMetrics | null;
}

export function compareSampling(
  book: WeightBook,
  options: SamplingComparisonOptions,
) {
  if (!Number.isSafeInteger(options.samples) || options.samples < 1)
    throw new Error("samples must be a positive safe integer");
  if (
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffffffff
  )
    throw new Error("seed must be an unsigned 32-bit integer");
  for (const item of book.items)
    for (const field of Object.values(item.fields))
      if (field.k === "cut" || field.k === "repetition")
        throw new Error(
          "This harness supports formula propagation only; cuts and repetitions are not yet sampled",
        );

  const started = performance.now();
  const prepared = prepareBook(book);
  const preparedAt = performance.now();
  const nominal = evaluatePreparedBook(prepared, options.metrics ?? null);
  const nominalAt = performance.now();
  // Validate authored semantics before replacing uncertainty with exact values (notably powers with units).
  for (const [key, cell] of nominal.cells)
    if (cell.error || (cell.quantity && !Number.isFinite(cell.quantity.v)))
      throw new Error(
        `Invalid nominal cell ${key}: ${cell.error ?? "non-finite value"}`,
      );
  const targets = [...new Set(options.targets)].map((key) => {
    const quantity = nominal.cells.get(key)?.quantity;
    if (!quantity) throw new Error(`Missing target value: ${key}`);
    if (Object.values(quantity.d).some((g) => !Number.isFinite(g)))
      throw new Error(`Non-finite nominal gradient: ${key}`);
    return {
      key,
      quantity,
      direct: [] as number[],
      linear: [] as number[],
      residual: [] as number[],
      failures: new Map<string, number>(),
    };
  });
  // Sort identities so book traversal order cannot change which draw a source receives.
  const sources = [...nominal.sources.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (sources.some((s) => s.sample))
    throw new Error("Model-discrepancy sources are not supported");
  const random = seededRandom(options.seed);
  let samplingMs = 0,
    directEvaluationMs = 0,
    linearEvaluationMs = 0;
  for (let i = 0; i < options.samples; i++) {
    let time = performance.now();
    const offsets = new Map(
      sources.map((s) => [s.id, -s.lo + random() * (s.lo + s.hi)]),
    );
    samplingMs += performance.now() - time;
    time = performance.now();
    const result = evaluatePreparedBook(
      prepared,
      options.metrics ?? null,
      undefined,
      undefined,
      { inputOffsets: offsets },
    );
    directEvaluationMs += performance.now() - time;
    time = performance.now();
    const predictions = targets.map(
      ({ quantity }) =>
        quantity.v +
        Object.entries(quantity.d).reduce(
          (sum, [id, g]) => sum + g * offsets.get(id)!,
          0,
        ),
    );
    linearEvaluationMs += performance.now() - time;
    targets.forEach((target, j) => {
      const cell = result.cells.get(target.key);
      const value = cell?.quantity?.v;
      const predicted = predictions[j];
      const error =
        cell?.error ??
        (value === undefined
          ? "missing value"
          : !Number.isFinite(value)
            ? "non-finite value"
            : !Number.isFinite(predicted)
              ? "non-finite linear prediction"
              : null);
      if (error)
        target.failures.set(error, (target.failures.get(error) ?? 0) + 1);
      else {
        target.direct.push(value!);
        target.linear.push(predicted);
        target.residual.push(value! - predicted);
      }
    });
  }
  const summaries = targets.map((target) => ({
    key: target.key,
    nominal: target.quantity.v,
    dim: target.quantity.dim,
    valid: target.direct.length,
    invalid: options.samples - target.direct.length,
    failures: Object.fromEntries(target.failures),
    // Both summaries use the same valid worlds: explicitly conditional when any failed.
    direct: sampleStatistics(target.direct, target.quantity.v),
    linear: sampleStatistics(target.linear, target.quantity.v),
    difference: sampleStatistics(target.residual, 0),
  }));
  return {
    distribution: "uniform over authored bounds" as const,
    geometry: "fixed hull metrics; cuts and repetitions unsupported" as const,
    seed: options.seed,
    samples: options.samples,
    sourceCount: sources.length,
    statistics:
      "population moments and interpolated empirical quantiles, conditional on paired valid worlds" as const,
    targets: summaries,
    timings: {
      preparationMs: preparedAt - started,
      nominalMs: nominalAt - preparedAt,
      samplingMs,
      directEvaluationMs,
      linearEvaluationMs,
      totalMs: performance.now() - started,
    },
  };
}
