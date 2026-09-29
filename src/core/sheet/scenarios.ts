import type {
  Field,
  FieldLeaf,
  Item,
  SheetCommand,
  SheetOutcome,
  SliceShape,
  WeightBook,
} from "./book";
import { interpretSheetCommand, isSliceShape, leafOf } from "./book";
import { BOUNDARIES, isBoundaryLeaf, type BoundaryFields } from "./boundaries";

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly note: string;
}
export type Applicability =
  | { readonly k: "all" }
  | {
      readonly k: "only";
      readonly scenarios: readonly string[];
      readonly shared?: boolean;
    };
export type SheetEditScope =
  | { readonly k: "shared" }
  | { readonly k: "scenario"; readonly scenarioId: string };

/** Only authored inputs may vary. Names, kinds, roles and units are shared. */
export interface FieldPatch extends BoundaryFields {
  readonly formula?: string;
  readonly x?: string;
  readonly y?: string;
  readonly z?: string;
  readonly from?: string;
  readonly pos?: string;
  readonly start?: string;
  readonly end?: string;
  readonly spacing?: string;
  readonly count?: string;
  readonly shape?: SliceShape;
  readonly repetition?: "spacing" | "count";
}
export interface ScenarioFieldMetadata {
  readonly applicability?: Applicability;
  readonly overrides?: Readonly<Record<string, FieldPatch>>;
}
/** Reserved runtime identity; Shared is implicit and never stored as a named scenario. */
export const SHARED_WORKSPACE = "__shared__";
export const scenariosOf = (book: WeightBook): readonly Scenario[] =>
  book.scenarios ?? [];
export const appliesTo = (
  rule: Applicability | undefined,
  id: string | null,
): boolean =>
  !rule ||
  rule.k === "all" ||
  (id === null ? rule.shared === true : rule.scenarios.includes(id));

export function applyFieldPatch(
  field: Field,
  patch: FieldPatch | undefined,
): Field {
  if (!patch) return field;
  return {
    ...field,
    ...patch,
    ...((field.k === "cut" || field.k === "repetition") && patch.boundaryEnabled
      ? {
          boundaryEnabled: {
            ...field.boundaryEnabled,
            ...patch.boundaryEnabled,
          },
        }
      : {}),
  } as Field;
}

/** Reject rather than silently accepting properties which the field cannot use. */
export function patchViolation(field: Field, patch: FieldPatch): string | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return "invalid field override";
  for (const [key, value] of Object.entries(patch)) {
    if (key === "shape") {
      if (
        (field.k !== "cut" && field.k !== "repetition") ||
        typeof value !== "string" ||
        !isSliceShape(value)
      )
        return "invalid override orientation";
    } else if (key === "repetition") {
      if (
        field.k !== "repetition" ||
        (value !== "count" && value !== "spacing")
      )
        return "invalid override repetition mode";
    } else if (key === "boundaryEnabled") {
      if (
        (field.k !== "cut" && field.k !== "repetition") ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([leaf, enabled]) =>
            !isBoundaryLeaf(leaf) || typeof enabled !== "boolean",
        )
      )
        return "invalid override boundaries";
    } else if (
      typeof value !== "string" ||
      leafOf(field, key as FieldLeaf) === null
    )
      return `invalid override property: ${key}`;
  }
  return null;
}

export type ScenarioCommand =
  | { type: "addScenario"; id: string; name: string; source?: string }
  | { type: "renameScenario"; id: string; name: string }
  | { type: "removeScenario"; id: string }
  | {
      type: "setApplicability";
      item: string;
      fieldKey?: string;
      applicability: Applicability;
    }
  | {
      type: "setScenarioPatch";
      scenarioId: string;
      item: string;
      fieldKey: string;
      patch: FieldPatch;
    }
  | {
      type: "resetScenarioOverrides";
      scenarioId: string;
      targets: readonly {
        item: string;
        fieldKey: string;
        property?: keyof FieldPatch;
      }[];
    };

