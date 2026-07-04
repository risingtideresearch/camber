import { useEffect, useRef } from "react";
import { addTrimPoint, type Model, type Section } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import { drawProfile } from "../core/draw2d";
import { invX, invZp, PH } from "../core/view";
import { vbCoords } from "./svgCoords";
import type { Tool } from "./types";
import "./ViewStrip.css";

// The profile strip (sheer trim, keel/stem, transom in side view). Owns its <svg>; redraws it via
// drawProfile() on model / selection change. In "add" mode a click on empty space inserts a sheer-trim point.
interface ProfileViewProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  sections: Section[];
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  bumpModel: () => void;
}

export function ProfileView({
  model,
  modelVersion,
  selection,
  sections,
  tool,
  onSelect,
  setTool,
  bumpModel,
}: ProfileViewProps) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (svg) drawProfile(svg, model, selection, sections, 0, onSelect);
  }, [model, modelVersion, selection, sections, onSelect]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = ref.current;
    if (!svg) return;
    if (tool === "add") {
      const [vx, vy] = vbCoords(svg, e.nativeEvent);
      const idx = addTrimPoint(model, invX(vx), invZp(vy));
      setTool("select");
      onSelect({ tgt: "trim", idx });
      bumpModel();
    } else {
      onSelect(null);
    }
  };

  return (
    <div className="viewstrip">
      <svg
        ref={ref}
        viewBox={`0 0 1000 ${PH}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ cursor: tool === "add" ? "crosshair" : "default" }}
        onPointerDown={onPointerDown}
      />
    </div>
  );
}
