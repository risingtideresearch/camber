import type { RepairPolicy } from "./repair";
import type { AnalysisQueries, Available, QueryKind } from "../api";
import type { MeshAnalysisSetup } from "./setup";
import type { PhysicalSetup, PreparationReport } from "./prepare";
export interface MeshImport {
  physical: PhysicalSetup;
  /** Permit a safely parsed/cleaned surface to open the workspace even when it
   * cannot provide hydrostatics. Strict API callers omit this. */
  allowSurfaceOnly?: true;
  repair?: RepairPolicy & { accepted: true };
  /** One physical surface label per original STL triangle, in file order. Omitted = unclassified. */
  surfaceByTriangle?: string[];
  analysis: MeshAnalysisSetup;
  /** Accept one conservatively validated open top/sheers boundary. Calculations
   * stop when any rim point immerses; this does not add closure faces. */
  openSheer?: true;
  /** Legacy/explicit sealed-envelope mode. This physically adds synthetic cap
   * triangles to the numerical mesh and must never be inferred. */
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
