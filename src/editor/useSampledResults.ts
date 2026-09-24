import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cloneHull } from "../core/hull";
import type { HullMetrics } from "../core/hullMetrics";
import type { HullSampling } from "../core/mesh";
import type { Model } from "../core/model";
import type { WeightBook } from "../core/sheet/book";
import type { SampledResults, SamplingTarget } from "../core/sheet/sampling";
import type {
  SamplingCommand,
  SamplingEvent,
} from "../worker/samplingProtocol";
import { createSampledRunCache } from "./sampledRunCache";

export function useSampledResults(
  book: WeightBook,
  model: Model,
  sampling: HullSampling | null,
  metrics: HullMetrics | null,
) {
  // Session-local revision tokens. A replay still needs the original document/settings.
  const context = useMemo(
    () => ({ book, model, sampling, metrics }),
    [book, model, sampling, metrics],
  );
  const cacheState = useMemo(
    () => ({ context, cache: createSampledRunCache() }),
    [context],
  );
  const cachedResult = useCallback(
    (keys: readonly string[]) => cacheState.cache.get(keys),
    [cacheState],
  );
  const active = useRef<{
    worker: Worker;
    runId: string;
    context: typeof context;
  } | null>(null);
  const [state, setState] = useState<{
    context: typeof context;
    result: SampledResults | null;
    completed: number;
    error: string | null;
    targetKeys: readonly string[];
  } | null>(null);
  useEffect(
    () => () => {
      active.current?.worker.terminate();
      active.current = null;
    },
    [context],
  );
  const current = state?.context === context ? state : null;
  const start = useCallback(
    (targets: readonly SamplingTarget[]) => {
      // A fixed keyed stream makes a field change a new reduction of the same worlds.
      const seed = 12345;
      if (!sampling) return;
      const existing =
        active.current?.context === context ? active.current.worker : null;
      const runId = crypto.randomUUID();
      const targetKeys = targets.map((target) => target.cellKey);
      setState({
        context,
        result: null,
        completed: 0,
        error: null,
        targetKeys,
      });
      let worker: Worker | undefined;
      try {
        worker =
          existing ??
          new Worker(new URL("../worker/samplingWorker.ts", import.meta.url), {
            type: "module",
          });
        const session = { worker, runId, context };
        active.current = session;
        worker.onmessage = (event: MessageEvent<SamplingEvent>) => {
          if (active.current !== session) return;
          const message = event.data;
          if (
            (message.kind === "snapshot"
              ? message.result.runId
              : message.runId) !== runId
          )
            return;
          if (message.kind === "snapshot")
            cacheState.cache.store(message.result);
          setState((previous) => {
            if (previous?.context !== context) return previous;
            if (message.kind === "snapshot") {
              if (
                previous.result &&
                message.result.sequence <= previous.result.sequence
              )
                return previous;
              return {
                context,
                result: message.result,
                completed: message.result.progress.completedTrials,
                error: null,
                targetKeys,
              };
            }
            if (message.kind === "error")
              return { ...previous, error: message.message };
            return { ...previous, completed: message.completedTrials };
          });
        };
        worker.onerror = (event) => {
          if (active.current !== session) return;
          worker!.terminate();
          active.current = null;
          setState((previous) =>
            previous?.context === context
              ? {
                  ...previous,
                  error: event.message || "Sampling worker failed",
                }
              : previous,
          );
        };
        worker.onmessageerror = () => {
          if (active.current !== session) return;
          worker!.terminate();
          active.current = null;
          setState((previous) =>
            previous?.context === context
              ? { ...previous, error: "Sampling response could not be decoded" }
              : previous,
          );
        };
        const command: SamplingCommand = {
          type: "start",
          book,
          hull: cloneHull(model),
          sampling,
          metrics,
          request: {
            runId,
            context: {
              bookRevision: runId,
              hullRevision: runId,
              geometrySettingsRevision: runId,
            },
            seed,
            checkpoints: [64, 256, 1024],
            targets,
          },
        };
        worker.postMessage(command);
      } catch (error) {
        worker?.terminate();
        active.current = null;
        setState({
          context,
          result: null,
          completed: 0,
          error: error instanceof Error ? error.message : String(error),
          targetKeys,
        });
      }
    },
    [book, model, sampling, metrics, context, cacheState],
  );
  const send = (type: "cancel" | "extend") => {
    const session = active.current;
    if (!session || session.context !== context) return;
    const command: SamplingCommand =
      type === "cancel"
        ? { type, runId: session.runId }
        : { type, runId: session.runId, checkpoints: [4096] };
    session.worker.postMessage(command);
  };
  return {
    result: current?.result ?? null,
    cachedResult,
    targetKeys: current?.targetKeys ?? [],
    completed: current?.completed ?? 0,
    error: current?.error ?? null,
    starting: !!current && !current.result && !current.error,
    start,
    cancel: () => send("cancel"),
    refine: () => send("extend"),
  };
}
