import type { ReactNode } from "react";
import type { Hydro } from "../core/hydro";
import { unitScale } from "../core/json";
import type { Unit as DocUnit } from "../core/document";

// ---------- naval-architecture metrics, live from the blended hull ----------
// Unitless coefficients always show; the dimensional ones are converted from the DOCUMENT's unit into the
// display unit. v1 needed an "LOA" input here because its coordinates were unitless — the hull's real size
// was not in the document and had to be asserted; v2's are absolute, so the size is known and the only
// question left is which unit to read it in. Stability is geometry only — KMt, not GM (GM needs a weight/KG).

export type Unit = "m" | "ft";
export type Water = "salt" | "fresh";

interface MetricsPanelProps {
  hydro: Hydro | null;
  docUnit: DocUnit; // the unit the blended model's coordinates are in
  unit: Unit;
  water: Water;
  onUnit: (u: Unit) => void;
  onWater: (w: Water) => void;
}

// build the metric rows for a valid hydrostatics result, converted into the display unit
function metricRows(
  h: Hydro,
  docUnit: DocUnit,
  u: Unit,
  water: Water,
): ReactNode[] {
  const s = unitScale(docUnit, u); // display units per model unit
  const rho =
    u === "m"
      ? water === "salt"
        ? 1.025
        : 1.0
      : water === "salt"
        ? 64.0
        : 62.4; // t/m³ or lb/ft³
  const amid = (h.xAft + h.xFwd) / 2;
  const lcbPct = ((h.lcb - amid) / h.lwl) * 100; // + fwd of amidships
  const slender = h.vol > 0 ? h.lwl / Math.cbrt(h.vol) : NaN; // unitless (model units cancel)

  const num = (v: number, d = 2): string =>
    Number.isFinite(v) ? v.toFixed(d) : "—";
  const len = (v: number): string =>
    s ? `${(v * s).toFixed(v * s < 10 ? 2 : 1)} ${u}` : "—";
  const area = (v: number): string =>
    s ? `${(v * s * s).toFixed(2)} ${u}²` : "—";

  const rows: ReactNode[] = [];
  const sec = (t: string): void =>
    void rows.push(
      <div className="msec" key={`sec-${t}`}>
        {t}
      </div>,
    );
  const row = (k: string, v: string): void =>
    void rows.push(
      <div className="mrow" key={`row-${k}`}>
        <span className="mk">{k}</span>
        <span className="mv">{v}</span>
      </div>,
    );

  if (!h.validWaterplane)
    rows.push(
      <div className="mnote" key="note-wl">
        Waterline sits above the sheer — no waterplane. Lower the design
        waterline.
      </div>,
    );
  sec("Dimensions");
  row("LWL", len(h.lwl));
  row("Beam (WL)", len(h.bwl));
  row("Draft", len(h.draft));
  sec("Form");
  row("C_b block", num(h.cb, 3));
  row("C_p prismatic", num(h.cp, 3));
  row("C_m midship", num(h.cm, 3));
  row("C_w waterplane", num(h.cw, 3));
  sec("Displacement");
  row("∇ volume", s ? `${(h.vol * s ** 3).toFixed(2)} ${u}³` : "—");
  row(
    "Δ displacement",
    s
      ? `${(h.vol * s ** 3 * rho * (u === "m" ? 1 : 1 / 2240)).toFixed(3)} ${u === "m" ? "t" : "LT"}`
      : "—",
  );
  row("Wetted area", area(h.wettedArea));
  sec("Stability · geometry");
  row("KB", len(h.kb));
  row("BM_t", len(h.bmt));
  row("KM_t", len(h.kmt));
  sec("Ratios & angles");
  row("L / B", num(h.lwl / h.bwl, 2));
  row("B / T", num(h.bwl / h.draft, 2));
  row("L / ∇⅓", num(slender, 2));
  row(
    "LCB",
    Number.isFinite(lcbPct)
      ? `${Math.abs(lcbPct).toFixed(1)}% ${lcbPct >= 0 ? "fwd" : "aft"}`
      : "—",
  );
  row(
    "Deadrise",
    Number.isFinite(h.deadrise) ? `${h.deadrise.toFixed(0)}°` : "—",
  );
  row(
    "½ entrance",
    Number.isFinite(h.halfEntrance) ? `${h.halfEntrance.toFixed(0)}°` : "—",
  );
  if (!h.closed)
    rows.push(
      <div className="mnote" key="note-closed">
        Some sections don't close on the centerline — ∇ is approximate.
      </div>,
    );
  return rows;
}

export function MetricsPanel({
  hydro,
  docUnit,
  unit,
  water,
  onUnit,
  onWater,
}: MetricsPanelProps) {
  return (
    <div className="card">
      <div className="cap">
        <span>Metrics</span>
      </div>
      <div className="ctl">
        <div className="scalerow">
          <label
            className="docunit"
            title="The unit the blended hull's coordinates are stated in (the family's own unit)"
          >
            in {docUnit}
          </label>
          <select
            title="Display the dimensional metrics in this unit"
            value={unit}
            onChange={(e) => onUnit(e.target.value as Unit)}
          >
            <option value="m">m</option>
            <option value="ft">ft</option>
          </select>
          <select
            title="Water density"
            value={water}
            onChange={(e) => onWater(e.target.value as Water)}
          >
            <option value="salt">salt</option>
            <option value="fresh">fresh</option>
          </select>
        </div>
        <div className="metrics">
          {hydro ? (
            metricRows(hydro, docUnit, unit, water)
          ) : (
            <div className="mrow">
              <span className="mk">—</span>
              <span className="mv">load hulls</span>
            </div>
          )}
        </div>
        <div className="hint">
          Unitless metrics show always; dimensional ones are converted from the
          hull's own unit. Stability is geometry only (KMt) — GM needs a
          weight/KG.
        </div>
      </div>
    </div>
  );
}
