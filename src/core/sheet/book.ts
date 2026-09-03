// ---------- the weight book: items carrying fields, authored, plain and serializable ----------
//
// A weight estimate is a SCHEDULE, not a grid: named things, each carrying what is known about it. So a cell
// is addressed by (item, field) — never by (row number, column letter), and never by (page, row) either.
// References in a formula are the names themselves, which is what makes an estimate readable a month later,
// and what lets the sensitivity readout name the input that drives the spread rather than pointing at a
// coordinate.
//
// Items carry a stable `id` that nothing renames. A formula names an item by its `name`, resolved when the
// book is evaluated, so renaming rewrites nothing and reordering means nothing at all.
//
// ---------- items, not pages ----------
//
// One physical thing is ONE item. An engine has a mass, a position and perhaps a cost, and those are three
// fields of one record rather than three rows on three pages kept in name-sync by hand. That is the whole
// change from the page model this replaces: a page was a namespace, a type constraint, an organisational
// container and a tab all at once, so reorganising an estimate — the thing you do most as one grows — meant
// rewriting every formula that crossed a page boundary.
//
// Organisation now lives in FACETS (`system: structure/hull/shell`, `status: weighed`), which no formula
// mentions, so an item can be reclassified freely and nothing breaks. That is the rule the whole design turns
// on: an address names a thing, never where the thing is filed.
//
// ---------- fields are local, and ad-hoc ----------
//
// A field key is unique only within its item and means nothing outside it: `shell.area` and `sail.area` are
// unrelated numbers that happen to share a key. Nothing declares a field before it is used — typing a key
// creates it — which keeps the scratch calculation as cheap as it is in a grid with a spare column.
//
// ---------- names with spaces ----------
//
// `hull shell` is a better name than `hull_shell`, and a schedule is full of them. It works because the
// language has no implicit multiplication: two names side by side could never have meant anything else, so
// the lexer can take the longest known name at each position without ambiguity. `formula.ts` does that,
// against the symbol table `symbolsOf` builds from here.
//
// This module is the authored shape and its reducer only. Evaluation — the formula language, the uncertainty
// algebra and the hull's own numbers — lives in `formula.ts`, `quantity.ts` and `../hullMetrics.ts`, none of
// which this file knows about. Views live in `views.ts` and are derived, not authored. A `WeightBook`
// survives `structuredClone` and `JSON.stringify` unchanged.

import { canCarryRole, isRoleName, ROLE_NAMES, roleSpec } from "./roles";

// ---------- the authored shape ----------

/** What a slice cuts with. A plane is horizontal; a station is normal to the sheer plan's heading. */
export type SliceShape = "plane" | "station";

export const SLICE_SHAPES: readonly SliceShape[] = ["plane", "station"];

export const isSliceShape = (shape: string): shape is SliceShape =>
  (SLICE_SHAPES as readonly string[]).includes(shape);

/**
 * One scalar: a mass, an areal density, a fraction, a length.
 *
 * `unit` is what the number is written in: `kg`, `t`, `kg/m2`, `m`, or blank. Blank does NOT mean
 * dimensionless — it means "say it in whatever the formula works out to", and the panel fills the natural
 * unit in for you. Typing one over that converts the display where the dimension agrees, and is flagged
 * where it does not. On a formula with no dimension of its own it is a declaration: `1.4` in a cell marked
 * `t` is 1400 kg. See `units.ts`.
 */
export interface ScalarField {
  readonly k: "scalar";
  /** The expression, as the user typed it. Never stored pre-parsed — see `json.ts`. */
  readonly formula: string;
  readonly unit: string;
  /** Which of the item's values this one IS, by `ROLES` name, or null where it is just a field. */
  readonly role: string | null;
}

/**
 * One position in the hull: three formulas, not one.
 *
 * Each coordinate takes the whole language, `±` included, and that is the point of splitting them — a tank's
 * longitudinal position is usually known well and its height badly, and per-coordinate uncertainty is what
 * lets the sensitivity ranking say which of the two is costing you. All three are lengths, so one unit covers
 * the field.
 *
 * The frame is the SHEET's, not the drawing's: x from the transom, y from the centreline (starboard
 * positive), z above the keel baseline — the same frame `hullMetrics.ts` reports `shellLcg` and `shellVcg`
 * in, so a formula never has to know the hull is authored deck-flat with rake applied as a rotation.
 */
