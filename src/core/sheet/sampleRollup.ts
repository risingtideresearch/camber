import { cellKey } from "./addresses";
import { lookupRole, type Item, type WeightBook } from "./book";
import { sameDim } from "./quantity";
import { roleLeaves } from "./rollups";
import { roleSpec } from "./roles";
import type { SamplingTarget } from "./sampling";
import type { Trial, TrialValue } from "./trial";

/** A transient report total is not a book cell. Identify it by its actual members, not by a view name. */
export interface SampleRollup {
  readonly itemIds: readonly string[];
  readonly role: string;
  readonly leaf: "value" | "x" | "y" | "z";
}

export const rollupSampleKey = (rollup: SampleRollup): string =>
  JSON.stringify([
    "role-total",
    [...rollup.itemIds].sort(),
    rollup.role,
    rollup.leaf,
  ]);

export function prepareSampleRollup(book: WeightBook, rollup: SampleRollup) {
  const spec = roleSpec(rollup.role);
  if (
    !spec ||
    spec.aggregation.k === "none" ||
    !roleLeaves(spec).includes(rollup.leaf)
  )
    throw new Error("Unknown roll-up role or coordinate");
  if (new Set(rollup.itemIds).size !== rollup.itemIds.length)
    throw new Error("Duplicate roll-up members");
  const items = rollup.itemIds.map((id) => {
    const item = book.items.find((entry) => entry.id === id);
    if (!item) throw new Error(`Unknown roll-up member: ${id}`);
    return item;
  });
  const weightSpec =
    spec.aggregation.k === "weightedMean"
      ? roleSpec(spec.aggregation.weight)
      : null;
  if (spec.aggregation.k === "weightedMean" && !weightSpec)
    throw new Error("Unknown roll-up weight role");

  const members = items.map((item) => ({
    item,
    value: lookupRole(item, spec.name),
    weight: weightSpec ? lookupRole(item, weightSpec.name) : null,
  }));
  const keys = members.flatMap(({ item, value, weight }) => {
    const keys: string[] = [];
    if (value.k === "one")
      for (const leaf of roleLeaves(spec))
        keys.push(
          cellKey(item.id, value.key, leaf === "value" ? "formula" : leaf),
        );
    if (weight?.k === "one") keys.push(cellKey(item.id, weight.key));
    return keys;
  });
  const failure = (error: string): TrialValue => ({
    value: null,
    dim: spec.dim,
    error,
  });
  const read = (
    item: Item,
    found: ReturnType<typeof lookupRole>,
    leaf: SampleRollup["leaf"],
    dim: typeof spec.dim,
    values: ReadonlyMap<string, TrialValue>,
  ): number | string | null => {
    if (found.k === "none") return null;
    if (found.k === "many")
      return `${item.name || "unnamed item"}: multiple ${leaf} roles`;
    if (!(
      (leaf === "value" && found.field.k === "scalar") ||
      (leaf !== "value" && found.field.k === "point")
    ))
      return `${item.name || "unnamed item"}: invalid role field`;
    const key = cellKey(
      item.id,
      found.key,
      leaf === "value" ? "formula" : leaf,
    );
    const cell = values.get(key);
    if (
      !cell ||
      cell.error ||
      cell.value === null ||
      !Number.isFinite(cell.value) ||
      !cell.dim ||
      !sameDim(cell.dim, dim)
    )
      return `${item.name || "unnamed item"}: ${cell?.error ?? "invalid role value"}`;
    return cell.value;
  };
  return {
    keys,
    evaluate(values: ReadonlyMap<string, TrialValue>): TrialValue {
      let total = 0,
        weightSum = 0,
        contributors = 0;
      for (const { item, value, weight } of members) {
        if (weightSpec) {
          const mass = read(item, weight!, "value", weightSpec.dim, values);
          if (typeof mass === "string") return failure(mass);
          if (mass === null) continue;
          // A point contributes as one semantic value: a bad y or z excludes x too.
          const components = roleLeaves(spec).map((leaf) => ({
            leaf,
            value: read(item, value, leaf, spec.dim, values),
          }));
          const issue = components.find(
            (component) => typeof component.value === "string",
          );
          if (issue && typeof issue.value === "string")
            return failure(issue.value);
          const coordinate = components.find(
            (component) => component.leaf === rollup.leaf,
          )!.value;
          if (coordinate === null) continue;
          if (typeof coordinate !== "number") return failure(coordinate);
          total += mass * coordinate;
          weightSum += mass;
          contributors++;
        } else {
          const scalar = read(item, value, rollup.leaf, spec.dim, values);
          if (typeof scalar === "string") return failure(scalar);
          if (scalar === null) continue;
          total += scalar;
          contributors++;
        }
      }
      if (!contributors) return failure(`${spec.name} has no contributors`);
      if (weightSpec && weightSum === 0)
        return failure(`${spec.name} has zero total ${weightSpec.name}`);
      const result = weightSpec ? total / weightSum : total;
      return Number.isFinite(result)
        ? { value: result, dim: spec.dim, error: null }
        : failure("Non-finite roll-up total");
    },
  };
}

/** Add virtual report outputs to the worker's cached, lazily evaluated trial cells. */
export function sampleTargets(
  book: WeightBook,
  targets: readonly SamplingTarget[],
  evaluateCells: (
    trial: Trial,
    keys: readonly string[],
  ) => ReadonlyMap<string, TrialValue>,
) {
  const rollups = new Map(
    targets.flatMap((target) =>
      target.rollup
        ? [[target.cellKey, prepareSampleRollup(book, target.rollup)] as const]
        : [],
    ),
  );
  if (!rollups.size) return evaluateCells;
  return (
    trial: Trial,
    keys: readonly string[],
  ): ReadonlyMap<string, TrialValue> => {
    const dependencies = keys.flatMap((key) => rollups.get(key)?.keys ?? [key]);
    const cells = evaluateCells(trial, [...new Set(dependencies)]);
    const out = new Map(cells);
    for (const key of keys) {
      const rollup = rollups.get(key);
      if (rollup) out.set(key, rollup.evaluate(cells));
    }
    return out;
  };
}
