// Worker-owned source and dependency-keyed derived geometry. Opening only parses:
// surface cleanup, envelope validation, repair search and integration are lazy.
import { parseStl } from "../core/stlImport";
import {
  physicalPoints,
  prepareMesh,
  prepareSurfaceMesh,
  type PreparedMesh,
} from "../analysis/mesh/prepare";
import { validateOpenSheer } from "../analysis/mesh/closure";
import {
  repairMesh,
  patchPreparedMesh,
  proposeMeshRepair,
  type RepairPolicy,
  type RepairReport,
} from "../analysis/mesh/repair";
import { bounds } from "../analysis/mesh/spatial";
import { meshDisplayGeometry } from "../analysis/mesh/projection";
import { createMeshComputation, meshStability } from "../analysis/mesh/compute";
import { meshMeasurements } from "../analysis/mesh/measurements";
import {
  available,
  unavailable,
  type AnalysisQueries,
  type QueryKind,
  type Available,
  type StabilityData,
} from "../analysis/api";
import {
  analysisSetup,
  physicalSetup,
  message,
  type Configuration,
  type Inspection,
} from "./setup";

export type EngineAction =
  | { type: "preview" }
  | { type: "validate" }
  | { type: "repair"; policy?: RepairPolicy }
  | {
      type: "query";
      kind: QueryKind;
      input: AnalysisQueries[QueryKind]["input"];
      envelope?: boolean;
    };

export class WorkspaceEngine {
  private raw: ReturnType<typeof parseStl>;
  private variants = new Map<
    string,
    {
      surface?: PreparedMesh;
      topology?: PreparedMesh;
      envelope?: PreparedMesh;
      automaticPatches?: RepairReport;
    }
  >();
  private curves = new Map<string, Available<StabilityData>>();
  readonly stats = { parses: 1, surfaces: 0, validations: 0, stability: 0 };
  constructor(bytes: ArrayBuffer) {
    this.raw = parseStl(bytes);
  }

