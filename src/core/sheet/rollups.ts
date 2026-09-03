// ---------- role-based facet roll-ups ----------
//
// A facet says WHICH items belong in a report; roles say WHAT comparable value each item contributes. The
// resulting totals deliberately remain a report rather than a formula namespace, so refiling an item still
// cannot change any calculation in the book.

import { leavesOf, lookupRole, type FieldLeaf, type Item } from "./book";
import { resultAt, type BookResults, type CellResult } from "./evaluate";
import {
  add,
  div,
  exact,
  mul,
  read,
  sameDim,
  type Quantity,
  type Reading,
} from "./quantity";
import { ROLES, roleSpec, type RoleSpec } from "./roles";

export type RollupLeaf = "value" | "x" | "y" | "z";

/** The columns a role contributes. A point is one semantic value shown as its three coordinates. */
export const roleLeaves = (spec: RoleSpec): readonly RollupLeaf[] =>
  spec.kinds.includes("point") ? ["x", "y", "z"] : ["value"];

export type ItemRoleResult =
  | { readonly k: "none" }
  | {
      readonly k: "error";
      readonly fieldKey: string | null;
      readonly message: string;
    }
  | {
      readonly k: "value";
      readonly fieldKey: string;
      readonly cells: Readonly<Record<RollupLeaf, CellResult>>;
    };

/** Resolve one item's role to evaluated cells, without pretending that an absent role is an error. */
export function itemRoleResult(
  item: Item,
  spec: RoleSpec,
  results: BookResults,
): ItemRoleResult {
  const found = lookupRole(item, spec.name);
  if (found.k === "none") return { k: "none" };
  if (found.k === "many")
    return {
      k: "error",
      fieldKey: null,
      message: `${found.keys.join(" and ")} both claim ${spec.name}`,
    };

  const expected = roleLeaves(spec);
  const fieldLeaves = leavesOf(found.field);
  const cells: Partial<Record<RollupLeaf, CellResult>> = {};
  for (const leaf of expected) {
    const fieldLeaf: FieldLeaf = leaf === "value" ? fieldLeaves[0] : leaf;
    const cell = resultAt(results, item.id, found.key, fieldLeaf);
    const problem = cell?.error ?? cell?.unitWarning;
    if (problem) return { k: "error", fieldKey: found.key, message: problem };
    if (!cell?.quantity || !cell.reading || cell.empty)
      return {
        k: "error",
        fieldKey: found.key,
        message: `${spec.name} has no value`,
      };
    if (!sameDim(cell.quantity.dim, spec.dim))
      return {
        k: "error",
        fieldKey: found.key,
        message: `${spec.name} has the wrong dimension`,
      };
    cells[leaf] = cell;
  }
  return {
    k: "value",
    fieldKey: found.key,
    cells: cells as Readonly<Record<RollupLeaf, CellResult>>,
  };
}

export interface RoleTotal {
  readonly role: string;
  readonly values: Readonly<Partial<Record<RollupLeaf, Quantity>>>;
  readonly readings: Readonly<Partial<Record<RollupLeaf, Reading>>>;
  readonly contributors: number;
  /** Problems on fields which claimed this role. An item with no such role is simply not a contributor. */
  readonly issues: readonly string[];
  /** For a weighted mean, how much valid weight was included and how much existed in all. */
  readonly coverage: {
    readonly included: Quantity;
    readonly total: Quantity;
  } | null;
}

const sum = (values: readonly Quantity[], dim: RoleSpec["dim"]): Quantity =>
  values.reduce(add, exact(0, dim));

const quantitiesOf = (
  result: ItemRoleResult,
  leaves: readonly RollupLeaf[],
): Quantity[] | null =>
  result.k === "value"
    ? leaves.map((leaf) => result.cells[leaf].quantity!)
    : null;

/** Aggregate every role for one set of items, preserving gradients so totals retain their spread. */
export function roleTotals(
  items: readonly Item[],
  results: BookResults,
): ReadonlyMap<string, RoleTotal> {
  const out = new Map<string, RoleTotal>();
  // The catalogue is closed; weighted-role references resolve through the same catalogue.
  for (const spec of ROLES) {
    const name = spec.name;
    const leaves = roleLeaves(spec);
    const resolved = items.map((item) => ({
      item,
      value: itemRoleResult(item, spec, results),
    }));
    const issues = resolved.flatMap(({ item, value }) =>
      value.k === "error"
        ? [`${item.name || "unnamed item"}: ${value.message}`]
        : [],
    );
    const values: Partial<Record<RollupLeaf, Quantity>> = {};
    let contributors = 0;
    let coverage: RoleTotal["coverage"] = null;

    if (spec.aggregation.k === "sum") {
      const valid = resolved.flatMap(({ value }) => {
        const quantities = quantitiesOf(value, leaves);
        return quantities ? [quantities] : [];
      });
      contributors = valid.length;
      for (let i = 0; i < leaves.length; i++)
        values[leaves[i]] = sum(
          valid.map((entry) => entry[i]),
          spec.dim,
        );
    } else if (spec.aggregation.k === "weightedMean") {
      const weightSpec = roleSpec(spec.aggregation.weight);
      if (weightSpec) {
        const weighted: { target: Quantity[]; weight: Quantity }[] = [];
        const allWeights: Quantity[] = [];
        for (const { item, value } of resolved) {
          const weight = itemRoleResult(item, weightSpec, results);
          const weightQuantities = quantitiesOf(weight, roleLeaves(weightSpec));
          if (!weightQuantities) {
            if (weight.k === "error")
              issues.push(
                `${item.name || "unnamed item"}: ${weightSpec.name} ${weight.message}`,
              );
            continue;
          }
          const scalarWeight = weightQuantities[0];
          allWeights.push(scalarWeight);
          const target = quantitiesOf(value, leaves);
          if (target) weighted.push({ target, weight: scalarWeight });
        }
        contributors = weighted.length;
        const totalWeight = sum(allWeights, weightSpec.dim);
        const includedWeight = sum(
          weighted.map((entry) => entry.weight),
          weightSpec.dim,
        );
        coverage = { included: includedWeight, total: totalWeight };
        if (weighted.length && includedWeight.v !== 0)
          for (let i = 0; i < leaves.length; i++) {
            const moments = weighted.map((entry) =>
              mul(entry.weight, entry.target[i]),
            );
            values[leaves[i]] = div(
              moments.reduce(add, exact(0, moments[0].dim)),
              includedWeight,
            );
          }
      }
    }

    out.set(name, {
      role: name,
      values,
      readings: Object.fromEntries(
        Object.entries(values).map(([leaf, quantity]) => [
          leaf,
          read(quantity, results.sources),
        ]),
      ),
      contributors,
      issues,
      coverage,
    });
  }
  return out;
}
