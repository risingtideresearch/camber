import type {
  MarineGeometry,
  PointM,
  Triangle,
  SurfaceRegion,
} from "@risingtideresearch/chartroom/formats/marine-geometry/v1";
import type { Model } from "./model";
import { unitScale } from "./json";
import { computeHullSampling } from "./mesh";
import { orientedHullTriangles } from "./sheet/orientedMesh";
export interface MarineGeometryExportOptions {
  numSections?: number;
  girthSteps?: number;
  generatedAt?: string;
  modelId?: string;
}
/** Capture complete deck-fixed geometry. Convert units and reverse y/winding once;
 * the design attitude remains metadata, never a pose baked into the vertices. */
export function buildMarineGeometry(
  model: Model,
  options: MarineGeometryExportOptions = {},
): MarineGeometry {
  const numSections = options.numSections ?? 80,
    girthSteps = options.girthSteps ?? 6;
  if (
    !Number.isInteger(numSections) ||
    numSections < 8 ||
    numSections > 1000 ||
    !Number.isInteger(girthSteps) ||
    girthSteps < 2 ||
    girthSteps > 64
  )
    throw new Error("Invalid marine geometry mesh resolution");
  const scale = unitScale(model.unit, "m"),
    sampling = computeHullSampling(model, numSections, girthSteps),
    source = orientedHullTriangles(sampling);
  const verticesM: PointM[] = [],
    triangles: Triangle[] = [],
    ids = new Map<string, number>();
  const partition: Record<string, number[]> = {
    shell: [],
    transom: [],
    "sheer-cap": [],
    "aft-cap": [],
  };
  const vertex = (p: PointM) => {
    const point: PointM = [p[0] * scale, -p[1] * scale, p[2] * scale],
      key = point.join(",");
    let id = ids.get(key);
    if (id === undefined) {
      id = verticesM.length;
      ids.set(key, id);
      verticesM.push(point);
    }
    return id;
  };
  for (const face of source) {
    const [a, b, c] = face.points;
    partition[face.surface ?? "shell"].push(triangles.length);
    triangles.push([vertex(a), vertex(c), vertex(b)]);
  }
  if (!triangles.length) throw new Error("Hull has no exportable surface");
  const regions: SurfaceRegion[] = [];
  for (const id of ["shell", "transom", "sheer-cap", "aft-cap"] as const)
    if (partition[id].length) {
      const common = {
        id,
        name:
          id === "shell"
            ? "Hull shell"
            : id === "transom"
              ? "Transom"
              : id === "sheer-cap"
                ? "Idealized sheer cap"
                : "Idealized aft cap",
        triangleIndices: partition[id],
      };
      regions.push(
        id === "sheer-cap" || id === "aft-cap"
          ? {
              ...common,
              representation: "idealized",
              description:
                id === "sheer-cap"
                  ? "Straight closure ladders across the open sheer, for a closed analysis volume; not an authored physical deck."
                  : "Straight closure ladders across the natural aft end of the swept sheet where it ends forward of the transom plane; not an authored physical transom.",
            }
          : { ...common, representation: "physical" },
      );
    }
  const refs = regions.map((r) => ({ meshId: "hull-mesh", regionId: r.id }));
  return {
    format: "marine-geometry",
    version: 1,
    ...(model.name ? { name: model.name } : {}),
    frame: {
      axes: "x-forward-y-port-z-up",
      originDescription:
        "Original Camber deck-fixed origin, converted to metres; x forward, y port, z up. No translation or design rotation applied.",
    },
    meshes: [{ id: "hull-mesh", verticesM, triangles, regions }],
    bodies: [{ id: "hull", kind: "hull", regions: refs, centerplaneYM: 0 }],
    envelopes: [
      {
        id: "hull-envelope",
        bodyId: "hull",
        boundary: "closed-watertight",
        description:
          "Sampled mirrored hull shell plus physical transom where present, an idealized cap across the sheer and an idealized aft cap where the swept sheet ends forward of the transom plane; no openings, thickness, appendages or flooding model.",
        regions: refs,
      },
    ],
    referenceState: {
      heelDeg: 0,
      trimDeg: (model.deckTrim * 180) / Math.PI,
      waterplaneOffsetM: -model.waterline * scale,
    },
    source: {
      tool: "Camber",
      method: `Trimmed indexed triangle mesh: ${numSections} longitudinal sections, ${girthSteps} girth subdivisions per span. Exact shared producer coordinates are indexed; normals follow outward winding.`,
      ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
    },
    notes: [
      "Experimental Chartroom marine-geometry v1. Physical shell and transom are separate selections; idealized sheer and aft analysis caps are not shell plating.",
      "Sampled geometry, not a continuous hull reconstruction or a convergence certificate. Compare mesh resolutions for the intended estimate.",
      "No weight book, loading condition, construction stations or named reference geometry is included.",
    ],
  };
}
