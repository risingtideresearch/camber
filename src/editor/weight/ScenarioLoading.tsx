import { outputResult, type BookResults } from "../../core/sheet/evaluate";
import { LENGTH, MASS, sameDim } from "../../core/sheet/quantity";
import { sig } from "./weightFormat";

/** A read-only view of the weight editor's scenario, never the analysis selection. */
export function ScenarioLoading({
  results,
  scenarioName,
  density,
}: {
  readonly results: BookResults;
  readonly scenarioName: string;
  readonly density: number;
}) {
  const fields = [
    {
      key: "DISPLACEMENT",
      label: "Displacement",
      unit: "t",
      factor: 1000,
      dim: MASS,
    },
    { key: "LCG", label: "LCG", unit: "m", factor: 1, dim: LENGTH },
    { key: "VCG", label: "VCG", unit: "m", factor: 1, dim: LENGTH },
  ];
  return (
    <div
      className="loading-values"
      role="group"
      aria-label={`${scenarioName} loading values`}
    >
      {fields.map(({ key, label, unit, factor, dim }) => {
        const cell = outputResult(results, key);
        const quantity = cell?.quantity;
        const valid =
          !cell?.error &&
          !cell?.empty &&
          quantity &&
          sameDim(quantity.dim, dim) &&
          Number.isFinite(quantity.v) &&
          (key !== "DISPLACEMENT" || quantity.v > 0);
        return (
          <div className="loading-value" key={key}>
            <span>{label}</span>
            <strong>
              {valid ? sig(quantity.v / factor) : "—"} {unit}
            </strong>
            {!valid && (
              <small>
                {cell?.error ??
                  (cell?.empty || !cell
                    ? "No output formula."
                    : key === "DISPLACEMENT" && quantity && quantity.v <= 0
                      ? "Displacement must be positive."
                      : "No valid value available.")}
              </small>
            )}
          </div>
        );
      })}
      <div className="loading-value">
        <span>Water density</span>
        <strong>{sig(density * 1000)} kg/m³</strong>
      </div>
    </div>
  );
}
