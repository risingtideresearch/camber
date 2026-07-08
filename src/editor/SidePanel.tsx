import { useState } from "react";
import {
  addTemplate,
  removeTemplate,
  setKeelK,
  type Model,
} from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import type { CurvatureSettings } from "../core/comb";
import type { Tool } from "./types";
import { SideTabs } from "./SideTabs";
import { StationEditor } from "./StationEditor";
import "./SidePanel.css";

// The section-template editor card: the tab strip, the stacked per-template editors (only the active one
// shown), and the keel-knuckle slider for the active template. Owns which tab is active; everything else
// flows from the model passed in from above.
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
  const K = model.templates.length;
  const active = Math.min(activeTab, K - 1); // clamp in case a template was removed

  const onAddTemplate = () => {
    if (model.templates.length >= 7) return;
    addTemplate(model);
    onSelect(null);
    setActiveTab(model.templates.length - 1); // the freshly added template becomes active
    bumpModel();
  };
  const onRemoveTemplate = (ti: number) => {
    if (model.templates.length <= 1) return;
    removeTemplate(model, ti);
    onSelect(null);
    setActiveTab((t) => Math.min(t, model.templates.length - 1));
    bumpModel();
  };
  const onKeel = (k: number) => {
    setKeelK(model, active, k);
    bumpModel();
  };

  const keelK = model.keelK[active] ?? 0;

  return (
    <div className="card sidecard">
      <SideTabs
        model={model}
        activeTab={active}
        onSelectTab={setActiveTab}
        onAddTemplate={onAddTemplate}
        onRemoveTemplate={onRemoveTemplate}
      />
      <div className="sidebody">
        {model.templates.map((_, ti) => (
          <StationEditor
            key={ti}
            model={model}
            modelVersion={modelVersion}
            selection={selection}
            ti={ti}
            active={ti === active}
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
          title="Keel knuckle for the active template — 0 = smooth (C¹ across the centerline), 1 = a hard V"
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
