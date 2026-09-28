import type { GeometryOperation } from "./operations";
import { validateLimits, type SectionLimits } from "./boundaries";
import type { CutField, RepetitionField, SliceShape } from "./book";
import {
  createPreparedBookEvaluator,
  literalSourceId,
  type PreparedBook,
} from "./evaluate";
import type { Node } from "./formula";
import type { HullMetrics } from "../hullMetrics";
import type { Dim, Source } from "./quantity";
import { measureRepetitionLayout, type RepetitionLayout } from "./repetitions";
import type { SectionMeasures } from "./sectionMeasures";
import { sliceMeasurementKey } from "./slices";

/** JSON-replayable inputs for one world. No seed or RNG belongs in evaluation.
 * Replay with the same authored book revision, hull and geometry settings.
 * Offsets use authored literal units, before unit stamping; phases lie in [0,1).
 */
export interface Trial {
  readonly index: number;
  readonly inputOffsets: Readonly<Record<string, number>>;
  readonly repetitionPhases: Readonly<Record<string, number>>;
}
interface GeometryField {
  readonly itemId: string;
  readonly key: string;
  readonly id: string;
  readonly field: CutField | RepetitionField;
}
export interface TrialPlan {
  readonly prepared: PreparedBook;
  readonly sources: readonly Source[];
  readonly geometryFields: readonly GeometryField[];
  readonly repetitionIds: readonly string[];
}

/** Discover ALL literal inputs from syntax, including those behind invalid nominal
 * geometry or branches. Never derive the sampling schema from gradients at one point.
 */
export function prepareTrials(prepared: PreparedBook): TrialPlan {
  const sources: Source[] = [];
  const visit = (node: Node, key: string) => {
    if (node.k === "spread" && (node.lo || node.hi))
      sources.push({
        id: literalSourceId(key, node.at),
        label: key,
        at: key,
        lo: node.lo,
        hi: node.hi,
        distribution: node.distribution,
      });
    if (node.k === "bin") {
      visit(node.a, key);
      visit(node.b, key);
    }
    if (node.k === "neg" || node.k === "pct") visit(node.a, key);
    if (node.k === "call") node.args.forEach((arg) => visit(arg, key));
  };
  for (const [key, cell] of prepared.cells)
    if (cell.tree) visit(cell.tree, key);
  const geometryFields: GeometryField[] = prepared.book.items.flatMap((item) =>
    Object.entries(item.fields).flatMap(([key, field]) =>
      field.k === "cut" || field.k === "repetition"
        ? [
            {
              itemId: item.id,
              key,
              id: sliceMeasurementKey(item.id, key),
              field,
            },
          ]
        : [],
    ),
  );
  return {
    prepared,
    sources: sources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    geometryFields,
    repetitionIds: geometryFields
      .filter(({ field }) => field.k === "repetition")
      .map(({ id }) => id)
      .sort(),
  };
}
export interface SectionRequest {
  readonly shape: SliceShape;
  readonly position: number;
  readonly limits: SectionLimits;
}
export interface LayoutRequest {
  readonly shape: SliceShape;
  readonly start: number;
  readonly end: number;
  readonly pitch: number;
  readonly phase: number;
  readonly limits: SectionLimits;
}
export type LayoutMeasures = Pick<RepetitionLayout, "measures"> &
  Partial<Pick<RepetitionLayout, "count">>;
/** Deterministic geometry contract. A backend owns its fixed hull and numerical
 * settings; caches may reuse equivalent requests, but never pick a phase or input.
 */
export interface TrialGeometry {
  section(request: SectionRequest): SectionMeasures;
  layout(request: LayoutRequest): LayoutMeasures;
}
export function directTrialGeometry(
  section: TrialGeometry["section"],
  maxMembers = 8192,
): TrialGeometry {
  return {
    section,
    layout: (request) =>
      measureRepetitionLayout(
        (shape, position, limits = {}) => ({
          measures: section({ shape, position, limits }),
        }),
        { ...request, maxMembers },
      ),
  };
}
export interface TrialValue {
  readonly value: number | null;
  readonly dim: Dim | null;
  readonly error: string | null;
}

