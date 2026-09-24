import type { HullMetrics } from "../hullMetrics";
import {
  createTrialEvaluator,
  type Trial,
  type TrialGeometry,
  type TrialPlan,
  type TrialValue,
} from "./trial";

/** A worker-local map of deterministic trial worlds. Each world retains the
 * evaluated dependency cells and geometry, so a new target only fills in what
 * that trial has not yet visited. Evict old worlds to bound memory. */
export function createTrialValueCache(
  plan: TrialPlan,
  geometry: TrialGeometry,
  metrics: HullMetrics | null,
  maxWorlds = 1024,
) {
  const worlds = new Map<number, ReturnType<typeof createTrialEvaluator>>();
  return (
    trial: Trial,
    targets: readonly string[],
  ): ReadonlyMap<string, TrialValue> => {
    let evaluate = worlds.get(trial.index);
    if (!evaluate) {
      evaluate = createTrialEvaluator(plan, trial, geometry, metrics);
      worlds.set(trial.index, evaluate);
      if (worlds.size > maxWorlds) worlds.delete(worlds.keys().next().value!);
    } else {
      // Recently requested worlds remain available when moving between fields.
      worlds.delete(trial.index);
      worlds.set(trial.index, evaluate);
    }
    return evaluate(targets).values;
  };
}
