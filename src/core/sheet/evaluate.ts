import { cellKey, OUTPUT_ITEM } from "./addresses";
export { cellKey, OUTPUT_ITEM } from "./addresses";
import {
  createOperationCompiler,
  type GeometryOperation,
  type MeasureOperation,
  type ValueOperation,
} from "./operations";
import {
  affectedCells,
  buildDependencyGraph,
  type DependencyGraph,
} from "./dependencyGraph";
import { createReferenceBinder, type BoundReference } from "./bindings";
import { validateLimits, type SectionLimits } from "./boundaries";
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
// Preparation binds names and compiles value operations plus a dependency graph. Execution remains
// depth-first with a visiting set: cycles are reported when reached, without preventing unrelated cells
// from evaluating. The graph retains invalid cycles too, rather than rejecting the entire authored book.

import {
  GEOMETRY_LEAVES,
  geometryValue,
  type Measure,
  type SectionMeasures,
} from "./sectionMeasures";
import type { RepetitionMeasurements, RepetitionLayout } from "./repetitions";
import { evaluate, FormulaError, parseFormula, type Node } from "./formula";
import {
  hullMetric,
  hullPoint,
  isHullMetricName,
  isHullPointName,
  type HullMetrics,
} from "../hullMetrics";
import {
  AREA,
  DIMLESS,
  combine,
  sub,
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
  lookupRole,
  leafOf,
  leavesOf,
  roleOf,
  rollupsOf,
  symbolsOf,
  type Field,
  type FieldLeaf,
  type Item,
  type CellRef,
  type WeightBook,
} from "./book";
import { OUTPUTS, outputSpec } from "./outputs";
import { ROLES, roleSpec } from "./roles";
import { naturalUnit, parseUnit, UnitError, type UnitSpec } from "./units";
import { sliceMeasurementKey, type SliceMeasurements } from "./slices";

/** One evaluated cell. */
export interface CellResult {
  readonly itemId: string;
  readonly fieldKey: string;
  /** Which cell of the field this is. A scalar has only `"formula"`; a point has three. */
  readonly leaf: string;
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
  /** Revision-local name bindings, including authored occurrence locations. */
  readonly references: ReadonlyMap<number, BoundReference>;
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
  /** At least one returned reading is waiting for geometry uncertainty.
   * Presentation must use each reading's flag, not suppress the entire book. */
  readonly uncertaintyPending?: boolean;
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

export const resultAt = (
  results: BookResults,
  itemId: string,
  fieldKey: string,
  leaf: string = "formula",
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
 * break". Read off the bindings preparation already built rather than by re-parsing.
 * Unparseable formulas and unresolved names contribute no direct field references.
 *
 * Uses the same revision-local bindings as evaluation, including role aliases and
 * local shadowing. These are direct field references, not transitive dependencies
 * or rollup membership edges. Multiple coordinates count once per using field.
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
    for (const { binding } of cell.references.values()) {
      const key =
        binding.k === "field" && binding.item.id === itemId
          ? binding.key
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
    const namesTarget = [...cell.references.values()].some(
      ({ binding }) =>
        binding.k === "field" &&
        binding.item.id === itemId &&
        binding.key === fieldKey,
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
        leaf: sharedDerivation ? "from" : (cell.leaf as FieldLeaf),
        address,
      });
  }
  return [...found.values()];
}

/** A named facet rollup to which this field contributes through its role. */
export interface FieldRollupUse {
  readonly rollupId: string;
  readonly facetKey: string;
  readonly facetValue: string;
  readonly address: string;
  readonly roleLabel: string;
  /** Whether this field supplies the value or the weight of a weighted mean. */
  readonly as: "value" | "weight";
}

/**
 * Rollup contributions are structural, not formula references. A field participates only when its item
 * belongs to the named facet subtree and its role is selected by that rollup's aggregation. A weighted mean
 * requires both the value and its weight on the item; otherwise it has no entry to aggregate. This does not
 * require a successful reading or a formula naming the rollup.
 */
