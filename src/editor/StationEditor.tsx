import { useCallback } from "react";
import { addTemplatePoint, type Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import type { CurvatureSettings } from "../core/comb";
import { drawStation } from "../core/draw2d";
import { invD, invN } from "../core/view";
import { SvgView } from "./SvgView";
import type { Tool } from "./types";

// One section-template editor (template `ti`), drawn through a shared pan/zoom SvgView. Only the active
// template is shown; the others stay mounted (hidden) so switching tabs is instant and a drag started on one
// stays bound to a live element. In "add" mode a click inserts a section point (into every template,
// index-aligned); in "select" mode an empty click clears the selection.
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
  curvature: CurvatureSettings;
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
  curvature,
}: StationEditorProps) {
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawStation(model, selection, g, ti, onSelect, [sx, sy], curvature);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, modelVersion, selection, ti, onSelect, curvature],
  );

  const onBackgroundClick = (vx: number, vy: number) => {
    if (tool === "add") {
      const idx = addTemplatePoint(model, ti, invN(vx), invD(vy));
      setTool("select");
      onSelect({ tgt: "template", idx, ti });
      bumpModel();
    } else {
      onSelect(null);
    }
  };

  return (
    <div className="stationlayer" style={{ display: active ? "" : "none" }}>
      <SvgView
        contentWidth={360}
        contentHeight={360}
        draw={draw}
        cursor={tool === "add" ? "crosshair" : "default"}
        onBackgroundClick={onBackgroundClick}
      />
    </div>
  );
}
