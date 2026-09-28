import { OUTPUT_ITEM } from "./addresses";
import { activeBoundaries } from "./boundaries";
import {
  facetContains,
  leavesOf,
  lookupRole,
  type CutField,
  type Field,
  type Item,
  type RepetitionField,
  type WeightBook,
} from "./book";
import type { ReferenceBinding } from "./bindings";
import { FormulaError } from "./formula";
import { isHullPointName } from "../hullMetrics";
import type { Dim } from "./quantity";
import { roleSpec } from "./roles";
import { CG_NAMES, GEOMETRY_LEAVES } from "./sectionMeasures";

export interface CellOperation {
  readonly k: "cell";
  readonly itemId: string;
  readonly fieldKey: string;
  readonly leaf: string;
}
export interface ErrorOperation {
  readonly k: "error";
  readonly message: string;
}
export interface GeometryOperation {
  readonly item: Item;
  readonly key: string;
  readonly field: CutField | RepetitionField;
  readonly boundaries: Readonly<ReturnType<typeof activeBoundaries>>;
  readonly inputs: readonly CellOperation[];
}
export interface MeasureOperation {
  readonly k: "measure";
  readonly geometry: GeometryOperation;
  readonly leaf: string;
}
export type ValueOperation =
  | CellOperation
  | ErrorOperation
  | MeasureOperation
  | { readonly k: "hull"; readonly path: readonly string[] }
  | {
      readonly k: "sum";
      readonly dim: Dim;
      readonly terms: readonly (CellOperation | ErrorOperation)[];
    }
  | {
      readonly k: "weightedMean";
      readonly weightDim: Dim;
      readonly zeroMessage: string;
      readonly entries: readonly (
        | {
            readonly k: "entry";
            readonly weight: CellOperation;
            readonly value: CellOperation;
          }
        | ErrorOperation
      )[];
    };

const cell = (
  itemId: string,
  fieldKey: string,
  leaf = "formula",
): CellOperation => ({ k: "cell", itemId, fieldKey, leaf });
const fail = (message: string): never => {
  throw new FormulaError(message);
};
const capture = <T>(compile: () => T): T | ErrorOperation => {
  try {
    return compile();
  } catch (error) {
    if (!(error instanceof FormulaError)) throw error;
    return { k: "error", message: error.message };
  }
};
const isAxis = (leaf: string | undefined): leaf is "x" | "y" | "z" =>
  leaf === "x" || leaf === "y" || leaf === "z";

/** Lower revision-local bindings into value operations. No numeric evaluation,
 * geometry requests, or random draws occur here. Errors remain lazy operations
 * so preparation does not change formula evaluation/error precedence.
 */
