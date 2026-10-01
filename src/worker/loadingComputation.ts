import {
  solveEquilibrium,
  equilibriumResidual,
  MASS_TOLERANCE,
  BALANCE_TOLERANCE,
  type EquilibriumMode,
  type EquilibriumResult,
} from "../core/equilibrium";
import { loa } from "../core/hull";
import { hullMetrics } from "../core/hullMetrics";
import { unitScale } from "../core/json";
import type {
  LoadingConstraints,
  LoadingPurpose,
  LoadingValues,
} from "../core/loading";
import type { Model } from "../core/model";
import type { HullSampling } from "../core/mesh";
import type { WeightBook } from "../core/sheet/book";
import { prepareBook, evaluatePreparedBook } from "../core/sheet/evaluate";
import { loadingOutputs } from "../core/sheet/loadingOutputs";
import {
  planWeightGeometry,
  resolveWeightGeometry,
} from "../editor/weightGeometryPlan";
import { createWeightGeometryProcessor } from "./weightGeometryComputation";
import { requestedHull, type HullComputationRequest } from "./hullComputation";

export interface LoadingRequest extends HullComputationRequest {
  readonly mode: EquilibriumMode;
  readonly values: LoadingValues | null;
  /** Already resolved to the selected scenario. Null for manual inputs. */
  readonly book: WeightBook | null;
  readonly density: number;
  readonly purpose: LoadingPurpose;
  readonly constraints?: LoadingConstraints;
}
export interface LoadingProposal extends EquilibriumResult {
  readonly iterations: number;
}
export type LoadingResponse =
  | {
      readonly proposal: LoadingProposal;
    }
  | { readonly error: string };

function evaluateLoading(
  book: WeightBook,
  model: Model,
  sampling: HullSampling,
  heel = 0,
  required: readonly ("lcg" | "vcg" | "tcg")[] = [],
): LoadingValues {
  const metrics = hullMetrics(model, sampling, null, heel);
  const prepared = prepareBook(book);
  const positions = evaluatePreparedBook(prepared, metrics);
  const plan = planWeightGeometry(book, positions);
  const response = createWeightGeometryProcessor(
    model,
    sampling,
  )({ key: "loading", phase: "nominal", jobs: plan.jobs });
  const geometry = resolveWeightGeometry(
    plan,
    new Map(response.results.map(({ key, result }) => [key, result])),
  );
  const results = evaluatePreparedBook(
    prepared,
    metrics,
    geometry.measurements,
    geometry.repetitions,
  );
  const { values, errors } = loadingOutputs(results);
  if (!values || required.some((key) => values[key] == null)) {
    const needed = [
      "DISPLACEMENT",
      ...required.map((key) => key.toUpperCase()),
    ];
    throw new Error(
      errors
        .filter((error) =>
          needed.some((name) => error.toUpperCase().startsWith(name)),
        )
        .join(" "),
    );
  }
  return values;
}

/** Pure private computation. A batch shares deck-fixed sampling, but every
 * scenario starts from the same authored attitude, never the preceding result. */
export function computeLoading(
  request: LoadingRequest,
  hull = requestedHull(request, {}),
): LoadingProposal {
  const { model: initial, sampling } = hull;
  let model = initial;
  let heel = 0;
  // Design balance sets the authored upright flotation, not a transverse
  // equilibrium. Off-centre loads and heel belong to scenario comparison.
  const constraints: LoadingConstraints | undefined =
    request.purpose === "balance-design"
      ? {
          trim: request.constraints
            ? request.constraints.trim
            : request.mode === "displacement"
              ? initial.deckTrim
              : null,
          heel: 0,
        }
      : request.constraints;
  const required: ("lcg" | "vcg" | "tcg")[] = [];
  if (constraints) {
    const { trim, heel } = constraints;
    if (trim === null || heel === null) required.push("vcg");
    if (
      trim === null ||
      (heel === null && Math.abs(trim - initial.deckTrim) > 1e-12)
    )
      required.push("lcg");
    if (heel === null) required.push("tcg");
  }
  let values = request.book
    ? evaluateLoading(request.book, model, sampling, 0, required)
    : request.values;
  if (!values) throw new Error("Enter a positive displacement first.");
  const coupled = request.purpose === "balance-design" && request.book !== null;
  if (!constraints && request.mode === "balance" && values.tcg != null)
    required.push("tcg");
  const scale = unitScale(model.unit, "m");
  for (let iteration = 1; iteration <= (coupled ? 30 : 1); iteration++) {
    const solved = solveEquilibrium(
      model,
      sampling,
      values,
      request.density,
      request.mode,
      heel,
      constraints,
    );
    if (!coupled) return { ...solved, iterations: iteration };
    // Damping the outer fixed-point iteration reduces oscillation in feedback
    // through HULL metrics. Convergence is judged on physical residuals, not steps.
    model = {
      ...model,
      waterline: model.waterline + 0.65 * (solved.waterline - model.waterline),
      deckTrim:
        constraints?.trim ??
        model.deckTrim + 0.65 * (solved.deckTrim - model.deckTrim),
    };
    heel = constraints?.heel ?? heel + 0.65 * (solved.heel - heel);
    values = evaluateLoading(request.book!, model, sampling, heel, required);
    const residual = equilibriumResidual(
      model,
      sampling,
      values,
      request.density,
      request.mode,
      heel,
      constraints,
    );
    if (
      Math.abs(residual.volumeError) <= MASS_TOLERANCE &&
      (residual.balanceError === null ||
        Math.abs(residual.balanceError) <=
          loa(model) * scale * BALANCE_TOLERANCE) &&
      (residual.transverseBalanceError === null ||
        Math.abs(residual.transverseBalanceError) <=
          loa(model) * scale * BALANCE_TOLERANCE)
    ) {
      // Validate closure, finite inputs and freeboard at the final loading too.
      solveEquilibrium(
        model,
        sampling,
        values,
        request.density,
        request.mode,
        heel,
        constraints,
      );
      return {
        waterline: model.waterline,
        deckTrim: model.deckTrim,
        heel,
        values,
        ...residual,
        iterations: iteration,
      };
    }
  }
  throw new Error(
    "The sheet and floating attitude did not converge after 30 iterations. Check geometry-dependent formulas or try fixing trim.",
  );
}

export interface LoadingBatchRequest extends HullComputationRequest {
  readonly purpose: LoadingPurpose;
  readonly constraints: LoadingConstraints;
  readonly entries: readonly {
    readonly id: string;
    readonly book: WeightBook;
  }[];
}
export type LoadingBatchResponse = LoadingResponse & {
  readonly key: string;
  readonly id: string;
};

/** Stream independent results so one invalid scenario does not hide the rest. */
export function computeLoadingBatch(
  request: LoadingBatchRequest,
  receive: (response: LoadingBatchResponse) => void,
) {
  let hull: ReturnType<typeof requestedHull>;
  try {
    hull = requestedHull(request, {});
  } catch (error) {
    for (const { id } of request.entries)
      receive({ key: request.key, id, error: String(error) });
    return;
  }
  for (const { id, book } of request.entries) {
    let result: LoadingResponse;
    try {
      result = {
        proposal: computeLoading(
          {
            ...request,
            mode: "balance",
            book,
            values: null,
            density: book.density,
          },
          hull,
        ),
      };
    } catch (error) {
      result = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    receive({ key: request.key, id, ...result });
  }
}
