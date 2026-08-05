import { useCallback } from "react";
import { addStationPoint, type Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import type { CurvatureSettings } from "../core/comb";
import { drawStation } from "../core/draw2d";
import { viewOf, STW, STH } from "../core/view";
import { SvgView } from "./SvgView";
import type { Tool } from "./types";

// One station's section editor (station `si`), drawn through a shared pan/zoom SvgView. Only the active
// station is shown; the others stay mounted (hidden) so switching tabs is instant and a drag started on one
// stays bound to a live element. In "add" mode a click inserts a section point (into every station,
// index-aligned); in "select" mode an empty click clears the selection.
interface StationEditorProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  si: number;
  active: boolean;
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  bumpModel: () => void;
  curvature: CurvatureSettings;
  knotLongs: boolean; // the station view's "Show knot longitudinals" toggle
}

export function StationEditor({
  model,
  modelVersion,
  selection,
  si,
  active,
  tool,
  onSelect,
  setTool,
  bumpModel,
  curvature,
  knotLongs,
}: StationEditorProps) {
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawStation(
        model,
        selection,
        g,
        si,
        onSelect,
        [sx, sy],
        curvature,
        knotLongs,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, modelVersion, selection, si, onSelect, curvature, knotLongs],
  );

  const onBackgroundClick = (vx: number, vy: number) => {
    if (tool === "add") {
      const v = viewOf(model);
      const idx = addStationPoint(model, si, v.invN(vx), v.invZ(vy));
      setTool("select");
      onSelect({ tgt: "station", idx, si });
      bumpModel();
    } else {
      onSelect(null);
    }
  };

  return (
    <div className="stationlayer" style={{ display: active ? "" : "none" }}>
      <SvgView
        contentWidth={STW}
        contentHeight={STH}
        draw={draw}
        cursor={tool === "add" ? "crosshair" : "default"}
        onBackgroundClick={onBackgroundClick}
      />
    </div>
  );
}
