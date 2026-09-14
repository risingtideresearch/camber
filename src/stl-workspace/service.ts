import { createHullAnalysis, type QueryRunner } from "../analysis/queries";
import { meshContext, MESH_CAPABILITIES } from "../analysis/mesh/setup";
import {
  analysisSetup,
  type Asset,
  type Configuration,
  type Inspection,
} from "./setup";
import type { EngineAction } from "./engine";
import type { AnalysisQueries, Available, QueryKind } from "../analysis/api";

/** One asset-owned worker for every view, including detached windows.
 * Cancellation terminates executing numerical work; a subsequent request lazily
 * reinstalls original bytes. Ordinary settings changes never recreate the worker. */
export class WorkspaceService {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  private closed = false;
  private fixed = new Map<string, Promise<unknown>>();
  constructor(readonly asset: Asset) {}
  request<T>(configuration: Configuration, action: EngineAction): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Project closed"));
    if (
      action.type !== "query" ||
      !["stability", "measurements"].includes(action.kind)
    )
      return this.send(configuration, action);
    const key = JSON.stringify([configuration, action]);
    let result = this.fixed.get(key) as Promise<T> | undefined;
    if (!result) {
      result = this.send<T>(configuration, action);
      if (this.fixed.size >= 64)
        this.fixed.delete(this.fixed.keys().next().value!);
      this.fixed.set(key, result);
      const current = result;
      void result.catch(() => {
        if (this.fixed.get(key) === current) this.fixed.delete(key);
      });
    }
    return result;
  }
  private send<T>(
    configuration: Configuration,
    action: EngineAction,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Project closed"));
    if (!this.asset.bytes.byteLength)
      return Promise.resolve(
        (action.type === "query"
          ? {
              status: "unavailable",
              reason: "Attach an STL to use hull geometry.",
            }
          : {}) as T,
      );
    return new Promise<T>((resolve, reject) => {
      try {
        const fresh = !this.worker;
        const worker = (this.worker ??= new Worker(
          new URL("../worker/stlWorkspaceWorker.ts", import.meta.url),
          { type: "module" },
        ));
        worker.onmessage = (
          e: MessageEvent<{ id: number; value?: unknown; error?: string }>,
        ) => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          if (e.data.error) p.reject(new Error(e.data.error));
          else p.resolve(e.data.value);
        };
        worker.onerror = (e) =>
          this.cancel(e.message || "Geometry worker failed");
        const id = ++this.sequence;
        this.pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        const buffer = fresh ? this.asset.bytes.slice(0) : undefined;
        worker.postMessage(
          { id, buffer, configuration, action },
          buffer ? [buffer] : [],
        );
      } catch (e) {
        this.cancel(String(e));
        reject(e);
      }
    });
  }
  preview(c: Configuration) {
    return this.request<Inspection>(c, { type: "preview" });
  }
  hull(c: Configuration, envelopeMeasurements: boolean) {
    const setup = analysisSetup(
      { ...c, metresPerUnit: c.metresPerUnit || 1 },
      crypto.randomUUID(),
    ).analysis;
    const context = meshContext(setup);
    const run: QueryRunner = async <K extends QueryKind>(
      kind: K,
      input: AnalysisQueries[K]["input"],
    ) => ({
      contextId: context.id,
      result: await this.request<Available<AnalysisQueries[K]["output"]>>(c, {
        type: "query",
        kind,
        input,
        envelope: envelopeMeasurements && kind === "measurements",
      }),
    });
    return createHullAnalysis(context, run, MESH_CAPABILITIES);
  }
  cancel(reason = "Calculation cancelled") {
    this.worker?.terminate();
    this.worker = undefined;
    for (const p of this.pending.values())
      p.reject(new DOMException(reason, "AbortError"));
    this.pending.clear();
    this.fixed.clear();
  }
  dispose() {
    this.closed = true;
    this.cancel("Project closed");
  }
}