function validateTrial(plan: TrialPlan, trial: Trial): void {
  if (!Number.isSafeInteger(trial.index) || trial.index < 0)
    throw new Error("Invalid trial index");
  const check = (
    values: Readonly<Record<string, number>>,
    expected: readonly string[],
    phase: boolean,
  ) => {
    const wanted = new Set(expected);
    for (const id of expected) {
      if (
        !Object.prototype.hasOwnProperty.call(values, id) ||
        !Number.isFinite(values[id])
      )
        throw new Error(`Missing or invalid trial input: ${id}`);
      if (phase && (values[id] < 0 || values[id] >= 1))
        throw new Error(`Trial phase must be in [0,1): ${id}`);
    }
    for (const id of Object.keys(values))
      if (!wanted.has(id)) throw new Error(`Unknown trial input: ${id}`);
  };
  check(
    trial.inputOffsets,
    plan.sources.map((s) => s.id),
    false,
  );
  check(trial.repetitionPhases, plan.repetitionIds, true);
}

/** No randomness, quadrature weights or statistics. Full-book replay and targeted
 * sampling use the same lazy world; omitting targets requests every prepared cell.
 * Geometry is measured once on demand, and geometry-to-geometry dependencies
 * remain forbidden in both modes.
 */
export function evaluateTrial(
  plan: TrialPlan,
  trial: Trial,
  geometry?: TrialGeometry,
  metrics: HullMetrics | null = null,
  targets?: readonly string[],
) {
  return createTrialEvaluator(plan, trial, geometry, metrics)(targets);
}

/** Keep the mapped cells of one immutable trial alive across requested reductions.
 * Omit targets to request all cells; an empty list requests none.
 */
export function createTrialEvaluator(
  plan: TrialPlan,
  trial: Trial,
  geometry?: TrialGeometry,
  metrics: HullMetrics | null = null,
) {
  validateTrial(plan, trial);
  const cutMeasures = new Map<string, SectionMeasures>();
  const repetitionLayouts = new Map<string, LayoutMeasures>();
  const geometryErrors = new Map<string, string>();
  const requests = new Map<string, SectionRequest | LayoutRequest>();
  const ensureGeometry = (
    operation: GeometryOperation,
    readInput: (leaf: string) => number,
    limits: SectionLimits,
  ) => {
    const { item, key, field } = operation;
    const id = sliceMeasurementKey(item.id, key);
    if (requests.has(id) || geometryErrors.has(id)) return;
    try {
      if (!geometry) throw new Error("Trial geometry backend is unavailable");
      validateLimits(limits);
      const input = (leaf: string): number => {
        const value = readInput(leaf);
        if (!Number.isFinite(value))
          throw new Error(`Invalid geometry input ${leaf}`);
        return value;
      };
      if (field.k === "cut") {
        const request = {
          shape: field.shape,
          position: input("pos"),
          limits,
        };
        requests.set(id, request);
        cutMeasures.set(id, geometry.section(request));
      } else {
        const start = input("start"),
          end = input("end"),
          repeat = input(field.repetition);
        if (!(end > start) || !(repeat > 0))
          throw new Error(
            "Trial repetition needs positive spacing/count and From less than To",
          );
        const request = {
          shape: field.shape,
          start,
          end,
          pitch:
            field.repetition === "spacing" ? repeat : (end - start) / repeat,
          phase: trial.repetitionPhases[id],
          limits,
        };
        if (!Number.isFinite(request.pitch) || request.pitch <= 0)
          throw new Error("Invalid trial pitch");
        requests.set(id, request);
        repetitionLayouts.set(id, geometry.layout(request));
      }
    } catch (error) {
      geometryErrors.set(
        id,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const evaluate = createPreparedBookEvaluator(
    plan.prepared,
    metrics,
    undefined,
    undefined,
    {
      inputOffsets: new Map(Object.entries(trial.inputOffsets)),
      // Preserve authored algebraic validity checks (e.g. uncertain powers).
      // Trials report scalar values, never these internal gradients/readings.
      retainInputGradients: true,
      cutMeasures,
      repetitionLayouts,
      geometryErrors,
      ensureGeometry,
    },
  );
  return (targets?: readonly string[]) => {
    const results = evaluate(targets);
    const values = new Map<string, TrialValue>(
      [...results.cells].map(([key, cell]) => {
        const v = cell.quantity?.v;
        const error =
          cell.error ??
          (v !== undefined && !Number.isFinite(v) ? "non-finite value" : null);
        return [
          key,
          {
            value: error ? null : (v ?? null),
            dim: cell.quantity?.dim ?? null,
            error,
          },
        ];
      }),
    );
    return { values, requests, cutMeasures, repetitionLayouts, geometryErrors };
  };
}
