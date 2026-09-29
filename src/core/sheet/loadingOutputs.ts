import { outputResult, type BookResults } from "./evaluate";
import { LENGTH, MASS, sameDim } from "./quantity";
import type { LoadingValues } from "../loading";

/** Units on sheet outputs are advisory while editing; flotation must enforce them. */
export function loadingOutputs(results: BookResults): {
  values: LoadingValues | null;
  errors: readonly string[];
} {
  const errors: string[] = [];
  const value = (name: string, mass = false): number | null => {
    const cell = outputResult(results, name);
    if (!cell || cell.empty) {
      errors.push(`${name} has no formula. Define it in Weights.`);
      return null;
    }
    if (cell.error || !cell.quantity) {
      errors.push(`${name}: ${cell.error ?? "waiting for geometry"}`);
      return null;
    }
    if (
      !sameDim(cell.quantity.dim, mass ? MASS : LENGTH) ||
      !Number.isFinite(cell.quantity.v)
    ) {
      errors.push(`${name} must be a finite ${mass ? "mass" : "length"}.`);
      return null;
    }
    if (mass && cell.quantity.v <= 0) {
      errors.push("Displacement must be positive.");
      return null;
    }
    return cell.quantity.v;
  };
  const mass = value("DISPLACEMENT", true);
  const vcg = value("VCG");
  const lcg = value("LCG");
  return { values: mass === null ? null : { mass, vcg, lcg }, errors };
}
