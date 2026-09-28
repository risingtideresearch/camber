import type { SampleStatistics } from "./compare-sampling";

/** Conditional moments and inverse weighted empirical-CDF quantiles.
 * Weights are probability mass, not replicated observations. Zero-weight points
 * carry no information; an all-invalid/zero-mass distribution has no statistics.
 */
export function weightedSampleStatistics(
  values: readonly number[],
  weights: readonly number[],
  nominal: number,
): SampleStatistics | null {
  if (values.length !== weights.length)
    throw new Error("Values and weights must have equal lengths");
  if (!Number.isFinite(nominal)) throw new Error("Nominal must be finite");
  const points = values
    .map((value, i) => {
      const weight = weights[i];
      if (!Number.isFinite(value) || !Number.isFinite(weight) || weight < 0)
        throw new Error(
          "Weighted samples must be finite with non-negative weights",
        );
      return { value, weight };
    })
    .filter(({ weight }) => weight > 0);
  if (!points.length) return null;
  const scale =
    points.reduce(
      (s, p) => Math.max(s, Math.abs(p.value)),
      Math.abs(nominal),
    ) || 1;
  const total = points.reduce((s, p) => s + p.weight, 0);
  if (!Number.isFinite(total))
    throw new Error("Total sample weight must be finite");
  const mean = points.reduce(
    (s, p) => s + (p.weight / total) * (p.value / scale),
    0,
  );
  const variance = points.reduce(
    (s, p) => s + (p.weight / total) * (p.value / scale - mean) ** 2,
    0,
  );
  const deviation = points.reduce(
    (s, p) => s + (p.weight / total) * (p.value / scale - nominal / scale) ** 2,
    0,
  );
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const quantile = (p: number) => {
    let cumulative = 0;
    for (const point of sorted) {
      cumulative += point.weight / total;
      if (cumulative >= p) return point.value;
    }
    return sorted[sorted.length - 1].value;
  };
  return {
    count: points.length,
    mean: mean * scale,
    standardDeviation: Math.sqrt(variance) * scale,
    rmsFromNominal: Math.sqrt(deviation) * scale,
    p025: quantile(0.025),
    median: quantile(0.5),
    p975: quantile(0.975),
  };
}
