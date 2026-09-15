import {
  measureFootprint,
  type FootprintResult,
  type FootprintMeasurements,
} from "../core/sheet/footprints";
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
  createSectionMeasurer,
  sliceMeasurementKey,
  type SliceMeasurement,
  type SliceMeasurements,
} from "../core/sheet/slices";

// Geometry depends only on the runtime model, its sampling, the shape and nominal position. A weak two-level
// cache shares unchanged cuts across panel hooks and across unrelated book edits without retaining old hulls.
interface GeometryCache {
  readonly values: Map<string, SliceMeasurement>;
  readonly footprints: Map<string, FootprintResult>;
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
    cache = {
      footprints: new Map(),
      values: new Map(),
      resolvedKey: null,
      resolved: null,
    };
    bySampling.set(sampling, cache);
  }
  return cache;
}

export interface WeightBookResults {
  /** First pass, used to resolve and diagnose authored slice positions. */
  readonly positions: BookResults;
  readonly measurements: SliceMeasurements;
  readonly footprints: FootprintMeasurements;
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

  const footprints = useMemo(() => {
    const out = new Map<string, FootprintResult>();
    if (!sampling) return out;
    const cache = geometryCache(model, sampling).footprints;
    let measure: ReturnType<typeof createSectionMeasurer> | undefined;
    for (const item of book.items)
      for (const [key, field] of Object.entries(item.fields)) {
        if (field.k !== "footprint") continue;
        const start = resultAt(positions, item.id, key, "start"),
          end = resultAt(positions, item.id, key, "end"),
          repetition = resultAt(positions, item.id, key, field.repetition);
        if (
          !start?.quantity ||
          !end?.quantity ||
          !repetition?.quantity ||
          start.error ||
          end.error ||
          repetition.error
        )
          continue;
        const pitch =
          field.repetition === "spacing"
            ? repetition.quantity.v
            : (end.quantity.v - start.quantity.v) / repetition.quantity.v;
        const geometryKey = `${field.shape}\0${start.quantity.v}\0${end.quantity.v}\0${pitch}`;
        let result = cache.get(geometryKey);
        if (!result) {
          measure ??= createSectionMeasurer(model, sampling);
          result = measureFootprint(
            measure,
            field.shape,
            start.quantity.v,
            end.quantity.v,
            pitch,
          );
          if (cache.size >= 32) cache.delete(cache.keys().next().value!);
          cache.set(geometryKey, result);
        }
        out.set(sliceMeasurementKey(item.id, key), result);
      }
    return out;
  }, [book, model, sampling, positions]);

  const results = useMemo(
    () => evaluateBook(book, metrics, measurements, footprints),
    [book, metrics, measurements, footprints],
  );
  return { positions, measurements, footprints, results };
}
