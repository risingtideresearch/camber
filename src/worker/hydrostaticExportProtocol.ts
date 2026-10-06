import type { HullState } from "../core/hull";
import type { HydrostaticExportOptions } from "../core/hydrostaticExport";

export interface HydrostaticExportRequest {
  state: HullState;
  options: HydrostaticExportOptions;
}
export type HydrostaticExportResponse =
  | { type: "progress"; completedRows: number; totalRows: number }
  | { type: "complete"; json: string }
  | { type: "error"; error: string };