export function createOperationCompiler(book: WeightBook) {
  const geometries = new Map<string, GeometryOperation>();
  const geometry = (
    item: Item,
    key: string,
    field: CutField | RepetitionField,
  ): GeometryOperation => {
    const id = JSON.stringify([item.id, key]);
    let operation = geometries.get(id);
    if (!operation) {
      operation = {
        item,
        key,
        field,
        boundaries: activeBoundaries(field),
        inputs: leavesOf(field).map((leaf) => cell(item.id, key, leaf)),
      };
      geometries.set(id, operation);
    }
    return operation;
  };
  const measure = (
    item: Item,
    key: string,
    field: CutField | RepetitionField,
    leaf: string,
  ): MeasureOperation => ({
    k: "measure",
    geometry: geometry(item, key, field),
    leaf,
  });
  const fieldValue = (
    item: Item,
    key: string,
    field: Field,
    leaf: string | undefined,
    axis: string,
  ): ValueOperation => {
    if (leaf === undefined) {
      if (field.k === "scalar") return cell(item.id, key);
      if (field.k !== "repetition" && isAxis(axis)) leaf = axis;
      else {
        const leaves =
          field.k === "cut"
            ? ["pos", "area", "closedPerimeter", "openPerimeter", "x", "y", "z"]
            : leavesOf(field);
        return fail(
          `${item.name}.${key} is a ${field.k} — write ${item.name}.${key}.${leaves[0]}${leaves.length > 1 ? ` (or .${leaves.slice(1).join(", .")})` : ""}`,
        );
      }
    }
    if (field.k === "scalar")
      return fail(
        `${item.name}.${key} is a single value — .${leaf} is one dot too deep`,
      );
    if ((leavesOf(field) as readonly string[]).includes(leaf))
      return cell(item.id, key, leaf);
    if (field.k === "point")
      return fail(
        `a point has no ${leaf} — try .${leavesOf(field).join(", .")}`,
      );
    if ((CG_NAMES as readonly string[]).includes(leaf)) {
      if (!isAxis(axis))
        return fail(`${leaf} is a point — write .x, .y, or .z`);
      leaf += `.${axis}`;
    }
    const aliases: Record<string, string> = {
      openPerimeter: "openLength",
      closedPerimeter: "closedLength",
      x: "areaCg.x",
      y: "areaCg.y",
      z: "areaCg.z",
    };
    if (field.k === "cut") leaf = aliases[leaf] ?? leaf;
    if (
      !GEOMETRY_LEAVES.includes(leaf) &&
      !(field.k === "repetition" && leaf === "equivalentCount")
    )
      return fail(
        `a ${field.k} has no ${leaf} — choose area, openLength, closedLength, or their Cg coordinates`,
      );
    return measure(item, key, field, leaf);
  };
  const compile = (binding: ReferenceBinding, axis: string): ValueOperation => {
    switch (binding.k) {
      case "error":
        return binding;
      case "output":
        return cell(OUTPUT_ITEM, binding.name);
      case "field":
        return fieldValue(
          binding.item,
          binding.key,
          binding.field,
          binding.leaf,
          axis,
        );
      case "hull":
        return {
          k: "hull",
          path:
            binding.path.length === 1 &&
            isHullPointName(binding.path[0]) &&
            isAxis(axis)
              ? [binding.path[0], axis]
              : binding.path,
        };
      case "rollup": {
        const { rollup, role, leaf } = binding;
        const spec = roleSpec(role);
        if (!spec) return fail(`there is no role called ${role}`);
        const members = book.items.filter((item) =>
          facetContains(rollup.facetValue, item.facets[rollup.facetKey] ?? ""),
        );
        const claimed = (item: Item, name: string) => {
          const found = lookupRole(item, name);
          if (found.k === "many")
            return fail(
              `${item.name || "an unnamed item"} tags ${found.keys.join(" and ")} as ${name}`,
            );
          return found.k === "one" ? found : null;
        };
        if (spec.aggregation.k === "sum") {
          if (leaf) return fail(`${rollup.name}.${role} is a single value`);
          const terms = members.flatMap((item) => {
            const term = capture(() => {
              const found = claimed(item, role);
              if (!found) return null;
              if (found.field.k !== "scalar")
                return fail(
                  `${item.name}.${found.key} cannot be summed as ${role}`,
                );
              return cell(item.id, found.key);
            });
            return term ? [term] : [];
          });
          if (!terms.length)
            return fail(`${rollup.name}.${role} has no contributors`);
          return { k: "sum", dim: spec.dim, terms };
        }
        if (spec.aggregation.k !== "weightedMean")
          return fail(`${role} has no roll-up aggregation`);
        if (leaf !== undefined && !isAxis(leaf))
          return fail(
            `${rollup.name}.${role} has no ${leaf} — write .x, .y, or .z`,
          );
        const coordinate = leaf ?? axis;
        if (!isAxis(coordinate))
          return fail(
            `${rollup.name}.${role} is a place — write .x, .y, or .z`,
          );
        const weightName = spec.aggregation.weight;
        const entries = members.flatMap((item) => {
          const entry = capture(() => {
            const weight = claimed(item, weightName);
            if (!weight) return null;
            if (weight.field.k !== "scalar")
              return fail(`${item.name}.${weight.key} cannot weight ${role}`);
            const target = claimed(item, role);
            if (!target)
              return fail(
                `${rollup.name}.${role} is incomplete: ${item.name || "an unnamed item"} has ${weightName} but no ${role}`,
              );
            if (target.field.k !== "point")
              return fail(`${item.name}.${target.key} is not a point`);
            return {
              k: "entry" as const,
              weight: cell(item.id, weight.key),
              value: cell(item.id, target.key, coordinate),
            };
          });
          return entry ? [entry] : [];
        });
        if (!entries.length)
          return fail(`${rollup.name}.${role} has no contributors`);
        return {
          k: "weightedMean",
          weightDim: roleSpec(weightName)!.dim,
          zeroMessage: `${rollup.name}.${role} has zero total ${weightName}`,
          entries,
        };
      }
    }
  };
  return {
    measure,
    reference: (binding: ReferenceBinding, axis: string): ValueOperation =>
      capture(() => compile(binding, axis)),
  };
}
