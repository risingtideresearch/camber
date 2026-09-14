// Bounded repair proposals and incremental patches on validated geometry. No
// component deletion, blanket sealing or disabled validation; STL bytes stay authoritative.
import { V, type Vec3 } from "../../core/math";
import type { BoundarySource } from "../sections";
import type { DisplayGeometry } from "../projections";
import { proposeDeckClosure, validateOpenSheer } from "./closure";
import {
  physicalPoints,
  prepareWeldedMesh,
  appendMeshFaces,
  weldMesh,
  type PhysicalSetup,
  type PreparedMesh,
} from "./prepare";
import { bounds, type Bounds, type Face } from "./spatial";

export type RepairPolicy =
  | {
      /** Legacy projects always patched every bounded small opening. */
      version: 1;
      weldRelative: number;
      fillSmallHoles: true;
    }
  | {
      version: 2;
      weldRelative: number;
      /** Independent from cleanup/stitching so a user can leave possible
       * intentional openings alone and accept a surface-only result. */
      fillSmallHoles: boolean;
    };
export interface RepairHole {
  diameter: number;
  area: number;
  triangles: number;
}
export interface RepairReport {
  policy: RepairPolicy;
  inputTriangles: number;
  degenerate: number;
  duplicate: number;
  maxVertexMove: number;
  weldTolerance: number;
  removedArea: number;
  changedArea: number;
  holes: RepairHole[];
  skippedHoles: RepairHole[];
}
const WELDS = [1e-8, 1e-7, 1e-6, 1e-5, 5e-5];
export function validateRepairPolicy(p: RepairPolicy): void {
  if (
    !p ||
    !WELDS.includes(p.weldRelative) ||
    !(
      (p.version === 1 && p.fillSmallHoles === true) ||
      (p.version === 2 && typeof p.fillSmallHoles === "boolean")
    )
  )
    throw new Error("Unsupported mesh repair policy/version");
}
const area = (p: Vec3[]) =>
  Math.hypot(...V.cross(V.sub(p[1], p[0]), V.sub(p[2], p[0]))) / 2;
const diameter = (p: Vec3[]) => {
  const b = bounds(p);
  return Math.hypot(...V.sub(b.max, b.min));
};

/** Small holes can be in a side, keel or transom: triangulate in their own local
 * plane, not hull-xy. Retain boundary vertices and validate the resulting 3D mesh. */
function patchHole(mesh: PreparedMesh, loop: number[]): Face[] {
  const origin = mesh.vertices[loop[0]];
  let normal: Vec3 = [0, 0, 0];
  loop.forEach((id, i) => {
    const cross = V.cross(
      V.sub(mesh.vertices[id], origin),
      V.sub(mesh.vertices[loop[(i + 1) % loop.length]], origin),
    );
    normal = normal.map((n, j) => n + cross[j]) as Vec3;
  });
  if (Math.hypot(...normal) <= mesh.report.tolerance ** 2)
    throw new Error("Small hole has no stable projection plane");
  normal = V.norm(normal);
  const reference: Vec3 = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const u = V.norm(V.cross(reference, normal)),
    v = V.cross(normal, u);
  const vertices = loop.map((id) => {
    const d = V.sub(mesh.vertices[id], origin);
    return [V.dot(d, u), V.dot(d, v), V.dot(d, normal)] as Vec3;
  });
  const projected = {
    vertices,
    report: { tolerance: mesh.report.tolerance },
    boundary: [loop.map((_, i) => i)],
  };
  return proposeDeckClosure(projected).triangles.map(
    (f) => f.map((i) => loop[i]) as Face,
  );
}

export function repairMesh(
  positions: ArrayLike<number>,
  physical: PhysicalSetup,
  policy: RepairPolicy,
  sources?: readonly BoundarySource[],
): { mesh: PreparedMesh; report: RepairReport; changes: DisplayGeometry } {
  validateRepairPolicy(policy);
  const original = physicalPoints(positions, physical),
    size = diameter(original),
    weldTolerance = size * policy.weldRelative;
  // Snapping permission and numerical predicate tolerance are DIFFERENT. Raising
  // intersection/area tolerance along with snapping would erase valid thin faces.
  const welded = weldMesh(positions, physical, {
    cleanup: true,
    weldTolerance,
    sources,
  });
  const mesh = prepareWeldedMesh(welded, { allowOpen: true });
  if (size > diameter(mesh.vertices) * 1.01)
    throw new Error(
      "Cleanup would substantially change the mesh extent; remove remote outliers explicitly",
    );
  const retained = new Set(welded.originalFaces);
  let originalArea = 0,
    removedArea = 0,
    changedArea = 0;
  const changed: number[] = [];
  for (let i = 0; i < original.length; i += 3) {
    const points = original.slice(i, i + 3),
      a = area(points);
    originalArea += a;
    if (!retained.has(i / 3) && !welded.removedDuplicates.has(i / 3)) {
      removedArea += a;
      changed.push(...points.flat());
    }
  }
  welded.faces.forEach((f, i) => {
    const points = f.map((j) => welded.vertices[j]),
      before = original.slice(
        welded.originalFaces[i] * 3,
        welded.originalFaces[i] * 3 + 3,
      );
    changedArea += Math.abs(area(points) - area(before));
    if (
      points.some(
        (p, j) => Math.hypot(...V.sub(p, before[j])) > mesh.report.tolerance,
      )
    )
      changed.push(...points.flat());
  });
  if (removedArea + changedArea > originalArea * 0.001)
    throw new Error(
      "Cleanup would change too much physical surface area (limit 0.1%)",
    );
  const report: RepairReport = {
    policy: { ...policy },
    inputTriangles: original.length / 3,
    ...welded.cleanup,
    weldTolerance,
    removedArea,
    changedArea,
    holes: [],
    skippedHoles: [],
  };
  return finishRepair(
    mesh,
    report,
    size,
    originalArea,
    changed,
    bounds(original),
  );
}

