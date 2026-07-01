import "./CutPanel.css";

// The live cut-station panel. `render.ts` draws into `#svgCut` and writes the `#profVal` readout
// (draft / WL beam) by id, so both are static here.
export function CutPanel() {
  return (
    <div className="card cutcard">
      <div className="cap">
        Cut{" "}
        <span className="val" id="profVal">
          —
        </span>
      </div>
      <div className="sidefit">
        <div className="sidepanel">
          <svg id="svgCut" viewBox="0 0 360 360" />
        </div>
      </div>
    </div>
  );
}
