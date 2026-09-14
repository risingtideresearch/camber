import { meshMeasurements } from "./measurements";
import { meshProjection, meshDisplayGeometry } from "./projection";
import type { ProjectionRequest } from "../projections";
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
import { bounds, buildTree } from "./spatial";
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
    sheer = (
      mesh.report.openHydrostatics
        ? mesh.boundary[0].map((id) => mesh.vertices[id])
        : deckReference(mesh)
    ).map(rotate);
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
      if (mesh.report.openHydrostatics)
        for (const p of sheer) hi = Math.min(hi, V.dot(p, n));
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
interface SymmetryQuality {
  exact: boolean;
  acceptable: boolean;
  maximumDifference: number;
  summary: string;
}

/** STL tessellations almost never mirror to predicate tolerance. Judge whether
 * the resulting buoyancy is approximately symmetric instead of requiring every
 * reflected triangle to have nanometre-level matching coverage. */
function symmetryQuality(
  mesh: PreparedMesh,
  setup: MeshAnalysisSetup,
): SymmetryQuality {
  const exact = symmetricAboutCentreline(mesh);
  if (exact)
    return {
      exact,
      acceptable: true,
      maximumDifference: 0,
      summary: "Exact reflected surface coverage",
    };
  const box = bounds(mesh.vertices),
    beam = box.max[1] - box.min[1],
    backend = meshBackend(mesh, setup),
    differences: number[] = [];
  if (!(beam > mesh.report.tolerance))
    return {
      exact,
      acceptable: false,
      maximumDifference: Infinity,
      summary: "The envelope has no usable transverse extent",
    };
  differences.push(Math.abs(box.min[1] + box.max[1]) / beam);
  const uprightSpan = backend.heightSpan(0),
    representativeHeight = mesh.report.openHydrostatics
      ? (uprightSpan[0] + uprightSpan[1]) / 2
      : uprightSpan[1] + (uprightSpan[1] - uprightSpan[0]),
    representative = backend.at(0, representativeHeight);
  if (representative.vol > (backend.volumeEpsilon ?? 0))
    differences.push(Math.abs(representative.yB) / beam);
  for (const angle of [Math.PI / 6, (40 * Math.PI) / 180]) {
    const port = backend.heightSpan(-angle),
      starboard = backend.heightSpan(angle),
      lo = Math.max(port[0], starboard[0]),
      hi = Math.min(port[1], starboard[1]);
    for (const fraction of [0.25, 0.5, 0.75]) {
      const waterline = lo + (hi - lo) * fraction,
        a = backend.at(angle, waterline).vol,
        b = backend.at(-angle, waterline).vol,
        mean = (a + b) / 2;
      if (mean > (backend.volumeEpsilon ?? 0))
        differences.push(Math.abs(a - b) / mean);
    }
  }
  const maximumDifference = Math.max(...differences);
  // This is a model applicability tolerance, not a geometry error bound. Larger
  // asymmetry needs a two-sided/asymmetric stability model rather than more STL repair.
  const acceptable = maximumDifference <= 0.05;
  return {
    exact,
    acceptable,
    maximumDifference,
    summary: `${(maximumDifference * 100).toPrecision(2)}% maximum centreline/±30°/40° buoyancy discrepancy`,
  };
}

export function meshStability(
  mesh: PreparedMesh,
  setup: MeshAnalysisSetup,
): Available<StabilityData> {
  meshContext(setup);
  if (!mesh.report.closed && !mesh.report.openHydrostatics)
    return unavailable(
      mesh.report.envelopeError ??
        "Stability requires a closed envelope or validated open sheer",
    );
  const symmetry = symmetryQuality(mesh, setup);
  if (!symmetry.acceptable)
    return unavailable(
      `The centreline-symmetric stability model does not support this envelope (${symmetry.summary}; limit 5.0%)`,
    );
  const backend = meshBackend(mesh, setup),
    steps = setup.sinkageSteps ?? 32,
    curves = buildCrossCurves(backend, { steps }),
    limit = buildInitialStability(backend, curves);
  let reference: ReturnType<typeof backend.at> | null = null;
  try {
    if (setup.referenceWaterlineZ !== undefined)
      reference = backend.at(0, setup.referenceWaterlineZ, true);
  } catch {
    // An authored reference above an open rim does not invalidate lower,
    // pre-immersion cross curves.
  }
  const valid =
    !!reference &&
    reference.vol > backend.volumeEpsilon! &&
    !!reference.waterplane;
  const sheer = Number.isFinite(curves.sheerZ[0]);
  return available({
    curves,
    limit,
    hydro: valid ? { vol: reference!.vol, kb: reference!.zB } : null,
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
      "Fixed trim; symmetric-envelope approximation; centreline G; KG above the stated upright datum",
      mesh.report.openHydrostatics
        ? "Validated open sheer; each heel row stops at first rim immersion"
        : "Closed numerical envelope, not a vessel safety certification",
      ...(!symmetry.exact
        ? [
            `Approximately symmetric STL accepted (${symmetry.summary}; both heel directions are not independently modelled)`,
          ]
        : []),
      ...(mesh.report.repair
        ? [
            "Bounded mesh repairs applied; small-hole patches are not downflooding or deck references",
          ]
        : []),
      ...(mesh.report.openHydrostatics
        ? [
            "No deck cap is added; states at and beyond open-rim immersion are unavailable",
          ]
        : sheer
          ? [
              "Synthetic sheer closure is hypothetical after reference-edge immersion",
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
      case "measurements":
        result = available(meshMeasurements(mesh, setup));
        break;
      case "project":
        result = meshProjection(mesh, input as ProjectionRequest);
        break;
      case "displayGeometry":
        result = available(meshDisplayGeometry(mesh));
        break;
      case "section":
        result = mesh.report.envelopeError
          ? unavailable(
              `Measured sections require supported surface topology: ${mesh.report.envelopeError}`,
            )
          : meshSection(mesh, input as SectionRequest);
        break;
      case "stability":
        result = stability ??= meshStability(mesh, setup);
        break;
      default:
        result = unavailable(
          `${kind} is a legacy Camber geometry query; use physical section/project queries for mesh sources`,
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
