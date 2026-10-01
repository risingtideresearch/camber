import type { LoadingResponse } from "../worker/loadingComputation";
import { degrees, showLoadingValue as show } from "./loadingPresentation";

export interface LoadingScenarioChoice {
  readonly id: string;
  readonly name: string;
}

/** Differences always use a successfully calculated scenario in this batch,
 * never the current model attitude or an older reference result. */
export function LoadingScenarioComparison({
  scenarios,
  results,
  scale,
  referenceId,
  onReferenceChange,
  showChanges,
  onShowChanges,
  disabled = false,
}: {
  readonly scenarios: readonly LoadingScenarioChoice[];
  readonly results: ReadonlyMap<string, LoadingResponse>;
  readonly scale: number;
  readonly referenceId: string;
  readonly onReferenceChange: (id: string) => void;
  readonly showChanges: boolean;
  readonly onShowChanges: (show: boolean) => void;
  readonly disabled?: boolean;
}) {
  const reference = results.get(referenceId);
  const baseline =
    reference && "proposal" in reference ? reference.proposal : null;
  const referenceName =
    scenarios.find((scenario) => scenario.id === referenceId)?.name ?? "Shared";
  return (
    <>
      <div className="loading-controls">
        <label>
          Reference{" "}
          <select
            aria-label="Comparison reference"
            value={referenceId}
            disabled={disabled}
            onChange={(event) => onReferenceChange(event.target.value)}
          >
            {scenarios.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showChanges}
            disabled={disabled}
            onChange={(event) => onShowChanges(event.target.checked)}
          />{" "}
          Show changes from reference
        </label>
      </div>
      <div className="loading-table-scroll">
        <table className="loading-comparison">
          <caption>
            {showChanges
              ? `Changes from ${referenceName}`
              : "Calculated floating attitudes"}
          </caption>
          <thead>
            <tr>
              <th>Scenario</th>
              <th>Displacement (t)</th>
              <th>Waterline depth (m)</th>
              <th>Trim (°)</th>
              <th>Heel (°)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map(({ id, name }) => {
              const response = results.get(id);
              const proposal =
                response && "proposal" in response ? response.proposal : null;
              const value = (
                current: number | undefined,
                base: number | undefined,
              ) =>
                show(
                  current === undefined
                    ? null
                    : showChanges
                      ? base === undefined
                        ? null
                        : current - base
                      : current,
                  showChanges,
                );
              return (
                <tr
                  key={id}
                  className={
                    id === referenceId ? "loading-reference" : undefined
                  }
                >
                  <th>
                    {name}
                    {id === referenceId && (
                      <small className="loading-fixed">reference</small>
                    )}
                  </th>
                  <td>
                    {value(
                      proposal ? proposal.values.mass / 1000 : undefined,
                      baseline ? baseline.values.mass / 1000 : undefined,
                    )}
                  </td>
                  <td>
                    {value(
                      proposal ? proposal.waterline * scale : undefined,
                      baseline ? baseline.waterline * scale : undefined,
                    )}
                  </td>
                  <td>
                    {value(
                      proposal ? degrees(proposal.deckTrim) : undefined,
                      baseline ? degrees(baseline.deckTrim) : undefined,
                    )}
                  </td>
                  <td>
                    {value(
                      proposal ? degrees(proposal.heel) : undefined,
                      baseline ? degrees(baseline.heel) : undefined,
                    )}
                  </td>
                  <td className="loading-row-status">
                    {!response ? (
                      <span role="status">Computing…</span>
                    ) : "error" in response ? (
                      <span role="alert">{response.error}</span>
                    ) : (
                      "Ready"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showChanges && !baseline && (
        <p className="loading-hint" role="status">
          {reference && "error" in reference
            ? "Reference unavailable. Differences cannot be calculated until its loading is valid."
            : "Waiting for the calculated reference before showing differences…"}
        </p>
      )}
      {scenarios.length === 1 && (
        <p className="loading-hint">
          Create named scenarios in Weights to compare alternative loads with
          Shared.
        </p>
      )}
    </>
  );
}