export interface PointField {
  readonly k: "point";
  readonly unit: string;
  readonly x: string;
  readonly y: string;
  readonly z: string;
  /**
   * One expression standing for all three coordinates, or empty on a point that authors them separately.
   *
   * A centre of gravity is not three unrelated statements — it is one statement, made three times over. Held
   * as three cells it would drift: adding a fortieth item means editing `x`, `y` and `z` in step, and
   * forgetting one leaves a CG that is right along the boat and wrong up it, with nothing on screen saying
   * so. Held once, that cannot happen.
   *
   * It is read once per coordinate, and a point named in it without a coordinate means the matching one —
   * so `(engine.mass * engine.cg + tank.mass * tank.cg) / total.mass` is the whole of a CG. See
   * `evaluate.ts`, which turns this one source into the field's three cells.
   *
   * `x`, `y` and `z` are kept while it is set rather than cleared, so turning a derivation off gives back the
   * coordinates that were there before it.
   */
  readonly from: string;
  /** Which of the item's places this one IS, by `ROLES` name, or null where it is just a field. */
  readonly role: string | null;
}

/**
 * One cut through the hull, which reports its area, open and closed perimeters, and its centroid.
 *
 * `pos` is in the sheet's frame, as a point's coordinates are: a height above the keel baseline for a plane,
 * x from the transom for a station.
 */
/*
 * A cut carries no role. See the note on `RoleSpec.kinds`: a role names one value, and a cut is a position
 * plus whatever is measured off it, so tagging one would have to name a leaf as well.
 */
export interface CutField {
  readonly k: "cut";
  readonly shape: SliceShape;
  /** Unit used to author and display `pos`; blank derives metres from a dimensioned formula. */
  readonly unit: string;
  readonly pos: string;
}

export type Field = ScalarField | PointField | CutField;

export type FieldKind = Field["k"];

export const FIELD_KINDS: readonly FieldKind[] = ["scalar", "point", "cut"];

export const isFieldKind = (kind: string): kind is FieldKind =>
  (FIELD_KINDS as readonly string[]).includes(kind);

/**
 * One thing the estimate accounts for.
 *
 * `fields` is a plain object rather than an array because a key is how a field is addressed, and the object
 * IS the index. Insertion order is the authored order and survives `JSON.stringify` — guaranteed here rather
 * than assumed, because a key that looked like an array index would be hoisted, and `NAME_PATTERN` forbids a
 * leading digit.
 *
 * `facets` is how the item is filed: `system: structure/hull/shell`, `status: weighed`. A value may be a
 * path, and that is what makes a facet tree. Nothing in a formula may mention one.
 */
export interface Item {
  readonly id: string;
  /** What formulas call it. Globally unique among items — see the note on `symbolsOf`. */
  readonly name: string;
  readonly note: string;
  readonly facets: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, Field>>;
}

/**
 * The addressable cells of a field. A scalar has one; a point has three, and a derivation besides.
 *
 * `from` is an address a command can write to, but it is NOT one of the cells a field evaluates to — see the
 * note on `leavesOf`, which is the list of those and deliberately does not include it.
 */
export type FieldLeaf = "formula" | "x" | "y" | "z" | "pos" | "from";

/** Where a value lives: a field, on an item. */
export interface CellRef {
  readonly item: string;
  readonly field: string;
}

export interface WeightBook {
  readonly items: readonly Item[];
  /**
   * Saved views. The four standard ones are DERIVED from what the book contains (see `views.ts`) and are not
   * in here — a stored copy of a generated thing is a thing that can go stale.
   */
  readonly views: readonly View[];
  /**
   * What the book answers, by `OUTPUTS` name: `DISPLACEMENT`, `VCG`, `LCG`. An ordinary formula in the same
   * language as everything else, so deleting one deletes the answer and renaming what it refers to rewrites
   * nothing. See `outputs.ts` for why this is a formula rather than a reference to a row.
   */
  readonly outputs: Readonly<Record<string, string>>;
  /**
   * Water density in t/m³, turning an estimated mass into the displaced volume the stability panel wants.
   * 1.025 is seawater, and is what the stability plane's own axis is drawn in.
   */
  readonly density: number;
}

/** A view: a scope, a grouping and a layout. Defined here so `WeightBook` can hold one; see `views.ts`. */
export type ViewScope =
  | { readonly k: "all" }
  | { readonly k: "item"; readonly item: string }
  | { readonly k: "fieldType"; readonly type: FieldKind }
  | { readonly k: "facet"; readonly key: string; readonly value: string };

