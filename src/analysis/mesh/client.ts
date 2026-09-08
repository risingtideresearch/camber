import { createHullAnalysis, type QueryRunner } from "../queries";
import type { QueryResult } from "../api";
import { meshContext, MESH_CAPABILITIES } from "./setup";
import type { PreparationReport } from "./prepare";
import type { MeshImport, MeshRequest, MeshResponse } from "./protocol";
export interface MeshWorker {
  onmessage: ((event: MessageEvent<MeshResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: MeshRequest, transfer?: Transferable[]): void;
  terminate(): void;
}
/** One asset install, small subsequent queries. Original bytes remain owned by the host.
 * Replacing a source means disposing this client and constructing a new context. */
export function createStlAnalysisClient(
  buffer: ArrayBuffer,
  source: MeshImport,
  makeWorker: () => MeshWorker = () =>
    new Worker(new URL("../../worker/meshAnalysisWorker.ts", import.meta.url), {
      type: "module",
    }),
) {
  if (buffer.byteLength > 64 * 1024 * 1024)
    throw new Error("STL exceeds the 64 MiB input limit");
  const setup = structuredClone(source),
    context = meshContext(setup.analysis);
  let resolveReady!: (report: PreparationReport) => void,
    rejectReady!: (reason: unknown) => void;
  const ready = new Promise<PreparationReport>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined); // a host may choose to await queries instead of the preparation report
  let worker: MeshWorker | undefined,
    closed = false,
    nextId = 0,
    installed = false;
  const pending = new Map<
    number,
    {
      resolve: (result: QueryResult<unknown>) => void;
      reject: (reason: unknown) => void;
    }
  >();
  const stop = (reason: unknown) => {
    closed = true;
    worker?.terminate();
    rejectReady(reason);
    for (const p of pending.values()) p.reject(reason);
    pending.clear();
  };
  try {
    worker = makeWorker();
    worker.onerror = (e) => stop(new Error(e.message || "Mesh worker failed"));
    worker.onmessage = (e) => {
      const answer = e.data;
      if (closed) return;
      if (answer.contextId !== context.id) {
        stop(new Error("Mesh response context mismatch"));
        return;
      }
      if (answer.type === "ready") {
        if (installed) {
          stop(new Error("Duplicate mesh installation response"));
          return;
        }
        if (answer.error || !answer.report)
          stop(new Error(answer.error || "Empty mesh preparation response"));
        else {
          installed = true;
          resolveReady(answer.report);
        }
        return;
      }
      const p = pending.get(answer.id);
      if (!p) {
        stop(new Error("Unexpected mesh query response"));
        return;
      }
      pending.delete(answer.id);
      if (answer.error || !answer.result)
        p.reject(new Error(answer.error || "Empty mesh query response"));
      else p.resolve({ contextId: context.id, result: answer.result });
    };
    const copy = buffer.slice(0);
    worker.postMessage({ type: "install", buffer: copy, setup }, [copy]);
  } catch (reason) {
    stop(reason);
  }
  const run: QueryRunner = async (kind, input) => {
    await ready;
    if (closed) throw new DOMException("Mesh client closed", "AbortError");
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, {
        resolve: resolve as (r: QueryResult<unknown>) => void,
        reject,
      });
      try {
        worker!.postMessage({
          type: "query",
          id,
          contextId: context.id,
          kind,
          input,
        });
      } catch (reason) {
        stop(reason);
      }
    });
  };
  return {
    hull: createHullAnalysis(context, run, MESH_CAPABILITIES),
    ready,
    dispose: () => stop(new DOMException("Mesh client closed", "AbortError")),
  };
}
