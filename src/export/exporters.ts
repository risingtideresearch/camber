import {
  buildHydrostaticTable,
  type HydrostaticExportOptions,
} from "../core/hydrostaticExport";
import { parseHullState } from "../core/json";
import { assemble } from "../core/runtime";
import { buildStep } from "../core/step";
import { buildStl } from "../core/stl";
import type { ExportArtifact, ExportOptions, ExportRequest } from "./types";
import { safeExportName } from "./filename";

export function hydrostaticOptions(
  options: Extract<ExportOptions, { format: "hydrostatics" }>,
  designTrimDeg: number,
  generatedAt: string,
  modelId?: string,
): HydrostaticExportOptions {
  const step = options.fine ? 2.5 : 5;
  return {
    heelDeg:
      options.coverage === "upright"
        ? [0]
        : Array.from({ length: 360 / step + 1 }, (_, i) => -180 + i * step),
    trimDeg:
      options.coverage === "upright"
        ? [0]
        : options.coverage === "fixed"
          ? [designTrimDeg]
          : [-5, 0, 5, designTrimDeg],
    immersionSteps: options.fine ? 128 : 64,
    numSections: options.fine ? 400 : 240,
    girthSteps: options.fine ? 16 : 10,
    generatedAt,
    ...(modelId ? { modelId } : {}),
  };
}

/** Pure writers used by the shared worker, independently testable without browser APIs. */
export function buildExport(
  { source, options, generatedAt }: ExportRequest,
  progress?: (completedRows: number, totalRows: number) => void,
): ExportArtifact {
  const name = safeExportName(source.name);
  if (options.format === "json") {
    return {
      filename: `${name}.json`,
      text: source.json,
      mime: "application/json",
    };
  }
  const state = { ...parseHullState(source.json), name: source.name };
  const model = assemble(state);
  switch (options.format) {
    case "step":
      return {
        filename: `${name}.step`,
        text: buildStep(model, generatedAt.replace(/\.\d+Z$/, "")),
        mime: "application/step",
      };
    case "stl":
      return {
        filename: `${name}.stl`,
        text: buildStl(model, name, options.surfaces),
        mime: "model/stl",
      };
    case "hydrostatics": {
      const table = buildHydrostaticTable(
        model,
        hydrostaticOptions(
          options,
          (state.deckTrim * 180) / Math.PI,
          generatedAt,
          source.modelId,
        ),
        progress,
      );
      return {
        filename: `${name}.hydrostatics.json`,
        text: JSON.stringify(table, null, 2),
        mime: "application/json",
      };
    }
  }
}
