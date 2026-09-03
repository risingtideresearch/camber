// ---------- evaluating a weight book ----------
//
// Takes the authored items and the hull's numbers, and produces a value, a spread and a sensitivity ranking
// for every cell. Everything that can go wrong is reported PER CELL and nothing throws: a half-written
// formula is a normal state for a schedule to be in, and one bad line must not take the other thirty with it.
//
// ---------- how a name is resolved ----------
//
// A path is read from the inside out, so the shortest thing that could have been meant is what was meant:
//
//   area                  a SIBLING field — another field of the item the formula is written on
//   cg.z                  a sibling field's leaf
//   hull shell.mass       a field of another item
//   engine.cg.z           a leaf of a field of another item
//   HULL.LWL              the geometry, exact, in metres and kilograms (`../hullMetrics.ts`)
//   OUT.DISPLACEMENT      what the book itself answers (`outputs.ts`)
//   MASS                  whichever field of THIS item is tagged as its mass (`roles.ts`)
//   engine.CG.z           and of another item, whatever that item happens to key it
//
// Two segments are ambiguous in principle — `cg.z` could be a sibling's leaf or another item's field — and
// the sibling wins, for the same reason a local variable shadows a global. It is the scope you are standing
// in, and the alternative is reachable by writing the item's name.
//
// A facet path itself is not an address. The deliberate exception is a named aggregate such as
// `ROLLUP.hull.MASS`: creating that name explicitly says this calculation is intended to change when items
// enter or leave that facet subtree.
//
// ---------- names may contain spaces ----------
//
// The lexer is handed the symbol table that makes that unambiguous — one table for the whole book now, where
// the page model needed one per page. See `symbolsOf`.
//
// ---------- cycles ----------
//
// Resolution is depth-first with a visiting set, so a cycle is caught at the moment it closes and every cell
// on it gets the same message naming the loop. There is no topological pre-pass: the graph is tiny, and doing
// it lazily means a cell that references nothing is evaluated even when the rest of the book is tangled.

import {
  evaluate,
  FormulaError,
  parseFormula,
  referencesOf,
  type Node,
} from "./formula";
import {
  hullMetric,
  hullPoint,
  isHullMetricName,
  isHullPointName,
  type HullMetrics,
} from "../hullMetrics";
import {
  AREA,
  add,
  div,
  exact,
  isDimless,
  LENGTH,
  mul,
  read,
  sameDim,
  type Dim,
  type Quantity,
  type Reading,
  type Source,
} from "./quantity";
import {
  facetContains,
  fieldUnit,
  isDerived,
  leafOf,
  leavesOf,
  lookupRole,
  roleOf,
  rollupsOf,
  symbolsOf,
  type Field,
  type FieldLeaf,
  type Item,
  type CellRef,
  type Rollup,
  type WeightBook,
} from "./book";
import { isOutputName, OUTPUTS, outputSpec } from "./outputs";
import { isRoleName, roleSpec } from "./roles";
import { naturalUnit, parseUnit, UnitError, type UnitSpec } from "./units";
import {
  SLICE_VALUE_FIELDS,
  sliceMeasurementKey,
  type SliceMeasurements,
  type SliceValueField,
} from "./slices";

/**
 * The pseudo item the book's own answers are evaluated under.
 *
 * They are cells like any other — they parse, they can fail, they can join a cycle — and giving them a home
 * in the same map is what lets `OUT.DISPLACEMENT` appear in the middle of a loop and be named in the message
 * along with everything else. Not a real id: `newId` mints `i`-prefixed ids, so nothing can collide with it.
 */
export const OUTPUT_ITEM = "OUT";

/** One evaluated cell. */
export interface CellResult {
  readonly itemId: string;
  readonly fieldKey: string;
  /** Which cell of the field this is. A scalar has only `"formula"`; a point has three. */
  readonly leaf: FieldLeaf;
  /** A blank formula has no value and no error — it is simply empty. */
  readonly empty: boolean;
  readonly reading: Reading | null;
  /**
   * The value with its GRADIENT still attached, which `reading` has spent.
   *
   * A `Reading` reports each source's downward and upward reach as two non-negative numbers, so the SIGN of
   * ∂v/∂xᵢ is gone by then — and with it any way to tell whether two values move together or apart. That is
   * exactly what the point editor needs: two coordinates that lean on one uncertain input are correlated,
   * and their uncertainty region is a tilted parallelogram rather than the axis-aligned box the two readings
   * alone would draw.
   */
  readonly quantity: Quantity | null;
  /**
   * The parse the evaluation ran on, for a caller that needs to REWRITE the source rather than read the
   * value. The point editor moves a literal inside an expression by splicing its span, and the spans are on
   * the tree (`formula.ts`). Null where the cell is empty or would not parse.
   */
  readonly tree: Node | null;
  /** What went wrong, in a sentence a person can act on. */
  readonly error: string | null;
  /** Where in the formula, for a caret. −1 when the message is not about a position. */
  readonly errorAt: number;
  /**
   * The unit the value is SHOWN in: what the field declares, or — where it declares nothing — the natural
   * unit of whatever the formula worked out to.
   */
  readonly unit: UnitSpec | null;
  /** True when the shown unit was derived rather than typed, so the panel can render it as a suggestion. */
  readonly unitIsDerived: boolean;
  /**
   * The declared unit's dimension disagrees with the formula's own. Not an error: the value is reported as
   * the formula computed it, and the cell is flagged so the mismatch is visible rather than silently believed.
   */
  readonly unitWarning: string | null;
}