export const SCENARIO_COMMAND_TYPES = {
  addScenario: 1,
  renameScenario: 1,
  removeScenario: 1,
  setApplicability: 1,
  setScenarioPatch: 1,
  resetScenarioOverrides: 1,
} as const;
export const isScenarioCommand = (
  command: SheetCommand,
): command is ScenarioCommand => command.type in SCENARIO_COMMAND_TYPES;
export const isScenarioLocalCommand = (command: SheetCommand): boolean =>
  [
    "addItem",
    "removeItem",
    "addField",
    "removeField",
    "setFieldFormula",
    "setPointPosition",
    "setCutShape",
    "setSectionBoundary",
    "setRepetitionMode",
  ].includes(command.type);

export function applicabilityViolation(
  rule: Applicability | undefined,
  ids: readonly string[],
): string | null {
  if (!rule) return null;
  if (rule.k === "all") return null;
  if (
    rule.k !== "only" ||
    !Array.isArray(rule.scenarios) ||
    rule.scenarios.some((id) => !ids.includes(id)) ||
    (rule.shared !== undefined && typeof rule.shared !== "boolean") ||
    new Set(rule.scenarios).size !== rule.scenarios.length
  )
    return "invalid scenario membership";
  return null;
}

function editTarget(
  book: WeightBook,
  itemId: string,
  fieldKey: string | undefined,
  edit: (value: Item | Field) => Item | Field,
): SheetOutcome {
  const item = book.items.find((i) => i.id === itemId);
  if (!item) return { rejected: "no such item" };
  const key = fieldKey;
  if (
    key !== undefined &&
    !Object.prototype.hasOwnProperty.call(item.fields, key)
  )
    return { rejected: "no such field" };
  const next =
    key === undefined
      ? (edit(item) as Item)
      : {
          ...item,
          fields: { ...item.fields, [key]: edit(item.fields[key]) as Field },
        };
  return {
    book: { ...book, items: book.items.map((i) => (i === item ? next : i)) },
  };
}

