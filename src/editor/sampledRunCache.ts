import type { SampledResults } from "../core/sheet/sampling";

/** Finished reductions for one immutable book/hull/settings context. The worker
 * retains mapped trial worlds separately; this avoids even replaying the reducer
 * when a view returns to an output already shown. */
export function createSampledRunCache(limit = 32) {
  const snapshots = new Map<string, SampledResults>();
  const keyOf = (keys: readonly string[]) => JSON.stringify(keys);
  return {
    get(keys: readonly string[]): SampledResults | null {
      const key = keyOf(keys);
      const snapshot = snapshots.get(key) ?? null;
      if (snapshot) {
        snapshots.delete(key);
        snapshots.set(key, snapshot);
      }
      return snapshot;
    },
    store(result: SampledResults): void {
      if (result.execution.status !== "finished") return;
      const key = keyOf(result.outputs.map((output) => output.cellKey));
      snapshots.delete(key);
      snapshots.set(key, result);
      if (snapshots.size > limit)
        snapshots.delete(snapshots.keys().next().value!);
    },
  };
}
