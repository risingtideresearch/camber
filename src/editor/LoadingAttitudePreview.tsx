import { useId } from "react";
import { canApplyEquilibrium } from "../core/equilibrium";
import type { LoadingPurpose } from "../core/loading";
import type { LoadingProposal } from "../worker/loadingComputation";
import {
  degrees,
  showLoadingValue as show,
  type LoadingConstraintInputs,
} from "./loadingPresentation";

export function LoadingPurposePicker({
  purpose,
  onChange,
  disabled,
}: {
  readonly purpose: LoadingPurpose;
  readonly onChange: (purpose: LoadingPurpose) => void;
  readonly disabled: boolean;
}) {
  const group = useId();
  return (
    <fieldset className="loading-purpose" disabled={disabled}>
      <legend>Loading view</legend>
      <label>
        <input
          type="radio"
          name={group}
          checked={purpose === "balance-design"}
          onChange={() => onChange("balance-design")}
        />{" "}
        <strong>Balance the design</strong>
        <span>
          Balance waterline and trim with heel held at 0°. Recalculate
          geometry-dependent sheet values as the hull moves; heel is not
          balanced.
        </span>
      </label>
      <label>
        <input
          type="radio"
          name={group}
          checked={purpose === "compare-scenarios"}
          onChange={() => onChange("compare-scenarios")}
        />{" "}
        <strong>Compare loading scenarios</strong>
        <span>
          Compare where different loads float. Freeze each estimate at the same
          starting attitude; leave the model unchanged.
        </span>
      </label>
    </fieldset>
  );
}

export function LoadingConstraintFields({
  inputs,
  onChange,
  disabled,
  allowHeel = true,
}: {
  readonly inputs: LoadingConstraintInputs;
  readonly onChange: (patch: Partial<LoadingConstraintInputs>) => void;
  readonly disabled: boolean;
  readonly allowHeel?: boolean;
}) {
  return (
    <details className="loading-constraints-disclosure">
      <summary>
        Floating attitude constraints
        <small>
          {inputs.fixTrim
            ? `Trim fixed at ${inputs.trim || "—"}°`
            : "Trim free"}
          {" · "}
          {allowHeel
            ? inputs.fixHeel
              ? `Heel fixed at ${inputs.heel || "—"}°`
              : "Heel free"
            : "Heel held at 0°"}
        </small>
      </summary>
      <fieldset
        className="loading-constraints"
        aria-label="Floating attitude constraints"
        disabled={disabled}
      >
        <div>
          <label>
            <input
              type="checkbox"
              checked={inputs.fixTrim}
              onChange={(event) => onChange({ fixTrim: event.target.checked })}
            />{" "}
            Fix trim at
          </label>
          <input
            aria-label="Fixed trim in degrees"
            type="number"
            min={-30}
            max={30}
            step={0.1}
            value={inputs.trim}
            disabled={!inputs.fixTrim}
            onChange={(event) => onChange({ trim: event.target.value })}
          />
          °
        </div>
        {allowHeel && (
          <div>
            <label>
              <input
                type="checkbox"
                checked={inputs.fixHeel}
                onChange={(event) =>
                  onChange({ fixHeel: event.target.checked })
                }
              />{" "}
              Fix heel at
            </label>
            <input
              aria-label="Fixed heel in degrees"
              type="number"
              min={-45}
              max={45}
              step={0.1}
              value={inputs.heel}
              disabled={!inputs.fixHeel}
              onChange={(event) => onChange({ heel: event.target.value })}
            />
            °
          </div>
        )}
        <p className="loading-hint">
          {allowHeel
            ? "Unchecked angles are free to balance. Fixing both angles finds waterline only."
            : "Design balance stays upright. Fixing trim finds waterline only."}{" "}
          Changing a constraint recomputes automatically.
        </p>
      </fieldset>
    </details>
  );
}

/** Design result only. Scenario comparisons have their own multi-row table. */
export function LoadingAttitudePreview({
  waterline,
  deckTrim,
  scale,
  proposal,
}: {
  readonly waterline: number;
  readonly deckTrim: number;
  readonly scale: number;
  readonly proposal?: LoadingProposal;
}) {
  const rows = [
    {
      label: "Waterline depth (m)",
      start: waterline * scale,
      result: proposal ? proposal.waterline * scale : null,
      fixed: false,
    },
    {
      label: "Trim (°)",
      start: degrees(deckTrim),
      result: proposal ? degrees(proposal.deckTrim) : null,
      fixed: proposal?.balanceError === null,
    },
    {
      label: "Heel (°)",
      start: 0,
      result: proposal ? degrees(proposal.heel) : null,
      fixed: proposal?.transverseBalanceError === null,
    },
  ];
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Attitude</th>
            <th>Current</th>
            <th>Balanced</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, start, result, fixed }) => (
            <tr key={label}>
              <th>{label}</th>
              <td>{show(start)}</td>
              <td>
                {show(result)}
                {proposal && fixed && (
                  <small className="loading-fixed">fixed</small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {proposal && (
        <div
          className="loading-values"
          role="group"
          aria-label="Balanced estimate"
        >
          {[
            {
              label: "Displacement",
              value: proposal.values.mass / 1000,
              unit: "t",
            },
            { label: "LCG", value: proposal.values.lcg, unit: "m" },
            { label: "VCG", value: proposal.values.vcg, unit: "m" },
            { label: "TCG", value: proposal.values.tcg, unit: "m" },
          ].map(({ label, value, unit }) => (
            <div className="loading-value" key={label}>
              <span>{label}</span>
              <strong>
                {show(value)} {unit}
              </strong>
            </div>
          ))}
        </div>
      )}
      {proposal && !canApplyEquilibrium(proposal) && (
        <p className="loading-hint">
          This heeled attitude is preview-only. The model does not store heel,
          so applying just its waterline and trim would not preserve the
          calculated attitude.
        </p>
      )}
    </>
  );
}
