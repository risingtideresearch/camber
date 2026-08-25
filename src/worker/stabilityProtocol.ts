import type { CrossCurves, LimitingKgPoint } from "../core/stability";
import type { Hydro } from "../core/hydro";
import type { HullMetrics } from "../core/hullMetrics";
import type { HullComputationRequest } from "./hullComputation";

export type StabilityRequest = HullComputationRequest;

export interface StabilityAnalysis {
  readonly curves: CrossCurves;
  readonly limit: LimitingKgPoint[];
  readonly hydro: Hydro | null;
  /**
   * The same hull, measured the way a weight sheet reads it: in metres and kilograms, with the whole-shell
   * numbers the design waterline's cut cannot give. It rides along with the stability payload because it is
   * one extra cut on a hull this worker has already swept — the weight panel needs no worker of its own.
   */
  readonly metrics: HullMetrics | null;
  readonly lowestSheerKg: number;
}

export interface StabilityResponse {
  readonly key: string;
  readonly analysis: StabilityAnalysis | null;
}
