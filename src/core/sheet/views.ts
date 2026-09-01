// ---------- views: a scope, a grouping and a layout ----------
//
// A view selects and groups ITEMS, and then states what to ask each of them. It is an editing surface with a
// scope on it, not a report that happens to be editable — which is why the standard views below are the ones
// that replace the typed pages one-for-one, and why the cleverer ones are absent.
//
// ---------- the standard views are DERIVED ----------
//
// Nothing stores them. The bar keeps only whole-book reports and useful alternate facet groupings; item and
// facet editing views are opened from the explorer instead of generating a row of overlapping tabs.
//
// ---------- columns are not classified ----------
//
// A column is a question a view puts to many items; a field is one item's answer. So there is no book-level
// table describing fields, no field facets and no declared dimensions: a view derives its columns from what
// the scoped items actually carry. The field key would otherwise be doing two incompatible jobs — the
// address of a value inside one item, and the identity of a column across items — and pulling those apart is
// what lets a field key be genuinely local to its item.
//
// A column is a LEAF, so it is always one scalar and always one cell. `mass` is one column; `cg` is three,
// under a spanned header; a `cut` is its position plus whichever measurements are asked for. That is what
// lets a view over items with different field kinds pose no problem at all: there is only ever one kind of
// cell.

import {
  facetContains,
  leavesOf,
  facetKeys,
  facetSegments,
  primaryFacet,
  type Field,
  type FieldKind,
  type FieldLeaf,
  type Item,
  type View,
  type ViewScope,
  type WeightBook,
} from "./book";
import { SLICE_VALUE_FIELDS, type SliceValueField } from "./slices";

// ---------- scope ----------

/** Every item a scope admits, in the book's authored order. */
export function scopeItems(book: WeightBook, scope: ViewScope): Item[] {
  switch (scope.k) {
    case "all":
      return [...book.items];
    case "item":
      return book.items.filter((item) => item.id === scope.item);
    case "fieldType":
      return book.items.filter((item) =>
        Object.values(item.fields).some((field) => field.k === scope.type),
      );
    case "facet":
      // A facet value matches itself and everything beneath it: `structure` takes in `structure/hull/shell`.
      // Path containment, not a query — there is no predicate language here on purpose.
      return book.items.filter((item) => {
        const value = item.facets[scope.key];
        return !!value && facetContains(scope.value, value);
      });
  }
}

// ---------- columns ----------

/**
 * One column: a single scalar, asked of every item in the view.
 *
 * `source` is what to read. An authored LEAF is a cell the user types in; a MEASURE is a number read off the
 * hull for a cut, which is why the two are different shapes rather than one string — an editor has to know
 * which cells it may put a caret in, and "is this authored" must not be a guess about the name.
 *
 * `band` is the spanned header a multi-column field sits under, and it is the field key itself: the header
 * reads `cg` over `x  y  z`. Nothing configures it in this refactor; a view that wants `cg` under "mass
 * properties" is the custom-column work that comes later.
 */
export type ColumnSource =
  | { readonly k: "leaf"; readonly leaf: FieldLeaf }
  | { readonly k: "measure"; readonly measure: SliceValueField };

export interface Column {
  readonly fieldKey: string;
  readonly kind: FieldKind;
  readonly source: ColumnSource;
  /** What the column head reads: the leaf where a field has several, the key where it has one. */
  readonly label: string;
  /** The spanned header above it, or "" where the field is a single column. */
  readonly band: string;
}

export const isAuthored = (column: Column): boolean =>
  column.source.k === "leaf";

/**
 * Field keys in the order they first appear across the items.
 *
 * First-appearance rather than most-used, because it is stable while you type: adding a second item with a
 * `cost` must not move the column it already had.
 */
export function fieldKeyOrder(items: readonly Item[]): string[] {
  const seen: string[] = [];
  for (const item of items)
    for (const key of Object.keys(item.fields))
      if (!seen.includes(key)) seen.push(key);
  return seen;
}

