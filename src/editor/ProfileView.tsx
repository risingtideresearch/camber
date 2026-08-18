import { useCallback } from "react";
import { rejected } from "../core/commands";
import { useDocumentDispatch, useDocumentRuntime } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { drawProfile } from "../core/draw2d";
import { viewOf } from "../core/view";
import { SvgView } from "./SvgView";
import "./ViewStrip.css";

// The profile strip (sheer trim, keel/stem, transom in side view). Draws through a shared pan/zoom SvgView.
// In "add" mode a click on empty space inserts a sheer-trim point.
export function ProfileView() {
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const {
    selection,
    setSelection: onSelect,
    sampling: hullSampling,
    tool,
    setTool,
    curvature,
    knotLongs,
    planProfileSync: sync,
  } = useEditorUi();
  // Read during render — see PlanView: the sweep is shared between the views, not owned by one.
  const sampling = hullSampling();
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      if (!sampling) return;
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
    const out = await dispatch({
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
