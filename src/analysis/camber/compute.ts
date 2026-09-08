import { camberPlaneMesh } from "./planeMesh";
import { meshSection } from "../mesh/section";
import type { SectionRequest } from "../sections";
// Camber implementation of the phase-1 queries. The existing numerical routines are
// unchanged; one prepared sweep serves independently requested answers in the worker.
import { hydrostatics } from "../../core/hydro";
import { hullMetrics } from "../../core/hullMetrics";
import { unitScale } from "../../core/lengthUnits";
import {
  hullOutlines,
  sectionOutline,
  verticalSection,
} from "../../core/pointGeometry";
import { createSliceMeasurer } from "../../core/sheet/slices";
import {
  crossCurves,
  limitingKgCurve,
  stationGeometry,
} from "../../core/stability";
import {
  requestedHull,
  type HullComputationRequest,
} from "../../worker/hullComputation";
import {
  available,
  unavailable,
  type AnalysisQueries,
  type Available,
  type QueryKind,
  type QueryResult,
  type SliceQuery,
  type OutlineQuery,
} from "../api";
import { toSheet, type SliceMeasurement } from "../geometry";
import { scaleStability } from "../stabilityData";

export function createCamberComputation() {
  const assemblyCache = {};
  let prepared: ReturnType<typeof prepare> | null = null;
  function prepare(source: HullComputationRequest) {
    const { model, sampling } = requestedHull(source, assemblyCache);
    const values = new Map<QueryKind, Available<unknown>>();
    const cuts = new Map<string, Available<SliceMeasurement>>();
    // Lazily built: plain hull metrics don't need point outlines or a KN march.
    const getOutlines = () => {
      if (!values.has("outlines")) {
        const outlines = hullOutlines(model, sampling);
        values.set(
          "outlines",
          outlines
            ? available(outlines)
            : unavailable("The hull has no valid point-placement frame"),
        );
      }
      return values.get("outlines") as Available<
        NonNullable<ReturnType<typeof hullOutlines>>
      >;
    };
    let planeMesh: ReturnType<typeof camberPlaneMesh> | undefined;
    let planeFailure: string | undefined;
    let measurer: ReturnType<typeof createSliceMeasurer> | null = null;
    const measure = (query: SliceQuery): Available<SliceMeasurement> => {
      const key = JSON.stringify(query);
      const cached = cuts.get(key);
      if (cached) return cached;
      measurer ??= createSliceMeasurer(model, sampling);
      const raw = measurer(query.shape, query.position);
      const outlines = getOutlines();
      const value =
        raw && outlines.status === "available"
          ? available({
              ...raw,
              curve: raw.curve.map((p) => toSheet(outlines.value.frame, p)),
              centroid: toSheet(outlines.value.frame, raw.centroid),
            })
          : unavailable("The hull has no measurable cut at this position");
      if (cuts.size >= 256) cuts.delete(cuts.keys().next().value!);
      cuts.set(key, value);
      return value;
    };
    const compute = (
      kind: QueryKind,
      input: AnalysisQueries[QueryKind]["input"],
    ): Available<unknown> => {
      if (input === null && values.has(kind)) return values.get(kind)!;
      let result: Available<unknown>;
      switch (kind) {
        case "section": {
          if (planeFailure) return unavailable(planeFailure);
          if (!planeMesh) {
            try {
              planeMesh = camberPlaneMesh(model, sampling);
            } catch (reason) {
              planeFailure = `Camber plane envelope unavailable: ${reason instanceof Error ? reason.message : String(reason)}`;
              return unavailable(planeFailure);
            }
          }
          return meshSection(planeMesh, input as SectionRequest);
        }
        case "stability": {
          const curves = crossCurves(model, sampling);
          const geom = stationGeometry(model, sampling);
          const hydro = hydrostatics(model, sampling);
          result =
            curves && geom
              ? available(
                  scaleStability(
                    {
                      curves,
                      limit: limitingKgCurve(geom, curves),
                      hydro: hydro ? { vol: hydro.vol, kb: hydro.kb } : null,
                      lowestSheerKg: geom.lowestSheerZ - geom.keelZ,
                    },
                    unitScale(model.unit, "m"),
                  ),
                )
              : unavailable(
                  "The hull does not provide enough geometry to build stability curves",
                );
          break;
        }
        case "measurements": {
          const metrics = hullMetrics(model, sampling);
          result = metrics
            ? available(metrics)
            : unavailable("The hull cannot be measured");
          break;
        }
        case "outlines":
          return getOutlines();
        case "slices":
          return available((input as readonly SliceQuery[]).map(measure));
        case "sectionOutline": {
          const query = input as OutlineQuery;
          const outlines = getOutlines();
          if (outlines.status === "unavailable") return outlines;
          return available(
            query.kind === "station"
              ? sectionOutline(model, outlines.value.frame, {
                  k: "at",
                  x: query.x,
                })
              : verticalSection(sampling, outlines.value.frame, query.x),
          );
        }
      }
      values.set(kind, result);
      return result;
    };
    return { id: source.key, compute };
  }
  return <K extends QueryKind>(
    source: HullComputationRequest,
    kind: K,
    input: AnalysisQueries[K]["input"],
  ): QueryResult<AnalysisQueries[K]["output"]> => {
    if (prepared?.id !== source.key) prepared = prepare(source);
    return {
      contextId: source.key,
      result: prepared.compute(kind, input) as Available<
        AnalysisQueries[K]["output"]
      >,
    };
  };
}
