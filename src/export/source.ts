import type { HullState } from "../core/hull";
import { buildJson } from "../core/json";
import type { ExportSource } from "./types";

/** Serialize immediately so later edits cannot affect any export type. */
export function captureCurrentHull(
  hull: HullState,
  name: string,
  modelId?: string,
): ExportSource {
  const exportName = name || hull.name;
  return {
    name: exportName,
    json: buildJson({ ...hull, name: exportName }),
    ...(modelId ? { modelId } : {}),
  };
}

/** Preserve the saved document's version and fields for JSON; other writers parse/convert it. */
export function captureSavedHull(
  document: unknown,
  name: string,
  modelId: string,
): ExportSource {
  return { name, json: JSON.stringify(document, null, 2), modelId };
}
