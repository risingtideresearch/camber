import type { View3DMode } from "../model.js";
import "./ThreeDView.css";

// The 3D viewport: the WebGL canvas and the lines-plan SVG overlay are drawn into by `render.ts`
// (and `interaction.ts` handles drag-rotate / scroll-zoom on `#cv3d`), so both are static. The
// view-mode segmented control IS React-owned — nothing else changes `state.view3dMode` — so its
// active button comes from React state and each click pushes the mode to the controller.
const MODES: { mode: View3DMode; label: string; title: string }[] = [
  { mode: "render", label: "Render", title: "Shaded hull" },
  { mode: "body", label: "Body", title: "Lines plan — body (stations)" },
  {
    mode: "buttocks",
    label: "Buttocks",
    title: "Lines plan — buttocks (constant-y cuts)",
  },
  {
    mode: "waterline",
    label: "Waterline",
    title: "Lines plan — waterlines (constant-z cuts)",
  },
  { mode: "zebra", label: "Zebra", title: "Zebra-stripe fairness check" },
  { mode: "sheet", label: "Sheet", title: "Untrimmed swept sheet (one side)" },
];

interface ThreeDViewProps {
  mode: View3DMode;
  onMode: (mode: View3DMode) => void;
}

export function ThreeDView({ mode, onMode }: ThreeDViewProps) {
  return (
    <div className="top3d">
      <canvas id="cv3d" />
      <svg id="lines3d" className="lines3d" style={{ display: "none" }} />
      <div className="view3dctl" id="view3dModes">
        {MODES.map((m) => (
          <button
            key={m.mode}
            className={"vmode" + (mode === m.mode ? " on" : "")}
            data-mode={m.mode}
            title={m.title}
            onClick={() => onMode(m.mode)}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
