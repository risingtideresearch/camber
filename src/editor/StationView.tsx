import { useCallback } from "react";
import { NumberInput } from "polymorph-ui";
import {
  addStation,
  addStationPoint,
  moveStationU,
  removeStation,
  setKeelK,
  type Model,
} from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import type { CurvatureSettings } from "../core/comb";
import { drawStation } from "../core/draw2d";
import { viewOf, STW, STH } from "../core/view";
import { SvgView } from "./SvgView";
import type { Tool } from "./types";
import { StationTabs } from "./StationTabs";
import "./StationView.css";

// The section editor card: the tab strip, the section editor for the active station, and the keel-knuckle
// slider for it. Which station is active is owned above, since the plan view activates one too; everything
// else flows from the model passed in from above.
//
// One SvgView draws whichever station is active — switching tabs only changes what `draw` closes over, so
// the pan / zoom carries across tabs (sections stay comparable) and the inactive stations cost nothing.
// In "add" mode a click inserts a section point (into every station, index-aligned); in "select" mode an
// empty click clears the selection.
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
  // The same edit as dragging the station's handle in the plan view, typed instead: the model clamps u
  // between the neighbouring stations, so a value past a neighbour lands at the limit and the field
  // redraws showing where the station actually went.
  const onU = (u: number) => {
    moveStationU(model, activeStation, u);
    bumpModel();
  };

  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawStation(
        model,
        selection,
        g,
        activeStation,
        onSelect,
        [sx, sy],
        curvature,
        knotLongs,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      model,
      modelVersion,
      selection,
      activeStation,
      onSelect,
      curvature,
      knotLongs,
    ],
  );

  const onBackgroundClick = (vx: number, vy: number) => {
    if (tool === "add") {
      const v = viewOf(model);
      const idx = addStationPoint(model, activeStation, v.invN(vx), v.invZ(vy));
      setTool("select");
      onSelect({ tgt: "station", idx, si: activeStation });
      bumpModel();
    } else {
      onSelect(null);
    }
  };

  const keelK = model.stations[activeStation]?.keelK ?? 0;
  // Shown rounded: dragging the handle in the plan view leaves a full-precision float, and 3 decimals is
  // already finer than the 0.02 minimum spacing between stations.
  const u = Math.round((model.stations[activeStation]?.u ?? 0) * 1000) / 1000;

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
        <SvgView
          contentWidth={STW}
          contentHeight={STH}
          draw={draw}
          cursor={tool === "add" ? "crosshair" : "default"}
          onBackgroundClick={onBackgroundClick}
        />
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
      <div
        className="keelrow urow"
        title="Where the active station sits along the sheer plan, in the plan's own parameter u — 0 at the transom, 1 at the stem. Type a value or drag across the field; the station stops 0.02 short of its neighbours, the same limit a drag on its plan-view handle hits."
      >
        <span>Position</span>
        <NumberInput label="u" value={u} onChange={onU} min={0} max={1} />
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