/** Patch a validated source directly: no new welding, movement or face removal. */
export function patchPreparedMesh(mesh: PreparedMesh) {
  if (mesh.report.envelopeError)
    throw new Error("Automatic patching requires validated topology");
  const size = Math.hypot(...V.sub(mesh.tree.max, mesh.tree.min));
  const originalArea = mesh.faces.reduce(
    (sum, f) => sum + area(f.map((i) => mesh.vertices[i])),
    0,
  );
  const report: RepairReport = {
    policy: { version: 2, weldRelative: 1e-8, fillSmallHoles: true },
    inputTriangles: mesh.faces.length,
    degenerate: 0,
    duplicate: 0,
    maxVertexMove: 0,
    weldTolerance: mesh.report.tolerance,
    removedArea: 0,
    changedArea: 0,
    holes: [],
    skippedHoles: [],
  };
  return finishRepair(mesh, report, size, originalArea, [], mesh.tree);
}

function finishRepair(
  source: PreparedMesh,
  report: RepairReport,
  size: number,
  originalArea: number,
  changed: number[],
  originalBounds: Bounds,
): { mesh: PreparedMesh; report: RepairReport; changes: DisplayGeometry } {
  // Reports are derived state; leave the validated source untouched even on failure.
  let mesh = {
    ...source,
    report: { ...source.report, diagnostics: [...source.report.diagnostics] },
  };
  const policy = report.policy;
  const patches: Face[] = [],
    patchSources: BoundarySource[] = [];
  for (const loop of mesh.boundary) {
    const span = diameter(loop.map((i) => mesh.vertices[i]));
    if (span > size * 0.005) continue; // Never infer permission to seal a deck or a large opening.
    if (
      loop.length > 32 ||
      report.holes.length + report.skippedHoles.length >= 16
    )
      throw new Error("Too many/complex small holes for bounded repair");
    const faces = patchHole(mesh, loop),
      da = faces.reduce(
        (sum, f) => sum + area(f.map((i) => mesh.vertices[i])),
        0,
      );
    const hole = { diameter: span, area: da, triangles: faces.length };
    if (!policy.fillSmallHoles) {
      report.skippedHoles.push(hole);
      continue;
    }
    report.holes.push(hole);
    patches.push(...faces);
    patchSources.push(
      ...faces.map(() => ({
        kind: "synthetic" as const,
        closure: `repair-hole-${report.holes.length}`,
        purpose: "repair" as const,
      })),
    );
  }
  if (report.holes.reduce((sum, h) => sum + h.area, 0) > originalArea * 0.0001)
    throw new Error(
      "Small-hole patches exceed the 0.01% surface-area repair limit",
    );
  changed.push(...patches.flatMap((f) => f.flatMap((i) => mesh.vertices[i])));
  if (patches.length) mesh = appendMeshFaces(mesh, patches, patchSources);
  mesh.report.repair = report;
  mesh.report.diagnostics.push(
    `Repair policy v${policy.version}: ${report.degenerate} collapsed/degenerate and ${report.duplicate} duplicate triangles removed; ${report.holes.length} small openings patched; ${report.skippedHoles.length} left open; maximum vertex move ${report.maxVertexMove} m`,
  );
  // Resolve open-surface winding while validating the one remaining sheer, but
  // retain no cap triangles. Explicit legacy callers may still request a cap.
  if (!mesh.report.closed && policy.fillSmallHoles)
    mesh = validateOpenSheer(mesh, false);
  const changes: DisplayGeometry = {
    positions: new Float32Array(changed),
    bounds: { min: originalBounds.min, max: originalBounds.max },
    sources: Array.from({ length: changed.length / 9 }, () => ({
      kind: "synthetic",
      closure: "repair-preview",
      purpose: "repair",
    })),
  };
  return { mesh, report, changes };
}

/** Finite, increasing snap budgets. First fully valid repaired envelope wins.
 * This searches for a proposal, never records user acceptance or installs analysis. */
export function proposeMeshRepair(
  positions: ArrayLike<number>,
  physical: PhysicalSetup,
) {
  let last: unknown;
  for (const weldRelative of WELDS) {
    try {
      return repairMesh(positions, physical, {
        version: 2,
        weldRelative,
        fillSmallHoles: true,
      });
    } catch (e) {
      last = e;
    }
  }
  throw new Error(
    `No bounded repair found. Repair the mesh externally rather than increasing tolerances blindly. Last check: ${last instanceof Error ? last.message : String(last)}`,
  );
}
