import {
  lookupRole,
  rollupsOf,
  type Field,
  type Item,
  type Rollup,
  type WeightBook,
} from "./book";
import { FormulaError, referenceNodesOf, type Node } from "./formula";
import { isOutputName, OUTPUTS } from "./outputs";
import { isRoleName, roleSpec } from "./roles";

/** Name binding is revision-local and independent of values, hulls, and trials.
 * operations.ts lowers these authored bindings into explicit cell reads, geometry
 * projections, and aggregates. Keep the authored path separate for editing.
 */
export type ReferenceBinding =
  | {
      readonly k: "field";
      readonly item: Item;
      readonly key: string;
      readonly field: Field;
      readonly leaf?: string;
    }
  | { readonly k: "output"; readonly name: string }
  | { readonly k: "hull"; readonly path: readonly string[] }
  | {
      readonly k: "rollup";
      readonly rollup: Rollup;
      readonly role: string;
      readonly leaf?: string;
    }
  | { readonly k: "error"; readonly message: string };

export interface BoundReference {
  readonly path: readonly string[];
  readonly at: number;
  readonly binding: ReferenceBinding;
}

export function createReferenceBinder(book: WeightBook) {
  const itemsByName = new Map(
    book.items.filter((i) => i.name).map((i) => [i.name, i]),
  );
  const rollups = new Map(rollupsOf(book).map((r) => [r.name, r]));
  const fail = (message: string): never => {
    throw new FormulaError(message);
  };
  const fieldBinding = (
    item: Item,
    key: string,
    field: Field,
    leaf?: string,
  ): ReferenceBinding => ({ k: "field", item, key, field, leaf });
  const roleBinding = (
    item: Item,
    role: string,
    after: readonly string[],
  ): ReferenceBinding => {
    const spec = roleSpec(role)!;
    const who = item.name || "this item";
    const found = lookupRole(item, role);
    if (found.k === "none")
      return fail(
        `${who} does not say which of its fields is its ${spec.label}`,
      );
    if (found.k === "many")
      return fail(
        `${who} tags ${found.keys.join(" and ")} as its ${spec.label} — only one of them can be`,
      );
    if (after.length > 1)
      return fail(`${role}.${after.join(".")} is one dot too deep`);
    return fieldBinding(item, found.key, found.field, after[0]);
  };
  const fromItem = (
    item: Item,
    rest: readonly string[],
    path: readonly string[],
  ): ReferenceBinding => {
    const key = rest[0];
    if (isRoleName(key)) return roleBinding(item, key, rest.slice(1));
    const field = item.fields[key];
    if (!field) {
      if (
        book.scenarioContext?.authoredItems.find((i) => i.id === item.id)
          ?.fields[key]
      )
        return fail(
          `${item.name}.${key} is unavailable in ${book.scenarioContext.name}`,
        );
      const near = Object.keys(item.fields).find(
        (candidate) => candidate.toLowerCase() === key.toLowerCase(),
      );
      return fail(
        `${item.name} has nothing called ${key}${near ? ` — did you mean ${near}?` : Object.keys(item.fields).length ? ` — it has ${Object.keys(item.fields).join(", ")}` : " — it has no fields yet"}`,
      );
    }
    if (rest.length > 2 && field.k !== "cut" && field.k !== "repetition")
      return fail(`${path.join(".")} is one dot too deep`);
    return fieldBinding(
      item,
      key,
      field,
      rest.length === 1 ? undefined : rest.slice(1).join("."),
    );
  };
  const bind = (
    path: readonly string[],
    owner: Item | null,
  ): ReferenceBinding => {
    const [head, ...rest] = path;
    if (head === "ROLLUP") {
      if (rest.length < 2 || rest.length > 3)
        return fail(`ROLLUP.${rest.join(".") || "?"} is not a roll-up value`);
      const rollup = rollups.get(rest[0]);
      if (!rollup) return fail(`there is no roll-up called ${rest[0]}`);
      return { k: "rollup", rollup, role: rest[1], leaf: rest[2] };
    }
    if (head === "HULL") {
      if (rest.length < 1 || rest.length > 2)
        return fail(`HULL.${rest.join(".") || "?"} is not a hull measurement`);
      return { k: "hull", path: rest };
    }
    if (head === "OUT") {
      if (rest.length !== 1)
        return fail(
          `OUT.${rest.join(".") || "?"} is not one of the book's answers`,
        );
      if (!isOutputName(rest[0]))
        return fail(
          `the book has no answer called ${rest[0]} — it has ${OUTPUTS.map((spec) => spec.name).join(", ")}`,
        );
      if (!(book.outputs[rest[0]] ?? "").trim())
        return fail(`nothing answers ${rest[0]} yet`);
      return { k: "output", name: rest[0] };
    }
    if (isRoleName(head)) {
      if (!owner)
        return fail(
          `${head} means "this item's ${roleSpec(head)!.label}", and an answer belongs to no item — name the item, as in engine.${head}`,
        );
      return roleBinding(owner, head, rest);
    }
    const sibling = owner?.fields[head];
    if (owner && sibling) {
      if (rest.length > 1 && sibling.k !== "cut" && sibling.k !== "repetition")
        return fail(`${path.join(".")} is one dot too deep`);
      return fieldBinding(
        owner,
        head,
        sibling,
        rest.length ? rest.join(".") : undefined,
      );
    }
    const authoredOwner =
      owner &&
      book.scenarioContext?.authoredItems.find((i) => i.id === owner.id);
    if (authoredOwner?.fields[head])
      return fail(
        `${owner!.name}.${head} is unavailable in ${book.scenarioContext!.name}`,
      );
    if (
      !itemsByName.has(head) &&
      book.scenarioContext?.authoredItems.some((i) => i.name === head)
    )
      return fail(`${head} is unavailable in ${book.scenarioContext.name}`);
    if (!rest.length) {
      const item = itemsByName.get(head);
      if (item)
        return fail(
          `${head} is an item — write ${head}.something${Object.keys(item.fields).length ? ` (it has ${Object.keys(item.fields).join(", ")})` : ""}`,
        );
      const near = owner
        ? Object.keys(owner.fields).find(
            (candidate) => candidate.toLowerCase() === head.toLowerCase(),
          )
        : undefined;
      return fail(
        `nothing here is called ${head}${near ? ` — did you mean ${near}?` : ""}`,
      );
    }
    const item = itemsByName.get(head);
    if (!item) return fail(`there is no item called ${head}`);
    return fromItem(item, rest, path);
  };
  return (
    tree: Node | null,
    owner: Item | null,
  ): ReadonlyMap<number, BoundReference> =>
    new Map(
      (tree ? referenceNodesOf(tree) : []).map(({ path, at }) => {
        let binding: ReferenceBinding;
        try {
          binding = bind(path, owner);
        } catch (error) {
          if (!(error instanceof FormulaError)) throw error;
          binding = { k: "error", message: error.message };
        }
        return [at, { path, at, binding }];
      }),
    );
}