/**
 * What renders a view.
 *
 * `table` and `split` are the two the typed pages had — a table alone, and a table beside a full-size editor
 * for what it holds. `detail` is one item and every field it carries. `summary` and `problems` are the two
 * that read the book rather than list it, and they are layouts rather than scopes because what they select
 * depends on EVALUATION, which the authored shape knows nothing about.
 */
export type ViewLayout = "table" | "split" | "detail" | "summary" | "problems";

export interface View {
  readonly id: string;
  readonly name: string;
  readonly scope: ViewScope;
  /** Facet keys, outermost first. Empty means a flat list. */
  readonly groupBy: readonly string[];
  readonly layout: ViewLayout;
}

export const SEAWATER_DENSITY = 1.025;

export const emptyBook = (): WeightBook => ({
  items: [],
  views: [],
  outputs: {},
  density: SEAWATER_DENSITY,
});

export const cloneBook = (book: WeightBook): WeightBook => ({
  items: book.items.map((item) => ({
    ...item,
    facets: { ...item.facets },
    fields: Object.fromEntries(
      Object.entries(item.fields).map(([key, field]) => [key, { ...field }]),
    ),
  })),
  views: book.views.map((view) => ({ ...view, groupBy: [...view.groupBy] })),
  outputs: { ...book.outputs },
  density: book.density,
});

// ---------- names ----------

/**
 * What a formula may call an item or a field.
 *
 * Letters, digits, underscores and single interior spaces, starting with a letter. Everything the language
 * uses as punctuation is excluded, and so is the leading digit that would make a name look like a number —
 * or, for a field key, like an array index.
 */
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z0-9_]+)*$/;

export const isValidName = (name: string): boolean => NAME_PATTERN.test(name);

/** Trim and collapse runs of spaces — what a name field commits, so `hull  shell` is `hull shell`. */
export const tidyName = (name: string): string =>
  name.trim().replace(/\s+/g, " ");

/**
 * The namespaces a formula reserves. An item may not take one of these for its own.
 *
 * They point in three directions. `HULL` is what the sheet READS — the geometry's own numbers, supplied to
 * it. `OUT` is what the sheet PROVIDES — the answers the rest of the app asks it for, which live in
 * `book.outputs` (see `outputs.ts`). A ROLE name is what the sheet asks one ITEM for, resolving to whichever
 * of its fields is tagged with it (see `roles.ts`).
 *
 * All of them are reserved against being taken as an item name or a field key, because all of them win over
 * a user name in `resolve` — a field keyed `MASS` would simply be unreachable, and a name nothing can address
 * is worse than a name refused.
 */
export const RESERVED: readonly string[] = ["HULL", "OUT", ...ROLE_NAMES];

export const isReserved = (name: string): boolean => RESERVED.includes(name);

// ---------- facets ----------

/**
 * A facet value: one or more path segments, `structure/hull/shell`.
 *
 * Looser than a name, because nothing addresses a facet: no formula mentions one, so a value only has to be
 * something a person can read and a tree can split on.
 */
const FACET_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_]*(?: [A-Za-z0-9_]+)*$/;

export const isValidFacetValue = (value: string): boolean =>
  value.length > 0 &&
  value.split("/").every((part) => FACET_SEGMENT.test(part));

/** Trim each segment and drop empty ones, so `structure / hull /` commits as `structure/hull`. */
export const tidyFacetValue = (value: string): string =>
  value
    .split("/")
    .map((part) => tidyName(part))
    .filter((part) => part.length > 0)
    .join("/");

export const facetSegments = (value: string): string[] => value.split("/");

/** True where `value` is `ancestor` or sits beneath it. What a `facet` scope matches with. */
export const facetContains = (ancestor: string, value: string): boolean =>
  value === ancestor || value.startsWith(`${ancestor}/`);

/**
 * The facet a tree is built on by default.
 *
 * `system` by convention, because that is what a weight schedule is filed under; failing that, whichever key
 * the book actually uses most, so a book that files by `zone` or by `trade` still opens on something useful.
 * A convention rather than a stored setting: there is nothing here a user would want to change that renaming
 * a facet would not already do.
 */
export const SYSTEM_FACET = "system";

