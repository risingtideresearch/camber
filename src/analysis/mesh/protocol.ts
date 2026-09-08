import type { AnalysisQueries, Available, QueryKind } from "../api";
import type { MeshAnalysisSetup } from "./setup";
import type { PhysicalSetup, PreparationReport } from "./prepare";
export interface MeshImport {
  physical: PhysicalSetup;
  analysis: MeshAnalysisSetup;
  /** Omitted means closed-envelope mode. Never infer permission to seal an opening. */
  deckClosure?: { accepted: true; closureId: string };
}
export type MeshRequest =
  | { type: "install"; buffer: ArrayBuffer; setup: MeshImport }
  | {
      type: "query";
      id: number;
      contextId: string;
      kind: QueryKind;
      input: AnalysisQueries[QueryKind]["input"];
    };
export type MeshResponse =
  | {
      type: "ready";
      contextId: string;
      report?: PreparationReport;
      error?: string;
    }
  | {
      type: "answer";
      contextId: string;
      id: number;
      result?: Available<AnalysisQueries[QueryKind]["output"]>;
      error?: string;
    };
