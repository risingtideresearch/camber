import type { AnalysisContext } from "../api";
export interface MeshAnalysisSetup {
  id: string;
  fixedTrim: number;
  /** Explicit heights in the fixed-trim upright frame, metres. Not Camber waterline depth. */
  referenceWaterlineZ: number;
  keelZ: number;
  sinkageSteps?: number;
}
export function meshContext(setup: MeshAnalysisSetup): AnalysisContext {
  if (
    !setup.id ||
    ![setup.fixedTrim, setup.referenceWaterlineZ, setup.keelZ].every(
      Number.isFinite,
    )
  )
    throw new Error("Finite trim, waterline height and KG datum are required");
  if (
    setup.sinkageSteps !== undefined &&
    (!Number.isInteger(setup.sinkageSteps) ||
      setup.sinkageSteps < 4 ||
      setup.sinkageSteps > 512)
  )
    throw new Error("Use 4…512 integer sinkage steps");
  const c = Math.cos(setup.fixedTrim),
    s = Math.sin(setup.fixedTrim);
  return {
    hullToWeight: {
      rows: [
        [c, 0, -s],
        [0, 1, 0],
        [s, 0, c],
      ],
      offset: [0, 0, -setup.keelZ],
    },
    kgDatum: { frame: "upright", z: setup.keelZ },
    id: setup.id,
    fixedTrim: setup.fixedTrim,
    referenceWaterline: setup.referenceWaterlineZ,
    referenceWaterlineConvention: "world-z",
    weightFrame: "upright-cartesian",
  };
}
export const MESH_CAPABILITIES = {
  stability: true,
  measurements: false,
  legacySlices: false,
  pointViews: false,
  arbitraryPlanes: true,
} as const;
