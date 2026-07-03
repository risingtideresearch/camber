import { useCallback } from "react";
import { addSheerPoint, type Model, type Section } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import { drawPlan } from "../core/draw2d";
import { invX, invY, LH } from "../core/view";
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
  sections: Section[];
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  bumpModel: () => void;
  sync?: RefObject<SvgViewSync>; // shared zoom / x-pan with the profile strip
}

export function PlanView({
  model,
  modelVersion,
  selection,
  sections,
  tool,
  onSelect,
  setTool,
  bumpModel,
  sync,
}: PlanViewProps) {
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawPlan(g, model, selection, sections, onSelect, [sx, sy]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, modelVersion, selection, sections, onSelect],
  );

  const onBackgroundClick = (vx: number, vy: number) => {
    if (tool === "add") {
      const idx = addSheerPoint(model, invX(vx), invY(vy));
      setTool("select");
      onSelect({ tgt: "plan", idx });
      bumpModel();
    } else {
      onSelect(null);
    }
  };

  return (
    <div className="viewstrip">
      <SvgView
        contentWidth={1000}
        contentHeight={LH}
        draw={draw}
        sync={sync}
        cursor={tool === "add" ? "crosshair" : "default"}
        onBackgroundClick={onBackgroundClick}
      />
    </div>
  );
}
