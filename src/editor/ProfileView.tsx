import { useCallback } from "react";
import type { Model } from "../core/model";
import { rejected } from "../core/commands";
import { useHullStore } from "./hullStore";
import type { HullSampling } from "../core/mesh";
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
  selection: ModelSelection;
  sampling: HullSampling; // the shared hull sampling; the keel / stem outline is drawn from its trimmedSections
  tool: Tool;
  onSelect: (sel: ModelSelection) => void;
  setTool: (t: Tool) => void;
  sync?: RefObject<SvgViewSync>; // shared zoom / x-pan with the plan strip
  curvature: CurvatureSettings;
  knotLongs: boolean; // the station editor's "Show knot longitudinals" toggle, shared by all three 2D views
}

export function ProfileView({
  model,
  selection,
  sampling,
  tool,
  onSelect,
  setTool,
  sync,
  curvature,
  knotLongs,
}: ProfileViewProps) {
  const store = useHullStore();
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawProfile(
        g,
        model,
        selection,
        sampling,
        onSelect,
        [sx, sy],
        curvature,
        knotLongs,
      );
    },
    [model, selection, sampling, onSelect, curvature, knotLongs],
  );

  const onBackgroundClick = async (vx: number, vy: number) => {
    if (tool !== "add") {
      onSelect(null);
      return;
    }
    const v = viewOf(model);
    const out = await store.dispatch({
      type: "addTrimPoint",
      x: v.invX(vx),
      z: v.invZp(vy),
    });
    setTool("select");
    if (rejected(out)) return; // no room at the minimum point spacing — nothing was inserted
    onSelect({ tgt: "trim", idx: out.result as number });
  };

  const ph = viewOf(model).ph; // a fraction of the length the hull was loaded at, held there (see view.ts)

  return (
    <div className="viewstrip">
      <SvgView
        contentWidth={1000}
        contentHeight={ph}
        draw={draw}
        sync={sync}
        cursor={tool === "add" ? "crosshair" : "default"}
        onBackgroundClick={(vx, vy) => void onBackgroundClick(vx, vy)}
      />
    </div>
  );
}
