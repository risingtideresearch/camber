import type { AnalysisContext } from "../api";
export interface MeshAnalysisSetup {
  id: string;
  fixedTrim: number;
  /** Explicit heights in the fixed-trim upright frame, metres. Not Camber waterline depth. */
  referenceWaterlineZ?: number;
  keelZ: number;
  sinkageSteps?: number;
  /** Deliberately selected PHYSICAL surfaces, never synthetic closure faces. */
  shellScope?: { confirmed: true; surfaces: string[]; label: string };
}
export function meshContext(setup: MeshAnalysisSetup): AnalysisContext {
  if (
    !setup.id ||
    ![setup.fixedTrim, setup.keelZ].every(Number.isFinite) ||
    (setup.referenceWaterlineZ !== undefined &&
      !Number.isFinite(setup.referenceWaterlineZ))
  )
    throw new Error(
      "Finite trim and KG datum are required; an optional waterline height must be finite",
    );
  if (
    setup.sinkageSteps !== undefined &&
    (!Number.isInteger(setup.sinkageSteps) ||
      setup.sinkageSteps < 4 ||
      setup.sinkageSteps > 512)
  )
    throw new Error("Use 4…512 integer sinkage steps");
  if (
    setup.shellScope &&
    (setup.shellScope.confirmed !== true ||
      !setup.shellScope.label?.trim() ||
      !Array.isArray(setup.shellScope.surfaces) ||
      !setup.shellScope.surfaces.length ||
      setup.shellScope.surfaces.some(
        (s) => typeof s !== "string" || !s.trim(),
      ) ||
      new Set(setup.shellScope.surfaces).size !==
        setup.shellScope.surfaces.length)
  )
    throw new Error("Confirm a named, non-empty physical shell surface scope");
  const c = Math.cos(setup.fixedTrim),
    s = Math.sin(setup.fixedTrim);
  return {
    shellScope: setup.shellScope
      ? structuredClone(setup.shellScope)
      : undefined,
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
    referenceWaterline: setup.referenceWaterlineZ ?? NaN,
    referenceWaterlineConvention: "world-z",
    weightFrame: "upright-cartesian",
  };
}
export const MESH_CAPABILITIES = {
  authoredStations: false,
} as const;
