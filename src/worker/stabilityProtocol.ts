import type { CrossCurves, LimitingKgPoint } from "../core/stability";
import type { Hydro } from "../core/hydro";
import type { HullComputationRequest } from "./hullComputation";

export type StabilityRequest = HullComputationRequest;

export interface StabilityAnalysis {
  readonly curves: CrossCurves;
  readonly limit: LimitingKgPoint[];
  readonly hydro: Hydro | null;
  readonly lowestSheerKg: number;
}

export interface StabilityResponse {
  readonly key: string;
  readonly analysis: StabilityAnalysis | null;
}
