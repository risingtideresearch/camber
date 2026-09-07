import type {
  AnalysisContext,
  AnalysisQueries,
  HullAnalysis,
  QueryKind,
  QueryOptions,
  QueryResult,
} from "./api";

export type QueryRunner = <K extends QueryKind>(
  kind: K,
  input: AnalysisQueries[K]["input"],
) => Promise<QueryResult<AnalysisQueries[K]["output"]>>;

/** Cancel one subscriber without cancelling a cached query another panel is still awaiting. */
export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new DOMException("Query cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new DOMException("Query cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One immutable handle. Only queried answers are cached; no section family is precomputed. */
export function createHullAnalysis(
  context: AnalysisContext,
  run: QueryRunner,
  capabilities: HullAnalysis["capabilities"],
): HullAnalysis {
  const immutableContext = Object.freeze({ ...context });
  const fixed = new Map<string, Promise<QueryResult<unknown>>>();
  const geometry = new Map<string, Promise<QueryResult<unknown>>>();
  const query = <K extends QueryKind>(
    kind: K,
    input: AnalysisQueries[K]["input"],
    options?: QueryOptions,
  ) => {
    if (options?.signal?.aborted)
      return Promise.reject(new DOMException("Query cancelled", "AbortError"));
    const key = `${kind}:${JSON.stringify(input)}`;
    const cache = input === null ? fixed : geometry;
    let promise = cache.get(key) as
      Promise<QueryResult<AnalysisQueries[K]["output"]>> | undefined;
    if (!promise) {
      // A deferred runner must see the request used to form the cache key, not an object
      // a caller subsequently changed while waiting for a worker slot.
      const request = structuredClone(input);
      promise = Promise.resolve()
        .then(() => run(kind, request))
        .then((result) => {
          if (result.contextId !== immutableContext.id)
            throw new Error("Analysis answered for another context");
          return result;
        });
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(key, promise);
      const current = promise;
      void promise.catch(() => {
        if (cache.get(key) === current) cache.delete(key);
      });
    }
    return abortable(promise, options?.signal);
  };
  return {
    context: immutableContext,
    capabilities: Object.freeze({ ...capabilities }),
    stability: (options) => query("stability", null, options),
    measurements: (options) => query("measurements", null, options),
    outlines: (options) => query("outlines", null, options),
    slices: (input, options) => query("slices", input, options),
    sectionOutline: (input, options) => query("sectionOutline", input, options),
  };
}
