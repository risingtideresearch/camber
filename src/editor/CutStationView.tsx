import { useEffect, useMemo, useRef } from "react";
import { clippedSection, waterlineStats, type Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import { drawCutStation } from "../core/draw2d";
import "./CutStationView.css";

// The live cut-station panel: the interpolated section at the red cut x0, plus a draft / WL-beam readout.
// Both the drawing (drawCutStation into its <svg>) and the readout react to model / selection changes.
interface CutStationViewProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
}

export function CutStationView({
  model,
  modelVersion,
  selection,
}: CutStationViewProps) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (svg) drawCutStation(svg, model, selection);
  }, [model, modelVersion, selection]);

  // the draft / WL-beam readout for the live cut, measured against the design waterline
  const label = useMemo(() => {
    const h = clippedSection(model, model.x0, 18);
    const wl = waterlineStats(model, h),
      open = h.open ? " · open" : "";
    return wl.wet
      ? `x=${Math.round(model.x0)}${open} · draft ${Math.round(wl.draft)} · WL beam ${Math.round(wl.beam)}`
      : `x=${Math.round(model.x0)}${open} · above WL`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, modelVersion]);

  return (
    <div className="card cutcard">
      <div className="cap">
        Cut <span className="val">{label}</span>
      </div>
      <div className="sidefit">
        <div className="sidepanel">
          <svg ref={ref} id="svgCut" viewBox="0 0 360 360" />
        </div>
      </div>
    </div>
  );
}
