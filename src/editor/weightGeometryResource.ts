import { createWorkerTaskQueue } from "../worker/taskWorker";
import type {
  WeightGeometryJob,
  WeightGeometryRequest,
  WeightGeometryResponse,
  WeightGeometryResult,
} from "../worker/weightGeometryProtocol";

interface GeometrySnapshot {
  readonly values: ReadonlyMap<string, WeightGeometryResult>;
  readonly error: string | null;
}

/** Shared by panels reading the same hull. Responses are cached by their exact
 * geometry key, never presented as the answer to a newer boundary edit. */
export function createWeightGeometryResource(makeWorker: () => Worker) {
  let snapshot: GeometrySnapshot = { values: new Map(), error: null };
  const listeners = new Set<() => void>();
  let wanted = new Set<string>();
  let disposeTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: GeometrySnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const fail = (reason: unknown) =>
    publish({
      ...snapshot,
      error: reason instanceof Error ? reason.message : String(reason),
    });
  const tasks = createWorkerTaskQueue<
    WeightGeometryRequest,
    WeightGeometryResponse
  >(
    makeWorker,
    (response) => {
      if (response.error) {
        fail(response.error);
        return;
      }
      const values = new Map(snapshot.values);
      for (const { key, result } of response.results) values.set(key, result);
      // Keep all current fields, even for a large book; bound only the undo cache.
      for (const key of values.keys()) {
        if (values.size <= Math.max(256, wanted.size)) break;
        if (!wanted.has(key)) values.delete(key);
      }
      // Sending the queued task can fail just before this older answer is
      // published. Do not clear that failure and leave the newest edit pending forever.
      publish({ values, error: snapshot.error });
    },
    fail,
  );
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      clearTimeout(disposeTimer);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size)
          disposeTimer = setTimeout(() => tasks.dispose(), 0);
      };
    },
    request(jobs: readonly WeightGeometryJob[]) {
      wanted = new Set(jobs.map((job) => job.key));
      if (snapshot.error) return;
      const missing = jobs.filter((job) => !snapshot.values.has(job.key));
      if (!missing.length) {
        tasks.discardQueued();
        return;
      }
      // The task queue runs one request and keeps only the latest waiting edit.
      // No synchronous geometry fallback: a failed worker must not freeze React.
      const key = JSON.stringify(missing.map((job) => job.key));
      try {
        tasks.post({ key, jobs: missing });
      } catch (error) {
        fail(error);
      }
    },
  };
}
