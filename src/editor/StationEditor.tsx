import { useEffect, useRef } from "react";
import { addTemplatePoint, type Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import { drawStation } from "../core/draw2d";
import { invD, invN } from "../core/view";
import { vbCoords } from "./svgCoords";
import type { Tool } from "./types";

// One section-template editor (template `ti`), drawn via drawStation() into its own persistent <svg>. Only the
// active template is shown; the others stay mounted (hidden) so switching tabs is instant and a drag started
// on one stays bound to a live, measurable element. In "add" mode a click inserts a section point (into every
// template, index-aligned); in "select" mode an empty click clears the selection.
interface StationEditorProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  ti: number;
  active: boolean;
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  bumpModel: () => void;
}

export function StationEditor({
  model,
  modelVersion,
  selection,
  ti,
  active,
  tool,
  onSelect,
  setTool,
  bumpModel,
}: StationEditorProps) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (svg) drawStation(model, selection, svg, ti, onSelect);
  }, [model, modelVersion, selection, ti, onSelect]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = ref.current;
    if (!svg) return;
    if (tool === "add") {
      const [vx, vy] = vbCoords(svg, e.nativeEvent);
      const idx = addTemplatePoint(model, ti, invN(vx), invD(vy));
      setTool("select");
      onSelect({ tgt: "template", idx, ti });
      bumpModel();
    } else {
      onSelect(null);
    }
  };

  return (
    <svg
      ref={ref}
      viewBox="0 0 360 360"
      style={{
        display: active ? "" : "none",
        cursor: tool === "add" ? "crosshair" : "default",
      }}
      onPointerDown={onPointerDown}
    />
  );
}
