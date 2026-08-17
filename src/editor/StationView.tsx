import { useCallback } from "react";
import { NumberInput } from "polymorph-ui";
import { rejected } from "../core/commands";
import { useDocumentDispatch, useDocumentRuntime } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { drawStation } from "../core/draw2d";
import { viewOf, STW, STH } from "../core/view";
import { SvgView } from "./SvgView";
import { StationTabs } from "./StationTabs";
import { DetachPanelButton } from "./DetachPanelButton";
import "./StationView.css";

// The section editor card: the tab strip, the section editor for the active station, and the keel-knuckle
// slider for it. Which station is active is owned above, since the plan view activates one too; everything
// else flows from the model passed in from above.
//
// One SvgView draws whichever station is active — switching tabs only changes what `draw` closes over, so
// the pan / zoom carries across tabs (sections stay comparable) and the inactive stations cost nothing.
// In "add" mode a click inserts a section point (into every station, index-aligned); in "select" mode an
// empty click clears the selection.
export function StationView() {
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const {
    selection,
    setSelection: onSelect,
    tool,
    setTool,
    curvature,
    knotLongs,
    setKnotLongs,
    activeStation,
    setActiveStation,
  } = useEditorUi();
  const K = model.stations.length;

  // A station is added AT THE CUT: it needs a definite position along the sheer (v1's templates had none),
  // and the cut is where the user is already looking. Its section is read off the loft there, so the hull is
  // unchanged by the insert — it just gains a handle where the surface already was.
  const onAddStation = async () => {
    if (K >= 7) return;
    const out = await dispatch({
      type: "addStation",
      u: model.plan.uAtX(model.x0),
    });
    if (rejected(out)) return; // no room at the minimum station spacing
    onSelect(null);
    setActiveStation(out.result as number); // the freshly added station becomes active
  };
  const onRemoveStation = (si: number) => {
    if (K <= 1) return;
    void dispatch({ type: "removeStation", idx: si });
    onSelect(null);
    setActiveStation(Math.min(activeStation, K - 2));
  };
  const onKeel = (k: number) =>
    void dispatch({ type: "setKeelK", si: activeStation, k });
  // The same edit as dragging the station's handle in the plan view, typed instead: the model clamps u
  // between the neighbouring stations, so a value past a neighbour lands at the limit and the field
  // redraws showing where the station actually went.
  const onU = (u: number) =>
    void dispatch({ type: "moveStationU", idx: activeStation, u });

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
    [model, selection, activeStation, onSelect, curvature, knotLongs],
  );

  const onBackgroundClick = async (vx: number, vy: number) => {
    if (tool !== "add") {
      onSelect(null);
      return;
    }
    const v = viewOf(model);
    const out = await dispatch({
      type: "addStationPoint",
      si: activeStation,
      n: v.invN(vx),
      z: v.invZ(vy),
    });
    setTool("select");
    if (rejected(out)) return;
    onSelect({ tgt: "station", idx: out.result as number, si: activeStation });
  };

  const keelK = model.stations[activeStation]?.keelK ?? 0;
  // Shown rounded: dragging the handle in the plan view leaves a full-precision float, and 3 decimals is
  // already finer than the 0.02 minimum spacing between stations.
  const u = Math.round((model.stations[activeStation]?.u ?? 0) * 1000) / 1000;

  return (
    <div className="card stationcard">
      {/* the tab strip, and — at the far end of its row — the button that opens every station side by side
          in a window of its own. It sits on the tabs because the tabs are what it replaces: one station at a
          time here, all of them there. */}
      <div className="stationhead">
        <StationTabs
          activeTab={activeStation}
          onSelectTab={setActiveStation}
          onAddStation={() => void onAddStation()}
          onRemoveStation={onRemoveStation}
        />
        <DetachPanelButton kind="stations" />
      </div>
      <div className="stationbody">
        <SvgView
          contentWidth={STW}
          contentHeight={STH}
          draw={draw}
          cursor={tool === "add" ? "crosshair" : "default"}
          onBackgroundClick={(vx, vy) => void onBackgroundClick(vx, vy)}
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