  run(c: Configuration, action: EngineAction): unknown {
    const physical = physicalSetup({
      ...c,
      metresPerUnit: c.metresPerUnit || 1,
    });
    if (action.type === "preview") {
      const points = physicalPoints(this.raw.positions, physical);
      return {
        geometry: {
          positions: new Float32Array(points.flat()),
          bounds: bounds(points),
          sources: [],
        },
      } satisfies Inspection;
    }
    if (!c.metresPerUnit) {
      if (action.type === "query")
        return unavailable("Set the hull scale to use physical geometry.");
      throw new Error("Set the hull scale first.");
    }
    const key = JSON.stringify({
      physical,
      repair: c.repair,
      autoPatchSmallHoles: c.autoPatchSmallHoles !== false,
    });
    let variant = this.variants.get(key);
    if (!variant) {
      if (this.variants.size >= 3)
        this.variants.delete(this.variants.keys().next().value!);
      variant = {};
      this.variants.set(key, variant);
    }
    const topology = () => {
      if (!variant.topology) {
        this.stats.validations++;
        let mesh: PreparedMesh;
        try {
          mesh = c.repair
            ? repairMesh(this.raw.positions, physical, c.repair).mesh
            : prepareMesh(this.raw.positions, physical, { allowOpen: true });
        } catch (e) {
          // Never silently claim that a persisted repair was applied successfully.
          if (c.repair) throw e;
          mesh = prepareSurfaceMesh(
            this.raw.positions,
            physical,
            {},
            message(e),
          );
        }
        variant.topology = mesh;
      }
      return variant.topology;
    };
    const envelope = () => {
      if (!variant.envelope) {
        const source = topology();
        let mesh = { ...source, report: { ...source.report } };
        if (!mesh.report.closed && !mesh.report.envelopeError) {
          try {
            mesh = validateOpenSheer(mesh);
          } catch (e) {
            mesh.report.envelopeError = message(e);
          }
        }
        // Only cap gaps on otherwise valid topology, and only if the original
        // envelope failed. Do not launch the escalating weld/cleanup search.
        if (
          mesh.report.envelopeError &&
          !source.report.envelopeError &&
          !c.repair &&
          c.autoPatchSmallHoles !== false &&
          source.boundary.length
        ) {
          try {
            const result = patchPreparedMesh(source);
            if (result.report.holes.length) {
              const candidate = result.mesh.report.closed
                ? result.mesh
                : validateOpenSheer(result.mesh);
              if (!candidate.report.envelopeError) {
                mesh = candidate;
                variant.automaticPatches = result.report;
              }
            }
          } catch {
            // Leave the original failure actionable; never loosen numerical gates.
          }
        }
        variant.envelope = mesh;
      }
      return variant.envelope;
    };
    if (action.type === "repair") {
      const result = action.policy
        ? repairMesh(this.raw.positions, physical, action.policy)
        : proposeMeshRepair(this.raw.positions, physical);
      const preparedTopology = result.mesh;
      result.mesh = { ...result.mesh, report: { ...result.mesh.report } };
      if (!result.mesh.report.closed) {
        try {
          result.mesh = validateOpenSheer(result.mesh);
        } catch (e) {
          result.mesh.report.envelopeError = message(e);
        }
      }
      // Accepting exactly this proposal reuses its validated geometry.
      const repairedKey = JSON.stringify({
        physical,
        repair: result.report.policy,
        autoPatchSmallHoles: c.autoPatchSmallHoles !== false,
      });
      if (this.variants.size >= 3)
        this.variants.delete(this.variants.keys().next().value!);
      this.variants.set(repairedKey, {
        topology: preparedTopology,
        envelope: result.mesh,
      });
      return {
        geometry: meshDisplayGeometry(result.mesh),
        report: result.mesh.report,
        repair: result.report,
        changes: result.changes,
      } satisfies Inspection;
    }
    if (action.type === "validate") {
      const mesh = envelope();
      return {
        report: mesh.report,
        geometry: meshDisplayGeometry(mesh),
        automaticPatches: variant.automaticPatches,
      } satisfies Inspection;
    }
    const needsFrame = action.kind !== "measurements" || action.envelope;
    if (needsFrame && !c.frameConfirmed)
      return unavailable("Apply the hull scale and coordinates in Hull.");
    const mesh =
      action.envelope || action.kind === "stability"
        ? envelope()
        : action.kind === "section"
          ? topology()
          : (variant.surface ??= (() => {
              this.stats.surfaces++;
              return prepareSurfaceMesh(this.raw.positions, physical);
            })());
    const setup = analysisSetup(c, "workspace").analysis;
    if (action.kind === "stability") {
      const curveKey = JSON.stringify({
        key,
        trim: setup.fixedTrim,
        datum: setup.keelZ,
      });
      let result = this.curves.get(curveKey);
      if (!result) {
        this.stats.stability++;
        result = meshStability(mesh, {
          ...setup,
          referenceWaterlineZ: undefined,
        });
        if (this.curves.size >= 3)
          this.curves.delete(this.curves.keys().next().value!);
        this.curves.set(curveKey, result);
      }
      if (
        result.status === "available" &&
        setup.referenceWaterlineZ !== undefined
      ) {
        const metrics = meshMeasurements(mesh, setup);
        const valid =
          Number.isFinite(metrics.dispVol) && Number.isFinite(metrics.kb);
        return {
          ...result,
          value: {
            ...result.value,
            hydro: valid ? { vol: metrics.dispVol, kb: metrics.kb } : null,
            availability: {
              ...result.value.availability!,
              referenceWaterline: valid
                ? { status: "available", value: true }
                : unavailable(
                    "No supported reference waterplane at this height",
                  ),
            },
          },
        };
      }
      return result;
    }
    if (action.kind === "measurements") {
      const metrics = meshMeasurements(mesh, setup);
      if (!c.frameConfirmed) {
        return available({
          ...metrics,
          loa: NaN,
          shellLcg: NaN,
          shellTcg: NaN,
          shellVcg: NaN,
          unavailable: {
            ...metrics.unavailable,
            ...Object.fromEntries(
              ["LOA", "SHELL_CG", "SHELL_LCG", "SHELL_VCG"].map((name) => [
                name,
                "Apply hull coordinates to use positions or longitudinal extents",
              ]),
            ),
          },
        });
      }
      return available(metrics);
    }
    return createMeshComputation(mesh, setup)(action.kind, action.input).result;
  }
}