export function interpretScenarioCommand(
  book: WeightBook,
  command: ScenarioCommand,
): SheetOutcome {
  const scenarios = scenariosOf(book);
  const ids = scenarios.map((s) => s.id);
  switch (command.type) {
    case "addScenario": {
      const name = command.name.trim();
      if (
        !command.id ||
        command.id === SHARED_WORKSPACE ||
        ids.includes(command.id) ||
        !name ||
        scenarios.some((s) => s.name === name)
      )
        return { rejected: "a scenario needs a unique ID and name" };
      if (command.source && !ids.includes(command.source))
        return { rejected: "no such source scenario" };
      const include = (
        rule: Applicability | undefined,
      ): Applicability | undefined =>
        command.source && rule?.k === "only" && appliesTo(rule, command.source)
          ? { ...rule, scenarios: [...rule.scenarios, command.id] }
          : rule;
      return {
        book: {
          ...book,
          scenarios: [...scenarios, { id: command.id, name, note: "" }],
          items: book.items.map((item) => ({
            ...item,
            applicability: include(item.applicability),
            fields: Object.fromEntries(
              Object.entries(item.fields).map(([key, field]) => [
                key,
                {
                  ...field,
                  applicability: include(field.applicability),
                  ...(command.source && field.overrides?.[command.source]
                    ? {
                        overrides: {
                          ...field.overrides,
                          [command.id]: structuredClone(
                            field.overrides[command.source],
                          ),
                        },
                      }
                    : {}),
                },
              ]),
            ),
          })),
        },
      };
    }
    case "renameScenario": {
      const name = command.name.trim();
      if (
        !ids.includes(command.id) ||
        !name ||
        scenarios.some((s) => s.id !== command.id && s.name === name)
      )
        return { rejected: "a scenario needs a unique name" };
      return {
        book: {
          ...book,
          scenarios: scenarios.map((s) =>
            s.id === command.id ? { ...s, name } : s,
          ),
        },
      };
    }
    case "removeScenario": {
      if (!ids.includes(command.id)) return { rejected: "no such scenario" };
      const remove = (
        rule: Applicability | undefined,
      ): Applicability | undefined =>
        rule?.k === "only"
          ? {
              ...rule,
              scenarios: rule.scenarios.filter((id) => id !== command.id),
            }
          : rule;
      return {
        book: {
          ...book,
          scenarios: scenarios.filter((s) => s.id !== command.id),
          items: book.items.map((item) => ({
            ...item,
            applicability: remove(item.applicability),
            fields: Object.fromEntries(
              Object.entries(item.fields).map(([key, field]) => {
                const overrides = { ...field.overrides };
                delete overrides[command.id];
                return [
                  key,
                  {
                    ...field,
                    applicability: remove(field.applicability),
                    overrides,
                  },
                ];
              }),
            ),
          })),
        },
      };
    }
    case "setApplicability": {
      const error = applicabilityViolation(command.applicability, ids);
      return error
        ? { rejected: error }
        : editTarget(book, command.item, command.fieldKey, (value) => ({
            ...value,
            applicability: command.applicability,
          }));
    }
    case "setScenarioPatch": {
      if (!ids.includes(command.scenarioId))
        return { rejected: "no such scenario" };
      const item = book.items.find((i) => i.id === command.item);
      const key = command.fieldKey;
      if (!item || !Object.prototype.hasOwnProperty.call(item.fields, key))
        return { rejected: "no such field" };
      if (
        !appliesTo(item.applicability, command.scenarioId) ||
        !appliesTo(item.fields[key].applicability, command.scenarioId)
      )
        return { rejected: "include the item and field before editing" };
      const error = patchViolation(item.fields[key], command.patch);
      if (error) return { rejected: error };
      return editTarget(book, command.item, command.fieldKey, (value) => {
        const field = value as Field;
        const previous = field.overrides?.[command.scenarioId];
        return {
          ...field,
          overrides: {
            ...field.overrides,
            [command.scenarioId]: {
              ...previous,
              ...command.patch,
              ...(command.patch.boundaryEnabled
                ? {
                    boundaryEnabled: {
                      ...previous?.boundaryEnabled,
                      ...command.patch.boundaryEnabled,
                    },
                  }
                : {}),
            },
          },
        };
      });
    }
    case "resetScenarioOverrides": {
      if (!ids.includes(command.scenarioId))
        return { rejected: "no such scenario" };
      let next = book;
      for (const target of command.targets) {
        if (typeof target.fieldKey !== "string" || !target.fieldKey)
          return { rejected: "no such field" };
        const outcome = editTarget(
          next,
          target.item,
          target.fieldKey,
          (value) => {
            const field = value as Field;
            const overrides = { ...field.overrides };
            const patch = { ...overrides[command.scenarioId] };
            if (target.property) delete patch[target.property];
            if (!target.property || !Object.keys(patch).length)
              delete overrides[command.scenarioId];
            else overrides[command.scenarioId] = patch;
            return { ...field, overrides };
          },
        );
        if ("rejected" in outcome) return outcome;
        next = outcome.book;
      }
      return { book: next };
    }
  }
}

