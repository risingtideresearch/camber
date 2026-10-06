import type { SurfaceToggles } from "../core/hullGeometry";

export type ExportFormat = "json" | "step" | "stl" | "hydrostatics";
export type HydrostaticCoverage = "upright" | "fixed" | "grid";
export type ExportOptions =
  | { format: "json" | "step" }
  | { format: "stl"; surfaces: SurfaceToggles }
  | {
      format: "hydrostatics";
      coverage: HydrostaticCoverage;
      fine: boolean;
    };

/** A captured hull document, not viewport geometry or a live reference to editor state. */
export interface ExportSource {
  name: string;
  json: string;
  modelId?: string;
}
export interface ExportRequest {
  source: ExportSource;
  options: ExportOptions;
  generatedAt: string;
}
export interface ExportArtifact {
  filename: string;
  text: string;
  mime: string;
}
export type ExportResponse =
  | { type: "progress"; completedRows: number; totalRows: number }
  | { type: "complete"; artifact: ExportArtifact }
  | { type: "error"; error: string };
