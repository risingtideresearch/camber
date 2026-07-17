import { useState } from "react";
import { addStation, removeStation, setKeelK, type Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import type { CurvatureSettings } from "../core/comb";
import type { Tool } from "./types";
import { SideTabs } from "./SideTabs";
import { StationEditor } from "./StationEditor";
import "./SidePanel.css";

// The section editor card: the tab strip, the stacked per-station editors (only the active one shown), and
// the keel-knuckle slider for the active station. Owns which tab is active; everything else flows from the
// model passed in from above.
interface SidePanelProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  bumpModel: () => void;
  curvature: CurvatureSettings;
}

export function SidePanel({
  model,
  modelVersion,
  selection,
  tool,
  onSelect,
  setTool,
  bumpModel,
  curvature,
}: SidePanelProps) {
  const [activeTab, setActiveTab] = useState(0);
  const K = model.stations.length;
  const active = Math.min(activeTab, K - 1); // clamp in case a station was removed

  // A station is added AT THE CUT: it needs a definite position along the sheer (v1's templates had none),
  // and the cut is where the user is already looking. Its section is read off the loft there, so the hull is
  // unchanged by the insert — it just gains a handle where the surface already was.
  const onAddStation = () => {
    if (K >= 7) return;
    const idx = addStation(model, model.plan.uAtX(model.x0));
    if (idx < 0) return; // no room at the minimum station spacing
    onSelect(null);
    setActiveTab(idx); // the freshly added station becomes active
    bumpModel();
  };
  const onRemoveStation = (si: number) => {
    if (K <= 1) return;
    removeStation(model, si);
    onSelect(null);
    setActiveTab((t) => Math.min(t, model.stations.length - 1));
    bumpModel();
  };
  const onKeel = (k: number) => {
    setKeelK(model, active, k);
    bumpModel();
  };

  const keelK = model.stations[active]?.keelK ?? 0;

  return (
    <div className="card sidecard">
      <SideTabs
        model={model}
        activeTab={active}
        onSelectTab={setActiveTab}
        onAddStation={onAddStation}
        onRemoveStation={onRemoveStation}
      />
      <div className="sidebody">
        {model.stations.map((_, si) => (
          <StationEditor
            key={si}
            model={model}
            modelVersion={modelVersion}
            selection={selection}
            si={si}
            active={si === active}
            tool={tool}
            onSelect={onSelect}
            setTool={setTool}
            bumpModel={bumpModel}
            curvature={curvature}
          />
        ))}
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
