import { V, type Vec3 } from "../../core/math";
import {
  available,
  unavailable,
  type AnalysisQueries,
  type Available,
  type QueryKind,
  type QueryResult,
  type StabilityData,
} from "../api";
import {
  buildCrossCurves,
  buildInitialStability,
  type ImmersedBackend,
} from "../immersed";
import { createHullAnalysis, type QueryRunner } from "../queries";
import type { SectionRequest } from "../sections";
import { deckReference } from "./closure";
import { meshImmersion } from "./immersion";
import type { PreparedMesh } from "./prepare";
import { meshSection } from "./section";
import { buildTree } from "./spatial";
import { symmetricAboutCentreline } from "./symmetry";

export {
  meshContext,
  MESH_CAPABILITIES,
  type MeshAnalysisSetup,
} from "./setup";
import {
  meshContext,
  MESH_CAPABILITIES,
  type MeshAnalysisSetup,
} from "./setup";
export function meshBackend(
  mesh: PreparedMesh,
  setup: MeshAnalysisSetup,
): ImmersedBackend {
  const cr = Math.cos(setup.fixedTrim),
    sr = Math.sin(setup.fixedTrim);
  const rotate = (p: Vec3): Vec3 => [
    p[0] * cr - p[2] * sr,
    p[1],
    p[0] * sr + p[2] * cr,
  ];
  const vertices = mesh.vertices.map(rotate),
    upright = { ...mesh, vertices, tree: buildTree(vertices, mesh.faces) },
    sheer = deckReference(mesh).map(rotate);
  return {
    keelZ: setup.keelZ,
    omitImmersedReference: false,
    retainDryEndpoint: false,
    volumeEpsilon: mesh.report.tolerance ** 3,
    heightSpan: (heel) => {
      const n: Vec3 = [0, -Math.sin(heel), Math.cos(heel)];
      let lo = Infinity,
        hi = -Infinity;
      for (const p of vertices) {
        const h = V.dot(p, n);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      return [lo, hi];
    },
    at: (heel, wl, moments) => {
      const c = Math.cos(heel),
        s = Math.sin(heel),
        n: Vec3 = [0, -s, c];
      const im = meshImmersion(
        upright,
        { origin: V.scale(n, wl), u: [1, 0, 0], v: [0, c, s] },
        moments,
      );
      let sheerZ = NaN;
      if (sheer.length) {
        sheerZ = Infinity;
        for (const p of sheer) sheerZ = Math.min(sheerZ, V.dot(p, n));
      }
      const zB = im.centroid ? im.centroid[2] - setup.keelZ : 0,
        yB = im.centroid?.[1] ?? 0;
      const wp =
        im.waterplane?.status === "available"
          ? im.waterplane.value.measurements
          : null;
      return {
        vol: im.vol,
        yB,
        zB,
        kn: im.centroid ? yB * c + zB * s : 0,
        sheerZ,
        deckDown: Number.isFinite(sheerZ) ? wl > sheerZ : null,
        waterplane:
          wp?.area.status === "available" &&
          wp.area.value > mesh.report.tolerance ** 2 &&
          wp.moments.status === "available"
            ? { it: wp.moments.value.uu }
            : undefined,
      };
    },
  };
}
export function meshStability(
  mesh: PreparedMesh,
  setup: MeshAnalysisSetup,
): Available<StabilityData> {
  meshContext(setup);
  if (!mesh.report.closed)
    return unavailable(
      "Stability requires a confirmed closed buoyancy envelope",
    );
  if (!symmetricAboutCentreline(mesh))
    return unavailable(
      "The initial stability model requires a port/starboard-symmetric envelope about hull y=0",
    );
  const backend = meshBackend(mesh, setup),
    steps = setup.sinkageSteps ?? 32,
    curves = buildCrossCurves(backend, { steps }),
    limit = buildInitialStability(backend, curves);
  const reference = backend.at(0, setup.referenceWaterlineZ, true),
    valid = reference.vol > backend.volumeEpsilon! && !!reference.waterplane;
  const sheer = Number.isFinite(curves.sheerZ[0]);
  return available({
    curves,
    limit,
    hydro: valid ? { vol: reference.vol, kb: reference.zB } : null,
    lowestSheerKg: sheer ? curves.sheerZ[0] - setup.keelZ : NaN,
    availability: {
      sheer: sheer
        ? available(true)
        : unavailable("No sheer/deck-edge reference is annotated"),
      referenceWaterline: valid
        ? available(true)
        : unavailable("Reference waterline has no supported free waterplane"),
      downflooding: unavailable(
        "Openings and actual downflooding are not modelled",
      ),
    },
    assumptions: [
      "Fixed trim; symmetric envelope; centreline G; KG above the stated upright datum",
      "Closed numerical envelope, not a vessel safety certification",
      ...(sheer
        ? [
            "Synthetic deck closure is hypothetical after reference-edge immersion",
          ]
        : ["Sheer immersion is unknown, not never immersed"]),
    ],
    numerics: {
      method: "clipped signed tetrahedra; PCHIP sinkage interpolation",
      sinkageSteps: steps,
      triangles: mesh.faces.length,
      errorBound: null,
    },
  });
}
export function createMeshComputation(
  mesh: PreparedMesh,
  source: MeshAnalysisSetup,
) {
  const setup = structuredClone(source);
  meshContext(setup);
  let stability: Available<StabilityData> | undefined;
  return <K extends QueryKind>(
    kind: K,
    input: AnalysisQueries[K]["input"],
  ): QueryResult<AnalysisQueries[K]["output"]> => {
    let result: Available<unknown>;
    switch (kind) {
      case "section":
        result = meshSection(mesh, input as SectionRequest);
        break;
      case "stability":
        result = stability ??= meshStability(mesh, setup);
        break;
      default:
        result = unavailable(
          `${kind} is not implemented for mesh sources in the Phase 2 spike`,
        );
    }
    return {
      contextId: setup.id,
      result: result as Available<AnalysisQueries[K]["output"]>,
    };
  };
}
/** Worker-local/test composition. Browser hosts use the asset-once worker client. */
export function createMeshAnalysis(
  mesh: PreparedMesh,
  setup: MeshAnalysisSetup,
) {
  const compute = createMeshComputation(structuredClone(mesh), setup);
  const run: QueryRunner = async (kind, input) => compute(kind, input);
  return createHullAnalysis(meshContext(setup), run, MESH_CAPABILITIES);
}