export interface BookResults {
  /** Keyed by `cellKey`. Includes the book's answers, under `OUTPUT_ITEM`. */
  readonly cells: ReadonlyMap<string, CellResult>;
  readonly sources: ReadonlyMap<string, Source>;
  /** The book's declared outputs, resolved. Null where nothing is written or the formula failed. */
  readonly outputs: {
    readonly displacement: Reading | null;
    readonly vcg: Reading | null;
    readonly lcg: Reading | null;
  };
}

/**
 * Where a result lives.
 *
 * The leaf defaults to `"formula"`, which is the only cell a scalar has. A point occupies three keys under
 * this scheme, one per coordinate.
 */
export const cellKey = (
  itemId: string,
  fieldKey: string,
  leaf: FieldLeaf = "formula",
): string => `${itemId} ${fieldKey} ${leaf}`;

export const resultAt = (
  results: BookResults,
  itemId: string,
  fieldKey: string,
  leaf: FieldLeaf = "formula",
): CellResult | undefined => results.cells.get(cellKey(itemId, fieldKey, leaf));

export const resultFor = (
  results: BookResults,
  ref: CellRef | null,
): CellResult | undefined =>
  ref ? results.cells.get(cellKey(ref.item, ref.field)) : undefined;

/**
 * What names each field of one item, by the address a person would recognise.
 *
 * The reverse of the dependency edge the evaluator follows, and the answer to "what does removing this
 * break". Read off the parse trees the evaluation already built rather than by re-parsing: a formula that
 * would not lex contributes nothing, which is the right answer, because it resolves to nothing either.
 *
 * The two ways to name a field are the two `resolve` accepts — bare from a formula on the same item, where a
 * sibling wins, and `item.field` from anywhere else, where a sibling of the SAME name on the naming item
 * would shadow it and so does not count. One pass over every cell answers for every field at once, and a
 * point that names one in two of its three coordinates counts once: it is one thing to go and edit.
 */
export function fieldUsers(
  book: WeightBook,
  results: BookResults,
  itemId: string,
): ReadonlyMap<string, readonly string[]> {
  const owner = book.items.find((item) => item.id === itemId);
  const found = new Map<string, Set<string>>();
  if (!owner) return new Map();
  for (const key of Object.keys(owner.fields)) found.set(key, new Set());

  const byId = new Map(book.items.map((item) => [item.id, item]));
  for (const cell of results.cells.values()) {
    if (!cell.tree) continue;
    const from = byId.get(cell.itemId);
    for (const path of referencesOf(cell.tree)) {
      const key =
        cell.itemId === itemId && found.has(path[0])
          ? path[0]
          : owner.name &&
              path[0] === owner.name &&
              found.has(path[1]) &&
              !from?.fields[path[0]]
            ? path[1]
            : null;
      // A cell of the field itself is not a user of it — that is a cycle, and `evaluate` already says so.
      if (!key || (cell.itemId === itemId && cell.fieldKey === key)) continue;
      found
        .get(key)!
        .add(
          cell.itemId === OUTPUT_ITEM
            ? `OUT.${cell.fieldKey}`
            : `${from?.name || "an unnamed item"}.${cell.fieldKey}`,
        );
    }
  }
  return new Map([...found].map(([key, users]) => [key, [...users]]));
}

/** One authored cell whose formula names a field. */
export interface FieldUse {
  readonly itemId: string;
  readonly fieldKey: string;
  readonly leaf: FieldLeaf;
  /** The full cell address a person sees in a formula editor. */
  readonly address: string;
}

/**
 * The individual formula cells that name one field.
 *
 * Unlike `fieldUsers`, this keeps the leaf and stable ids needed to follow an occurrence from the inspector.
 * A derived point is evaluated once per coordinate from the same authored `from` expression, so its three
 * results collapse back to that one editable use.
 */
