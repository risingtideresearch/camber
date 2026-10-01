import type {
  LoadingBatchRequest,
  LoadingBatchResponse,
  LoadingResponse,
} from "../worker/loadingComputation";

interface LoadingAnalysisSnapshot {
  readonly key: string | null;
  readonly results: ReadonlyMap<string, LoadingResponse>;
}

/** Debounce automatic solves, cancel obsolete work immediately, and publish rows
 * independently. Results never masquerade as answers to newer inputs. */
export function createLoadingAnalysisResource(
  makeWorker: () => Worker,
  delayMs = 150,
) {
  let snapshot: LoadingAnalysisSnapshot = { key: null, results: new Map() };
  let wanted: LoadingBatchRequest | null = null;
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: LoadingAnalysisSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    worker?.terminate();
    worker = null;
  };
  const cancel = () => {
    wanted = null;
    stop();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel,
    request(request: LoadingBatchRequest | null) {
      if (request && request.key === wanted?.key) return;
      cancel();
      wanted = request;
      publish({ key: request?.key ?? null, results: new Map() });
      if (!request || !request.entries.length) return;
      const ids = new Set(request.entries.map((entry) => entry.id));
      const fail = (reason: unknown) => {
        if (wanted !== request) return;
        const results = new Map(snapshot.results);
        const error = reason instanceof Error ? reason.message : String(reason);
        for (const id of ids) if (!results.has(id)) results.set(id, { error });
        stop();
        publish({ key: request.key, results });
      };
      timer = setTimeout(() => {
        timer = undefined;
        if (wanted !== request) return;
        try {
          const active = makeWorker();
          worker = active;
          active.onmessage = (event: MessageEvent<LoadingBatchResponse>) => {
            const response = event.data;
            if (
              worker !== active ||
              wanted !== request ||
              response.key !== request.key ||
              !ids.has(response.id)
            )
              return;
            const results = new Map(snapshot.results);
            const result: LoadingResponse =
              "proposal" in response
                ? { proposal: response.proposal }
                : { error: response.error };
            results.set(response.id, result);
            if (results.size === ids.size) stop();
            publish({ key: request.key, results });
          };
          active.onerror = (event) => {
            if (worker === active)
              fail(event.message || "Could not compute loading.");
          };
          active.postMessage(request);
        } catch (error) {
          fail(error);
        }
      }, delayMs);
    },
  };
}
