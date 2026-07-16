import {
  type WeightsState,
  type WeightSummary,
  type Flotation,
  newItem,
} from "../core/weights";
import "./AnalysisPanel.css";

// The weights & flotation card: sets the real scale (LOA), the shell material, and the placed cargo/machinery,
// then reads back the total weight, CG, and the solved free-floating equilibrium (draft, trim, heel, GM). It is
// purely presentational — EditorApp computes the mesh, weight summary, and flotation from whichever subject is
// active (the imported STL, else the parametric hull) and passes them in.
interface AnalysisPanelProps {
  subjectLabel: string; // "STL" or "Parametric hull"
  hasStl: boolean;
  weights: WeightsState;
  summary: WeightSummary;
  flotation: Flotation;
  onWeights: (patch: Partial<WeightsState>) => void;
  // optional: drive a 3D design-waterline to this equilibrium (the editor supplies it; the hydro page, whose
  // 2D views already draw the equilibrium, does not — the button is then hidden)
  onApplyFloat?: () => void;
}

const mass = (kg: number): string =>
  kg >= 1000
    ? `${(kg / 1000).toFixed(2)} t`
    : `${kg.toFixed(kg < 10 ? 1 : 0)} kg`;
const len = (m: number): string => `${m.toFixed(Math.abs(m) < 10 ? 3 : 2)} m`;

