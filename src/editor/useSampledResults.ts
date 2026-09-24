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

type RunView = {
  readonly result: SampledResults | null;
  readonly completed: number;
  readonly error: string | null;
  readonly starting: boolean;
  readonly runId: string;
};
const keyOf = (keys: readonly string[]) => JSON.stringify(keys);

export function useSampledResults(
  book: WeightBook,
  model: Model,
  sampling: HullSampling | null,
  metrics: HullMetrics | null,
) {
  const context = useMemo(
    () => ({ book, model, sampling, metrics }),
    [book, model, sampling, metrics],
  );
  // Runs are owned by the book/hull context, not by the visible inspector. The
  // worker pauses old runs so the selected field starts immediately, then resumes them.
  const session = useMemo(
    () => ({
      context,
      runs: new Map<string, RunView>(),
      finished: createSampledRunCache(),
    }),
    [context],
  );
  const active = useRef<{ worker: Worker; context: typeof context } | null>(
    null,
  );
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [, setRevision] = useState(0);
  useEffect(() => {
    clearTimeout(disposeTimer.current);
    if (active.current && active.current.context !== context) {
      active.current.worker.terminate();
      active.current = null;
    }
    return () => {
      // StrictMode probes effects with cleanup/setup; do not kill live work.
      const connection = active.current;
      disposeTimer.current = setTimeout(() => {
        if (active.current === connection) {
          connection?.worker.terminate();
          active.current = null;
        }
      }, 0);
    };
  }, [context]);
  const getRun = useCallback(
    (keys: readonly string[]): RunView | null => {
      const running = session.runs.get(keyOf(keys));
      if (running) return running;
      const result = session.finished.get(keys);
      return result
        ? {
            result,
            completed: result.progress.completedTrials,
            error: null,
            starting: false,
            runId: result.runId,
          }
        : null;
    },
    [session],
  );
  const start = useCallback(
    (targets: readonly SamplingTarget[]) => {
      if (!sampling) return;
      const keys = targets.map((target) => target.cellKey);
      const key = keyOf(keys);
      if (getRun(keys)) return;
      const runId = crypto.randomUUID();
      session.runs.set(key, {
        runId,
        result: null,
        completed: 0,
        error: null,
        starting: true,
      });
      setRevision((n) => n + 1);
      try {
        let worker =
          active.current?.context === context ? active.current.worker : null;
        const fresh = !worker;
        if (!worker) {
          worker = new Worker(
            new URL("../worker/samplingWorker.ts", import.meta.url),
            {
              type: "module",
            },
          );
          const connection = { worker, context };
          active.current = connection;
          worker.onmessage = (event: MessageEvent<SamplingEvent>) => {
            if (active.current !== connection) return;
            const message = event.data;
            const id =
              message.kind === "snapshot"
                ? message.result.runId
                : message.runId;
            const entry = [...session.runs].find(([, run]) => run.runId === id);
            if (!entry) return;
            const [key, previous] = entry;
            if (message.kind === "snapshot") {
              const result = message.result;
              if (
                previous.result &&
                result.sequence <= previous.result.sequence
              )
                return;
              if (result.execution.status === "finished") {
                session.finished.store(result);
                session.runs.delete(key);
              } else {
                session.runs.set(key, {
                  ...previous,
                  result,
                  completed: result.progress.completedTrials,
                  error: null,
                  starting: false,
                });
              }
            } else if (message.kind === "error") {
              session.runs.set(key, {
                ...previous,
                error: message.message,
                starting: false,
              });
            } else {
              session.runs.set(key, {
                ...previous,
                completed: message.completedTrials,
              });
            }
            // Completed reports live in the bounded cache. Keep at most 32
            // abandoned/cancelled/error entries beyond the pending jobs.
            const inactive = [...session.runs].filter(
              ([, run]) =>
                !!run.error ||
                run.result?.execution.status === "cancelled" ||
                run.result?.execution.status === "failed",
            );
            for (const [stale] of inactive.slice(0, -32))
              session.runs.delete(stale);
            setRevision((n) => n + 1);
          };
          const fail = (reason: string) => {
            if (active.current !== connection) return;
            worker!.terminate();
            active.current = null;
            for (const [key, run] of session.runs)
              session.runs.set(key, { ...run, error: reason, starting: false });
            setRevision((n) => n + 1);
          };
          worker.onerror = (event) =>
            fail(event.message || "Sampling worker failed");
          worker.onmessageerror = () =>
            fail("Sampling response could not be decoded");
        }
        const command: SamplingCommand = {
          type: "start",
          ...(fresh ? { book, hull: cloneHull(model), sampling, metrics } : {}),
          request: {
            runId,
            context: {
              bookRevision: runId,
              hullRevision: runId,
              geometrySettingsRevision: runId,
            },
            seed: 12345,
            checkpoints: [64, 256, 1024],
            targets,
          },
        };
        worker.postMessage(command);
      } catch (error) {
        active.current?.worker.terminate();
        active.current = null;
        session.runs.set(key, {
          ...session.runs.get(key)!,
          error: error instanceof Error ? error.message : String(error),
          starting: false,
        });
        setRevision((n) => n + 1);
      }
    },
    [book, model, sampling, metrics, context, session, getRun],
  );
  const send = useCallback(
    (type: "cancel" | "extend", keys: readonly string[]) => {
      if (active.current?.context !== context) return;
      const run = getRun(keys);
      if (!run) return;
      if (type === "extend" && !session.runs.has(keyOf(keys))) {
        session.runs.set(keyOf(keys), { ...run, starting: true });
        setRevision((n) => n + 1);
      }
      const command: SamplingCommand =
        type === "cancel"
          ? { type, runId: run.runId }
          : { type, runId: run.runId, checkpoints: [4096] };
      active.current.worker.postMessage(command);
    },
    [context, getRun, session],
  );
  const prioritize = useCallback(
    (keys: readonly string[]) => {
      if (active.current?.context !== context) return;
      const run = session.runs.get(keyOf(keys));
      if (run?.starting && !run.error)
        active.current.worker.postMessage({
          type: "prioritize",
          runId: run.runId,
        } satisfies SamplingCommand);
    },
    [context, session],
  );
  return {
    getRun,
    start,
    prioritize,
    cancel: (keys: readonly string[]) => send("cancel", keys),
    refine: (keys: readonly string[]) => send("extend", keys),
  };
}
