import { useEditorUi } from "./editorUi";
import { useState } from "react";
import { Dropdown } from "../components/Dropdown";
import { perfReset } from "../core/perf";

// The app-bar "Performance" control, next to Curvature and built the same way: a toggle button that turns
// the measurement readout on (recording costs nothing while it is off, so this really is a switch, not just
// a panel that hides), plus a dropdown for how the numbers are presented. State lives in EditorApp, which
// also forces a redraw when the toggle flips so the panel fills immediately instead of on the next edit.

export function PerfControls() {
  const { perf: value, setPerf: onChange } = useEditorUi();
  const [open, setOpen] = useState(false);

  return (
    <Dropdown
      label="Performance"
      active={value.on}
      onToggle={() => onChange({ ...value, on: !value.on })}
      open={open}
      onOpenChange={setOpen}
      title="Measure what each redraw costs: the 2D curves and the hull mesh, step by step (toggle); the caret picks how the numbers read"
      menuLabel="Performance options"
      align="right"
    >
      <div className="dd-group">Readout</div>
      <label
        className="dd-row dd-check"
        title="Show each step's running average rather than the last pass's raw time — a single frame's numbers jitter by a factor of two or more"
      >
        <input
          type="checkbox"
          checked={value.smooth}
          onChange={(e) => onChange({ ...value, smooth: e.target.checked })}
        />
        <span className="dd-name">Average over passes</span>
      </label>
      <label
        className="dd-row dd-check"
        title="Order each view's steps slowest-first rather than in the order they are drawn"
      >
        <input
          type="checkbox"
          checked={value.sort}
          onChange={(e) => onChange({ ...value, sort: e.target.checked })}
        />
        <span className="dd-name">Sort by time</span>
      </label>
      {/* the hull-sampling resolution: the cost of the ONE sampling every view shares, so it lives with the
          readout that measures it (moved here from the 3D view's Mesh dropdown) */}
      <div className="dd-group">Hull sampling</div>
      <label
        className="dd-row"
        title="Number of sampled sections along the length (station resolution) — the N fed to the shared hull sampling"
      >
        <span className="dd-name">Num sections</span>
        <input
          type="range"
          min={8}
          max={512}
          step={8}
          value={value.numSections}
          onChange={(e) => onChange({ ...value, numSections: +e.target.value })}
        />
        <span className="dd-val">{value.numSections}</span>
      </label>
      <label
        className="dd-row"
        title="Longitudinals per station knot (girth sub-steps per section segment). Every station knot must land on a mesh row — that is where a knuckle's crease lives — so a section of S points is (S−1)×R+1 rows wide."
      >
        <span className="dd-name">Longitudinals per knot</span>
        <input
          type="range"
          min={1}
          max={32}
          step={1}
          value={value.girthSteps}
          onChange={(e) => onChange({ ...value, girthSteps: +e.target.value })}
        />
        <span className="dd-val">{value.girthSteps}</span>
      </label>
      {/* a view that stops redrawing keeps its last numbers (a station editor whose tab was closed, say),
          so there is one way to drop everything and start measuring again */}
      <button
        type="button"
        className="btn"
        onClick={() => perfReset()}
        title="Drop every recorded number and start over"
      >
        Reset
      </button>
    </Dropdown>
  );
}
