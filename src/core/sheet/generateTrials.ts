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
/** Keyed streams: trial order/batching and unrelated inputs do not shift
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
  const offset = (source: TrialPlan["sources"][number]): number => {
    const u = draw("input", source.id);
    if (source.distribution === "triangular") {
      // Inverse CDF of a triangle on [-lo, hi] with its mode at zero.
      // The one-argument form (lo === hi) is the same symmetric triangle.
      const modeFraction = source.lo / (source.lo + source.hi);
      return u < modeFraction
        ? source.lo * (Math.sqrt(u / modeFraction) - 1)
        : source.hi * (1 - Math.sqrt((1 - u) / (1 - modeFraction)));
    }
    if (source.distribution === "normal") {
      // A second keyed variate does not disturb any other input or phase stream.
      const v = draw("input-normal-angle", source.id);
      return (
        source.lo * Math.sqrt(-2 * Math.log(1 - u)) * Math.cos(2 * Math.PI * v)
      );
    }
    return -source.lo + u * (source.lo + source.hi);
  };
  return Object.freeze({
    index,
    inputOffsets: Object.freeze(
      Object.fromEntries(plan.sources.map((s) => [s.id, offset(s)])),
    ),
    repetitionPhases: Object.freeze(
      Object.fromEntries(
        plan.repetitionIds.map((id) => [id, draw("phase", id)]),
      ),
    ),
  });
}
