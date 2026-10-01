import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  LoadingBatchRequest,
  LoadingResponse,
} from "../worker/loadingComputation";
import { createLoadingAnalysisResource } from "./loadingAnalysisResource";

const EMPTY: ReadonlyMap<string, LoadingResponse> = new Map();

/** Input changes hide previous results before the effect schedules new work.
 * Reference selection and delta display do not enter the calculation request. */
export function useLoadingAnalysis(request: LoadingBatchRequest | null) {
  const [resource] = useState(() =>
    createLoadingAnalysisResource(
      () =>
        new Worker(
          new URL("../worker/loadingBatchWorker.ts", import.meta.url),
          { type: "module" },
        ),
    ),
  );
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  useEffect(() => {
    resource.request(request);
  }, [resource, request]);
  useEffect(() => resource.cancel, [resource]);
  return request && snapshot.key === request.key ? snapshot.results : EMPTY;
}
