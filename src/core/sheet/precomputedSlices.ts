import { validateLimits, type SectionLimits } from "./boundaries";
import {
  MEASURE_NAMES,
  scaleMeasure,
  sumMeasure,
  type SectionMeasures,
} from "./sectionMeasures";
import {
  directTrialGeometry,
  type SectionRequest,
  type TrialGeometry,
} from "./trial";

export interface SliceTableSpec {
  /** Sweep stations are not a parallel family; they always use direct measurement. */
  readonly shape: "plane" | "transverse" | "longitudinal";
  readonly start: number;
  readonly end: number;
  readonly intervals: number;
  /** A table describes this exact clipping configuration, never nearby limits. */
  readonly limits?: SectionLimits;
}
export interface SliceInterpolationTolerance {
  readonly relative: number;
  readonly area: number; // absolute amount tolerance, m²
  readonly length: number; // absolute amount tolerance, m
  /** Moment floor uses amount × this distance, in metres. */
  readonly momentLengthScale: number;
}
export interface SliceSample {
  readonly measures: SectionMeasures;
  /** Optional topology signature, e.g. contour count. Changes force direct fallback.
   * This is a diagnostic, not proof of topology throughout the interval.
   */
  readonly topology?: string;
}
export interface SliceTableDiagnostics {
  readonly spec: SliceTableSpec;
  readonly interpolatedIntervals: number;
  readonly fallbackIntervals: number;
  readonly rejected: Readonly<Record<string, number>>;
}
export interface SliceBackendStats {
  readonly precomputeCalls: number;
  readonly precomputeFailures: number;
  readonly exactHits: number;
  readonly interpolated: number;
  readonly directFallbacks: number;
}
interface Snapshot {
  readonly measures: SectionMeasures;
  readonly topology?: string;
}
type Probe = { value: Snapshot } | { error: string };
interface Interval {
  readonly left: number;
  readonly right: number;
  readonly reason: string | null;
}
interface Table {
  readonly spec: SliceTableSpec;
  readonly probes: readonly Probe[];
  readonly exact: ReadonlyMap<number, Probe>;
  readonly intervals: readonly Interval[];
}

function limitsOf(limits: SectionLimits = {}): SectionLimits {
  validateLimits(limits);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(limits)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
}
const familyKey = (shape: string, limits: SectionLimits) =>
  JSON.stringify([shape, limitsOf(limits)]);
function snapshot(sample: SliceSample): Snapshot {
  // Own immutable data: changing a source cache must not mutate a finished table.
  const measures = Object.fromEntries(
    MEASURE_NAMES.map((name) => {
      const m = sample.measures[name];
      if (
        !Number.isFinite(m.amount) ||
        m.amount < 0 ||
        m.moment.some((x) => !Number.isFinite(x))
      )
        throw new Error("Non-finite or negative section measure");
      return [
        name,
        Object.freeze({
          amount: m.amount,
          moment: Object.freeze([...m.moment]),
        }),
      ];
    }),
  ) as unknown as SectionMeasures;
  return { measures: Object.freeze(measures), topology: sample.topology };
}
function interpolate(
  a: SectionMeasures,
  b: SectionMeasures,
  t: number,
): SectionMeasures {
  return Object.fromEntries(
    MEASURE_NAMES.map((name) => [
      name,
      sumMeasure(scaleMeasure(a[name], 1 - t), scaleMeasure(b[name], t)),
    ]),
  ) as unknown as SectionMeasures;
}

/** Build once for one fixed hull/settings revision. Construction and lookup are
 * deterministic, independent of trial order. Uniform tables use three interior
 * probes per interval; rejected intervals are measured directly, not extrapolated.
 * These probes estimate interpolation error, not a guaranteed continuous bound.
 */
