import { addStation, removeStation, setKeelK, type Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import type { CurvatureSettings } from "../core/comb";
import type { Tool } from "./types";
import { StationTabs } from "./StationTabs";
import { StationEditor } from "./StationEditor";
import "./StationView.css";

// The section editor card: the tab strip, the stacked per-station editors (only the active one shown), and
// the keel-knuckle slider for the active station. Which station is active is owned above, since the plan
// view activates one too; everything else flows from the model passed in from above.
interface StationViewProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  bumpModel: () => void;
  curvature: CurvatureSettings;
  // "Show knot longitudinals" — owned above (the plan and profile strips draw it too), toggled here
  knotLongs: boolean;
  setKnotLongs: (v: boolean) => void;
  activeStation: number;
  setActiveStation: (si: number) => void;
}

export function StationView({
  model,
  modelVersion,
  selection,
  tool,
  onSelect,
  setTool,
  bumpModel,
  curvature,
  knotLongs,
  setKnotLongs,
  activeStation,
  setActiveStation,
}: StationViewProps) {
  const K = model.stations.length;

  // A station is added AT THE CUT: it needs a definite position along the sheer (v1's templates had none),
  // and the cut is where the user is already looking. Its section is read off the loft there, so the hull is
  // unchanged by the insert — it just gains a handle where the surface already was.
  const onAddStation = () => {
    if (K >= 7) return;
    const idx = addStation(model, model.plan.uAtX(model.x0));
    if (idx < 0) return; // no room at the minimum station spacing
    onSelect(null);
    setActiveStation(idx); // the freshly added station becomes active
    bumpModel();
  };
  const onRemoveStation = (si: number) => {
    if (K <= 1) return;
    removeStation(model, si);
    onSelect(null);
    setActiveStation(Math.min(activeStation, model.stations.length - 1));
    bumpModel();
  };
  const onKeel = (k: number) => {
    setKeelK(model, activeStation, k);
    bumpModel();
  };

  const keelK = model.stations[activeStation]?.keelK ?? 0;

  return (
    <div className="card stationcard">
      <StationTabs
        model={model}
        activeTab={activeStation}
        onSelectTab={setActiveStation}
        onAddStation={onAddStation}
        onRemoveStation={onRemoveStation}
      />
      <div className="stationbody">
        {model.stations.map((_, si) => (
          <StationEditor
            key={si}
            model={model}
            modelVersion={modelVersion}
            selection={selection}
            si={si}
            active={si === activeStation}
            tool={tool}
            onSelect={onSelect}
            setTool={setTool}
            bumpModel={bumpModel}
            curvature={curvature}
            knotLongs={knotLongs}
          />
        ))}
      </div>
      <div className="keelrow">
        <label
          className="ctl"
          title="Show every station's knots (small circles) and, in grey, the longitudinal curve each knot traces along the hull — the u-interpolation a section at any position is read from. Drawn here and in the plan and profile views."
        >
          <input
            type="checkbox"
            checked={knotLongs}
            onChange={(e) => setKnotLongs(e.target.checked)}
          />
          Show knot longitudinals
        </label>
      </div>
      <div className="keelrow">
        <label
          className="ctl"
          title="Keel knuckle for the active station — 0 = smooth (C¹ across the centerline), 1 = a hard V. Stored and lofted, but not yet meshed: the keel is drawn smooth for now."
        >
          Keel
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={keelK}
            onChange={(e) => onKeel(parseFloat(e.target.value))}
          />
          <span className="ctlval">{keelK.toFixed(2)}</span>
        </label>
      </div>
    </div>
  );
}
