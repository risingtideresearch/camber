import { useEffect, useRef } from "react";
import { addWeightPoint, type Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import { drawWeights } from "../core/draw2d";
import { invX, WH } from "../core/view";
import { vbCoords } from "./svgCoords";
import type { Tool } from "./types";
import "./ViewStrip.css";

// The blend (weights) strip: each template's share of the simplex stacked vertically along the hull. Owns its
// <svg>; redraws it via drawWeights() on model / selection change. In "add" mode a click adds a station at the
// clicked x (its plan y read off the current curve); the band-boundary handles are drawn by drawWeights.
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
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (svg) drawWeights(svg, model, selection, onSelect);
  }, [model, modelVersion, selection, onSelect]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = ref.current;
    if (!svg) return;
    if (tool === "add") {
      const [vx] = vbCoords(svg, e.nativeEvent);
      const idx = addWeightPoint(model, invX(vx));
      setTool("select");
      onSelect({ tgt: "weight", idx });
      bumpModel();
    } else {
      onSelect(null);
    }
  };

  return (
    <div className="viewstrip">
      <svg
        ref={ref}
        viewBox={`0 0 1000 ${WH}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ cursor: tool === "add" ? "crosshair" : "default" }}
        onPointerDown={onPointerDown}
      />
    </div>
  );
}
