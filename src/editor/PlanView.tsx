import { useEffect, useRef } from "react";
import { addSheerPoint, type Model, type Section } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import { drawPlan } from "../core/draw2d";
import { invX, invY, LH } from "../core/view";
import { vbCoords } from "./svgCoords";
import type { Tool } from "./types";
import "./ViewStrip.css";

// The plan strip (deck-edge half-breadth). Owns its <svg>; redraws it via drawPlan() whenever the model or
// selection changes. In "add" mode a click on empty space inserts a sheer point there; in "select" mode an
// empty click clears the selection (clicks on control points are handled by their own node listeners, which
// stopPropagation before this fires).
interface PlanViewProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  sections: Section[];
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  bumpModel: () => void;
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
}: PlanViewProps) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (svg) drawPlan(svg, model, selection, sections, 0, onSelect);
  }, [model, modelVersion, selection, sections, onSelect]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = ref.current;
    if (!svg) return;
    if (tool === "add") {
      const [vx, vy] = vbCoords(svg, e.nativeEvent);
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
      <svg
        ref={ref}
        viewBox={`0 0 1000 ${LH}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ cursor: tool === "add" ? "crosshair" : "default" }}
        onPointerDown={onPointerDown}
      />
    </div>
  );
}
