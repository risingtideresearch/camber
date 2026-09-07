import { useEffect, useState } from "react";
import type { QueryResult, QueryOptions } from "../api";

export type QueryState<T> =
  | { readonly status: "pending" }
  | { readonly status: "available"; readonly value: T }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

const PENDING = { status: "pending" } as const;

/** Never expose a previous context/request's answer as the current one, even before effect cleanup. */
export function useAnalysisQuery<T>(
  contextId: string,
  key: string,
  load: (options: QueryOptions) => Promise<QueryResult<T>>,
): QueryState<T> {
  const [answer, setAnswer] = useState<{
    contextId: string;
    key: string;
    state: QueryState<T>;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => load({ signal: controller.signal }))
      .then((response) => {
        if (controller.signal.aborted) return;
        if (response.contextId !== contextId)
          throw new Error("Analysis context mismatch");
        setAnswer({ contextId, key, state: response.result });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setAnswer({
            contextId,
            key,
            state: {
              status: "error",
              reason: reason instanceof Error ? reason.message : String(reason),
            },
          });
      });
    return () => controller.abort();
  }, [contextId, key, load]);
  return answer?.contextId === contextId && answer.key === key
    ? answer.state
    : PENDING;
}
