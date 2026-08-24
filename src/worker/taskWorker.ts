// Shared client-side machinery for expensive, pure computations in dedicated workers.
//
// Both hull meshing and stability can be requested faster than their worker answers while a point is being
// dragged. The useful policy is identical: one task in flight, retain only the newest task behind it, and
// identify every answer with the opaque key supplied by the caller. This module owns that lifecycle so new
// computations do not each grow a subtly different worker queue.

export interface KeyedTask {
  readonly key: string;
}

export interface WorkerTaskQueue<Request extends KeyedTask> {
  /** Queue the task. False means a worker could not be created. */
  post(request: Request): boolean;
  /** Whether this exact task is running or is the newest task waiting behind it. */
  pending(key: string): boolean;
  dispose(): void;
}

export function createWorkerTaskQueue<
  Request extends KeyedTask,
  Response extends KeyedTask,
>(
  makeWorker: () => Worker,
  receive: (response: Response, roundTripMs: number) => void,
  unavailable?: (reason: unknown) => void,
): WorkerTaskQueue<Request> {
  let worker: Worker | null = null,
    noWorker = false,
    inflight: { key: string; sentAt: number } | null = null,
    queued: Request | null = null;

  const fail = (reason: unknown): void => {
    worker?.terminate();
    worker = null;
    noWorker = true;
    inflight = null;
    queued = null;
    unavailable?.(reason);
  };

  const ensureWorker = (): Worker | null => {
    if (worker || noWorker) return worker;
    try {
      const made = makeWorker();
      made.onmessage = (event: MessageEvent<Response>) => {
        const task = inflight;
        inflight = null;
        const next = queued;
        queued = null;
        // Start the newest waiting task before publishing this answer. A render caused by `receive` can then
        // ask for the same key without posting a duplicate between the two tasks.
        if (next) send(next);
        receive(
          event.data,
          task ? performance.now() - task.sentAt : Number.NaN,
        );
      };
      made.onerror = (event) => fail(event.error ?? event.message);
      worker = made;
    } catch (reason) {
      fail(reason);
    }
    return worker;
  };

  const send = (request: Request): boolean => {
    if (inflight) {
      queued = request;
      return true;
    }
    const active = ensureWorker();
    if (!active) return false;
    inflight = { key: request.key, sentAt: performance.now() };
    active.postMessage(request);
    return true;
  };

  return {
    post(request) {
      if (inflight?.key === request.key || queued?.key === request.key)
        return true;
      return send(request);
    },
    pending(key) {
      return inflight?.key === key || queued?.key === key;
    },
    dispose() {
      worker?.terminate();
      worker = null;
      noWorker = false;
      inflight = null;
      queued = null;
    },
  };
}
