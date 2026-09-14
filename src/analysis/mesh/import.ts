import { repairMesh } from "./repair";
import { parseStl } from "../../core/stlImport";
import { closeDeck, validateOpenSheer } from "./closure";
import { prepareMesh, prepareSurfaceMesh } from "./prepare";
import type { MeshImport } from "./protocol";
export function importAnalysisStl(buffer: ArrayBuffer, setup: MeshImport) {
  const raw = parseStl(buffer);
  const sources = setup.surfaceByTriangle?.map((surface) => ({
    kind: "physical" as const,
    surface,
  }));
  if (setup.repair && setup.repair.accepted !== true)
    throw new Error("Explicit mesh repair confirmation is required");

  let mesh;
  if (setup.repair) {
    // An accepted persisted repair must reproduce exactly; never pretend it was
    // applied by silently falling back to the original surface.
    mesh = repairMesh(
      raw.positions,
      setup.physical,
      setup.repair,
      sources,
    ).mesh;
  } else {
    try {
      mesh = prepareMesh(raw.positions, setup.physical, {
        // Discover a supported opening before deciding whether this caller has
        // consented to cap it. An open skin is still useful to the workspace.
        allowOpen: true,
        sources,
      });
    } catch (error) {
      if (!setup.allowSurfaceOnly) throw error;
      return prepareSurfaceMesh(
        raw.positions,
        setup.physical,
        { sources },
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (mesh.report.closed) return mesh;
  // Repair search validates candidate geometry, but only the import setup grants
  // open-sheer analysis capability to this context.
  if (!setup.openSheer) delete mesh.report.openHydrostatics;
  try {
    if (setup.deckClosure) return closeDeck(mesh, setup.deckClosure);
    if (setup.openSheer) return validateOpenSheer(mesh);
  } catch (error) {
    if (!setup.allowSurfaceOnly) throw error;
    mesh.report.envelopeError =
      error instanceof Error ? error.message : String(error);
    mesh.report.diagnostics.push(
      `Buoyancy envelope unavailable: ${mesh.report.envelopeError}`,
    );
    return mesh;
  }
  if (!setup.allowSurfaceOnly)
    throw new Error(
      "Open envelope: enable validated open-sheer hydrostatics or provide an explicit closure",
    );
  mesh.report.envelopeError =
    mesh.boundary.length > 1
      ? `Open envelope: ${mesh.boundary.length} boundary loops remain; open-sheer hydrostatics supports one. Repair or intentionally close the other ${mesh.boundary.length - 1} opening(s)`
      : "Open envelope: validated open-sheer hydrostatics was not enabled";
  mesh.report.diagnostics.push(mesh.report.envelopeError);
  return mesh;
}