/** Existing UI commands are interpreted in a captured workspace, never ambient UI state. */
export function interpretScopedCommand(
  book: WeightBook,
  command: SheetCommand,
  scenarioId: string,
): SheetOutcome {
  if (!scenariosOf(book).some((s) => s.id === scenarioId))
    return { rejected: "no such scenario" };
  if (!isScenarioLocalCommand(command))
    return {
      rejected: "this is a shared setting; edit it in Shared assumptions",
    };
  const sharedCommand = { ...command, scope: undefined };
  if (command.type === "addItem" || command.type === "addField") {
    const added = interpretSheetCommand(book, sharedCommand);
    if ("rejected" in added) return added;
    const itemId = command.type === "addItem" ? command.id : command.item;
    return interpretScenarioCommand(added.book, {
      type: "setApplicability",
      item: itemId,
      ...(command.type === "addField"
        ? {
            fieldKey: command.key.trim().replace(/\s+/g, " "),
          }
        : {}),
      applicability: { k: "only", scenarios: [scenarioId] },
    });
  }
  if (!("item" in command)) return { rejected: "no target" };
  const item = book.items.find((i) => i.id === command.item);
  if (!item) return { rejected: "no such item" };
  const key =
    "field" in command
      ? command.field
      : "key" in command
        ? command.key
        : undefined;
  const field = key ? item.fields[key] : undefined;
  if (command.type === "removeItem" || command.type === "removeField") {
    if (command.type === "removeField" && !field)
      return { rejected: "no such field" };
    const rule = field ? field.applicability : item.applicability;
    return interpretScenarioCommand(book, {
      type: "setApplicability",
      item: item.id,
      ...(key ? { fieldKey: key } : {}),
      applicability: {
        k: "only",
        ...(appliesTo(rule, null) ? { shared: true } : {}),
        scenarios: scenariosOf(book)
          .filter((s) => s.id !== scenarioId && appliesTo(rule, s.id))
          .map((s) => s.id),
      },
    });
  }
  if (!field || !key) return { rejected: "no such field" };
  // Validate geometry-specific commands against the effective inputs, using the existing reducer.
  const effective = applyFieldPatch(field, field.overrides?.[scenarioId]);
  const validation = interpretSheetCommand(
    {
      ...book,
      items: book.items.map((i) =>
        i === item
          ? { ...item, fields: { ...item.fields, [key]: effective } }
          : i,
      ),
    },
    sharedCommand,
  );
  if ("rejected" in validation) return validation;
  let patch: FieldPatch;
  switch (command.type) {
    case "setFieldFormula":
      patch = { [command.leaf]: command.formula };
      break;
    case "setPointPosition":
      patch = Object.fromEntries(
        (["x", "y", "z"] as const)
          .filter((axis) => command[axis] !== undefined)
          .map((axis) => [axis, command[axis]]),
      );
      break;
    case "setCutShape":
      patch = { shape: command.shape };
      break;
    case "setRepetitionMode":
      patch = { repetition: command.repetition };
      break;
    case "setSectionBoundary":
      patch = { boundaryEnabled: { [command.leaf]: command.enabled } };
      break;
    default:
      return { rejected: "unsupported scenario edit" };
  }
  return interpretScenarioCommand(book, {
    type: "setScenarioPatch",
    scenarioId,
    item: item.id,
    fieldKey: key,
    patch,
  });
}

export function scenarioViolations(book: WeightBook): string[] {
  const errors: string[] = [];
  const scenarios = scenariosOf(book),
    ids = scenarios.map((s) => s.id);
  if (
    new Set(ids).size !== ids.length ||
    scenarios.some(
      (s) =>
        typeof s.id !== "string" ||
        !s.id ||
        s.id === SHARED_WORKSPACE ||
        typeof s.name !== "string" ||
        !s.name.trim(),
    ) ||
    new Set(scenarios.map((s) => s.name)).size !== scenarios.length
  )
    errors.push("invalid scenario registry");
  for (const item of book.items) {
    const membershipError = applicabilityViolation(item.applicability, ids);
    if (membershipError) errors.push(membershipError);
    for (const field of Object.values(item.fields)) {
      const membershipError = applicabilityViolation(field.applicability, ids);
      if (membershipError) errors.push(membershipError);
      for (const [scenarioId, patch] of Object.entries(field.overrides ?? {})) {
        if (!ids.includes(scenarioId))
          errors.push("override references unknown scenario");
        const error = patchViolation(field, patch);
        if (error) errors.push(error);
      }
    }
  }
  return errors;
}

/** Formula-valued properties, including dormant geometry inputs, for rename and matrix editing. */
export const formulaProperties = (field: Field): readonly FieldLeaf[] => {
  switch (field.k) {
    case "scalar":
      return ["formula"];
    case "point":
      return ["x", "y", "z", "from"];
    case "cut":
      return ["pos", ...BOUNDARIES.map((b) => b.leaf)];
    case "repetition":
      return [
        "start",
        "end",
        "spacing",
        "count",
        ...BOUNDARIES.map((b) => b.leaf),
      ];
  }
};