/**
 * Whichever kind most of the scoped items use a key for.
 *
 * A key used two ways across two items is a naming mistake rather than something to model — nothing merges
 * them, they simply share a column heading — and it shows up here, and in the Fields tab, rather than being
 * prevented by a schema the rest of this design does without.
 */
function kindOf(items: readonly Item[], key: string): FieldKind | null {
  const counts = new Map<FieldKind, number>();
  for (const item of items) {
    const field: Field | undefined = item.fields[key];
    if (field) counts.set(field.k, (counts.get(field.k) ?? 0) + 1);
  }
  let best: FieldKind | null = null;
  let bestCount = 0;
  for (const [kind, count] of counts)
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  return best;
}

const leafColumn = (
  fieldKey: string,
  kind: FieldKind,
  leaf: FieldLeaf,
  label: string,
  band: string,
): Column => ({ fieldKey, kind, source: { k: "leaf", leaf }, label, band });

/** The columns one field kind contributes to a table, in the order they are shown. */
function columnsFor(key: string, kind: FieldKind): Column[] {
  switch (kind) {
    case "scalar":
      return [leafColumn(key, kind, "formula", key, "")];
    case "point":
      return (["x", "y", "z"] as const).map((leaf) =>
        leafColumn(key, kind, leaf, leaf, key),
      );
    case "cut":
      // The position is authored; the area is read off the hull. Area earns a column because it is what a
      // cut is usually taken for, and the other measurements stay reachable by formula rather than crowding
      // every table that happens to contain a cut.
      return [
        leafColumn(key, kind, "pos", "pos", key),
        {
          fieldKey: key,
          kind,
          source: { k: "measure", measure: "area" },
          label: "area",
          band: key,
        },
      ];
  }
}

/**
 * What a view asks each of its items.
 *
 * Generated, so it prunes: a column no scoped item carries is noise nobody asked for. Explicit columns —
 * which arrive with custom views — are the case that would NOT prune, because there the view asked and the
 * blank is the honest answer.
 */
export function viewColumns(view: View, items: readonly Item[]): Column[] {
  const out: Column[] = [];
  for (const key of fieldKeyOrder(items)) {
    const kind = kindOf(items, key);
    if (!kind) continue;
    // A `fieldType` view is the successor to a typed page, and shows that kind and nothing else.
    if (view.scope.k === "fieldType" && kind !== view.scope.type) continue;
    out.push(...columnsFor(key, kind));
  }
  return out;
}

/** Every measurement a cut can be asked for, for the inspector and for autocomplete. */
export const CUT_LEAVES: readonly string[] = ["pos", ...SLICE_VALUE_FIELDS];

// ---------- grouping ----------

/** One node of the row tree. A node with no facet value of its own is the unfiled bucket. */
export interface Group {
  /** The full facet path this node stands for, or "" for unfiled. */
  readonly value: string;
  /** The facet key it was split on — what a drag onto this node would set. */
  readonly key: string;
  /** The last path segment: what the header reads. */
  readonly label: string;
  readonly depth: number;
  /** Items sitting directly at this node, in the book's authored order. */
  readonly items: readonly Item[];
  /** Items here and below. */
  readonly count: number;
  readonly children: readonly Group[];
}

export const UNFILED = "— unfiled —";

/**
 * Split items into a tree.
 *
 * Each key in `keys` contributes a level, and a PATH value contributes one level per segment within it — so
 * `system: structure/hull/shell` nests three deep under a single key. That is the whole of the tree: nothing
 * stores a parent, so an item moves between branches by having its facet set, and sits in a different place
 * in every other facet's tree at the same time.
 */
export function groupItems(
  items: readonly Item[],
  keys: readonly string[],
  depth = 0,
): Group[] {
  if (!keys.length) return [];
  return splitByKey(items, keys[0], keys.slice(1), depth, "");
}

