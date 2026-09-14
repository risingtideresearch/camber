import { proposeMeshRepair, repairMesh } from "../analysis/mesh/repair";
// Off-thread, geometry-only preview. Supported open-sheer validation never adds
// the temporary validation cap to display or analysis geometry.
import { parseStl } from "../core/stlImport";
import {
  physicalPoints,
  prepareMesh,
  prepareSurfaceMesh,
} from "../analysis/mesh/prepare";
import { validateOpenSheer } from "../analysis/mesh/closure";
import { meshDisplayGeometry } from "../analysis/mesh/projection";
import { bounds } from "../analysis/mesh/spatial";
import { message, type InspectRequest, type Inspection } from "./setup";

export function inspectStl({
  buffer,
  physical,
  repair,
}: InspectRequest): Inspection {
  const result: Inspection = {};
  try {
    const raw = parseStl(buffer);
    const points = physicalPoints(raw.positions, physical);
    result.geometry = {
      positions: new Float32Array(points.flat()),
      sources: Array.from({ length: points.length / 3 }, () => ({
        kind: "physical" as const,
        surface: "unclassified",
      })),
      bounds: bounds(points),
    };
    const repaired =
      repair === true
        ? proposeMeshRepair(raw.positions, physical)
        : repair
          ? repairMesh(raw.positions, physical, repair)
          : undefined;
    let mesh = repaired?.mesh;
    if (!mesh)
      try {
        mesh = prepareMesh(raw.positions, physical, { allowOpen: true });
      } catch (e) {
        // Topology suitable for buoyancy is a capability, not an admission
        // requirement. Retain a cleaned physical surface for weight work.
        mesh = prepareSurfaceMesh(raw.positions, physical, {}, message(e));
      }
    if (repaired) {
      result.repair = repaired.report;
      result.changes = repaired.changes;
    }
    result.geometry = meshDisplayGeometry(mesh);
    result.report = mesh.report;
    result.boundaryLoops = mesh.boundary.length;
    if (!mesh.report.closed && !mesh.report.envelopeError) {
      try {
        mesh = validateOpenSheer(mesh);
        result.report = mesh.report;
        result.openSheer = true;
      } catch (e) {
        result.closureError = message(e);
      }
    }
  } catch (e) {
    result.error = message(e);
  }
  return result;
}