export function primaryFacet(book: WeightBook): string | null {
  const counts = new Map<string, number>();
  for (const item of book.items)
    for (const key of Object.keys(item.facets))
      counts.set(key, (counts.get(key) ?? 0) + 1);
  if (counts.has(SYSTEM_FACET)) return SYSTEM_FACET;
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts)
    if (count > bestCount || (count === bestCount && best && key < best)) {
      best = key;
      bestCount = count;
    }
  return best;
}

/** Every facet key any item carries, in a stable order. */
export function facetKeys(book: WeightBook): string[] {
  const keys = new Set<string>();
  for (const item of book.items)
    for (const key of Object.keys(item.facets)) keys.add(key);
  return [...keys].sort();
}

/** Every value in use under one facet key, in a stable order. */
export function facetValues(book: WeightBook, key: string): string[] {
  const values = new Set<string>();
  for (const item of book.items) {
    const value = item.facets[key];
    if (value) values.add(value);
  }
  return [...values].sort();
}

// ---------- lookup ----------

export const findItem = (book: WeightBook, id: string): Item | undefined =>
  book.items.find((item) => item.id === id);

export const itemNamed = (book: WeightBook, name: string): Item | undefined =>
  book.items.find((item) => item.name === name);

export const findView = (book: WeightBook, id: string): View | undefined =>
  book.views.find((view) => view.id === id);

export function cellValue(book: WeightBook, ref: CellRef | null): Field | null {
  if (!ref) return null;
  const item = findItem(book, ref.item);
  return item ? (item.fields[ref.field] ?? null) : null;
}

export const sameRef = (a: CellRef | null, b: CellRef | null): boolean =>
  a === b || (!!a && !!b && a.item === b.item && a.field === b.field);

/** Rebuild one item's field map in a new authored order. Invalid and no-op moves return the original book. */
export function fieldMoved(
  book: WeightBook,
  itemId: string,
  key: string,
  to: number,
): WeightBook {
  const itemIndex = book.items.findIndex((item) => item.id === itemId);
  if (itemIndex < 0) return book;
  const item = book.items[itemIndex];
  const entries = Object.entries(item.fields);
  const from = entries.findIndex(([candidate]) => candidate === key);
  if (from < 0) return book;
  const target = Math.max(0, Math.min(entries.length - 1, to));
  if (target === from) return book;
  const [moved] = entries.splice(from, 1);
  entries.splice(target, 0, moved);
  const items = [...book.items];
  items[itemIndex] = { ...item, fields: Object.fromEntries(entries) };
  return { ...book, items };
}

/** Every item carrying a field of `kind`. What a `fieldType` view is scoped to. */
export const itemsWithKind = (book: WeightBook, kind: FieldKind): Item[] =>
  book.items.filter((item) =>
    Object.values(item.fields).some((field) => field.k === kind),
  );

/**
 * Every name a formula could mention, longest first.
 *
 * This is the lexer's symbol table: it is what lets `hull shell.mass` read as a name, a dot and a name rather
 * than as a syntax error. Longest-first is the whole trick — with `shell` and `shell area` both defined, the
 * longer one has to be tried first or the shorter would always win and leave `area` dangling.
 *
 * ONE table for the whole book, where the page model needed one per page: item names are globally unique and
 * field keys are only ever read after a dot or as a sibling, so there is nothing left for a page to
 * disambiguate.
 */