export function precomputedSliceGeometry(
  measure: (request: SectionRequest) => SliceSample,
  specs: readonly SliceTableSpec[],
  tolerance: SliceInterpolationTolerance,
  options: {
    readonly maxPrecomputedSections?: number;
    readonly maxMembers?: number;
  } = {},
): {
  readonly geometry: TrialGeometry;
  readonly tables: readonly SliceTableDiagnostics[];
  readonly stats: () => SliceBackendStats;
} {
  const budget = options.maxPrecomputedSections ?? 8192;
  if (!Number.isSafeInteger(budget) || budget < 0)
    throw new Error("Invalid precomputed-section budget");
  for (const value of [tolerance.relative, tolerance.area, tolerance.length])
    if (!Number.isFinite(value) || value < 0)
      throw new Error(
        "Interpolation tolerances must be finite and non-negative",
      );
  if (
    !Number.isFinite(tolerance.momentLengthScale) ||
    tolerance.momentLengthScale <= 0
  )
    throw new Error("Moment length scale must be finite and positive");
  // Validate all settings before doing expensive geometry work.
  const keys = new Set<string>();
  let required = 0;
  const normalized = specs.map((spec) => {
    if (!["plane", "transverse", "longitudinal"].includes(spec.shape))
      throw new Error("Only parallel slice families can be precomputed");
    if (
      !Number.isFinite(spec.start) ||
      !Number.isFinite(spec.end) ||
      !Number.isFinite(spec.end - spec.start) ||
      spec.end <= spec.start
    )
      throw new Error("Slice table needs finite increasing bounds");
    if (!Number.isSafeInteger(spec.intervals) || spec.intervals < 1)
      throw new Error("Slice intervals must be a positive safe integer");
    required += 4 * spec.intervals + 1;
    if (!Number.isSafeInteger(required) || required > budget)
      throw new Error("Precomputed slices exceed their section budget");
    const limits = limitsOf(spec.limits),
      key = familyKey(spec.shape, limits);
    if (keys.has(key))
      throw new Error("Only one table per shape/clipping family is supported");
    keys.add(key);
    return Object.freeze({ ...spec, limits });
  });
  let precomputeCalls = 0,
    precomputeFailures = 0,
    exactHits = 0,
    interpolated = 0,
    directFallbacks = 0;
  const tables = new Map<string, Table>(),
    diagnostics: SliceTableDiagnostics[] = [];
  for (const spec of normalized) {
    const n = 4 * spec.intervals;
    const positions = Array.from({ length: n + 1 }, (_, i) =>
      i === n ? spec.end : spec.start + (spec.end - spec.start) * (i / n),
    );
    if (positions.some((p, i) => i > 0 && p <= positions[i - 1]))
      throw new Error("Slice resolution is too fine at this coordinate scale");
    const probes: Probe[] = positions.map((position) => {
      precomputeCalls++;
      try {
        return {
          value: snapshot(
            measure({ shape: spec.shape, position, limits: spec.limits }),
          ),
        };
      } catch (error) {
        precomputeFailures++;
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    const reasonAt = (i: number): string | null => {
      const local = probes.slice(4 * i, 4 * i + 5);
      if (local.some((p) => "error" in p)) return "measurement error";
      const samples = local.map((p) => (p as { value: Snapshot }).value);
      // Do not interpolate empty regions: narrow unseen features must not be
      // silently replaced with an interpolated zero or a fabricated centroid.
      if (
        samples.some((p) =>
          MEASURE_NAMES.some((name) => p.measures[name].amount === 0),
        )
      )
        return "empty measure";
      if (
        samples.some((p) =>
          MEASURE_NAMES.some(
            (name) =>
              p.measures[name].amount <=
              (name === "area" ? tolerance.area : tolerance.length),
          ),
        )
      )
        return "near-empty measure";
      if (samples.some((p) => p.topology !== samples[0].topology))
        return "topology change";
      for (let j = 1; j <= 3; j++) {
        const predicted = interpolate(
          samples[0].measures,
          samples[4].measures,
          j / 4,
        );
        for (const name of MEASURE_NAMES) {
          const actual = samples[j].measures[name],
            estimate = predicted[name];
          const absolute = name === "area" ? tolerance.area : tolerance.length;
          const amountScale = Math.max(actual.amount, estimate.amount);
          if (
            Math.abs(actual.amount - estimate.amount) >
            absolute + tolerance.relative * amountScale
          )
            return "amount tolerance";
          for (let axis = 0; axis < 3; axis++) {
            const scale = Math.max(
              Math.abs(actual.moment[axis]),
              Math.abs(estimate.moment[axis]),
              amountScale * tolerance.momentLengthScale,
            );
            if (
              Math.abs(actual.moment[axis] - estimate.moment[axis]) >
              absolute * tolerance.momentLengthScale +
                tolerance.relative * scale
            )
              return "moment tolerance";
          }
        }
      }
      return null;
    };
    const intervals = Array.from({ length: spec.intervals }, (_, i) => ({
      left: positions[4 * i],
      right: positions[4 * i + 4],
      reason: reasonAt(i),
    }));
    const rejected: Record<string, number> = {};
    for (const interval of intervals)
      if (interval.reason)
        rejected[interval.reason] = (rejected[interval.reason] ?? 0) + 1;
    tables.set(familyKey(spec.shape, spec.limits), {
      spec,
      probes,
      intervals,
      exact: new Map(positions.map((p, i) => [p, probes[i]])),
    });
    const fallbackIntervals = intervals.filter((i) => i.reason !== null).length;
    diagnostics.push({
      spec,
      interpolatedIntervals: spec.intervals - fallbackIntervals,
      fallbackIntervals,
      rejected,
    });
  }
  const section: TrialGeometry["section"] = (request) => {
    const table = tables.get(familyKey(request.shape, request.limits));
    if (
      Number.isFinite(request.position) &&
      table &&
      request.position >= table.spec.start &&
      request.position <= table.spec.end
    ) {
      const exact = table.exact.get(request.position);
      if (exact && "value" in exact) {
        exactHits++;
        return exact.value.measures;
      }
      // Binary search avoids choosing the wrong interval at rounded grid boundaries.
      let lo = 0,
        hi = table.intervals.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (request.position > table.intervals[mid].right) lo = mid + 1;
        else hi = mid;
      }
      const interval = table.intervals[lo];
      if (!interval.reason) {
        const a = table.probes[lo * 4] as { value: Snapshot },
          b = table.probes[lo * 4 + 4] as { value: Snapshot };
        interpolated++;
        return interpolate(
          a.value.measures,
          b.value.measures,
          (request.position - interval.left) / (interval.right - interval.left),
        );
      }
    }
    directFallbacks++;
    return measure(request).measures;
  };
  return {
    geometry: directTrialGeometry(section, options.maxMembers),
    tables: diagnostics,
    stats: () => ({
      precomputeCalls,
      precomputeFailures,
      exactHits,
      interpolated,
      directFallbacks,
    }),
  };
}
