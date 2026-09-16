import { useEffect, useMemo, useSyncExternalStore } from "react";
import { cloneHull } from "../core/hull";
import type { HullMetrics } from "../core/hullMetrics";
import type { HullSampling } from "../core/mesh";
import type { Model } from "../core/model";
import type { WeightBook } from "../core/sheet/book";
import { evaluateBook, type BookResults } from "../core/sheet/evaluate";
import type { SliceMeasurements } from "../core/sheet/slices";
import type { RepetitionMeasurements } from "../core/sheet/repetitions";
import type {
  WeightGeometryHull,
  WeightGeometryResult,
} from "../worker/weightGeometryProtocol";
import { createWeightGeometryResource } from "./weightGeometryResource";
import {
  planWeightGeometry,
  resolveWeightGeometry,
} from "./weightGeometryPlan";

type GeometryResource = ReturnType<typeof createWeightGeometryResource>;
const RESOURCES = new WeakMap<Model, WeakMap<HullSampling, GeometryResource>>();
function geometryResource(
  model: Model,
  sampling: HullSampling,
): GeometryResource {
  let bySampling = RESOURCES.get(model);
  if (!bySampling) {
    bySampling = new WeakMap();
    RESOURCES.set(model, bySampling);
  }
  let resource = bySampling.get(sampling);
  if (!resource) {
    resource = createWeightGeometryResource(() => {
      const worker = new Worker(
        new URL("../worker/weightGeometryWorker.ts", import.meta.url),
        { type: "module" },
      );
      try {
        const hull: WeightGeometryHull = {
          type: "hull",
          state: cloneHull(model),
          sampling,
        };
        worker.postMessage(hull);
      } catch (error) {
        worker.terminate();
        throw error;
      }
      return worker;
    });
    bySampling.set(sampling, resource);
  }
  return resource;
}
const EMPTY = { values: new Map<string, WeightGeometryResult>(), error: null };
const emptySnapshot = () => EMPTY;
const noSubscription = () => () => {};

export interface WeightBookResults {
  readonly positions: BookResults;
  readonly measurements: SliceMeasurements;
  readonly repetitions: RepetitionMeasurements;
  readonly results: BookResults;
  readonly pending: boolean;
  readonly error: string | null;
}

/** Formulas resolve on the UI thread; geometry never does. A changed boundary
 * immediately edits the form, then its worker result arrives under that exact
 * input key. Old geometry is never fed to new formulas while a job is pending. */
export function useWeightBookResults(
  book: WeightBook,
  model: Model,
  sampling: HullSampling | null,
  metrics: HullMetrics | null,
): WeightBookResults {
  const positions = useMemo(() => evaluateBook(book, metrics), [book, metrics]);
  const plan = useMemo(
    () => planWeightGeometry(book, positions),
    [book, positions],
  );
  const resource = useMemo(
    () => (sampling ? geometryResource(model, sampling) : null),
    [model, sampling],
  );
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? noSubscription,
    resource?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  useEffect(() => {
    resource?.request(plan.jobs);
  }, [resource, plan]);
  const geometry = useMemo(
    () => resolveWeightGeometry(plan, snapshot.values),
    [plan, snapshot.values],
  );
  const results = useMemo(
    () =>
      evaluateBook(book, metrics, geometry.measurements, geometry.repetitions),
    [book, metrics, geometry],
  );
  return {
    positions,
    ...geometry,
    results,
    pending: !!resource && geometry.pending && !snapshot.error,
    error: snapshot.error,
  };
}