export function fieldRollupUses(
  book: WeightBook,
  itemId: string,
  fieldKey: string,
): readonly FieldRollupUse[] {
  const item = book.items.find((candidate) => candidate.id === itemId);
  if (!item?.fields[fieldKey]) return [];
  const uses: FieldRollupUse[] = [];
  for (const rollup of rollupsOf(book)) {
    if (!facetContains(rollup.facetValue, item.facets[rollup.facetKey] ?? ""))
      continue;
    for (const spec of ROLES) {
      if (spec.aggregation.k === "none") continue;
      const value = lookupRole(item, spec.name);
      if (value.k !== "one" || !spec.kinds.includes(value.field.k)) continue;
      let weightKey: string | null = null;
      if (spec.aggregation.k === "weightedMean") {
        const weightSpec = roleSpec(spec.aggregation.weight);
        const weight = lookupRole(item, spec.aggregation.weight);
        if (
          !weightSpec ||
          weight.k !== "one" ||
          !weightSpec.kinds.includes(weight.field.k)
        )
          continue;
        weightKey = weight.key;
      }
      const as =
        value.key === fieldKey
          ? "value"
          : weightKey === fieldKey
            ? "weight"
            : null;
      if (as)
        uses.push({
          rollupId: rollup.id,
          facetKey: rollup.facetKey,
          facetValue: rollup.facetValue,
          address: `ROLLUP.${rollup.name}.${spec.name}`,
          roleLabel: spec.label,
          as,
        });
    }
  }
  return uses;
}

/** One of the book's answers, as an evaluated cell — what the summary view renders and edits. */
export const outputResult = (
  results: BookResults,
  name: string,
): CellResult | undefined => results.cells.get(cellKey(OUTPUT_ITEM, name));

// ---------- the evaluator ----------

/** Immutable definition shared by every evaluation of one book revision. */
export interface PreparedCell {
  /** Null on one of the book's answers, which belongs to no item and has no siblings. */
  readonly item: Item | null;
  readonly fieldKey: string;
  readonly field: Field | null;
  readonly leaf: string;
  readonly source: string;
  /** Parsed once, whatever it is referenced from. */
  readonly tree: Node | null;
  readonly parseError: FormulaError | null;
  readonly declared: UnitSpec | null;
  readonly unitError: string | null;
  readonly measuredLeaf?: string;
  readonly references: ReadonlyMap<number, BoundReference>;
  readonly operations: ReadonlyMap<number, ValueOperation>;
  readonly measurement?: MeasureOperation;
}

/** Mutable state belongs to one world, never to the prepared book. */
interface Cell extends PreparedCell {
  state: "fresh" | "running" | "done";
  value: Quantity | null;
  error: { message: string; at: number } | null;
  unitWarning: string | null;
  /** This cell's dependency graph reaches a geometry-derived cut leaf. */
  usesSliceMeasurement: boolean;
}

/** Stable within an authored formula revision; also used to enumerate trial inputs. */
export const literalSourceId = (cell: string, literalAt?: number): string =>
  JSON.stringify([cell, literalAt]);

export interface PreparedBook {
  readonly book: WeightBook;
  readonly cells: ReadonlyMap<string, PreparedCell>;
  readonly graph: DependencyGraph;
}

