// Window-owned worker transport. Handles share this client; each handle's query cache is
// independent. One request is in flight, and changing the editor context discards queued
// old-context work without discarding independent queries of the new context.
import type { QueryResult } from "../api";
import type { QueryRunner } from "../queries";
import type { HullComputationRequest } from "../../worker/hullComputation";
import type { CamberQueryRequest, CamberQueryResponse } from "./protocol";

export interface AnalysisWorker {
  onmessage: ((event: MessageEvent<CamberQueryResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: CamberQueryRequest): void;
  terminate(): void;
}

export function createCamberAnalysisClient(makeWorker: () => AnalysisWorker) {
  type Task = {
    request: CamberQueryRequest;
    resolve: (result: QueryResult<unknown>) => void;
    reject: (reason: unknown) => void;
  };
  let worker: AnalysisWorker | null = null;
  let inflight: Task | null = null;
  let queued: Task[] = [];
  let nextId = 0;
  let contextId: string | null = null;
  const stop = (reason: unknown) => {
    worker?.terminate();
    worker = null;
    inflight?.reject(reason);
    inflight = null;
    for (const task of queued) task.reject(reason);
    queued = [];
  };
  const pump = () => {
    if (inflight || !queued.length) return;
    try {
      if (!worker) {
        worker = makeWorker();
        worker.onmessage = (event) => {
          const task = inflight;
          const response = event.data;
          if (
            !task ||
            response.id !== task.request.id ||
            response.contextId !== task.request.source.key
          ) {
            stop(new Error("Unexpected analysis worker response"));
            return;
          }
          inflight = null;
          if (response.error) task.reject(new Error(response.error));
          else if (response.result)
            task.resolve({
              contextId: response.contextId,
              result: response.result,
            });
          else task.reject(new Error("Empty analysis worker response"));
          pump();
        };
        worker.onerror = (event) =>
          stop(new Error(event.message || "Analysis worker failed"));
      }
      inflight = queued.shift()!;
      worker.postMessage(inflight.request);
    } catch (reason) {
      stop(reason);
    }
  };
  return {
    /** Called by the host effect, not render. Old handles cannot enqueue work after replacement. */
    activate(id: string) {
      contextId = id;
      const old = queued.filter((task) => task.request.source.key !== id);
      queued = queued.filter((task) => task.request.source.key === id);
      for (const task of old)
        task.reject(
          new DOMException("Analysis context replaced", "AbortError"),
        );
    },
    runner(source: HullComputationRequest): QueryRunner {
      return (kind, input) =>
        new Promise((resolve, reject) => {
          if (contextId !== source.key) {
            reject(new DOMException("Analysis context replaced", "AbortError"));
            return;
          }
          queued.push({
            request: { id: ++nextId, source, kind, input },
            resolve: resolve as Task["resolve"],
            reject,
          });
          pump();
        });
    },
    dispose() {
      contextId = null;
      stop(new DOMException("Analysis client closed", "AbortError"));
    },
  };
}
