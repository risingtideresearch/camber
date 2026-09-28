import {
  BOUNDARIES,
  validateLimits,
  type BoundaryLeaf,
  type SectionLimits,
} from "./boundaries";
// Uniform structural distributions. Integrals are independent of repetition and
// materials; refining quadrature never creates or changes uncertainty sources.
import type { SliceShape } from "./book";
import {
  MEASURE_NAMES,
  sumMeasure,
  scaleMeasure,
  zeroMeasures,
  type SectionMeasures,
} from "./sectionMeasures";

export interface RepetitionPhaseTotal {
  readonly measures: SectionMeasures;
  readonly weight: number;
  /** Normalized offset for replay; absent on legacy/synthetic discrepancy data. */
  readonly phase?: number;
}
export interface RepetitionMeasurement {
  /** Nominal geometry is ready; placement/boundary uncertainty is not. */
  readonly uncertaintyPending?: boolean;
  readonly integrals: SectionMeasures;
  readonly boundaryDerivatives?: Readonly<
    Partial<Record<BoundaryLeaf, SectionMeasures>>
  >;
  /** Leibniz boundary derivatives: d integral / da = -q(a), d / db = q(b). */
  readonly start: SectionMeasures;
  readonly end: SectionMeasures;
  /** Final discrete regular-grid totals at sampled offsets within one pitch. */
  readonly phaseTotals?: readonly RepetitionPhaseTotal[];
  readonly warning?: string;
}
export type RepetitionResult =
  | { readonly value: RepetitionMeasurement; readonly error?: never }
  | { readonly error: string; readonly value?: never };
export type RepetitionMeasurements = ReadonlyMap<string, RepetitionResult>;

/** One realized regular grid, not a continuous integral or an uncertainty estimate. */
export interface RepetitionLayout {
  readonly measures: SectionMeasures;
  readonly count: number;
}
export interface RepetitionLayoutOptions {
  readonly shape: SliceShape;
  readonly start: number;
  readonly end: number;
  readonly pitch: number;
  /** Fraction of one pitch, in [0, 1). Members occupy [start, end). */
  readonly phase: number;
  readonly limits?: SectionLimits;
  readonly maxMembers?: number;
}

/** Deterministic: no quadrature, derivatives, random draws or placement allowance.
 * Like the section measurer, throws on invalid geometry; empty layouts are valid.
 */
export function measureRepetitionLayout(
  measure: (
    shape: SliceShape,
    pos: number,
    limits?: SectionLimits,
  ) => { readonly measures: SectionMeasures },
  {
    shape,
    start,
    end,
    pitch,
    phase,
    limits = {},
    maxMembers = 8192,
  }: RepetitionLayoutOptions,
): RepetitionLayout {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(end - start) ||
    end <= start
  )
    throw new Error(
      "repetition bounds must be finite and From must be less than To",
    );
  if (!Number.isFinite(pitch) || pitch <= 0)
    throw new Error("Layout needs a finite positive spacing");
  if (!Number.isFinite(phase) || phase < 0 || phase >= 1)
    throw new Error("Layout phase must be in [0, 1)");
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 0)
    throw new Error("Layout member budget must be a non-negative safe integer");
  validateLimits(limits);
  const count = Math.max(0, Math.ceil((end - start) / pitch - phase));
  if (!Number.isSafeInteger(count) || count > maxMembers)
    throw new Error("Layout exceeded its member budget");
  let measures = zeroMeasures(),
    measuredCount = 0;
  for (let k = 0; k < count; k++) {
    const pos = start + (k + phase) * pitch;
    // Integer indexing avoids accumulated error; rounding must not include the upper bound.
    if (pos >= end) continue;
    measures = weighted([measures, measure(shape, pos, limits).measures], 1);
    measuredCount++;
  }
  return { measures, count: measuredCount };
}

const weighted = (
  values: readonly SectionMeasures[],
  weight: number,
): SectionMeasures =>
  Object.fromEntries(
    MEASURE_NAMES.map((name) => [
      name,
      scaleMeasure(values.map((v) => v[name]).reduce(sumMeasure), weight),
    ]),
  ) as unknown as SectionMeasures;
const close = (a: SectionMeasures, b: SectionMeasures, span: number): boolean =>
  MEASURE_NAMES.every((name) => {
    const x = a[name],
      y = b[name],
      scale = Math.max(Math.abs(x.amount), Math.abs(y.amount), 1e-10);
    return (
      Math.abs(x.amount - y.amount) <= scale * 2e-3 &&
      x.moment.every(
        (v, i) =>
          Math.abs(v - y.moment[i]) <=
          2e-3 *
            Math.max(Math.abs(v), Math.abs(y.moment[i]), scale * span, 1e-10),
      )
    );
  });

/** Composite midpoint quadrature avoids claiming a boundary face as a member.
 * Require successive refinements to agree; this estimates quadrature error on the
 * sampled hull, not hull-discretization error or confidence in the structure.
 */