export function fieldUses(
  book: WeightBook,
  results: BookResults,
  itemId: string,
  fieldKey: string,
): readonly FieldUse[] {
  const owner = book.items.find((item) => item.id === itemId);
  if (!owner?.fields[fieldKey]) return [];
  const byId = new Map(book.items.map((item) => [item.id, item]));
  const found = new Map<string, FieldUse>();

  for (const cell of results.cells.values()) {
    if (!cell.tree) continue;
    const from = byId.get(cell.itemId);
    const namesTarget = referencesOf(cell.tree).some((path) =>
      cell.itemId === itemId && owner.fields[path[0]]
        ? path[0] === fieldKey
        : !!owner.name &&
          path[0] === owner.name &&
          path[1] === fieldKey &&
          !from?.fields[path[0]],
    );
    if (!namesTarget || (cell.itemId === itemId && cell.fieldKey === fieldKey))
      continue;

    const field = from?.fields[cell.fieldKey];
    const sharedDerivation = field?.k === "point" && isDerived(field);
    const base =
      cell.itemId === OUTPUT_ITEM
        ? `OUT.${cell.fieldKey}`
        : `${from?.name || "an unnamed item"}.${cell.fieldKey}`;
    const address =
      cell.itemId === OUTPUT_ITEM || field?.k === "scalar" || sharedDerivation
        ? base
        : `${base}.${cell.leaf}`;
    if (!found.has(address))
      found.set(address, {
        itemId: cell.itemId,
        fieldKey: cell.fieldKey,
        leaf: sharedDerivation ? "from" : cell.leaf,
        address,
      });
  }
  return [...found.values()];
}

/** One of the book's answers, as an evaluated cell — what the summary view renders and edits. */
export const outputResult = (
  results: BookResults,
  name: string,
): CellResult | undefined => results.cells.get(cellKey(OUTPUT_ITEM, name));

// ---------- the evaluator ----------

interface Cell {
  /** Null on one of the book's answers, which belongs to no item and has no siblings. */
  readonly item: Item | null;
  readonly fieldKey: string;
  readonly field: Field | null;
  readonly leaf: FieldLeaf;
  readonly source: string;
  /** Parsed once, whatever it is referenced from. */
  tree: Node | null;
  parseError: FormulaError | null;
  declared: UnitSpec | null;
  unitError: string | null;
  state: "fresh" | "running" | "done";
  value: Quantity | null;
  error: { message: string; at: number } | null;
  unitWarning: string | null;
  /** This cell's dependency graph reaches a geometry-derived cut leaf. */
  usesSliceMeasurement: boolean;
}

/**
 * Evaluate a whole book.
 *
 * `metrics` may be null — the hull has not been measured yet, or does not float — in which case any formula
 * touching `HULL.*` reports that rather than the book failing wholesale.
 */
