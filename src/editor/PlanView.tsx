import { useCallback } from "react";
import { rejected } from "../core/commands";
import { useDocumentDispatch, useDocumentRuntime } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { drawPlan } from "../core/draw2d";
import { viewOf } from "../core/view";
import { SvgView } from "./SvgView";
import "./ViewStrip.css";

// The plan strip (deck-edge half-breadth). Draws through a shared pan/zoom SvgView. In "add" mode a click on
// empty space inserts a sheer point there; in "select" mode an empty click clears the selection (clicks on
// control points are handled by their own node listeners, which stopPropagation before this fires).
export function PlanView() {
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const {
    selection,
    setSelection: onSelect,
    sampling,
    tool,
    setTool,
    curvature,
    knotLongs,
    activeStation,
    setActiveStation: onActivateStation,
    planProfileSync: sync,
  } = useEditorUi();
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawPlan(
        g,
        model,
        selection,
        sampling,
        onSelect,
        activeStation,
        onActivateStation,
        [sx, sy],
        curvature,
        knotLongs,
      );
    },
    [
      model,
      selection,
      sampling,
      onSelect,
      curvature,
      knotLongs,
      activeStation,
      onActivateStation,
    ],
  );

  // An insert is the one place the store's asynchrony reaches the UI: the new point's INDEX comes back from
  // the server, and the click that made it is what selects it. A click never begins a drag (drags always start
  // on an existing node), so the microtask between the two is invisible.
  const onBackgroundClick = async (vx: number, vy: number) => {
    if (tool !== "add") {
      onSelect(null);
      return;
    }
    const v = viewOf(model);
    const out = await dispatch({
      type: "addPlanPoint",
      x: v.invX(vx),
      y: v.invY(vy),
    });
    setTool("select");
    if (rejected(out)) return; // no room at the minimum point spacing — nothing was inserted
    onSelect({ tgt: "plan", idx: out.result as number });
  };

  // the strip's content box is sized for the hull as it was loaded, and stays that size while it is edited —
  // it is the box the initial fit is taken from, not a limit on where the sheer may go (see view.ts)
  const lh = viewOf(model).lh;

  return (
    <div className="viewstrip">
      <SvgView
        contentWidth={1000}
        contentHeight={lh}
        draw={draw}
        sync={sync}
        cursor={tool === "add" ? "crosshair" : "default"}
        onBackgroundClick={(vx, vy) => void onBackgroundClick(vx, vy)}
      />
    </div>
  );
}
