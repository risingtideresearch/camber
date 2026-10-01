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
import type { LoadingValues } from "../core/loading";
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
  readonly iterate: boolean;
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
): LoadingValues {
  const metrics = hullMetrics(model, sampling);
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
  if (!values) throw new Error(errors.join(" "));
  return values;
}

/** Run only on a button action, in a disposable worker. Each candidate has a
 * freshly measured sheet; no intermediate result is published to the document. */
export function computeLoading(request: LoadingRequest): LoadingProposal {
  const { model: initial, sampling } = requestedHull(request, {});
  let model = initial;
  let values = request.book
    ? evaluateLoading(request.book, model, sampling)
    : request.values;
  if (!values) throw new Error("Enter a positive displacement first.");
  const coupled = request.iterate && request.book !== null;
  const scale = unitScale(model.unit, "m");
  for (let iteration = 1; iteration <= (coupled ? 30 : 1); iteration++) {
    const solved = solveEquilibrium(
      model,
      sampling,
      values,
      request.density,
      request.mode,
    );
    if (!coupled) return { ...solved, iterations: iteration };
    // Damping the outer fixed-point iteration reduces oscillation in feedback
    // through HULL metrics. Convergence is judged on physical residuals, not steps.
    model = {
      ...model,
      waterline: model.waterline + 0.65 * (solved.waterline - model.waterline),
      deckTrim: model.deckTrim + 0.65 * (solved.deckTrim - model.deckTrim),
    };
    values = evaluateLoading(request.book!, model, sampling);
    const residual = equilibriumResidual(
      model,
      sampling,
      values,
      request.density,
      request.mode,
    );
    if (
      Math.abs(residual.volumeError) <= MASS_TOLERANCE &&
      (residual.balanceError === null ||
        Math.abs(residual.balanceError) <=
          loa(model) * scale * BALANCE_TOLERANCE)
    ) {
      // Validate closure, finite inputs and freeboard at the final loading too.
      solveEquilibrium(model, sampling, values, request.density, request.mode);
      return {
        waterline: model.waterline,
        deckTrim: model.deckTrim,
        values,
        ...residual,
        iterations: iteration,
      };
    }
  }
  throw new Error(
    "The sheet and floating attitude did not converge after 30 iterations. Check geometry-dependent formulas or try matching displacement only.",
  );
}
