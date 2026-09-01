import { useMemo } from "react";
import type { HullMetrics } from "../core/hullMetrics";
import type { HullSampling } from "../core/mesh";
import type { Model } from "../core/model";
import type { WeightBook } from "../core/sheet/book";
import {
  evaluateBook,
  resultAt,
  type BookResults,
} from "../core/sheet/evaluate";
import {
  createSliceMeasurer,
  sliceMeasurementKey,
  type SliceMeasurement,
  type SliceMeasurements,
} from "../core/sheet/slices";

// Geometry depends only on the runtime model, its sampling, the shape and nominal position. A weak two-level
// cache shares unchanged cuts across panel hooks and across unrelated book edits without retaining old hulls.
interface GeometryCache {
  readonly values: Map<string, SliceMeasurement>;
  resolvedKey: string | null;
  resolved: SliceMeasurements | null;
}

const MEASUREMENT_CACHE = new WeakMap<
  Model,
  WeakMap<HullSampling, GeometryCache>
>();

function geometryCache(model: Model, sampling: HullSampling): GeometryCache {
  let bySampling = MEASUREMENT_CACHE.get(model);
  if (!bySampling) {
    bySampling = new WeakMap();
    MEASUREMENT_CACHE.set(model, bySampling);
  }
  let cache = bySampling.get(sampling);
  if (!cache) {
    cache = { values: new Map(), resolvedKey: null, resolved: null };
    bySampling.set(sampling, cache);
  }
  return cache;
}

export interface WeightBookResults {
  /** First pass, used to resolve and diagnose authored slice positions. */
  readonly positions: BookResults;
  readonly measurements: SliceMeasurements;
  /** Final pass, with measured slice leaves available to every formula. */
  readonly results: BookResults;
}

/**
 * Evaluate a book around its geometry boundary.
 *
 * Positions are authored formulas, while area/perimeter/centroid are measured values. Keeping both passes
 * here prevents panels from implementing subtly different sequencing. The row cache also means an unrelated
 * formula edit re-evaluates the tiny book but does not rebuild unchanged cuts.
 */
export function useWeightBookResults(
  book: WeightBook,
  model: Model,
  sampling: HullSampling | null,
  metrics: HullMetrics | null,
): WeightBookResults {
  const positions = useMemo(() => evaluateBook(book, metrics), [book, metrics]);

  const measurements = useMemo(() => {
    const out = new Map<string, SliceMeasurement>();
    if (!sampling) return out;
    const cached = geometryCache(model, sampling);
    const signature: string[] = [];
    let measure: ReturnType<typeof createSliceMeasurer> | null = null;

    for (const item of book.items)
      for (const [fieldKey, field] of Object.entries(item.fields)) {
        if (field.k !== "cut") continue;
        const position = resultAt(positions, item.id, fieldKey, "pos");
        if (position?.error || !position?.reading) continue;
        const key = sliceMeasurementKey(item.id, fieldKey);
        const geometryKey = `${field.shape}\u0000${position.reading.v}`;
        let value = cached.values.get(geometryKey);
        if (!value) {
          measure ??= createSliceMeasurer(model, sampling);
          value = measure(field.shape, position.reading.v) ?? undefined;
          if (value) {
            // Position edits can produce an unbounded stream of nominal values. Retain enough cuts for undo
            // and cross-panel reuse without turning a long editing session into a geometry archive.
            if (cached.values.size >= 256) {
              const oldest = cached.values.keys().next().value;
              if (oldest !== undefined) cached.values.delete(oldest);
            }
            cached.values.set(geometryKey, value);
          }
        }
        if (value) {
          signature.push(`${key}\u0000${geometryKey}`);
          out.set(key, value);
        }
      }
    const resolvedKey = signature.join("\u0001");
    if (cached.resolvedKey === resolvedKey && cached.resolved)
      return cached.resolved;
    cached.resolvedKey = resolvedKey;
    cached.resolved = out;
    return out;
  }, [book, model, sampling, positions]);

  const results = useMemo(
    () => evaluateBook(book, metrics, measurements),
    [book, metrics, measurements],
  );
  return { positions, measurements, results };
}
