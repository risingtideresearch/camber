import { useEffect, useMemo, useRef, useState } from "react";
import type { PerfSettings } from "../core/perf";
import type { DocumentSnapshot } from "../document-store/snapshot";
import type {
  StabilityAnalysis,
  StabilityRequest,
  StabilityResponse,
} from "../worker/stabilityProtocol";
import { createWorkerTaskQueue } from "../worker/taskWorker";

const requestKey = (snapshot: DocumentSnapshot, perf: PerfSettings): string => {
  const { plan, trim, stations, transom, scalars } = snapshot.sliceRevs;
  return `${plan}|${trim}|${stations}|${transom}|${scalars}|${perf.numSections}|${perf.girthSteps}`;
};

/** Compute the complete stability panel payload without doing any hull or hydrostatic work in React. */
export function useStabilityAnalysis(
  snapshot: DocumentSnapshot,
  perf: PerfSettings,
): { analysis: StabilityAnalysis | null; error: string | null } {
  const [analysis, setAnalysis] = useState<StabilityAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tasks] = useState(() =>
    createWorkerTaskQueue<StabilityRequest, StabilityResponse>(
      () =>
        new Worker(new URL("../worker/stabilityWorker.ts", import.meta.url), {
          type: "module",
        }),
      (response) => {
        setAnalysis(response.analysis);
        setError(null);
      },
      (reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
    ),
  );
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    clearTimeout(disposeTimer.current);
    return () => {
      disposeTimer.current = setTimeout(() => tasks.dispose(), 0);
    };
  }, [tasks]);

  const key = requestKey(snapshot, perf);
  const request = useMemo<StabilityRequest>(
    () => ({
      key,
      state: snapshot.state.hull,
      session: snapshot.session,
      sliceRevs: snapshot.sliceRevs,
      numSections: perf.numSections,
      girthSteps: perf.girthSteps,
    }),
    [
      key,
      snapshot.state.hull,
      snapshot.session,
      snapshot.sliceRevs,
      perf.numSections,
      perf.girthSteps,
    ],
  );
  useEffect(() => {
    tasks.post(request);
  }, [tasks, request]);

  return { analysis, error };
}
