import { useState } from "react";
import type { HullSampling } from "../../core/mesh";
import type { WeightBookResults } from "../useWeightBookResults";

type Readout = Pick<
  WeightBookResults,
  "results" | "measurements" | "repetitions"
>;
export interface WeightPresentation {
  readonly sampling: HullSampling | null;
  readonly documentId: string | null;
  readonly readout: Readout;
  readonly stale: boolean;
  readonly retainable: boolean;
}

/** Presentation only. Never feed retained measurements back to evaluateBook or
 * the stability analysis. A changed hull/document or a real failure releases the
 * retained readout; a new nominal answer replaces it immediately. */
export function weightPresentation(
  previous: WeightPresentation | null,
  current: WeightBookResults,
  sampling: HullSampling | null,
  documentId: string | null,
): WeightPresentation {
  const stale = !!(
    current.pending &&
    !current.error &&
    sampling &&
    previous?.retainable &&
    previous.sampling === sampling &&
    previous.documentId === documentId
  );
  const retainable = stale || (!current.pending && !current.error);
  const readout = stale ? previous!.readout : current;
  if (
    previous &&
    previous.sampling === sampling &&
    previous.documentId === documentId &&
    previous.stale === stale &&
    previous.retainable === retainable &&
    previous.readout.results === readout.results &&
    previous.readout.measurements === readout.measurements &&
    previous.readout.repetitions === readout.repetitions
  )
    return previous;
  return { sampling, documentId, readout, stale, retainable };
}

export function useWeightPresentation(
  current: WeightBookResults,
  sampling: HullSampling | null,
  documentId: string | null,
): WeightPresentation {
  const [previous, setPrevious] = useState<WeightPresentation | null>(null);
  const next = weightPresentation(previous, current, sampling, documentId);
  // Adjust during render rather than in an effect: children must never paint the
  // transient "no valid cut" errors while nominal geometry is still in flight.
  if (next !== previous) setPrevious(next);
  return next;
}
