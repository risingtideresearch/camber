import { FUNCTIONS } from "../../core/sheet/formula";
import { HULL_METRICS, HULL_POINTS } from "../../core/hullMetrics";
import {
  lookupRole,
  rollupsOf,
  type FieldLeaf,
  type Item,
  type WeightBook,
} from "../../core/sheet/book";
import { OUTPUTS } from "../../core/sheet/outputs";
import { ROLES } from "../../core/sheet/roles";
import { SLICE_VALUE_FIELDS } from "../../core/sheet/slices";

// ---------- what a formula can mention, offered as you type ----------
//
// A schedule refers to its neighbours by name, and the names are the user's own — so the only way to know
// what is available is to be told. This builds the list from the very tables the evaluator resolves against,
// which is what keeps it from drifting: a hull measurement that exists is offered, and one that is offered
// exists.
//
// Two things decide what is on the list. The ITEM the formula is written on, because its own fields are
// reachable bare and everything else needs the item's name in front of it; and the LEAF, because a bare
// point resolves only in a coordinate cell and offering it anywhere else would complete straight into the
// evaluator's "write engine.cg.x" refusal.
//
// The tricky part is finding the FRAGMENT being completed, because names may contain spaces. Scanning back
// over "name characters" would stop at the first space and never complete `hull sh|`. So the scan instead
// runs back to the nearest thing that certainly is not part of a name — an operator, a bracket, a comma —
// and offers what follows it, trimmed.

export interface Completion {
  readonly insert: string;
  readonly kind: "sibling" | "item" | "hull" | "function";
  readonly hint: string;
}

const KIND_ORDER: Record<Completion["kind"], number> = {
  sibling: 0,
  item: 1,
  hull: 2,
  function: 3,
};

/** True where a bare point or cut resolves — a cell that already says which coordinate it wants. */
export const isCoordinate = (leaf: FieldLeaf): boolean =>
  leaf === "x" || leaf === "y" || leaf === "z";

/**
 * Everything nameable that does NOT depend on which item the formula is written on.
 *
 * Split out because it is the expensive half and it is the same for every cell: building the whole list per
 * row would be quadratic in the size of the book, and a schedule is exactly the thing that grows. The cheap
 * half — the item's own fields, reachable bare — is `siblingCompletions`, and the two are concatenated at
 * the cell.
 */
export function globalCompletions(
  book: WeightBook,
  coordinate: boolean,
): Completion[] {
  const out: Completion[] = [];

  const offer = (
    prefix: string,
    key: string,
    kind: Completion["kind"],
    fieldKind: string,
    where: string,
  ): void => {
    const base = `${prefix}${key}`;
    if (fieldKind === "scalar") {
      out.push({ insert: base, kind, hint: where });
      return;
    }
    if (fieldKind === "point") {
      // The bare form comes first in a coordinate cell, because that is the form the interesting formula
      // uses — a centre of gravity names each point once, not three times.
      if (coordinate)
        out.push({
          insert: base,
          kind,
          hint: `${key}${where ? ` ${where}` : ""}, in this cell's coordinate`,
        });
      for (const axis of ["x", "y", "z"] as const)
        out.push({
          insert: `${base}.${axis}`,
          kind,
          hint: `${axis} of ${key}`,
        });
      return;
    }
    // A cut has a position of its own — the centroid of what it cuts — so in a coordinate cell it binds like
    // a point does, and an area-weighted centre of several sections is one expression.
    if (coordinate)
      out.push({
        insert: base,
        kind,
        hint: `centroid of ${key}, in this cell's coordinate`,
      });
    for (const measure of ["pos", ...SLICE_VALUE_FIELDS])
      out.push({
        insert: `${base}.${measure}`,
        kind,
        hint: `${measure} of ${key}`,
      });
  };

  for (const other of book.items) {
    if (!other.name) continue;
    const where = other.facets.system ? `in ${other.facets.system}` : "";
    for (const [key, field] of Object.entries(other.fields))
      offer(`${other.name}.`, key, "item", field.k, where);
    // A role is offered only where it RESOLVES — one field tagged, not none and not two — which is the rule
    // this whole module keeps: what is offered exists, and what exists is offered.
    for (const spec of ROLES) {
      const found = lookupRole(other, spec.name);
      if (found.k !== "one") continue;
      offer(
        `${other.name}.`,
        spec.name,
        "item",
        found.field.k,
        `its ${spec.label}, ${found.key}`,
      );
    }
  }

  for (const rollup of rollupsOf(book))
    for (const spec of ROLES) {
      const base = `ROLLUP.${rollup.name}.${spec.name}`;
      const where = `${spec.label} of ${rollup.facetKey}: ${rollup.facetValue}`;
      if (spec.kinds.includes("point")) {
        if (coordinate)
          out.push({
            insert: base,
            kind: "item",
            hint: `${where}, in this coordinate`,
          });
        for (const axis of ["x", "y", "z"] as const)
          out.push({
            insert: `${base}.${axis}`,
            kind: "item",
            hint: `${axis} of ${where}`,
          });
      } else out.push({ insert: base, kind: "item", hint: where });
    }

  for (const spec of OUTPUTS)
    if ((book.outputs[spec.name] ?? "").trim())
      out.push({
        insert: `OUT.${spec.name}`,
        kind: "item",
        hint: spec.hint,
      });

  for (const spec of HULL_METRICS)
    out.push({ insert: `HULL.${spec.name}`, kind: "hull", hint: spec.hint });
  for (const spec of HULL_POINTS) {
    // Bare where it resolves — a coordinate cell — and by its leaves everywhere else, the same shape a point
    // field and a cut centroid are offered in.
    if (coordinate)
      out.push({
        insert: `HULL.${spec.name}`,
        kind: "hull",
        hint: `${spec.hint}, in this cell's coordinate`,
      });
    for (const axis of ["x", "y", "z"] as const)
      out.push({
        insert: `HULL.${spec.name}.${axis}`,
        kind: "hull",
        hint: `${axis} of the ${spec.label}`,
      });
  }
  for (const [name, spec] of Object.entries(FUNCTIONS))
    out.push({ insert: `${name}(`, kind: "function", hint: spec.hint });
  return out;
}