export function measureRepetition(
  measure: (
    shape: SliceShape,
    pos: number,
    limits?: SectionLimits,
  ) => { readonly measures: SectionMeasures },
  shape: SliceShape,
  start: number,
  end: number,
  /** Nominal regular-grid pitch. Omit when only the continuous integral is needed. */
  pitch?: number,
  limits: SectionLimits = {},
  /** Compute only sensitivities that can contribute uncertainty; omitted means all. */
  boundarySensitivities?: readonly BoundaryLeaf[],
  /** Reuse nominal geometry for exactly the same shape, extent and limits. */
  nominal?: RepetitionMeasurement,
): RepetitionResult {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return {
      error: "repetition bounds must be finite and From must be less than To",
    };
  try {
    validateLimits(limits);
    const atLimits = (shape: SliceShape, pos: number) =>
      measure(shape, pos, limits);
    const span = end - start;
    const nominalGeometry = (): RepetitionResult => {
      let previous = zeroMeasures(),
        integrals = previous,
        converged = false;
      for (let n = 16; n <= 512; n *= 2) {
        const sections = Array.from(
          { length: n },
          (_, i) => atLimits(shape, start + ((i + 0.5) * span) / n).measures,
        );
        integrals = weighted(sections, span / n);
        if (n >= 64 && close(previous, integrals, span)) {
          converged = true;
          break;
        }
        previous = integrals;
      }
      if (!converged)
        return {
          error:
            "repetition integration did not converge; split the region or refine the hull sampling",
        };
      // Evaluate just inside the extent if an endpoint coincides with a boundary
      // face. This is one-sided and is explicitly surfaced as a warning.
      let warning: string | undefined;
      const boundary = (at: number, direction: number) => {
        try {
          return atLimits(shape, at).measures;
        } catch {
          warning =
            "A bound coincides with a geometry transition. Bound uncertainty uses a one-sided local approximation; move the bound inside the hull for a smoother estimate.";
          return atLimits(shape, at + direction * span * 1e-6).measures;
        }
      };
      const a = boundary(start, 1),
        b = boundary(end, -1);

      return { value: { integrals, start: a, end: b, warning } };
    };
    const base = nominal ? { value: nominal } : nominalGeometry();
    if (!base.value) return base;
    const { integrals, start: a, end: b, warning } = base.value;

    // Stratify at the member-count transition. Even a very rare extra member
    // must receive its actual probability, rather than disappear between offsets.
    let phaseTotals: RepetitionMeasurement["phaseTotals"];
    if (pitch !== undefined) {
      if (!Number.isFinite(pitch) || pitch <= 0)
        throw new Error(
          "Placement uncertainty needs a finite positive spacing",
        );
      const members = span / pitch;
      const fraction = members - Math.floor(members);
      const edges = fraction > 0 ? [0, fraction, 1] : [0, 1];
      let work = 0;
      let previousSpread: number[] | undefined;
      let phaseConverged = false;
      const flatten = (m: SectionMeasures) =>
        MEASURE_NAMES.flatMap((name) => [m[name].amount, ...m[name].moment]);
      const nominal = flatten(integrals).map((v) => v / pitch);
      for (let n = 4; n <= 64; n *= 2) {
        const totals: NonNullable<
          RepetitionMeasurement["phaseTotals"]
        >[number][] = [];
        for (let j = 1; j < edges.length; j++) {
          const width = edges[j] - edges[j - 1];
          for (let i = 0; i < n; i++) {
            const phase = edges[j - 1] + ((i + 0.5) * width) / n;
            // Integer indexing avoids accumulated position error.
            const count = Math.max(0, Math.ceil(members - phase));
            if (work + count > 8192)
              throw new Error(
                "Placement uncertainty exceeded its sampling budget; increase spacing or reduce equivalent count",
              );
            work += count;
            const layout = measureRepetitionLayout(measure, {
              shape,
              start,
              end,
              pitch,
              phase,
              limits,
            });
            totals.push({
              measures: layout.measures,
              weight: width / n,
              phase,
            });
          }
        }
        const spread = nominal.map((v, axis) =>
          Math.sqrt(
            totals.reduce(
              (sum, sample) =>
                sum + sample.weight * (flatten(sample.measures)[axis] - v) ** 2,
              0,
            ),
          ),
        );
        phaseTotals = totals;
        if (
          previousSpread &&
          spread.every(
            (v, i) =>
              Math.abs(v - previousSpread![i]) <=
              0.02 *
                Math.max(
                  v,
                  previousSpread![i],
                  Math.abs(nominal[i]) * 1e-6,
                  1e-12,
                ),
          )
        ) {
          phaseConverged = true;
          break;
        }
        previousSpread = spread;
      }
      if (!phaseConverged)
        throw new Error(
          "Placement uncertainty did not converge; revise the repetition extent or spacing/count",
        );
    }
    const boundaryDerivatives: Partial<Record<BoundaryLeaf, SectionMeasures>> =
      {};
    for (const boundary of BOUNDARIES) {
      const value = limits[boundary.leaf];
      if (
        value === undefined ||
        (boundarySensitivities !== undefined &&
          !boundarySensitivities.includes(boundary.leaf))
      )
        continue;
      const h = Math.max(1e-5, Math.abs(value) * 1e-4);
      const shifted = (delta: number) =>
        measureRepetition(
          (shape, pos) =>
            measure(shape, pos, {
              ...limits,
              [boundary.leaf]: value + delta,
            }),
          shape,
          start,
          end,
        );
      const lo = shifted(-h),
        hi = shifted(h);
      if (!lo.value || !hi.value)
        throw new Error(
          `${boundary.label} boundary sensitivity could not be measured: ${lo.error ?? hi.error}`,
        );
      boundaryDerivatives[boundary.leaf] = Object.fromEntries(
        MEASURE_NAMES.map((name) => [
          name,
          {
            amount:
              (hi.value!.integrals[name].amount -
                lo.value!.integrals[name].amount) /
              (2 * h),
            moment: hi.value!.integrals[name].moment.map(
              (v, axis) =>
                (v - lo.value!.integrals[name].moment[axis]) / (2 * h),
            ),
          },
        ]),
      ) as unknown as SectionMeasures;
    }
    return {
      value: {
        integrals,
        start: a,
        end: b,
        phaseTotals,
        warning,
        boundaryDerivatives,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
