import { useCallback } from "react";
import { addWeightPoint, type Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import { drawWeights } from "../core/draw2d";
import { invX, WH } from "../core/view";
import { SvgView } from "./SvgView";
import type { Tool } from "./types";
import "./ViewStrip.css";

// The blend (weights) strip: each template's share of the simplex stacked vertically along the hull. Unlike
// the other 2D views it does not zoom / pan — the graph always fills the whole area (SvgView "fill" mode). In
// "add" mode a click adds a station at the clicked x (its plan y read off the current curve); the
// band-boundary handles are drawn by drawWeights.
interface WeightsViewProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  bumpModel: () => void;
}

export function WeightsView({
  model,
  modelVersion,
  selection,
  tool,
  onSelect,
  setTool,
  bumpModel,
}: WeightsViewProps) {
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawWeights(g, model, selection, onSelect, [sx, sy]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, modelVersion, selection, onSelect],
  );

  const onBackgroundClick = (vx: number) => {
    if (tool === "add") {
      const idx = addWeightPoint(model, invX(vx));
      setTool("select");
      if (idx < 0) return; // no room at the minimum station spacing — nothing was inserted
      onSelect({ tgt: "weight", idx });
      bumpModel();
    } else {
      onSelect(null);
    }
  };

  return (
    <div className="viewstrip">
      <SvgView
        contentWidth={1000}
        contentHeight={WH}
        mode="fill"
        draw={draw}
        cursor={tool === "add" ? "crosshair" : "default"}
        onBackgroundClick={onBackgroundClick}
      />
    </div>
  );
}
