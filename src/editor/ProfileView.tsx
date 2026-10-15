import { useCallback } from "react";
import { rejected } from "../core/commands";
import type { TransomSide } from "../core/hull";
import { selSide } from "../core/modelSelection";
import { useDocumentDispatch, useDocumentRuntime } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { drawProfile } from "../core/draw2d";
import { viewOf } from "../core/view";
import { SvgView } from "./SvgView";
import "./ViewStrip.css";

// The profile strip (sheer trim, keel/stem, transoms in side view). Draws through a shared pan/zoom SvgView.
// In "add" mode a click on empty space inserts a sheer-trim point. Under the strip, one checkbox per end of
// the hull says whether that end is closed by a transom plane: on, the plane appears at a default place near
// that end (its two points then draggable in the strip, like the sheer trim's); off, the plane and its cut
// go, and the hull simply runs out at the plan's end there.
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

  // Switching a transom off takes its points with it; a selection naming one would then point at nothing,
  // so it is cleared with the transom rather than left to resolve to no fields.
  const setTransom = (side: TransomSide, on: boolean) => {
    if (!on && selection?.tgt === "transom" && selSide(selection) === side)
      onSelect(null);
    void dispatch({ type: "setTransom", side, on });
  };

  return (
    <div className="profilecol">
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
      <div className="transomrow">
        <label
          className="ctl"
          title="Close the stern with a sloped transom plane. The hull keeps what lies forward of it; its two profile points are dragged here, like the sheer trim's. Off, the hull runs out at the plan's aft end."
        >
          <input
            type="checkbox"
            checked={model.transom !== null}
            onChange={(e) => setTransom("stern", e.target.checked)}
          />
          Stern transom
        </label>
        <label
          className="ctl"
          title="Close the bow with a sloped transom plane — a pram or scow bow. The hull keeps what lies aft of it; its two profile points are dragged here, like the sheer trim's. Off, the bow closes wherever the sheer trim meets the centerline."
        >
          <input
            type="checkbox"
            checked={model.bowTransom !== null}
            onChange={(e) => setTransom("bow", e.target.checked)}
          />
          Bow transom
        </label>
      </div>
    </div>
  );
}
