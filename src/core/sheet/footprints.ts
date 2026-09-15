// Uniform structural distributions. Integrals are independent of repetition and
// materials; refining quadrature never creates or changes uncertainty sources.
import type { SliceShape } from "./book";
import type { RawSliceMeasurement } from "./slices";
import {
  MEASURE_NAMES,
  sumMeasure,
  scaleMeasure,
  zeroMeasures,
  type SectionMeasures,
} from "./sectionMeasures";

export interface FootprintMeasurement {
  readonly integrals: SectionMeasures;
  /** Leibniz boundary derivatives: d integral / da = -q(a), d / db = q(b). */
  readonly start: SectionMeasures;
  readonly end: SectionMeasures;
  readonly samples: readonly RawSliceMeasurement[];
  readonly warning?: string;
}
export type FootprintResult =
  | { readonly value: FootprintMeasurement; readonly error?: never }
  | { readonly error: string; readonly value?: never };
export type FootprintMeasurements = ReadonlyMap<string, FootprintResult>;

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
export function measureFootprint(
  measure: (shape: SliceShape, pos: number) => RawSliceMeasurement,
  shape: SliceShape,
  start: number,
  end: number,
): FootprintResult {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return {
      error: "footprint bounds must be finite and From must be less than To",
    };
  try {
    const span = end - start;
    let previous = zeroMeasures(),
      integrals = previous,
      converged = false;
    for (let n = 16; n <= 512; n *= 2) {
      const sections = Array.from(
        { length: n },
        (_, i) => measure(shape, start + ((i + 0.5) * span) / n).measures,
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
          "footprint integration did not converge; split the region or refine the hull sampling",
      };
    // Evaluate just inside the extent if an endpoint coincides with a boundary
    // face. This is one-sided and is explicitly surfaced as a warning.
    let warning: string | undefined;
    const boundary = (at: number, direction: number) => {
      try {
        return measure(shape, at).measures;
      } catch {
        warning =
          "A bound coincides with a geometry transition. Bound uncertainty uses a one-sided local approximation; move the bound inside the hull for a smoother estimate.";
        return measure(shape, at + direction * span * 1e-6).measures;
      }
    };
    const a = boundary(start, 1),
      b = boundary(end, -1);
    const samples = Array.from({ length: 7 }, (_, i) =>
      measure(shape, start + ((i + 0.5) * span) / 7),
    );
    return { value: { integrals, start: a, end: b, samples, warning } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
