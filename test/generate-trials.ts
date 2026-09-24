import type { Trial, TrialPlan } from "../src/core/sheet/trial";
export { seededRandom, generateTrial } from "../src/core/sheet/generateTrials";

/** Weighted quadrature is a sampling policy too: it makes explicit trials rather
 * than letting geometry select a hidden phase. No Cartesian product is implied.
 */
export function existingPhaseTrials(
  plan: TrialPlan,
  id: string,
  phases: readonly { readonly phase?: number; readonly weight: number }[],
): readonly { trial: Trial; weight: number }[] {
  if (
    plan.sources.length ||
    plan.repetitionIds.length !== 1 ||
    plan.repetitionIds[0] !== id
  )
    throw new Error(
      "Existing weighted phases require one repetition and exact authored inputs",
    );
  return phases.map(({ phase, weight }, index) => {
    if (
      phase === undefined ||
      !Number.isFinite(phase) ||
      phase < 0 ||
      phase >= 1 ||
      !Number.isFinite(weight) ||
      weight <= 0
    )
      throw new Error("Phase data cannot be replayed as a weighted trial");
    return {
      trial: { index, inputOffsets: {}, repetitionPhases: { [id]: phase } },
      weight,
    };
  });
}
