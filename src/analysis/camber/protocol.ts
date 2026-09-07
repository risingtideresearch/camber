import type { AnalysisQueries, Available, QueryKind } from "../api";
import type { HullComputationRequest } from "../../worker/hullComputation";

export interface CamberQueryRequest {
  readonly id: number;
  readonly source: HullComputationRequest;
  readonly kind: QueryKind;
  readonly input: AnalysisQueries[QueryKind]["input"];
}
export interface CamberQueryResponse {
  readonly id: number;
  readonly contextId: string;
  readonly result?: Available<AnalysisQueries[QueryKind]["output"]>;
  readonly error?: string;
}