export function symbolsOf(book: WeightBook): string[] {
  const names = new Set<string>(RESERVED);
  for (const item of book.items) {
    if (item.name) names.add(item.name);
    for (const key of Object.keys(item.fields)) names.add(key);
  }
  return [...names].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * A fresh id. Generated by the WINDOW rather than the server, because the window that asked for the item
 * needs to know which one it got in order to put the caret in it, and because two windows adding one at once
 * must not collide.
 */
export function newId(prefix = "i"): string {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}${rand}`;
}

/** An item name nothing else in the book is using. */
export function freeItemName(book: WeightBook, wanted: string): string {
  const taken = new Set(book.items.map((item) => item.name));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++)
    if (!taken.has(`${wanted} ${n}`)) return `${wanted} ${n}`;
}

/** A field key the item is not already using. */
export function freeFieldKey(item: Item, wanted: string): string {
  if (!(wanted in item.fields)) return wanted;
  for (let n = 2; ; n++)
    if (!(`${wanted} ${n}` in item.fields)) return `${wanted} ${n}`;
}

/**
 * The conventional key a converted page lands on, and what a fresh field of each kind is offered as.
 *
 * There is no primary-field shorthand — `ply density.value`, never a bare `ply density` — so these are
 * defaults for a name field, nothing more. A user renaming `value` to `mass` breaks nothing but the formulas
 * that named it, and `renameField` rewrites none of them: they are resolved by name at evaluation.
 */
export const DEFAULT_FIELD_KEY: Record<FieldKind, string> = {
  scalar: "value",
  point: "position",
  cut: "section",
};

/** The unit a field actually authors in, including the intrinsic default for positions. */
export const fieldUnit = (field: Field): string =>
  field.k === "scalar" ? field.unit : field.unit.trim() || "m";

// ---------- roles ----------

/** Which of the item's values this field is, or null. A cut is never one — see `roles.ts`. */
export const roleOf = (field: Field): string | null =>
  field.k === "cut" ? null : field.role;

/** The same field, tagged or untagged. A cut is returned as it was, because it cannot carry one. */
export const withRole = (field: Field, role: string | null): Field =>
  field.k === "cut" ? field : { ...field, role };

/** Every field of the item carrying a role, in authored order. More than one is a book to complain about. */
export const roleKeys = (item: Item, role: string): string[] =>
  Object.entries(item.fields)
    .filter(([, field]) => roleOf(field) === role)
    .map(([key]) => key);

/**
 * What an item answers for a role: nothing, one field, or an ambiguity.
 *
 * Three-way rather than `Field | null`, because "none" and "two" need different messages and a caller that
 * collapsed them would have to guess which it was looking at. `setFieldRole` makes "many" impossible to
 * author; it survives only in a book read off disk, where the answer is to say so rather than to pick one —
 * a silently chosen mass produces a displacement that looks right and is not.
 */
export type RoleLookup =
  | { readonly k: "none" }
  | { readonly k: "one"; readonly key: string; readonly field: Field }
  | { readonly k: "many"; readonly keys: readonly string[] };

export function lookupRole(item: Item, role: string): RoleLookup {
  const keys = roleKeys(item, role);
  if (keys.length === 0) return { k: "none" };
  if (keys.length > 1) return { k: "many", keys };
  return { k: "one", key: keys[0], field: item.fields[keys[0]] };
}

/** A fresh field of one kind. Every cell it carries, empty. */
export function blankField(kind: FieldKind): Field {
  switch (kind) {
    case "scalar":
      return { k: "scalar", formula: "", unit: "", role: null };
    case "point":
      // A point is the one field whose dimension is known before anything is typed: three lengths. Declaring
      // the unit up front is what makes `3.2` in a fresh cell mean 3.2 m rather than a bare number — which
      // matters because the editor AUTHORS these cells by dragging, and a dragged coordinate that came out
      // dimensionless would fail the first moment arm it was multiplied into.
      return {
        k: "point",
        unit: "m",
        x: "",
        y: "",
        z: "",
        from: "",
        role: null,
      };
    case "cut":
      // A cut's authored position is a length just like a point's coordinates. Starting in metres makes a
      // freshly typed or dragged `0.4` a location on the hull rather than a dimensionless number.
      return { k: "cut", shape: "station", unit: "m", pos: "" };
  }
}

export const blankItem = (id: string, name: string): Item => ({
  id,
  name,
  note: "",
  facets: {},
  fields: {},
});

/**
 * Read the text at one address on a field, or null where the field has no such cell.
 *
 * The ADDRESSES of a field, which for a point is one more than the cells it evaluates to: `from` is written
 * by a command like any other formula, and is then the source of all three coordinates rather than a fourth
 * one. `leavesOf` is the other list, and the two stopped mirroring each other for exactly that reason.
 */
export function leafOf(field: Field, leaf: FieldLeaf): string | null {
  switch (field.k) {
    case "scalar":
      return leaf === "formula" ? field.formula : null;
    case "point":
      if (leaf === "from") return field.from;
      return leaf === "x" || leaf === "y" || leaf === "z" ? field[leaf] : null;
    case "cut":
      return leaf === "pos" ? field.pos : null;
  }
}

/** True when a point states its coordinates as one expression rather than three. */
export const isDerived = (field: Field): boolean =>
  field.k === "point" && field.from.trim() !== "";

/**
 * Every cell a field EVALUATES TO, in the order the editor shows them.
 *
 * A point has three whether or not it derives them: a derivation changes where their text comes from, never
 * how many there are, which is what lets `engine.cg.z`, the views and the sensitivity ranking go on working
 * without knowing the difference. So `from` is absent here and present in `leafOf`, and that asymmetry is the
 * whole distinction between the two.
 */
export function leavesOf(field: Field): FieldLeaf[] {
  switch (field.k) {
    case "scalar":
      return ["formula"];
    case "point":
      return ["x", "y", "z"];
    case "cut":
      return ["pos"];
  }
}

// ---------- commands ----------
// Every edit as a value, in the same spirit as `commands.ts`. These are interpreted against the BOOK ALONE:
// unlike a hull command, none of them needs the assembled model, which is why the reducer below takes a
// `WeightBook` rather than a `Model`.

export type SheetCommand =
  | { type: "addItem"; id: string; name: string; after: number }
  | { type: "removeItem"; item: string }
  | { type: "renameItem"; item: string; name: string }
  | { type: "moveItem"; item: string; to: number }
  | { type: "setItemNote"; item: string; note: string }
  /**
   * File an item, or unfile it. An empty `value` removes the facet outright rather than storing a blank,
   * so "no system" is the absence of a key and never a key whose value is "".
   *
   * This is what dragging an item onto a node in the explorer sends. Grouping is a PROPERTY now, not a
   * consequence of where a row landed, which is the whole reason a drag can record what was meant.
   */
  | { type: "setFacet"; item: string; key: string; value: string }
  | { type: "addField"; item: string; key: string; kind: FieldKind }
  | { type: "removeField"; item: string; key: string }
  | { type: "moveField"; item: string; key: string; to: number }
  | { type: "renameField"; item: string; key: string; name: string }
  | {
      type: "setFieldFormula";
      item: string;
      field: string;
      leaf: FieldLeaf;
      formula: string;
    }
  | { type: "setFieldUnit"; item: string; field: string; unit: string }
  /**
   * Say which of the item's fields is its mass, or its centre of gravity. A null role clears the tag.
   *
   * Setting one MOVES it: whichever sibling held it gives it up in the same edit. That is what makes "an item
   * has one mass" an invariant of the write path rather than a rule to check afterwards, and it is why the
   * chip in the detail card needs no dialogue — clicking the field you meant is the whole gesture.
   */
  | { type: "setFieldRole"; item: string; field: string; role: string | null }
  | { type: "setCutShape"; item: string; field: string; shape: SliceShape }
  /**
   * A point moved, as ONE edit.
   *
   * Three `setFieldFormula`s would say the same thing, and they are what this replaces. A drag in the point
   * editor writes two coordinates per frame, and `sameGesture` tells two gestures apart by their LEAF — so
   * alternating x and z would coalesce into nothing and leave one undo step per pointer move. It also keeps
   * the three coordinates atomic: a point half-moved is not a position anyone authored.
   *
   * An omitted coordinate is one the gesture did not touch, and is left exactly as it was.
   */
  | {
      type: "setPointPosition";
      item: string;
      field: string;
      x?: string;
      y?: string;
      z?: string;
    }
  /** One of the book's answers. An empty formula clears it — the book then answers nothing for that name. */
  | { type: "setOutput"; name: string; formula: string }
  | { type: "setSheetDensity"; density: number }
  | { type: "installSheet"; book: WeightBook };

/**
 * The command types above, as a value the compiler checks for completeness. This is what lets `commands.ts`
 * keep ONE flat union and still route each command to the reducer that owns it: adding a member to
 * `SheetCommand` without listing it here stops compiling.
 */
export const SHEET_COMMAND_TYPES = {
  addItem: 1,
  removeItem: 1,
  renameItem: 1,
  moveItem: 1,
  setItemNote: 1,
  setFacet: 1,
  addField: 1,
  removeField: 1,
  moveField: 1,
  renameField: 1,
  setFieldFormula: 1,
  setFieldUnit: 1,
  setFieldRole: 1,
  setCutShape: 1,
  setPointPosition: 1,
  setOutput: 1,
  setSheetDensity: 1,
  installSheet: 1,
} as const satisfies Record<SheetCommand["type"], 1>;

export const isSheetCommand = (command: {
  type: string;
}): command is SheetCommand => command.type in SHEET_COMMAND_TYPES;

/** A rejection reads the same as a hull command's, so one outcome type covers both families. */
export type SheetOutcome =
  { book: WeightBook; result?: number | boolean } | { rejected: string };

const withItems = (book: WeightBook, items: readonly Item[]): WeightBook => ({
  ...book,
  items,
});

const editItem = (
  book: WeightBook,
  id: string,
  change: (item: Item) => Item | { rejected: string },
): SheetOutcome => {
  const idx = book.items.findIndex((item) => item.id === id);
  if (idx < 0) return { rejected: `no such item: ${id}` };
  const next = change(book.items[idx]);
  if ("rejected" in next) return next;
  const items = [...book.items];
  items[idx] = next;
  return { book: withItems(book, items) };
};

const editField = (
  book: WeightBook,
  itemId: string,
  key: string,
  change: (field: Field, item: Item) => Field | { rejected: string },
): SheetOutcome =>
  editItem(book, itemId, (item) => {
    const field = item.fields[key];
    if (!field)
      return { rejected: `${item.name || "this item"} has no ${key}` };
    const next = change(field, item);
    if ("rejected" in next) return next;
    return { ...item, fields: { ...item.fields, [key]: next } };
  });

/**
 * Interpret one command. Pure: it returns the next book or a refusal, and never mutates the one it was given.
 * Structural validity — unique names, resolvable outputs — is checked by `invariants.ts` after the fact, in
 * the same two-stage way a hull command is.
 */
export function interpretSheetCommand(
  book: WeightBook,
  command: SheetCommand,
): SheetOutcome {
  switch (command.type) {
    case "addItem": {
      if (book.items.some((item) => item.id === command.id))
        return { rejected: `item ${command.id} already exists` };
      const name = tidyName(command.name);
      // An unnamed item is legal — it is the scratch line a grid would spend a spare column on — but a named
      // one has to be resolvable and has to be the only one answering to that name.
      if (name && !isValidName(name))
        return {
          rejected: `"${command.name}" is not a name a formula can use`,
        };
      if (name && isReserved(name))
        return { rejected: `${name} is a name the formula language reserves` };
      if (name && book.items.some((item) => item.name === name))
        return { rejected: `there is already an item called ${name}` };
      const at = Math.max(0, Math.min(book.items.length, command.after + 1));
      const items = [...book.items];
      items.splice(at, 0, blankItem(command.id, name));
      return { book: withItems(book, items), result: at };
    }

    case "removeItem": {
      const idx = book.items.findIndex((item) => item.id === command.item);
      if (idx < 0) return { rejected: `no such item: ${command.item}` };
      const items = [...book.items];
      items.splice(idx, 1);
      return { book: withItems(book, items), result: idx };
    }

    case "renameItem": {
      const name = tidyName(command.name);
      if (name && !isValidName(name))
        return {
          rejected: `"${command.name}" is not a name a formula can use — letters, digits, _ and spaces, starting with a letter`,
        };
      if (name && isReserved(name))
        return { rejected: `${name} is a name the formula language reserves` };
      if (
        name &&
        book.items.some(
          (item) => item.name === name && item.id !== command.item,
        )
      )
        return { rejected: `there is already an item called ${name}` };
      return editItem(book, command.item, (item) => ({ ...item, name }));
    }

    case "moveItem": {
      const from = book.items.findIndex((item) => item.id === command.item);
      if (from < 0) return { rejected: `no such item: ${command.item}` };
      const to = Math.max(0, Math.min(book.items.length - 1, command.to));
      if (to === from) return { book, result: false };
      const items = [...book.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      return { book: withItems(book, items), result: to };
    }

    case "setItemNote":
      return editItem(book, command.item, (item) => ({
        ...item,
        note: command.note,
      }));

    case "setFacet": {
      const key = tidyName(command.key);
      if (!isValidName(key))
        return { rejected: `"${command.key}" is not a usable facet name` };
      const value = tidyFacetValue(command.value);
      if (value && !isValidFacetValue(value))
        return { rejected: `"${command.value}" is not a usable facet value` };
      return editItem(book, command.item, (item) => {
        const facets = { ...item.facets };
        // Unfiling is the ABSENCE of a key, never a key holding "". Otherwise the explorer would have to know
        // that two different shapes both mean "not filed", and one of them would eventually be missed.
        if (value) facets[key] = value;
        else delete facets[key];
        return { ...item, facets };
      });
    }

    case "addField": {
      const key = tidyName(command.key);
      if (!isValidName(key))
        return { rejected: `"${command.key}" is not a name a formula can use` };
      // A reserved word wins over a field key in `resolve`, so a field taking one could never be named.
      if (isReserved(key)) return { rejected: `${key} is a reserved name` };
      if (!isFieldKind(command.kind))
        return { rejected: `there is no ${command.kind} field` };
      return editItem(book, command.item, (item) => {
        if (key in item.fields)
          return {
            rejected: `${item.name || "this item"} already has a ${key}`,
          };
        return {
          ...item,
          fields: { ...item.fields, [key]: blankField(command.kind) },
        };
      });
    }

    case "removeField":
      return editItem(book, command.item, (item) => {
        if (!(command.key in item.fields))
          return {
            rejected: `${item.name || "this item"} has no ${command.key}`,
          };
        const fields = { ...item.fields };
        delete fields[command.key];
        return { ...item, fields };
      });

    case "moveField": {
      const item = findItem(book, command.item);
      if (!item) return { rejected: `no such item: ${command.item}` };
      if (!(command.key in item.fields))
        return {
          rejected: `${item.name || "this item"} has no ${command.key}`,
        };
      return { book: fieldMoved(book, command.item, command.key, command.to) };
    }

    case "renameField": {
      const name = tidyName(command.name);
      if (!isValidName(name))
        return {
          rejected: `"${command.name}" is not a name a formula can use`,
        };
      if (isReserved(name)) return { rejected: `${name} is a reserved name` };
      return editItem(book, command.item, (item) => {
        const field = item.fields[command.key];
        if (!field)
          return {
            rejected: `${item.name || "this item"} has no ${command.key}`,
          };
        if (name === command.key) return item;
        if (name in item.fields)
          return {
            rejected: `${item.name || "this item"} already has a ${name}`,
          };
        // Rebuilt in order rather than deleted-and-appended, so renaming a field does not move its column.
        const fields: Record<string, Field> = {};
        for (const [key, value] of Object.entries(item.fields))
          fields[key === command.key ? name : key] = value;
        return { ...item, fields };
      });
    }

    case "setFieldFormula":
      return editField(book, command.item, command.field, (field) => {
        // The leaf has to be one the field actually carries: a point has no `formula` and a scalar has no
        // `z`. Writing it anyway would put a property on the field that nothing reads and the JSON would
        // carry.
        if (leafOf(field, command.leaf) === null)
          return {
            rejected: `a ${field.k} field has no ${command.leaf} to set`,
          };
        return { ...field, [command.leaf]: command.formula };
      });

    case "setFieldUnit":
      return editField(book, command.item, command.field, (field) => ({
        ...field,
        // Point coordinates and cut positions are intrinsically lengths. Clearing either display unit
        // restores metres instead of turning the next bare coordinate into a dimensionless number.
        unit: command.unit.trim() || (field.k === "scalar" ? "" : "m"),
      }));

    case "setFieldRole": {
      const role = command.role;
      if (role !== null && !isRoleName(role))
        return { rejected: `there is no role called ${role}` };
      return editItem(book, command.item, (item) => {
        const field = item.fields[command.field];
        if (!field)
          return {
            rejected: `${item.name || "this item"} has no ${command.field}`,
          };
        if (role !== null && !canCarryRole(field.k, role))
          return {
            rejected: `a ${field.k} cannot be an item's ${roleSpec(role)!.label}`,
          };
        // Rebuilt in order, and only where something actually changes, so tagging a field neither reorders
        // the card nor gives every untouched field a new identity.
        const fields: Record<string, Field> = {};
        for (const [key, value] of Object.entries(item.fields)) {
          const held = roleOf(value);
          const next =
            key === command.field
              ? role
              : role !== null && held === role
                ? null
                : held;
          fields[key] = next === held ? value : withRole(value, next);
        }
        return { ...item, fields };
      });
    }

    case "setCutShape":
      return editField(book, command.item, command.field, (field) => {
        if (field.k !== "cut") return { rejected: "only a cut has a shape" };
        return { ...field, shape: command.shape };
      });

    case "setPointPosition":
      return editField(book, command.item, command.field, (field) => {
        if (field.k !== "point")
          return { rejected: "only a point has a position" };
        return {
          ...field,
          x: command.x ?? field.x,
          y: command.y ?? field.y,
          z: command.z ?? field.z,
        };
      });

    case "setOutput": {
      const outputs = { ...book.outputs };
      if (command.formula.trim()) outputs[command.name] = command.formula;
      else delete outputs[command.name];
      return { book: { ...book, outputs } };
    }

    case "setSheetDensity":
      if (!isFinite(command.density) || command.density <= 0)
        return { rejected: "density must be a positive number" };
      return { book: { ...book, density: command.density } };

    case "installSheet":
      return { book: cloneBook(command.book) };
  }
}
