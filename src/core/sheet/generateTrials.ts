import type { Trial, TrialPlan } from "./trial";

/** Mulberry32; all pseudo-randomness is confined to this trial-generation module. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Version 1 keyed streams: trial order/batching and unrelated inputs do not shift
 * existing draws. This is reproducible Monte Carlo, not a cryptographic generator.
 */
export function generateTrial(
  plan: TrialPlan,
  seed: number,
  index: number,
): Trial {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("seed must be an unsigned 32-bit integer");
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error("Invalid trial index");
  const draw = (kind: string, id: string) => {
    let hash = 2166136261;
    const key = JSON.stringify([seed, index, kind, id]);
    for (let i = 0; i < key.length; i++)
      hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return seededRandom(hash)();
  };
  return Object.freeze({
    index,
    inputOffsets: Object.freeze(
      Object.fromEntries(
        plan.sources.map((s) => [
          s.id,
          -s.lo + draw("input", s.id) * (s.lo + s.hi),
        ]),
      ),
    ),
    repetitionPhases: Object.freeze(
      Object.fromEntries(
        plan.repetitionIds.map((id) => [id, draw("phase", id)]),
      ),
    ),
  });
}
