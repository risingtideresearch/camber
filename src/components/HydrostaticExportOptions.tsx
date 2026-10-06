import type { HydrostaticCoverage } from "../export/types";

interface Props {
  coverage: HydrostaticCoverage;
  fine: boolean;
  onCoverage: (coverage: HydrostaticCoverage) => void;
  onFine: (fine: boolean) => void;
}

export function HydrostaticExportOptions({
  coverage,
  fine,
  onCoverage,
  onFine,
}: Props) {
  return (
    <>
      <label className="export-field">
        <span>Coverage</span>
        <select
          value={coverage}
          onChange={(e) => onCoverage(e.target.value as HydrostaticCoverage)}
        >
          <option value="grid">Heel and trim grid</option>
          <option value="fixed">Heel at design trim</option>
          <option value="upright">Upright only (0° / 0°)</option>
        </select>
      </label>
      <label className="export-field">
        <span>Resolution</span>
        <select
          value={fine ? "fine" : "standard"}
          onChange={(e) => onFine(e.target.value === "fine")}
        >
          <option value="standard">Standard: 5° / 64 immersion steps</option>
          <option value="fine">Fine: 2.5° / 128 immersion steps</option>
        </select>
      </label>
      <p>
        {coverage === "upright"
          ? "Only heel = trim = 0 is supported. This cannot provide large-angle GZ curves."
          : coverage === "fixed"
            ? "Heel −180…180° at the authored design trim only. No free-trim coverage."
            : "Heel −180…180°; trims −5°, 0°, +5° plus authored design trim. No extrapolation beyond this grid."}
      </p>
      <p>
        {fine
          ? "400 longitudinal intervals; 16 girth substeps per section segment."
          : "240 longitudinal intervals; 10 girth substeps per section segment."}{" "}
        Every row includes dry and fully immersed endpoints. Refine sampling to
        check convergence; resolution is not an accuracy guarantee.
      </p>
      <details>
        <summary>Envelope assumptions and limitations</summary>
        <p>
          Includes idealized deck/transom/end closures and sampled deck-edge
          markers. Opening/downflooding limits are unknown. No loading CG,
          density, mesh or stability verdict is exported.
        </p>
      </details>
    </>
  );
}