/** Prepare one immutable book revision, without allocating runtime evaluation state. */
export function prepareBook(book: WeightBook): PreparedBook {
  if (
    !book.scenarioContext &&
    ((book.scenarios?.length ?? 1) > 1 ||
      book.items.some(
        (item) =>
          item.applicability?.k === "only" ||
          Object.values(item.fields).some(
            (field) =>
              field.applicability?.k === "only" ||
              Object.keys(field.overrides ?? {}).length,
          ),
      ))
  ) {
    throw new Error(
      "Resolve a scenario before evaluating a scenario-aware book",
    );
  }
  const cells = new Map<string, PreparedCell>();
  const symbols = symbolsOf(book);
  const bindReferences = createReferenceBinder(book);
  const compiler = createOperationCompiler(book);

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
    leaf: string,
    text: string,
    unit: string,
    measuredLeaf?: string,
  ): void => {
    const declaration = declare(unit);
    const position =
      !measuredLeaf &&
      (field?.k === "point" ||
        field?.k === "cut" ||
        (field?.k === "repetition" && leaf !== "count"));
    // Positions have a known dimension independent of their formula. A mass unit on a scalar is useful; on
    // a coordinate it would make geometry interpret kilograms as metres, so refuse it at the cell boundary.
    const unitError =
      declaration.unitError ??
      (position &&
      declaration.declared &&
      !sameDim(declaration.declared.dim, LENGTH)
        ? `${field.k === "point" ? "point coordinates" : field.k === "repetition" ? "repetition bounds and spacing" : "cut positions"} must use a distance unit — try m, cm, mm, in, or ft`
        : null);
    const declared = declaration.declared;
    let tree: Node | null = null;
    let parseError: FormulaError | null = null;
    const trimmed = text.trim();
    if (trimmed && !measuredLeaf) {
      try {
        tree = parseFormula(trimmed, symbols);
      } catch (error) {
        parseError =
          error instanceof FormulaError
            ? error
            : new FormulaError(String(error));
      }
    }
    const references = bindReferences(tree, item);
    cells.set(cellKey(item?.id ?? OUTPUT_ITEM, fieldKey, leaf), {
      item,
      fieldKey,
      field,
      leaf,
      measuredLeaf,
      source: trimmed,
      tree,
      references,
      operations: new Map(
        [...references].map(([at, reference]) => [
          at,
          compiler.reference(reference.binding, leaf),
        ]),
      ),
      measurement:
        measuredLeaf &&
        item &&
        (field?.k === "cut" || field?.k === "repetition")
          ? compiler.measure(item, fieldKey, field, measuredLeaf)
          : undefined,
      parseError,
      declared,
      unitError,
    });
  };

  // One cell per LEAF, not per field: a scalar contributes one, a point three, a cut one.
  for (const item of book.items)
    for (const [key, field] of Object.entries(item.fields)) {
      // A derived point states its three coordinates once. It still produces THREE cells — the same three
      // keys everything downstream reads — and they simply all read from the one expression, evaluated once
      // per axis by the operation compiler, keeping implicit coordinates explicit at runtime.
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
          field.k === "repetition" && leaf === "count" ? "" : fieldUnit(field),
        );
      if (field.k === "cut" || field.k === "repetition")
        for (const leaf of [
          ...GEOMETRY_LEAVES,
          ...(field.k === "repetition" ? ["equivalentCount"] : []),
        ])
          // Measured addresses are read-only results, never authored command leaves.
          addCell(item, key, field, leaf, "[measured]", "", leaf);
    }

  // The book's own answers, as cells in the same space. They declare no unit — an output is whatever its
  // formula works out to, and `outputSpec` says what that ought to be.
  for (const spec of OUTPUTS)
    if ((book.outputs[spec.name] ?? "").trim())
      addCell(null, spec.name, null, "formula", book.outputs[spec.name], "");

  return { book, cells, graph: buildDependencyGraph(cells) };
}

export interface EvaluationOptions {
  /** Exact section results and failures supplied by deterministic trial geometry. */
  readonly cutMeasures?: ReadonlyMap<string, SectionMeasures>;
  readonly geometryErrors?: ReadonlyMap<string, string>;
  /** Preserve algebraic exactness checks (e.g. uncertain dimensioned powers).
   * Trial consumers read scalar values, never these internal gradients/readings.
   */
  readonly retainInputGradients?: boolean;
  /** Realized totals for scalar trials, keyed by sliceMeasurementKey. No density
   * scaling or placement discrepancy is applied to these already-summed measures.
   */
  readonly repetitionLayouts?: ReadonlyMap<
    string,
    Pick<RepetitionLayout, "measures">
  >;
  /** Experimental scalar mode: offsets in authored literal units, keyed by source identity.
   * Callers must validate authored semantics in a nominal pass before sampling.
   */
  readonly inputOffsets?: ReadonlyMap<string, number>;
  /** Evaluate only these cells and their transitive dependencies. Omit for the full book. */
  readonly targets?: readonly string[];
  /** Trial geometry is requested only when a measured leaf is reached. */
  readonly ensureGeometry?: (
    geometry: GeometryOperation,
    input: (leaf: string) => number,
    limits: SectionLimits,
  ) => void;
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
  repetitionMeasurements: RepetitionMeasurements = new Map(),
): BookResults {
  return evaluatePreparedBook(
    prepareBook(book),
    metrics,
    sliceMeasurements,
    repetitionMeasurements,
  );
}

export function evaluatePreparedBook(
  prepared: PreparedBook,
  metrics: HullMetrics | null,
  sliceMeasurements: SliceMeasurements = new Map(),
  repetitionMeasurements: RepetitionMeasurements = new Map(),
  options: EvaluationOptions = {},
): BookResults {
  return createPreparedBookEvaluator(
    prepared,
    metrics,
    sliceMeasurements,
    repetitionMeasurements,
    options,
  )(options.targets);
}