/**
 * The item's own fields, which is what a bare name means.
 *
 * First in the list because the scope you are standing in is the one you meant — the same rule the evaluator
 * resolves by, so what is offered and what resolves cannot drift apart.
 */
export function siblingCompletions(
  item: Item | null,
  coordinate: boolean,
): Completion[] {
  const out: Completion[] = [];
  if (!item) return out;
  // The item's own roles come first of all: `MASS` is the shortest true thing this cell can say, and it goes
  // on being true when the field it reads gets renamed.
  for (const spec of ROLES) {
    const found = lookupRole(item, spec.name);
    if (found.k !== "one") continue;
    if (found.field.k === "point") {
      if (coordinate)
        out.push({
          insert: spec.name,
          kind: "sibling",
          hint: `this item's ${spec.label} (${found.key}), in this cell's coordinate`,
        });
      for (const axis of ["x", "y", "z"] as const)
        out.push({
          insert: `${spec.name}.${axis}`,
          kind: "sibling",
          hint: `${axis} of this item's ${spec.label} (${found.key})`,
        });
      continue;
    }
    out.push({
      insert: spec.name,
      kind: "sibling",
      hint: `this item's ${spec.label} (${found.key})`,
    });
  }
  for (const [key, field] of Object.entries(item.fields)) {
    if (field.k === "scalar") {
      out.push({ insert: key, kind: "sibling", hint: "on this item" });
      continue;
    }
    if (coordinate)
      out.push({
        insert: key,
        kind: "sibling",
        hint: `${key}, in this cell's coordinate`,
      });
    const leaves =
      field.k === "point" ? ["x", "y", "z"] : ["pos", ...SLICE_VALUE_FIELDS];
    for (const leaf of leaves)
      out.push({
        insert: `${key}.${leaf}`,
        kind: "sibling",
        hint: `${leaf} of ${key}`,
      });
  }
  return out;
}

/** Everything nameable from a cell on `item`. The two halves, joined. */
export const completionsFor = (
  book: WeightBook,
  item: Item | null,
  leaf: FieldLeaf = "formula",
): Completion[] => [
  ...siblingCompletions(item, isCoordinate(leaf)),
  ...globalCompletions(book, isCoordinate(leaf)),
];

/** Where the name being typed starts. −1 when the caret is not in one. */
export function fragmentStart(source: string, caret: number): number {
  let i = caret;
  while (i > 0) {
    const c = source[i - 1];
    // Anything the language uses as punctuation certainly ends a name. A space does not, because names have
    // them — so a fragment may carry trailing spaces, and the filter below trims.
    if ("+-*/^(),%±×−–[]".includes(c)) break;
    i--;
  }
  return i;
}

const score = (candidate: string, query: string): number => {
  const c = candidate.toLowerCase(),
    q = query.toLowerCase();
  if (!q) return 1;
  if (c.startsWith(q)) return 3;
  // A word inside the name starting with the query — `shell` finds `hull shell`.
  if (new RegExp(`(^|[ .])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(c))
    return 2;
  return c.includes(q) ? 1 : 0;
};

export interface Suggest {
  readonly items: readonly Completion[];
  readonly query: string;
  readonly from: number;
}

/** The suggestions for a caret position, best first, or null when there is nothing worth showing. */
export function suggestAt(
  all: readonly Completion[],
  source: string,
  caret: number,
): Suggest | null {
  const from = fragmentStart(source, caret);
  const raw = source.slice(from, caret);
  const query = raw.trimStart();
  // An empty formula offers everything; a fragment that is only spaces offers nothing, or the list would
  // flash open every time a binary operator is typed.
  if (source.trim() && !query) return null;
  const items = all
    .map((item) => ({ item, s: score(item.insert, query) }))
    .filter((entry) => entry.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s ||
        KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
        a.item.insert.length - b.item.insert.length ||
        a.item.insert.localeCompare(b.item.insert),
    )
    .slice(0, 8)
    .map((entry) => entry.item);
  return items.length
    ? { items, query, from: from + (raw.length - query.length) }
    : null;
}
