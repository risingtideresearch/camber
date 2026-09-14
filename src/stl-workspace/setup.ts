import {
  validateRepairPolicy,
  type RepairPolicy,
  type RepairReport,
} from "../analysis/mesh/repair";
import type {
  PhysicalSetup,
  PreparationReport,
} from "../analysis/mesh/prepare";
import { meshContext } from "../analysis/mesh/setup";
import type { MeshImport } from "../analysis/mesh/protocol";
import type { DisplayGeometry } from "../analysis/projections";

export interface Asset {
  name: string;
  bytes: ArrayBuffer;
}
export interface Configuration {
  metresPerUnit: number;
  axes: PhysicalSetup["axes"];
  origin: PhysicalSetup["origin"];
  trimDegrees: number;
  keelZ: number;
  waterlineZ: number | null;
  /** Legacy field name: calibration has been applied, not a user attestation. */
  frameConfirmed?: boolean;
  /** Undefined retains the default automatic, tightly bounded gap treatment. */
  autoPatchSmallHoles?: boolean;
  closeDeck: boolean;
  wholeSurface: boolean;
  repair?: RepairPolicy;
}
export const DEFAULT_CONFIGURATION: Configuration = {
  metresPerUnit: 0, // STL has no units. Require a choice, never guess.
  axes: [1, 2, 3],
  origin: [0, 0, 0],
  trimDegrees: 0,
  keelZ: 0,
  waterlineZ: null,
  frameConfirmed: false,
  // Legacy project field. New standalone imports retain a validated open sheer
  // and stop calculations at rim immersion instead of adding a cap.
  closeDeck: false,
  // STL carries no hull-material classification. Ask when a formula needs it.
  wholeSurface: false,
};

/** Undo preview scaling/permutation to recover extents in original STL units.
 * Translation and signed axis flips do not change these lengths. */
export function sourceAxisLengths(
  bounds: DisplayGeometry["bounds"],
  previewConfiguration: Configuration,
): PhysicalSetup["origin"] {
  const lengths: PhysicalSetup["origin"] = [0, 0, 0];
  previewConfiguration.axes.forEach((axis, i) => {
    lengths[Math.abs(axis) - 1] =
      (bounds.max[i] - bounds.min[i]) /
      (previewConfiguration.metresPerUnit || 1);
  });
  return lengths;
}

export function placedReferences(
  currentOrigin: PhysicalSetup["origin"],
  bounds: { min: PhysicalSetup["origin"]; max: PhysicalSetup["origin"] },
): Pick<Configuration, "origin" | "keelZ" | "waterlineZ"> {
  const depth = bounds.max[2] - bounds.min[2];
  if (!(depth > 0) || !Number.isFinite(depth))
    throw new Error("The hull needs a finite vertical extent.");
  return {
    origin: [
      currentOrigin[0] + bounds.min[0],
      currentOrigin[1] + (bounds.min[1] + bounds.max[1]) / 2,
      currentOrigin[2] + bounds.min[2],
    ],
    keelZ: 0,
    waterlineZ: null,
  };
}
export function configurationForEnvelope(c: Configuration): Configuration {
  return {
    ...c,
    // Migrate old standalone projects away from synthetic sheer caps whenever
    // their setup is reviewed.
    closeDeck: false,
  };
}

export function physicalSetup(c: Configuration): PhysicalSetup {
  if (
    !Number.isFinite(c.metresPerUnit) ||
    c.metresPerUnit <= 0 ||
    c.axes.length !== 3 ||
    new Set(c.axes.map(Math.abs)).size !== 3 ||
    c.axes.some((a) => ![1, 2, 3, -1, -2, -3].includes(a)) ||
    c.origin.length !== 3 ||
    !c.origin.every(Number.isFinite)
  )
    throw new Error(
      "Choose source units, three different source axes, and a finite origin.",
    );
  return {
    metresPerUnit: c.metresPerUnit,
    axes: [...c.axes],
    origin: [...c.origin],
  };
}
export function analysisSetup(c: Configuration, id: string): MeshImport {
  if (c.repair) validateRepairPolicy(c.repair);
  if (
    ![c.trimDegrees, c.keelZ].every(Number.isFinite) ||
    (c.waterlineZ !== null && !Number.isFinite(c.waterlineZ))
  )
    throw new Error("Enter finite trim, waterline and VCG reference values.");
  const analysis = {
    id,
    fixedTrim: (c.trimDegrees * Math.PI) / 180,
    referenceWaterlineZ: c.waterlineZ ?? undefined,
    keelZ: c.keelZ,
    ...(c.wholeSurface
      ? {
          shellScope: {
            confirmed: true as const,
            surfaces: ["unclassified"],
            label:
              "All supplied physical STL faces (including any deck and transom)",
          },
        }
      : {}),
  };
  meshContext(analysis);
  return {
    physical: physicalSetup(c),
    // A project is useful without a hydrostatic envelope: the weight book,
    // physical surface measurements and preview should still open.
    allowSurfaceOnly: true,
    ...(c.repair ? { repair: { ...c.repair, accepted: true as const } } : {}),
    analysis,
    // The standalone host accepts only a validated single open sheer. The mesh
    // integrator truncates each heel row before rim immersion.
    openSheer: true,
  };
}
export interface Inspection {
  geometry?: DisplayGeometry;
  openSheer?: true;
  report?: PreparationReport;
  boundaryLoops?: number;
  repair?: RepairReport;
  changes?: DisplayGeometry;
  automaticPatches?: RepairReport;
  closureError?: string;
  error?: string;
}
export interface InspectRequest {
  buffer: ArrayBuffer;
  physical: PhysicalSetup;
  repair?: true | RepairPolicy;
}
export const message = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

/** Persistence accepts unknown scale/reference; numerical entry points do not. */
export function validateConfiguration(c: Configuration): void {
  if (
    !c ||
    !Number.isFinite(c.metresPerUnit) ||
    c.metresPerUnit < 0 ||
    typeof c.wholeSurface !== "boolean" ||
    typeof c.closeDeck !== "boolean" ||
    (c.autoPatchSmallHoles !== undefined &&
      typeof c.autoPatchSmallHoles !== "boolean") ||
    (c.frameConfirmed !== undefined && typeof c.frameConfirmed !== "boolean")
  )
    throw new Error("Invalid project calibration");
  analysisSetup({ ...c, metresPerUnit: c.metresPerUnit || 1 }, "validate");
}
