import { useCallback } from "react";
import { addPlanPoint, type Model } from "../core/model";
import type { HullSampling } from "../core/mesh";
import type { ModelSelection } from "../core/modelSelection";
import type { CurvatureSettings } from "../core/comb";
import { drawPlan } from "../core/draw2d";
import { viewOf } from "../core/view";
import type { RefObject } from "react";
import { SvgView } from "./SvgView";
import type { SvgViewSync } from "./svgViewSync";
import type { Tool } from "./types";
import "./ViewStrip.css";

// The plan strip (deck-edge half-breadth). Draws through a shared pan/zoom SvgView. In "add" mode a click on
// empty space inserts a sheer point there; in "select" mode an empty click clears the selection (clicks on
// control points are handled by their own node listeners, which stopPropagation before this fires).
interface PlanViewProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  sampling: HullSampling; // the shared hull sampling; the outline is drawn from its trimmedSections
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  bumpModel: () => void;
  sync?: RefObject<SvgViewSync>; // shared zoom / x-pan with the profile strip
  curvature: CurvatureSettings;
}

export function PlanView({
  model,
  modelVersion,
  selection,
  sampling,
  tool,
  onSelect,
  setTool,
  bumpModel,
  sync,
  curvature,
}: PlanViewProps) {
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawPlan(g, model, selection, sampling, onSelect, [sx, sy], curvature);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, modelVersion, selection, sampling, onSelect, curvature],
  );

  const onBackgroundClick = (vx: number, vy: number) => {
    if (tool === "add") {
      const v = viewOf(model);
      const idx = addPlanPoint(model, v.invX(vx), v.invY(vy));
      setTool("select");
      if (idx < 0) return; // no room at the minimum point spacing — nothing was inserted
      onSelect({ tgt: "plan", idx });
      bumpModel();
    } else {
      onSelect(null);
    }
  };

  // the strip's content box follows the hull's length: the panel geometry is derived from the same bounds
  // the drag clamps use, so the drawing and the clamps agree by construction
  const lh = viewOf(model).lh;

  return (
    <div className="viewstrip">
      <SvgView
        contentWidth={1000}
        contentHeight={lh}
        draw={draw}
        sync={sync}
        cursor={tool === "add" ? "crosshair" : "default"}
        onBackgroundClick={onBackgroundClick}
      />
    </div>
  );
}
