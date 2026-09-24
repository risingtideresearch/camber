import { useEffect, useState } from "react";
import type { HullSampling } from "../../core/mesh";
import type { WeightBook } from "../../core/sheet/book";
import type { BookResults } from "../../core/sheet/evaluate";
import type { SamplingTarget } from "../../core/sheet/sampling";
import { naturalUnit } from "../../core/sheet/units";
import { useSampledResults } from "../useSampledResults";
import { SampledDistribution } from "./SampledDistribution";
import { inUnit, sig } from "./weightFormat";

export function SampledResultsPanel({
  book,
  sampling,
  results,
  ready,
  run,
  selectedKey,
  keys,
  onPick,
}: {
  readonly book: WeightBook;
  readonly sampling: HullSampling | null;
  readonly results: BookResults;
  readonly ready: boolean;
  readonly run: ReturnType<typeof useSampledResults>;
  readonly selectedKey: string | null;
  readonly keys: readonly string[];
  readonly onPick: (key: string) => void;
}) {
  const names = new Map(
    book.items.map((item) => [item.id, item.name || item.id]),
  );
  const label = (key: string) => {
    const cell = results.cells.get(key);
    if (!cell) return key;
    return `${names.get(cell.itemId) ?? cell.itemId}.${cell.fieldKey}${cell.leaf === "formula" ? "" : `.${cell.leaf}`}`;
  };
  const [picked, setPicked] = useState(selectedKey);
  const selected = picked && keys.includes(picked) ? picked : (keys[0] ?? null);
  const targets = keys.filter((key) => {
    const cell = results.cells.get(key);
    return cell && !cell.empty;
  });
  const current = targets.length ? run.getRun(targets) : null;
  const start = run.start;
  const prioritize = run.prioritize;
  const result = current?.result ?? null;
  const error = current?.error ?? null;
  const running =
    !error &&
    !!current &&
    (current.starting || result?.execution.status === "running");
  const signature = targets.join("\0");
  useEffect(() => {
    if (!ready || !sampling || !signature) return;
    if (current) {
      if (current.starting) prioritize(signature.split("\0"));
      return;
    }
    const requested: SamplingTarget[] = signature.split("\0").map((key) => {
      const cell = results.cells.get(key)!;
      return {
        cellKey: key,
        dim: cell.quantity?.dim ?? null,
        nominal:
          cell.quantity && !cell.error && Number.isFinite(cell.quantity.v)
            ? { value: cell.quantity.v }
            : { error: cell.error ?? "Nominal value unavailable" },
      };
    });
    start(requested);
  }, [ready, sampling, signature, current, results, start, prioritize]);
  const chosen = result?.outputs.find((output) => output.cellKey === selected);
  const unitFor = (key: string, dim?: SamplingTarget["dim"]) =>
    results.cells.get(key)?.unit ?? (dim ? naturalUnit(dim) : null);
  const number = (value: number | undefined, factor = 1) =>
    value === undefined ? "—" : sig(inUnit(value, factor));
  const allInvalid = (output: NonNullable<typeof chosen>) =>
    !!result?.progress.completedTrials && output.validTrials === 0;
  const invalidLabel = (invalid: number, total: number) => {
    const percent = (100 * invalid) / total;
    return percent < 0.1 ? "<0.1% invalid" : `${percent.toFixed(1)}% invalid`;
  };
  const requested = result?.progress.requestedTrials ?? 1024;
  const completed = current?.completed ?? 0;
  const phase = !keys.length
    ? "Select a field or summary value to sample."
    : !targets.length
      ? "No authored values to sample."
      : !ready
        ? "Waiting for nominal geometry…"
        : !sampling && !current
          ? "Waiting for hull sampling…"
          : error || result?.execution.status === "failed"
            ? "Sampling failed"
            : result?.execution.status === "cancelled"
              ? "Sampling cancelled"
              : result?.execution.status === "finished"
                ? "Sampled"
                : current?.starting
                  ? "Queued for sampling…"
                  : result?.progress.completedTrials
                    ? "Sampling · preliminary estimates"
                    : "Sampling…";
  return (
    <div className="wsampled">
      <h3>Sampled results</h3>
      {running && (
        <button
          className="wsampled-cancel"
          type="button"
          onClick={() => run.cancel(targets)}
        >
          Cancel
        </button>
      )}
      <p>
        Independent input draws and repetition phases. Existing uncertainty
        readings are unchanged.
      </p>
      <div className="wsampled-status" role="status" aria-live="polite">
        {phase}
      </div>
      {targets.length > 0 && (
        <div className="wsampled-progress">
          <progress
            value={completed}
            max={requested}
            aria-label="Sampled trials"
          />
          <span className="wsampled-progress-count">
            <span
              style={{ minWidth: `${requested.toLocaleString().length}ch` }}
            >
              {completed.toLocaleString()}
            </span>
            {` / ${requested.toLocaleString()}`}
          </span>
        </div>
      )}
      {(error || result?.execution.status === "failed") && (
        <p role="alert">
          {error ??
            (result?.execution.status === "failed"
              ? result.execution.message
              : "")}
        </p>
      )}
      {keys.length > 1 && (
        <div className="wsampled-table">
          <table className="wsampled-summary">
            <thead>
              <tr>
                <th>Value</th>
                <th>Nominal</th>
                <th>Sampled mean ± SD</th>
                <th>95% interval</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const cell = results.cells.get(key);
                const output = result?.outputs.find(
                  (row) => row.cellKey === key,
                );
                const unit = unitFor(key, output?.dim);
                const factor = unit?.factor ?? 1;
                return (
                  <tr
                    key={key}
                    className={selected === key ? "on" : ""}
                    title={
                      cell?.error ??
                      (cell?.empty ? "Nothing written yet" : undefined)
                    }
                    onClick={() => {
                      setPicked(key);
                      onPick(key);
                    }}
                  >
                    <th scope="row">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setPicked(key);
                          onPick(key);
                        }}
                        aria-pressed={selected === key}
                      >
                        {cell?.leaf ?? key}
                      </button>
                      {unit?.label && (
                        <span className="winsprowunit"> {unit.label}</span>
                      )}
                      {output &&
                      output.invalidTrials > 0 &&
                      result?.progress.completedTrials ? (
                        <span
                          className={`wsampled-invalid-badge${allInvalid(output) ? " all" : ""}`}
                          title={`${output.invalidTrials.toLocaleString()} of ${result.progress.completedTrials.toLocaleString()} trials invalid`}
                        >
                          {allInvalid(output)
                            ? `All trials invalid${running ? " so far" : ""}`
                            : invalidLabel(
                                output.invalidTrials,
                                result.progress.completedTrials,
                              )}
                        </span>
                      ) : null}
                    </th>
                    <td>{number(cell?.quantity?.v, factor)}</td>
                    <td>
                      {output?.distribution ? (
                        `${number(output.distribution.mean, factor)} ± ${number(output.distribution.standardDeviation, factor)}`
                      ) : output && allInvalid(output) ? (
                        <strong className="wsampled-invalid-all">
                          No valid samples
                        </strong>
                      ) : output ? (
                        "—"
                      ) : cell?.empty ? (
                        "—"
                      ) : (
                        "…"
                      )}
                    </td>
                    <td>
                      {output?.distribution
                        ? `${number(output.distribution.quantiles.p025, factor)} – ${number(output.distribution.quantiles.p975, factor)}`
                        : output
                          ? "—"
                          : cell?.empty
                            ? "—"
                            : "…"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {selected && !chosen && results.cells.get(selected)?.empty && (
        <p>Nothing written for {label(selected)} yet.</p>
      )}
      {chosen && result && result.progress.completedTrials > 0 && (
        <>
          <h4>{label(chosen.cellKey)}</h4>
          {allInvalid(chosen) && (
            <p className="wsampled-invalid-all" role="status">
              All {result.progress.completedTrials.toLocaleString()} trials
              invalid{running ? " so far" : ""}. No distribution is available.
            </p>
          )}
          <SampledDistribution
            output={chosen}
            unit={unitFor(chosen.cellKey, chosen.dim)}
          />
          <div className="wsampled-table">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Nominal</th>
                  <th>Sampled mean</th>
                  <th>SD</th>
                  <th>95% sampled interval</th>
                </tr>
              </thead>
              <tbody>
                {[chosen].map((output) => {
                  const unit = unitFor(output.cellKey, output.dim);
                  const factor = unit?.factor ?? 1;
                  return (
                    <tr key={output.cellKey}>
                      <th scope="row">
                        {label(output.cellKey)}{" "}
                        {unit?.label && `(${unit.label})`}
                      </th>
                      <td
                        title={
                          "error" in output.nominal
                            ? output.nominal.error
                            : undefined
                        }
                      >
                        {number(
                          "value" in output.nominal
                            ? output.nominal.value
                            : undefined,
                          factor,
                        )}
                      </td>
                      <td>{number(output.distribution?.mean, factor)}</td>
                      <td>
                        {number(output.distribution?.standardDeviation, factor)}
                      </td>
                      <td>
                        {output.distribution
                          ? `${number(output.distribution.quantiles.p025, factor)} – ${number(output.distribution.quantiles.p975, factor)}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {chosen.invalidTrials > 0 && (
            <div
              className={`wsampled-validity${allInvalid(chosen) ? " all" : ""}`}
            >
              <span>
                {chosen.invalidTrials.toLocaleString()} of{" "}
                {result.progress.completedTrials.toLocaleString()} trials
                invalid
              </span>
              {chosen.failures.length > 0 && (
                <details>
                  <summary>Reasons</summary>
                  <ul>
                    {chosen.failures.map((failure) => (
                      <li key={failure.message}>
                        {failure.trials.toLocaleString()}: {failure.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          <p>
            Intervals are empirical percentiles, not worst-case bounds.
            Statistics are conditional on valid trials. Precision not assessed;
            direct geometry still has hull discretization error.
          </p>
        </>
      )}
    </div>
  );
}