function splitByKey(
  items: readonly Item[],
  key: string,
  rest: readonly string[],
  depth: number,
  prefix: string,
): Group[] {
  const consumed = prefix ? facetSegments(prefix).length : 0;
  const buckets = new Map<string, Item[]>();
  const unfiled: Item[] = [];
  for (const item of items) {
    const value = item.facets[key];
    const segments = value ? facetSegments(value) : [];
    // Nothing left to split on: the item terminates above this level, so it belongs to the caller's node.
    // At the top of a key that means it is unfiled; deeper it cannot happen, because every item in a bucket
    // reached it by having the segment.
    if (segments.length <= consumed) {
      unfiled.push(item);
      continue;
    }
    const segment = segments[consumed];
    const bucket = buckets.get(segment);
    if (bucket) bucket.push(item);
    else buckets.set(segment, [item]);
  }

  const node = (
    value: string,
    label: string,
    bucket: readonly Item[],
    own: readonly Item[],
    children: readonly Group[],
  ): Group => ({
    value,
    key,
    label,
    depth,
    // With another facet key still to come, the items go into ITS groups rather than sitting loose here.
    items: rest.length ? [] : own,
    count: bucket.length,
    children: rest.length
      ? [...groupItems(own, rest, depth + 1), ...children]
      : children,
  });

  const groups: Group[] = [];
  for (const [segment, bucket] of buckets) {
    const value = prefix ? `${prefix}/${segment}` : segment;
    const own = bucket.filter(
      (item) => facetSegments(item.facets[key] ?? "").length === consumed + 1,
    );
    const deeper = bucket.filter(
      (item) => facetSegments(item.facets[key] ?? "").length > consumed + 1,
    );
    groups.push(
      node(
        value,
        segment,
        bucket,
        own,
        deeper.length ? splitByKey(deeper, key, rest, depth + 1, value) : [],
      ),
    );
  }

  // The unfiled bucket goes last, and exists whenever anything is in it. A half-organised book showing its
  // own state is the point: hiding these would make "everything is filed" indistinguishable from "I have not
  // looked yet".
  if (unfiled.length) groups.push(node("", UNFILED, unfiled, unfiled, []));
  return groups;
}

/** The tree flattened for a table: a header row, then its items, then its children. */
export type Row =
  | { readonly k: "group"; readonly group: Group }
  | { readonly k: "item"; readonly item: Item; readonly depth: number };

export function flattenGroups(groups: readonly Group[]): Row[] {
  const out: Row[] = [];
  const walk = (list: readonly Group[]): void => {
    for (const group of list) {
      out.push({ k: "group", group });
      for (const item of group.items)
        out.push({ k: "item", item, depth: group.depth + 1 });
      walk(group.children);
    }
  };
  walk(groups);
  return out;
}

/** What a table renders: grouped where the view says so, a flat list where it does not. */
export function viewRows(view: View, items: readonly Item[]): Row[] {
  if (!view.groupBy.length)
    return items.map((item) => ({ k: "item" as const, item, depth: 0 }));
  return flattenGroups(groupItems(items, view.groupBy));
}

// ---------- the standard views ----------

export const SUMMARY_VIEW = "std-summary";
export const PROBLEMS_VIEW = "std-problems";

/**
 * Every view the book offers without anyone authoring one.
 *
 * Summary and Problems bookend any alternate facet groupings. Values, positions, sections and the catch-all
 * table are reached through the explorer, where their scope is explicit, rather than appearing as automatic
 * tabs that duplicate it.
 */
export function standardViews(book: WeightBook): View[] {
  const primary = primaryFacet(book);
  const groupBy = primary ? [primary] : [];
  const views: View[] = [
    {
      id: SUMMARY_VIEW,
      name: "Summary",
      scope: { k: "all" },
      groupBy,
      layout: "summary",
    },
  ];

  for (const key of facetKeys(book))
    if (key !== primary)
      views.push({
        id: `std-facet-${key}`,
        name: `By ${key}`,
        scope: { k: "all" },
        groupBy: [key],
        layout: "table",
      });

  views.push({
    id: PROBLEMS_VIEW,
    name: "Problems",
    scope: { k: "all" },
    groupBy: [],
    layout: "problems",
  });
  return views;
}