export function evaluateBook(
  book: WeightBook,
  metrics: HullMetrics | null,
  sliceMeasurements: SliceMeasurements = new Map(),
): BookResults {
  const cells = new Map<string, Cell>();
  const sources = new Map<string, Source>();
  let sourceSeq = 0;

  // Item names are globally unique, so ONE index serves the whole book — the page model needed one per page
  // because the same name could mean different things on two pages, and that is exactly the ambiguity items
  // removed.
  const itemsByName = new Map<string, Item>();
  for (const item of book.items)
    if (item.name) itemsByName.set(item.name, item);
  const symbols = symbolsOf(book);

  const declare = (
    unit: string,
  ): { declared: UnitSpec | null; unitError: string | null } => {
    const text = unit.trim();
    if (!text) return { declared: null, unitError: null };
    try {
      return { declared: parseUnit(text), unitError: null };
    } catch (error) {
      return {
        declared: null,
        unitError: error instanceof UnitError ? error.message : String(error),
      };
    }
  };

  const addCell = (
    item: Item | null,
    fieldKey: string,
    field: Field | null,
    leaf: FieldLeaf,
    text: string,
    unit: string,
  ): void => {
    const declaration = declare(unit);
    const position = field?.k === "point" || field?.k === "cut";
    // Positions have a known dimension independent of their formula. A mass unit on a scalar is useful; on
    // a coordinate it would make geometry interpret kilograms as metres, so refuse it at the cell boundary.
    const unitError =
      declaration.unitError ??
      (position &&
      declaration.declared &&
      !sameDim(declaration.declared.dim, LENGTH)
        ? `${field.k === "point" ? "point coordinates" : "cut positions"} must use a distance unit — try m, cm, mm, in, or ft`
        : null);
    const declared = declaration.declared;
    let tree: Node | null = null;
    let parseError: FormulaError | null = null;
    const trimmed = text.trim();
    if (trimmed) {
      try {
        tree = parseFormula(trimmed, symbols);
      } catch (error) {
        parseError =
          error instanceof FormulaError
            ? error
            : new FormulaError(String(error));
      }
    }
    cells.set(cellKey(item?.id ?? OUTPUT_ITEM, fieldKey, leaf), {
      item,
      fieldKey,
      field,
      leaf,
      source: trimmed,
      tree,
      parseError,
      declared,
      unitError,
      state: "fresh",
      value: null,
      error: null,
      unitWarning: null,
      usesSliceMeasurement: false,
    });
  };

  // One cell per LEAF, not per field: a scalar contributes one, a point three, a cut one.
  for (const item of book.items)
    for (const [key, field] of Object.entries(item.fields)) {
      // A derived point states its three coordinates once. It still produces THREE cells — the same three
      // keys everything downstream reads — and they simply all read from the one expression, evaluated once
      // per axis under the rule in `bareFieldValue`. Nothing but this line knows.
      const derivation = isDerived(field)
        ? (field as { from: string }).from
        : null;
      for (const leaf of leavesOf(field))
        addCell(
          item,
          key,
          field,
          leaf,
          derivation ?? leafOf(field, leaf) ?? "",
          fieldUnit(field),
        );
    }

  // The book's own answers, as cells in the same space. They declare no unit — an output is whatever its
  // formula works out to, and `outputSpec` says what that ought to be.
  for (const spec of OUTPUTS)
    if ((book.outputs[spec.name] ?? "").trim())
      addCell(null, spec.name, null, "formula", book.outputs[spec.name], "");

  // The path currently being resolved, so a cycle is reported as the loop it actually is.
  const visiting: string[] = [];
  // Cells whose message is already final because they sit ON a cycle. Without this the loop would be reported
  // by exactly one of its members — whichever closed it — and the others would each say only that a
  // neighbour failed, which tells the reader nothing about where the knot is.
  const cycled = new Set<string>();

  const fail = (message: string, at = -1): never => {
    throw new FormulaError(message, at);
  };

  /** How a cell is named in a cycle message and in the sensitivity ranking. */
  const describe = (key: string): string => {
    const cell = cells.get(key);
    if (!cell) return "a missing value";
    if (!cell.item) return `OUT.${cell.fieldKey}`;
    const item = cell.item.name || "an unnamed item";
    // A field with more than one cell holds more than one guess. A tank's x may be known well and its z
    // badly, and they are two different things to go and measure — so the ranking names the LEAF. Calling
    // both of them "tank" would answer "which of these is costing me" with the question.
    const leaf = cell.leaf === "formula" ? "" : `.${cell.leaf}`;
    return `${item}.${cell.fieldKey}${leaf}`;
  };

  // Which item the cell being evaluated belongs to, so a bare reference means "a sibling field".
  let currentItem: Item | null = null;
  let currentCell: Cell | null = null;
  // Geometry is evaluated after authored formulas have produced cut positions. Letting a position depend on
  // any measured leaf would require solving an implicit geometry system, not another evaluation pass. Track
  // the root computation so an indirect dependency through scalar fields is refused just as clearly as a
  // direct `other.area` reference.
  let cutPositionDepth = 0;

  const valueAt = (
    itemId: string,
    fieldKey: string,
    at: number,
    leaf: FieldLeaf = "formula",
  ): Quantity => {
    const key = cellKey(itemId, fieldKey, leaf);
    const cell = cells.get(key);
    if (!cell) fail("no such value", at);
    if (cell!.state === "running") {
      const loop = visiting.slice(visiting.indexOf(key));
      const text = `this refers back to itself: ${[...loop, key].map(describe).join(" → ")}`;
      for (const member of loop) {
        cycled.add(member);
        const onLoop = cells.get(member)!;
        onLoop.error = { message: text, at: -1 };
        onLoop.value = null;
      }
      fail(text, at);
    }
    if (cell!.state === "fresh") compute(cell!);
    if (cell!.error) fail(`${describe(key)} could not be worked out`, at);
    if (!cell!.value) fail(`${describe(key)} is empty`, at);
    if (cell!.usesSliceMeasurement) {
      if (currentCell && currentCell !== cell)
        currentCell.usesSliceMeasurement = true;
      if (cutPositionDepth > 0)
        fail("a cut position cannot depend on measured cut values", at);
    }
    return cell!.value!;
  };

  /**
   * A field named with no leaf after it.
   *
   * A scalar IS its value. A point is not — it is three of them — so naming one bare is a mistake with an
   * obvious fix, and saying so beats "there is no such name", which is what a lexer-level answer would be.
   */
  const bareFieldValue = (
    item: Item,
    key: string,
    field: Field,
    at: number,
  ): Quantity => {
    if (field.k === "scalar") return valueAt(item.id, key, at);
    // Anything with a POSITION, named in a coordinate cell, means that coordinate of it. `engine.cg` in an x
    // cell is `engine.cg.x`, in a z cell `engine.cg.z` — which is what lets one expression stand for a whole
    // place: a centre of gravity is `(m1 * a + m2 * b) / (m1 + m2)` whichever axis you read it along, and
    // writing it out three times with three different leaves would be writing one statement three times.
    //
    // A CUT has a position too — the centroid of what it cuts — so it binds the same way, and the
    // area-weighted centre of a set of sections is that same expression with areas where the masses were.
    const axis = currentCell?.leaf;
    if (axis === "x" || axis === "y" || axis === "z") {
      if (field.k === "point") return valueAt(item.id, key, at, axis);
      return leafValue(item, key, field, axis, at);
    }
    const leaves =
      field.k === "cut" ? ["pos", ...SLICE_VALUE_FIELDS] : leavesOf(field);
    fail(
      `${item.name}.${key} is a ${field.k} — write ${item.name}.${key}.${leaves[0]}${
        leaves.length > 1 ? ` (or .${leaves.slice(1).join(", .")})` : ""
      }`,
      at,
    );
    return null!;
  };

  const leafValue = (
    item: Item,
    key: string,
    field: Field,
    leaf: string,
    at: number,
  ): Quantity => {
    if (field.k === "scalar")
      fail(
        `${item.name}.${key} is a single value — .${leaf} is one dot too deep`,
        at,
      );
    if (field.k === "cut") {
      if (leaf === "pos") return valueAt(item.id, key, at, "pos");
      if (!(SLICE_VALUE_FIELDS as readonly string[]).includes(leaf))
        fail(
          `a cut has no ${leaf} — try .pos, .${SLICE_VALUE_FIELDS.join(", .")}`,
          at,
        );
      const measured = sliceMeasurements.get(sliceMeasurementKey(item.id, key));
      if (!measured)
        return fail(
          `${item.name}.${key} has not produced a valid hull cut`,
          at,
        );
      const measuredField = leaf as SliceValueField;
      currentCell!.usesSliceMeasurement = true;
      // A direct measured leaf has no intervening valueAt call to propagate the marker back to the position.
      if (currentCell!.field?.k === "cut" && currentCell!.leaf === "pos")
        fail("a cut position cannot depend on measured cut values", at);
      const position = valueAt(item.id, key, at, "pos");
      const slope = measured.derivative[measuredField];
      return {
        v: measured[measuredField],
        d: Object.fromEntries(
          Object.entries(position.d).map(([source, gradient]) => [
            source,
            gradient * slope,
          ]),
        ),
        dim: measuredField === "area" ? AREA : LENGTH,
      };
    }
    const leaves = leavesOf(field);
    if (!(leaves as string[]).includes(leaf))
      fail(`a point has no ${leaf} — try .${leaves.join(", .")}`, at);
    return valueAt(item.id, key, at, leaf as FieldLeaf);
  };

  /**
   * A role, on one item: `MASS`, `engine.CG`, `engine.CG.z`.
   *
   * It resolves to the tagged FIELD and then hands off to the ordinary field paths, so everything a field
   * does a role does too. In particular a bare `CG` in a coordinate cell means that coordinate of it — which
   * is what lets a centre of gravity be one expression rather than three, over items that need not agree on
   * what they call the position it reads.
   */
  const roleValue = (
    item: Item,
    role: string,
    after: readonly string[],
    at: number,
  ): Quantity => {
    const spec = roleSpec(role)!;
    const who = item.name || "this item";
    const found = lookupRole(item, role);
    if (found.k === "none")
      fail(`${who} does not say which of its fields is its ${spec.label}`, at);
    // Two fields claiming one role cannot be authored — `setFieldRole` moves the tag rather than copying it —
    // so this is a book that arrived saying it. Picking one would answer with a number that looks right.
    if (found.k === "many")
      fail(
        `${who} tags ${found.keys.join(" and ")} as its ${spec.label} — only one of them can be`,
        at,
      );
    const { key, field } = found as { key: string; field: Field };
    if (after.length === 0) return bareFieldValue(item, key, field, at);
    if (after.length === 1) return leafValue(item, key, field, after[0], at);
    fail(`${role}.${after.join(".")} is one dot too deep`, at);
    return null!;
  };

  /** Resolve a named facet aggregate inside the ordinary cell dependency graph. */
  const rollupValue = (
    rollup: Rollup,
    role: string,
    leaf: string | undefined,
    at: number,
  ): Quantity => {
    const spec = roleSpec(role);
    if (!spec) fail(`there is no role called ${role}`, at);
    const members = book.items.filter((item) =>
      facetContains(rollup.facetValue, item.facets[rollup.facetKey] ?? ""),
    );
    const claimed = (item: Item, name: string) => {
      const found = lookupRole(item, name);
      if (found.k === "many")
        fail(
          `${item.name || "an unnamed item"} tags ${found.keys.join(" and ")} as ${name}`,
          at,
        );
      return found.k === "one" ? found : null;
    };

    const aggregation = spec!.aggregation;
    if (aggregation.k === "sum") {
      if (leaf) fail(`${rollup.name}.${role} is a single value`, at);
      const values = members.flatMap((item) => {
        const found = claimed(item, role);
        if (!found) return [];
        if (found.field.k !== "scalar")
          fail(`${item.name}.${found.key} cannot be summed as ${role}`, at);
        return [valueAt(item.id, found.key, at)];
      });
      if (!values.length)
        fail(`${rollup.name}.${role} has no contributors`, at);
      return values.reduce(add, exact(0, spec!.dim));
    }

    if (aggregation.k !== "weightedMean")
      return fail(`${role} has no roll-up aggregation`, at);
    const axis =
      leaf === "x" || leaf === "y" || leaf === "z" ? leaf : currentCell?.leaf;
    if (axis !== "x" && axis !== "y" && axis !== "z")
      fail(`${rollup.name}.${role} is a place — write .x, .y, or .z`, at);
    const weightName = aggregation.weight;
    const weightSpec = roleSpec(weightName)!;
    const entries = members.flatMap((item) => {
      const weight = claimed(item, weightName);
      if (!weight) return [];
      if (weight.field.k !== "scalar")
        fail(`${item.name}.${weight.key} cannot weight ${role}`, at);
      const target = claimed(item, role);
      if (!target)
        return fail(
          `${rollup.name}.${role} is incomplete: ${item.name || "an unnamed item"} has ${weightName} but no ${role}`,
          at,
        );
      if (target.field.k !== "point")
        fail(`${item.name}.${target.key} is not a point`, at);
      return [
        {
          weight: valueAt(item.id, weight.key, at),
          value: valueAt(item.id, target.key, at, axis),
        },
      ];
    });
    if (!entries.length) fail(`${rollup.name}.${role} has no contributors`, at);
    const totalWeight = entries
      .map((entry) => entry.weight)
      .reduce(add, exact(0, weightSpec.dim));
    if (totalWeight.v === 0)
      fail(`${rollup.name}.${role} has zero total ${weightName}`, at);
    const moments = entries.map((entry) => mul(entry.weight, entry.value));
    return div(moments.slice(1).reduce(add, moments[0]), totalWeight);
  };

  /** `item.field`, `item.field.leaf` — the two shapes that start from a named item. */
  const fromItem = (
    item: Item,
    rest: readonly string[],
    path: readonly string[],
    at: number,
  ): Quantity => {
    const key = rest[0];
    // `engine.MASS` asks the item which of its fields that is. Ahead of the key lookup because a role name is
    // reserved, so no field can be answering to it.
    if (isRoleName(key)) return roleValue(item, key, rest.slice(1), at);
    const field = item.fields[key];
    if (!field) {
      const near = Object.keys(item.fields).find(
        (candidate) => candidate.toLowerCase() === key.toLowerCase(),
      );
      fail(
        `${item.name} has nothing called ${key}${
          near
            ? ` — did you mean ${near}?`
            : Object.keys(item.fields).length
              ? ` — it has ${Object.keys(item.fields).join(", ")}`
              : " — it has no fields yet"
        }`,
        at,
      );
    }
    if (rest.length === 1) return bareFieldValue(item, key, field!, at);
    if (rest.length > 2) fail(`${path.join(".")} is one dot too deep`, at);
    return leafValue(item, key, field!, rest[1], at);
  };

  const resolve = (path: readonly string[], at: number): Quantity => {
    const [head, ...rest] = path;

    if (head === "ROLLUP") {
      if (rest.length < 2 || rest.length > 3)
        fail(`ROLLUP.${rest.join(".") || "?"} is not a roll-up value`, at);
      const rollup = rollupsOf(book).find(
        (candidate) => candidate.name === rest[0],
      );
      if (!rollup) fail(`there is no roll-up called ${rest[0]}`, at);
      return rollupValue(rollup!, rest[1], rest[2], at);
    }

    if (head === "HULL") {
      // One segment for a measurement, and optionally a second for a coordinate of one that is a PLACE:
      // `HULL.SHELL_CG.z` is a height, and `HULL.SHELL_CG` in a coordinate cell is that cell's own
      // coordinate — the same binding a point field and a cut's centroid get, so the hull's own shell weighs
      // into a centre of gravity in the same expression as everything else.
      if (rest.length < 1 || rest.length > 2)
        fail(`HULL.${rest.join(".") || "?"} is not a hull measurement`, at);
      if (!metrics)
        fail(
          "the hull has not been measured yet — it may not float at its own waterline",
          at,
        );
      if (isHullPointName(rest[0])) {
        const axis = rest.length === 2 ? rest[1] : currentCell?.leaf;
        if (axis === "x" || axis === "y" || axis === "z")
          return hullPoint(metrics!, rest[0], axis)!;
        fail(
          `HULL.${rest[0]} is a place — write HULL.${rest[0]}.x (or .y, .z), or name it in a coordinate`,
          at,
        );
      }
      if (rest.length !== 1)
        fail(`HULL.${rest.join(".") || "?"} is not a hull measurement`, at);
      const value = hullMetric(metrics!, rest[0]);
      if (!value)
        fail(
          `the hull has no measurement called ${rest[0]}${isHullMetricName(rest[0].toUpperCase()) ? ` — did you mean HULL.${rest[0].toUpperCase()}?` : ""}`,
          at,
        );
      return value!;
    }

    // What the book itself answers. An ordinary cell, so it can fail, and can be named in a cycle.
    if (head === "OUT") {
      if (rest.length !== 1)
        fail(
          `OUT.${rest.join(".") || "?"} is not one of the book's answers`,
          at,
        );
      if (!isOutputName(rest[0]))
        fail(
          `the book has no answer called ${rest[0]} — it has ${OUTPUTS.map((spec) => spec.name).join(", ")}`,
          at,
        );
      if (!cells.has(cellKey(OUTPUT_ITEM, rest[0])))
        fail(`nothing answers ${rest[0]} yet`, at);
      return valueAt(OUTPUT_ITEM, rest[0], at);
    }

    // A bare ROLE means this item's. Alongside HULL and OUT rather than after the siblings, because these are
    // the language's own names and `isReserved` keeps a field from taking one — so there is nothing to shadow.
    if (isRoleName(head)) {
      if (!currentItem)
        fail(
          `${head} means "this item's ${roleSpec(head)!.label}", and an answer belongs to no item — name the item, as in engine.${head}`,
          at,
        );
      return roleValue(currentItem!, head, rest, at);
    }

    // A SIBLING field is tried first, at both lengths it could have: `area`, and `cg.z`. The scope you are
    // standing in wins, and the alternative is always reachable by writing the item's name.
    if (currentItem) {
      const sibling = currentItem.fields[head];
      if (sibling) {
        if (rest.length === 0)
          return bareFieldValue(currentItem, head, sibling, at);
        if (rest.length === 1)
          return leafValue(currentItem, head, sibling, rest[0], at);
        fail(`${path.join(".")} is one dot too deep`, at);
      }
    }

    if (rest.length === 0) {
      const item = itemsByName.get(head);
      if (item)
        fail(
          `${head} is an item — write ${head}.something${
            Object.keys(item.fields).length
              ? ` (it has ${Object.keys(item.fields).join(", ")})`
              : ""
          }`,
          at,
        );
      const near = currentItem
        ? Object.keys(currentItem.fields).find(
            (candidate) => candidate.toLowerCase() === head.toLowerCase(),
          )
        : undefined;
      fail(
        `nothing here is called ${head}${near ? ` — did you mean ${near}?` : ""}`,
        at,
      );
    }

    const item = itemsByName.get(head);
    if (!item) fail(`there is no item called ${head}`, at);
    return fromItem(item!, rest, path, at);
  };

  const env = {
    resolve,
    /**
     * What a bare term of the cell's outermost sum is written in.
     *
     * Only a unit with a DIMENSION says anything: a field that declares nothing leaves its numbers plain, as
     * the language always has, and a dimensionless declaration has nothing to say about what a number means.
     * Read off `currentCell` rather than passed in, because one env serves every cell in the book.
     */
    get literal(): { factor: number; dim: Dim } | null {
      const unit = currentCell?.declared;
      return unit && !isDimless(unit.dim)
        ? { factor: unit.factor, dim: unit.dim }
        : null;
    },
    source: (lo: number, hi: number): Source => {
      const cell = currentCell!;
      const at = cellKey(
        cell.item?.id ?? OUTPUT_ITEM,
        cell.fieldKey,
        cell.leaf,
      );
      const id = `s${sourceSeq++}`;
      // The cell key rides along with the label so a ranking can be FOLLOWED and not merely read: the
      // inspector turns a driver into the cell it was typed in, which is the whole point of naming it.
      const source: Source = { id, label: describe(at), at, lo, hi };
      sources.set(id, source);
      return source;
    },
  };

  /**
   * Apply the field's unit.
   *
   * A DIMENSIONLESS formula is scaled and stamped: `26` in a field marked `t` is 26000 kg. A formula that
   * already carries a dimension — because it touched `HULL.SHELL_AREA` or another stamped value — is already
   * in base units, so a matching unit is a DISPLAY choice handled at render time, and a mismatched one is a
   * warning rather than a refusal.
   */
  const stamp = (value: Quantity, cell: Cell): Quantity => {
    const unit = cell.declared;
    if (!unit || (unit.dim.m === 0 && unit.dim.l === 0 && unit.factor === 1))
      return value;
    const bare = value.dim.m === 0 && value.dim.l === 0;
    if (bare)
      return {
        v: value.v * unit.factor,
        d: Object.fromEntries(
          Object.entries(value.d).map(([id, g]) => [id, g * unit.factor]),
        ),
        dim: unit.dim,
      };
    if (value.dim.m !== unit.dim.m || value.dim.l !== unit.dim.l)
      cell.unitWarning = `this works out to ${naturalUnit(value.dim).label || "a plain number"}, not ${unit.label}`;
    return value;
  };

  const compute = (cell: Cell): void => {
    const key = cellKey(cell.item?.id ?? OUTPUT_ITEM, cell.fieldKey, cell.leaf);
    const isCutPosition = cell.field?.k === "cut" && cell.leaf === "pos";
    cell.state = "running";
    visiting.push(key);
    const savedItem = currentItem;
    const savedCell = currentCell;
    currentItem = cell.item;
    currentCell = cell;
    if (isCutPosition) cutPositionDepth++;
    try {
      if (cell.unitError) cell.error = { message: cell.unitError, at: -1 };
      else if (cell.parseError)
        cell.error = {
          message: cell.parseError.message,
          at: cell.parseError.at,
        };
      else if (cell.tree) {
        const value = stamp(evaluate(cell.tree, env), cell);
        const position = cell.field?.k === "point" || cell.field?.k === "cut";
        if (position && !sameDim(value.dim, LENGTH))
          cell.error = {
            message: `${cell.field?.k === "point" ? "a point coordinate" : "a cut position"} must be a distance, and this works out to ${naturalUnit(value.dim).label || "a plain number"}`,
            at: -1,
          };
        else cell.value = value;
      }
    } catch (error) {
      // A cell already named by a cycle keeps that message: "x could not be worked out" is true but useless
      // next to the loop itself.
      if (!cycled.has(key)) {
        cell.error =
          error instanceof FormulaError
            ? { message: error.message, at: error.at }
            : { message: String(error), at: -1 };
        cell.value = null;
      }
    } finally {
      if (isCutPosition) cutPositionDepth--;
      currentItem = savedItem;
      currentCell = savedCell;
      visiting.pop();
      cell.state = "done";
    }
  };

  for (const cell of cells.values()) if (cell.state === "fresh") compute(cell);

  // ---------- the reported shape ----------

  const results = new Map<string, CellResult>();
  for (const [key, cell] of cells) {
    // With nothing declared, the unit shown is the one the formula worked out to — which is why units appear
    // on their own the moment a value acquires a dimension, and why a plain number shows none.
    const derived = cell.value ? naturalUnit(cell.value.dim) : null;
    const unit = cell.declared ?? (derived && derived.label ? derived : null);
    // An answer that is not the kind of thing it claims to be. A warning and not a refusal, exactly as a
    // declared unit that disagrees with its formula is: the number is reported as written and flagged.
    const spec = cell.item ? undefined : outputSpec(cell.fieldKey);
    const outputWarning =
      spec && cell.value && !sameDim(cell.value.dim, spec.dim)
        ? `${spec.name} should be ${naturalUnit(spec.dim).label || "a plain number"}, and this works out to ${naturalUnit(cell.value.dim).label || "a plain number"}`
        : null;
    // The same test, for a field that has been tagged as one of the item's own values. A point's coordinates
    // are already refused unless they are lengths, so in practice this is what catches a mass that is not one.
    const role = cell.field ? roleSpec(roleOf(cell.field) ?? "") : undefined;
    const roleWarning =
      role && cell.value && !sameDim(cell.value.dim, role.dim)
        ? `an item's ${role.label} should be ${naturalUnit(role.dim).label || "a plain number"}, and this works out to ${naturalUnit(cell.value.dim).label || "a plain number"}`
        : null;
    results.set(key, {
      itemId: cell.item?.id ?? OUTPUT_ITEM,
      fieldKey: cell.fieldKey,
      leaf: cell.leaf,
      empty: !cell.source,
      reading: cell.value ? read(cell.value, sources) : null,
      quantity: cell.value,
      tree: cell.tree,
      error: cell.error?.message ?? null,
      errorAt: cell.error?.at ?? -1,
      unit,
      unitIsDerived: !cell.declared && !!unit,
      unitWarning: cell.unitWarning ?? outputWarning ?? roleWarning,
    });
  }

  const outputOf = (name: string): Reading | null => {
    const cell = cells.get(cellKey(OUTPUT_ITEM, name));
    return cell?.value ? read(cell.value, sources) : null;
  };

  return {
    cells: results,
    sources,
    outputs: {
      displacement: outputOf("DISPLACEMENT"),
      vcg: outputOf("VCG"),
      lcg: outputOf("LCG"),
    },
  };
}