/** One mapped world. Its computed cells and geometry-derived sources survive
 * subsequent requests; each reduction reports only the requested cells. */
export function createPreparedBookEvaluator(
  prepared: PreparedBook,
  metrics: HullMetrics | null,
  sliceMeasurements: SliceMeasurements = new Map(),
  repetitionMeasurements: RepetitionMeasurements = new Map(),
  options: EvaluationOptions = {},
): (targets?: readonly string[]) => BookResults {
  // A world allocates runtime state for a cell only on first use. Retained trial maps
  // therefore cost proportional to visited dependencies, not sheet size.
  const cells = new Map<string, Cell>();
  const getCell = (key: string): Cell | undefined => {
    let cell = cells.get(key);
    if (!cell) {
      const source = prepared.cells.get(key);
      if (!source) return undefined;
      cell = {
        ...source,
        state: "fresh",
        value: null,
        error: null,
        unitWarning: null,
        usesSliceMeasurement: false,
      };
      cells.set(key, cell);
    }
    return cell;
  };
  const sources = new Map<string, Source>();
  let sourceSeq = 0;
  // Mutually exclusive placement samples retain the existing derivative-mode grouping.
  const repetitionPhaseSources = new Map<string, readonly Source[]>();
  // Pending geometry taints only its downstream cells, not its authored inputs
  // or unrelated outputs. The graph is conservative across algebraic cancellation.
  const pendingGeometry: string[] = [];
  if (
    [...sliceMeasurements.values()].some((m) => m.uncertaintyPending) ||
    [...repetitionMeasurements.values()].some(
      (r) => r.value?.uncertaintyPending,
    )
  ) {
    for (const [id, node] of prepared.graph.nodes) {
      if (node.k !== "geometry") continue;
      const { item, key, field } = node.operation;
      const measurementKey = sliceMeasurementKey(item.id, key);
      const pending =
        field.k === "cut"
          ? !options.cutMeasures?.has(measurementKey) &&
            sliceMeasurements.get(measurementKey)?.uncertaintyPending
          : !options.repetitionLayouts?.has(measurementKey) &&
            repetitionMeasurements.get(measurementKey)?.value
              ?.uncertaintyPending;
      if (pending) pendingGeometry.push(id);
    }
  }
  const pendingCells = affectedCells(prepared.graph, pendingGeometry);

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
    const cell = getCell(key);
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
  let currentCell: Cell | null = null;
  // Preserve the authored geometry-input policy: no geometry-to-geometry inputs,
  // even when the compiled graph is acyclic. Track indirect and cached reads too;
  // accepting acyclic geometry chaining is a separate language change.
  let cutPositionDepth = 0;

  const valueAt = (
    itemId: string,
    fieldKey: string,
    at: number,
    leaf: string = "formula",
  ): Quantity => {
    const key = cellKey(itemId, fieldKey, leaf);
    const cell = getCell(key);
    if (!cell) fail("no such value", at);
    if (cell!.state === "running") {
      const loop = visiting.slice(visiting.indexOf(key));
      const text = `this refers back to itself: ${[...loop, key].map(describe).join(" → ")}`;
      for (const member of loop) {
        cycled.add(member);
        const onLoop = getCell(member)!;
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

  /** Execute one normalized measured projection. Names, aliases, and geometry
   * input schemas were resolved during preparation, independently of this world. */
  const measureValue = (operation: MeasureOperation, at: number): Quantity => {
    const { geometry, leaf } = operation;
    const { item, key, field } = geometry;
    currentCell!.usesSliceMeasurement = true;
    if (cutPositionDepth > 0)
      fail(
        "a cut position or repetition input cannot depend on measured cut values or repetitions",
        at,
      );
    const boundaryInputs = geometry.boundaries.map((boundary) => ({
      boundary,
      input: valueAt(item.id, key, at, boundary.leaf),
    }));
    try {
      validateLimits(
        Object.fromEntries(
          boundaryInputs.map(({ boundary, input }) => [boundary.leaf, input.v]),
        ),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), at);
    }
    const limits = Object.fromEntries(
      boundaryInputs.map(({ boundary, input }) => [boundary.leaf, input.v]),
    );
    if (field.k === "cut" && options.ensureGeometry)
      options.ensureGeometry(
        geometry,
        (inputLeaf) => valueAt(item.id, key, at, inputLeaf).v,
        limits,
      );
    const geometryError = options.geometryErrors?.get(
      sliceMeasurementKey(item.id, key),
    );
    if (
      geometryError &&
      !(field.k === "repetition" && leaf === "equivalentCount")
    )
      fail(geometryError, at);
    if (field.k === "cut") {
      const cutMeasures = options.cutMeasures?.get(
        sliceMeasurementKey(item.id, key),
      );
      if (cutMeasures) {
        valueAt(item.id, key, at, "pos");
        return exact(
          geometryValue(cutMeasures, leaf),
          leaf === "area" ? AREA : LENGTH,
        );
      }
      const measured = sliceMeasurements.get(sliceMeasurementKey(item.id, key));
      if (!measured)
        return fail(
          `${item.name}.${key} has not produced a valid hull cut`,
          at,
        );
      const position = valueAt(item.id, key, at, "pos");
      let boundaryGradient = {};
      for (const { boundary, input } of boundaryInputs) {
        const slope = measured.boundaryDerivatives?.[boundary.leaf]?.[leaf];
        if (
          !measured.uncertaintyPending &&
          !Number.isFinite(slope) &&
          Object.keys(input.d).length
        )
          fail(
            `${boundary.label} boundary uncertainty crosses an undefined centroid or geometry transition`,
            at,
          );
        boundaryGradient = combine(
          boundaryGradient,
          1,
          input.d,
          Number.isFinite(slope) ? slope! : 0,
        );
      }
      currentCell!.unitWarning ??= measured.warning ?? null;
      const slope = measured.geometryDerivative[leaf];
      if (
        !measured.uncertaintyPending &&
        !Number.isFinite(slope) &&
        Object.keys(position.d).length
      )
        fail(
          "Cut uncertainty crosses an undefined centroid or geometry transition",
          at,
        );
      return {
        v: geometryValue(measured.measures, leaf),
        d: combine(
          position.d,
          Number.isFinite(slope) ? slope : 0,
          boundaryGradient,
          1,
        ),
        dim: leaf === "area" ? AREA : LENGTH,
      };
    }
    const start = valueAt(item.id, key, at, "start"),
      end = valueAt(item.id, key, at, "end");
    const repeat = valueAt(item.id, key, at, field.repetition);
    if (!sameDim(repeat.dim, field.repetition === "count" ? DIMLESS : LENGTH))
      fail(
        "Equivalent count must be dimensionless and spacing must be a distance",
        at,
      );
    if (!Number.isFinite(repeat.v) || repeat.v <= 0 || end.v <= start.v)
      fail(
        options.inputOffsets
          ? "Trial repetition needs positive spacing/count and From less than To"
          : "section repetition needs positive spacing/count and From less than To",
        at,
      );
    const span = sub(end, start);
    const density =
      field.repetition === "count" ? div(repeat, span) : div(exact(1), repeat);
    const reach = read(repeat, sources).worst;
    const spanReach = read(span, sources).worst;
    if (repeat.v - reach.lo <= 0 || span.v - spanReach.lo <= 0)
      currentCell!.unitWarning ??=
        "The input uncertainty reaches zero spacing/count or reversed bounds; this local approximation is unreliable";
    if (leaf === "equivalentCount")
      return field.repetition === "count" ? repeat : div(span, repeat);
    if (options.ensureGeometry)
      options.ensureGeometry(
        geometry,
        (inputLeaf) => valueAt(item.id, key, at, inputLeaf).v,
        limits,
      );
    const trialGeometryError = options.geometryErrors?.get(
      sliceMeasurementKey(item.id, key),
    );
    if (trialGeometryError) fail(trialGeometryError, at);
    const layout = options.repetitionLayouts?.get(
      sliceMeasurementKey(item.id, key),
    );
    if (layout) {
      if (
        !options.inputOffsets &&
        [start, end, repeat, ...boundaryInputs.map(({ input }) => input)].some(
          (q) => Object.keys(q.d).length,
        )
      )
        fail("Realized layouts require exact trial geometry inputs", at);
      return exact(
        geometryValue(layout.measures, leaf),
        leaf === "area" ? AREA : LENGTH,
      );
    }
    const result = repetitionMeasurements.get(
      sliceMeasurementKey(item.id, key),
    );
    if (!result?.value)
      return fail(
        result?.error ??
          `${item.name}.${key} has not produced a valid repetition`,
        at,
      );
    const measured = result.value;
    const boundaries = boundaryInputs.map(({ boundary, input }) => {
      const derivative = measured.boundaryDerivatives?.[boundary.leaf];
      if (
        !measured.uncertaintyPending &&
        Object.keys(input.d).length &&
        !derivative
      )
        fail(
          `${boundary.label} boundary uncertainty has not produced a valid sensitivity`,
          at,
        );
      return { input, derivative };
    });
    currentCell!.unitWarning ??= measured.warning ?? null;
    const name = leaf.split(".")[0].replace(/Cg$/, "") as
      "area" | "openLength" | "closedLength";
    const integral = measured.integrals[name],
      a = measured.start[name],
      b = measured.end[name];
    const lift = (get: (m: Measure) => number, dim: Dim): Quantity => ({
      v: get(integral),
      d: boundaries.reduce(
        (gradient, { input, derivative }) =>
          combine(gradient, 1, input.d, derivative ? get(derivative[name]) : 0),
        combine(start.d, -get(a), end.d, get(b)),
      ),
      dim,
    });
    const amountDim = name === "area" ? { m: 0, l: 3 } : AREA;
    const amount = lift((m) => m.amount, amountDim);
    let nominal: Quantity;
    if (!leaf.includes(".")) nominal = mul(density, amount);
    else {
      if (amount.v === 0)
        fail(
          `${leaf.split(".")[0]} is undefined because its measure is zero`,
          at,
        );
      const axis = ["x", "y", "z"].indexOf(leaf.split(".")[1]);
      // Density cancels analytically: shared spacing/count uncertainty cannot move CG.
      nominal = div(
        lift((m) => m.moment[axis], { m: 0, l: amountDim.l + 1 }),
        amount,
      );
    }

    const phases = measured.phaseTotals;
    if (!phases?.length) return nominal;
    const phaseKey = sliceMeasurementKey(item.id, key);
    let phaseSources = repetitionPhaseSources.get(phaseKey);
    if (!phaseSources) {
      const group = `repetition-phase:${phaseKey}`;
      const target = cellKey(item.id, key, field.repetition);
      phaseSources = phases.map((phase) => {
        const source: Source = {
          id: `s${sourceSeq++}`,
          sample: { group, weight: phase.weight },
          label: `${item.name}.${key} — placement uncertainty`,
          at: target,
          lo: 1,
          hi: 1,
        };
        sources.set(source.id, source);
        return source;
      });
      repetitionPhaseSources.set(phaseKey, phaseSources);
    }
    // Linearize the centroid from amount and moment together. This makes
    // amount * centroid recover the same first-order moment deviations.
    if (leaf.includes(".") && phases.some((p) => p.measures[name].amount === 0))
      fail(
        "Placement centroid is undefined for an empty sampled layout; increase the repetition extent or repetition density",
        at,
      );
    const approximation = Object.fromEntries(
      phases.map((phase, i) => {
        const m = phase.measures[name];
        const delta = !leaf.includes(".")
          ? m.amount - nominal.v
          : (m.moment[["x", "y", "z"].indexOf(leaf.split(".")[1])] -
              nominal.v * m.amount) /
            (amount.v * density.v);
        return [phaseSources![i].id, delta];
      }),
    );
    return {
      ...nominal,
      d: combine(nominal.d, 1, approximation, 1),
    };
  };

  const operationValue = (operation: ValueOperation, at: number): Quantity => {
    switch (operation.k) {
      case "error":
        return fail(operation.message, at);
      case "cell":
        return valueAt(
          operation.itemId,
          operation.fieldKey,
          at,
          operation.leaf,
        );
      case "measure":
        return measureValue(operation, at);
      case "sum": {
        const values = operation.terms.map((term) => operationValue(term, at));
        return values.reduce(add, exact(0, operation.dim));
      }
      case "weightedMean": {
        const entries = operation.entries.map((entry) => {
          if (entry.k === "error") return fail(entry.message, at);
          return {
            weight: operationValue(entry.weight, at),
            value: operationValue(entry.value, at),
          };
        });
        const total = entries
          .map((entry) => entry.weight)
          .reduce(add, exact(0, operation.weightDim));
        if (total.v === 0) return fail(operation.zeroMessage, at);
        const moments = entries.map((entry) => mul(entry.weight, entry.value));
        return div(moments.slice(1).reduce(add, moments[0]), total);
      }
      case "hull": {
        const rest = operation.path;
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
    }
  };

  const env = {
    resolve: (_path: readonly string[], at: number): Quantity => {
      const operation = currentCell!.operations.get(at);
      if (!operation) throw new Error(`Missing prepared operation at ${at}`);
      return operationValue(operation, at);
    },
    retainInputGradients: options.retainInputGradients,
    inputOffset: options.inputOffsets
      ? (source: Source): number => {
          const offset = options.inputOffsets!.get(source.id);
          if (offset === undefined || !Number.isFinite(offset))
            throw new FormulaError(
              `Missing or invalid sampled input: ${source.id}`,
            );
          return offset;
        }
      : undefined,
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
    source: (
      lo: number,
      hi: number,
      literalAt?: number,
      distribution?: "triangular" | "normal",
    ): Source => {
      const cell = currentCell!;
      const at = cellKey(
        cell.item?.id ?? OUTPUT_ITEM,
        cell.fieldKey,
        cell.leaf,
      );
      const id = literalSourceId(at, literalAt);
      // The cell key rides along with the label so a ranking can be FOLLOWED and not merely read: the
      // inspector turns a driver into the cell it was typed in, which is the whole point of naming it.
      const source: Source = {
        id,
        label: describe(at),
        at,
        lo,
        hi,
        distribution,
      };
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
    const isCutPosition =
      !cell.measuredLeaf &&
      (cell.field?.k === "cut" || cell.field?.k === "repetition");
    cell.state = "running";
    visiting.push(key);
    const savedCell = currentCell;
    currentCell = cell;
    if (isCutPosition) cutPositionDepth++;
    try {
      if (cell.unitError) cell.error = { message: cell.unitError, at: -1 };
      else if (cell.parseError)
        cell.error = {
          message: cell.parseError.message,
          at: cell.parseError.at,
        };
      else if (cell.measurement)
        cell.value = measureValue(cell.measurement, -1);
      else if (cell.tree) {
        const value = stamp(evaluate(cell.tree, env), cell);
        const position =
          cell.field?.k === "point" ||
          cell.field?.k === "cut" ||
          (cell.field?.k === "repetition" && cell.leaf !== "count");
        if (position && !sameDim(value.dim, LENGTH))
          cell.error = {
            message: `${cell.field?.k === "point" ? "a point coordinate" : cell.field?.k === "repetition" ? "a repetition bound or spacing" : "a cut position"} must be a distance, and this works out to ${naturalUnit(value.dim).label || "a plain number"}`,
            at: -1,
          };
        else if (
          cell.field?.k === "repetition" &&
          cell.leaf === "count" &&
          !isDimless(value.dim)
        )
          cell.error = {
            message: "Equivalent count must be a dimensionless number",
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
      currentCell = savedCell;
      visiting.pop();
      cell.state = "done";
    }
  };

  return (targets?: readonly string[]): BookResults => {
    if (targets) {
      for (const key of targets) {
        const cell = getCell(key);
        if (!cell) throw new Error(`Unknown target: ${key}`);
        if (cell.state === "fresh") compute(cell);
      }
    } else {
      for (const key of prepared.cells.keys()) {
        const cell = getCell(key)!;
        if (cell.state === "fresh") compute(cell);
      }
    }

    // ---------- the reported shape ----------

    const results = new Map<string, CellResult>();
    for (const key of targets ?? prepared.cells.keys()) {
      const cell = getCell(key)!;
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
        reading: cell.value
          ? read(cell.value, sources, pendingCells.has(key))
          : null,
        quantity: cell.value,
        tree: cell.tree,
        references: cell.references,
        error: cell.error?.message ?? null,
        errorAt: cell.error?.at ?? -1,
        unit,
        unitIsDerived: !cell.declared && !!unit,
        unitWarning: cell.unitWarning ?? outputWarning ?? roleWarning,
      });
    }

    const outputOf = (name: string): Reading | null =>
      results.get(cellKey(OUTPUT_ITEM, name))?.reading ?? null;
    const uncertaintyPending = [...results.values()].some(
      (cell) => cell.reading?.uncertaintyPending,
    );

    return {
      ...(uncertaintyPending ? { uncertaintyPending: true } : {}),
      cells: results,
      sources,
      outputs: {
        displacement: outputOf("DISPLACEMENT"),
        vcg: outputOf("VCG"),
        lcg: outputOf("LCG"),
      },
    };
  };
}
