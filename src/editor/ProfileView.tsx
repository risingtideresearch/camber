import { useCallback } from "react";
import { addTrimPoint, type Model } from "../core/model";
import type { SectionRow } from "../core/mesh";
import type { ModelSelection } from "../core/modelSelection";
import type { CurvatureSettings } from "../core/comb";
import { drawProfile } from "../core/draw2d";
import { viewOf } from "../core/view";
import type { RefObject } from "react";
import { SvgView } from "./SvgView";
import type { SvgViewSync } from "./svgViewSync";
import type { Tool } from "./types";
import "./ViewStrip.css";

// The profile strip (sheer trim, keel/stem, transom in side view). Draws through a shared pan/zoom SvgView.
// In "add" mode a click on empty space inserts a sheer-trim point.
interface ProfileViewProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  rows: SectionRow[];
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  bumpModel: () => void;
  sync?: RefObject<SvgViewSync>; // shared zoom / x-pan with the plan strip
  curvature: CurvatureSettings;
}

export function ProfileView({
  model,
  modelVersion,
  selection,
  rows,
  tool,
  onSelect,
  setTool,
  bumpModel,
  sync,
  curvature,
}: ProfileViewProps) {
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawProfile(g, model, selection, rows, onSelect, [sx, sy], curvature);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, modelVersion, selection, rows, onSelect, curvature],
  );

  const onBackgroundClick = (vx: number, vy: number) => {
    if (tool === "add") {
      const v = viewOf(model);
      const idx = addTrimPoint(model, v.invX(vx), v.invZp(vy));
      setTool("select");
      if (idx < 0) return; // no room at the minimum point spacing — nothing was inserted
      onSelect({ tgt: "trim", idx });
      bumpModel();
    } else {
      onSelect(null);
    }
  };

  const ph = viewOf(model).ph; // the z window is a fraction of the hull's length (see view.ts)

  return (
    <div className="viewstrip">
      <SvgView
        contentWidth={1000}
        contentHeight={ph}
        draw={draw}
        sync={sync}
        cursor={tool === "add" ? "crosshair" : "default"}
        onBackgroundClick={onBackgroundClick}
      />
    </div>
  );
}