export function AnalysisPanel({
  subjectLabel,
  hasStl,
  weights,
  summary,
  flotation,
  onWeights,
  onApplyFloat,
}: AnalysisPanelProps) {
  const setItem = (
    id: string,
    patch: Partial<(typeof weights.items)[number]>,
  ): void =>
    onWeights({
      items: weights.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    });
  const addItem = (): void =>
    onWeights({
      items: [...weights.items, newItem({ x: weights.loa / 2 })],
    });
  const delItem = (id: string): void =>
    onWeights({ items: weights.items.filter((i) => i.id !== id) });

  const f = flotation;
  const balanced =
    f.ok && Math.abs(f.dispMass - summary.totalMass) < 0.01 * summary.totalMass;
  const tcg = summary.cg[1];

  return (
    <div className="card analysiscard">
      <div className="cap">
        <span>Weights &amp; Flotation</span>
        <span className="val">{subjectLabel}</span>
      </div>
      <div className="anbody">
        {/* scale + material + water */}
        <div className="an-sec">Scale &amp; material</div>
        <label
          className="an-field"
          title="Real overall length — scales the mesh to physical size"
        >
          <span>LOA</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={weights.loa}
            onChange={(e) =>
              onWeights({ loa: parseFloat(e.target.value) || 0 })
            }
          />
          <span className="an-unit">m</span>
        </label>
        <label
          className="an-field"
          title="Hull shell areal density — material mass per unit surface area (e.g. plywood ~5, light GRP ~8, alloy ~12 kg/m²)"
        >
          <span>Shell</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={weights.arealDensity}
            onChange={(e) =>
              onWeights({ arealDensity: parseFloat(e.target.value) || 0 })
            }
          />
          <span className="an-unit">kg/m²</span>
        </label>
        <label className="an-field" title="Water density">
          <span>Water</span>
          <select
            value={weights.water}
            onChange={(e) =>
              onWeights({ water: e.target.value as WeightsState["water"] })
            }
          >
            <option value="salt">salt</option>
            <option value="fresh">fresh</option>
          </select>
        </label>

        {/* cargo & machinery */}
        <div className="an-sec">
          Cargo &amp; machinery
          <button className="an-add" title="Add a point mass" onClick={addItem}>
            +
          </button>
        </div>
        {weights.items.length === 0 && (
          <div className="an-empty">
            No items — add engine, tanks, batteries, cargo…
          </div>
        )}
        {weights.items.map((it) => (
          <div className="an-item" key={it.id}>
            <div className="an-item-row">
              <input
                className="an-name"
                value={it.name}
                onChange={(e) => setItem(it.id, { name: e.target.value })}
              />
              <input
                className="an-num"
                type="number"
                step={10}
                value={it.mass}
                title="Mass (kg)"
                onChange={(e) =>
                  setItem(it.id, { mass: parseFloat(e.target.value) || 0 })
                }
              />
              <span className="an-unit">kg</span>
              <button
                className="an-del"
                title="Remove"
                onClick={() => delItem(it.id)}
              >
                ✕
              </button>
            </div>
            <div className="an-item-row an-xyz">
              {(["x", "y", "z"] as const).map((ax) => (
                <label key={ax} title={`${ax} position (m)`}>
                  {ax}
                  <input
                    type="number"
                    step={0.1}
                    value={it[ax]}
                    onChange={(e) =>
                      setItem(it.id, { [ax]: parseFloat(e.target.value) || 0 })
                    }
                  />
                </label>
              ))}
            </div>
          </div>
        ))}

        {/* results */}
        <div className="an-sec">Results</div>
        <div className="an-row">
          <span className="an-k">Hull area</span>
          <span className="an-v">{summary.hullArea.toFixed(2)} m²</span>
        </div>
        <div className="an-row">
          <span className="an-k">Structure</span>
          <span className="an-v">{mass(summary.structureMass)}</span>
        </div>
        <div className="an-row">
          <span className="an-k">Items</span>
          <span className="an-v">{mass(summary.itemsMass)}</span>
        </div>
        <div className="an-row an-strong">
          <span className="an-k">Total weight W</span>
          <span className="an-v">{mass(summary.totalMass)}</span>
        </div>
        <div className="an-row">
          <span className="an-k">CG (LCG · VCG)</span>
          <span className="an-v">
            {len(summary.cg[0])} · {len(summary.cg[2])}
          </span>
        </div>
        {Math.abs(tcg) > 0.005 && (
          <div className="an-row">
            <span className="an-k">TCG (off-center)</span>
            <span className="an-v">
              {len(Math.abs(tcg))} {tcg > 0 ? "stbd" : "port"}
            </span>
          </div>
        )}

        {f.ok ? (
          <>
            <div className="an-row an-strong">
              <span className="an-k">Displacement ∇·ρ</span>
              <span className="an-v">{mass(f.dispMass)}</span>
            </div>
            <div className="an-row">
              <span className="an-k">Draft</span>
              <span className="an-v">{len(f.hydro.draft)}</span>
            </div>
            <div className="an-row">
              <span className="an-k">Trim</span>
              <span className="an-v">
                {Math.abs(f.trimDeg) < 0.05
                  ? "level"
                  : `${Math.abs(f.trimDeg).toFixed(1)}° ${f.trimDeg > 0 ? "bow down" : "bow up"}`}
              </span>
            </div>
            {Math.abs(f.heelDeg) > 0.05 && (
              <div className="an-row">
                <span className="an-k">List</span>
                <span className="an-v">
                  {Math.abs(f.heelDeg).toFixed(1)}°{" "}
                  {f.heelDeg > 0 ? "stbd" : "port"}
                </span>
              </div>
            )}
            <div className="an-row">
              <span className="an-k">Freeboard (min)</span>
              <span className={"an-v" + (f.freeboardMin < 0 ? " an-warn" : "")}>
                {len(f.freeboardMin)}
              </span>
            </div>
            <div className="an-row">
              <span className="an-k">GMt (stability)</span>
              <span className={"an-v" + (f.gmt < 0 ? " an-warn" : "")}>
                {len(f.gmt)}
              </span>
            </div>
          </>
        ) : (
          <div className="an-note an-warn">
            {f.note || "No equilibrium found."}
          </div>
        )}

        {f.ok && !balanced && (
          <div className="an-note an-warn">
            Displacement ≠ weight — solver did not fully converge.
          </div>
        )}
        {f.ok && f.gmt < 0 && (
          <div className="an-note an-warn">
            GMt &lt; 0 — the hull is unstable upright (will loll/capsize).
          </div>
        )}
        {summary.closureError > 0.02 && (
          <div className="an-note">
            Mesh looks open / non-watertight (closure{" "}
            {(summary.closureError * 100).toFixed(0)}%) — ∇ is approximate.
          </div>
        )}
        {onApplyFloat && (
          <button
            className="an-float"
            disabled={hasStl || !f.ok}
            title={
              hasStl
                ? "Not available for an imported STL — the 3D view shows the parametric hull"
                : "Set the 3D design-waterline and rake to this floating equilibrium"
            }
            onClick={onApplyFloat}
          >
            Float 3D view at equilibrium
          </button>
        )}
      </div>
    </div>
  );
}
