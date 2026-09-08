// Only NEW physical plane sections use this tessellation. Hydrostatics, KN and
// legacy authored station measurements continue through the original sweep.
import type { Model } from "../../core/model";
import type { HullSampling } from "../../core/mesh";
import { buildHullMesh, buildTransomMesh } from "../../core/hullGeometry";
import { unitScale } from "../../core/lengthUnits";
import { closeDeck } from "../mesh/closure";
import { prepareMesh } from "../mesh/prepare";
import type { BoundarySource } from "../sections";

/** Orthonormal, unraked deck/body frame in metres. Applying fixed trim is NOT
 * part of a body-plane query. Do not use hybrid weight coordinates as normals. */
export function camberPlaneMesh(model: Model, sampling: HullSampling) {
  const scale = unitScale(model.unit, "m");
  const parts = [
    { mesh: buildHullMesh(sampling, true, false, false).hull, surface: "skin" },
    { mesh: buildTransomMesh(model, sampling), surface: "transom" },
  ];
  const positions: number[] = [],
    sources: BoundarySource[] = [];
  for (const { mesh, surface } of parts) {
    for (const v of mesh.pos) positions.push(v * scale);
    for (let i = 0; i < mesh.pos.length; i += 9)
      sources.push({ kind: "physical", surface });
  }
  const open = prepareMesh(positions, undefined, { allowOpen: true, sources });
  // Camber explicitly defines closure to the sheer. The new section path uses
  // transverse ruled strips, an identified approximation, not the swept cap.
  return closeDeck(open, {
    accepted: true,
    closureId: "camber-sheer-prototype",
  });
}