/**
 * A view of one facet value and everything under it. Built on demand from an id, so clicking a node in the
 * explorer needs nothing stored: the id IS the query, and it round-trips through the panel's view state.
 *
 * Neither a facet key nor a facet value may contain `-` (see `FACET_SEGMENT`), so the first dash after the
 * prefix separates them unambiguously.
 */
export const facetView = (key: string, value: string): View => ({
  id: `facet-${key}-${value}`,
  name: `${key}: ${value}`,
  scope: { k: "facet", key, value },
  groupBy: [key],
  layout: "table",
});

const parseFacetView = (id: string): View | null => {
  if (!id.startsWith("facet-")) return null;
  const rest = id.slice("facet-".length);
  const dash = rest.indexOf("-");
  if (dash <= 0 || dash === rest.length - 1) return null;
  return facetView(rest.slice(0, dash), rest.slice(dash + 1));
};

/** The detail view of one item. Built on demand — one per item would swamp the list. */
export const itemView = (item: Item): View => ({
  id: `item-${item.id}`,
  name: item.name || "unnamed item",
  scope: { k: "item", item: item.id },
  groupBy: [],
  layout: "detail",
});

/** Find a view by id among the standard ones, the saved ones, and the per-item ones. */
export function resolveView(book: WeightBook, id: string | null): View {
  const standard = standardViews(book);
  if (!id) return standard[0];
  const saved = book.views.find((view) => view.id === id);
  if (saved) return saved;
  const found = standard.find((view) => view.id === id);
  if (found) return found;
  if (id.startsWith("item-")) {
    const item = book.items.find((candidate) => `item-${candidate.id}` === id);
    if (item) return itemView(item);
  }
  const facet = parseFacetView(id);
  if (facet) return facet;
  return standard[0];
}

// ---------- what is wrong with the book ----------
//
// The Problems view and the explorer's warning markers read the same list, so what counts as a problem is
// said once. Everything here comes off `CellResult`, which the evaluator already produced — nothing is
// recomputed and nothing new is stored.

export interface Problem {
  readonly item: Item;
  readonly fieldKey: string;
  readonly leaf: FieldLeaf;
  readonly message: string;
}

/**
 * Every cell worth going back to, in the book's own order.
 *
 * An EMPTY cell is a problem and a broken one is a problem, but an item with no fields at all is not: that is
 * a line you have just added and are about to fill in, and flagging it would make the list flash a warning at
 * every keystroke of ordinary work.
 */
export function problemsOf(
  book: WeightBook,
  results: {
    cells: ReadonlyMap<
      string,
      {
        readonly error: string | null;
        readonly empty: boolean;
        readonly unitWarning: string | null;
      }
    >;
  },
  cellKey: (item: string, field: string, leaf: FieldLeaf) => string,
): Problem[] {
  const out: Problem[] = [];
  for (const item of book.items)
    for (const [fieldKey, field] of Object.entries(item.fields))
      for (const leaf of leavesOf(field)) {
        const cell = results.cells.get(cellKey(item.id, fieldKey, leaf));
        if (!cell) continue;
        if (cell.error) out.push({ item, fieldKey, leaf, message: cell.error });
        else if (cell.empty)
          out.push({ item, fieldKey, leaf, message: "nothing written yet" });
        else if (cell.unitWarning)
          out.push({ item, fieldKey, leaf, message: cell.unitWarning });
      }
  return out;
}

/** The item ids with at least one problem, for the explorer's markers. */
export const problemItems = (problems: readonly Problem[]): Set<string> =>
  new Set(problems.map((problem) => problem.item.id));

/** True where every item under a group — at any depth — is worth a marker. */
export function groupHasProblem(
  group: Group,
  flagged: ReadonlySet<string>,
): boolean {
  if (group.items.some((item) => flagged.has(item.id))) return true;
  return group.children.some((child) => groupHasProblem(child, flagged));
}
