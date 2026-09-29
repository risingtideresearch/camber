import type { WeightBook } from "./book";
import {
  appliesTo,
  scenariosOf,
  type Applicability,
  type FieldPatch,
} from "./scenarios";

/** Authored changes, not computed result differences or a replayable edit log.
 * A future transfer planner must check targets, prerequisites and destination conflicts
 * before applying selected entries in one transaction. Targets use current field keys, not
 * durable identities; these entries must not be retained across edits. Equal-valued overrides are retained.
 */
export type ScenarioDifference =
  | {
      readonly k: "membership";
      readonly item: string;
      readonly fieldKey?: string;
      readonly label: string;
      readonly included: boolean;
      readonly applicability: Applicability;
    }
  | {
      readonly k: "override";
      readonly item: string;
      readonly fieldKey: string;
      readonly label: string;
      readonly property: keyof FieldPatch;
      readonly shared: FieldPatch[keyof FieldPatch];
      readonly value: FieldPatch[keyof FieldPatch];
      readonly active: boolean;
    };

export function scenarioDiff(
  book: WeightBook,
  scenarioId: string,
): ScenarioDifference[] {
  if (!scenariosOf(book).some((s) => s.id === scenarioId))
    throw new Error("Unknown scenario");
  const differences: ScenarioDifference[] = [];
  for (const item of book.items) {
    const included = appliesTo(item.applicability, scenarioId);
    const label = item.name || "Unnamed item";
    if (item.applicability?.k === "only")
      differences.push({
        k: "membership",
        item: item.id,
        label,
        included,
        applicability: item.applicability,
      });
    for (const [key, field] of Object.entries(item.fields)) {
      const fieldLabel = `${label}.${key}`;
      if (field.applicability?.k === "only")
        differences.push({
          k: "membership",
          item: item.id,
          fieldKey: key,
          label: fieldLabel,
          included: included && appliesTo(field.applicability, scenarioId),
          applicability: field.applicability,
        });
      for (const property of Object.keys(
        field.overrides?.[scenarioId] ?? {},
      ).sort() as (keyof FieldPatch)[]) {
        differences.push({
          k: "override",
          item: item.id,
          fieldKey: key,
          label: `${fieldLabel}.${property}`,
          property,
          shared: (field as FieldPatch)[property],
          value: field.overrides![scenarioId][property],
          active: included && appliesTo(field.applicability, scenarioId),
        });
      }
    }
  }
  return differences;
}
