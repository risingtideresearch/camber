import { useCallback, useMemo } from "react";
import { clippedSection, waterlineStats, type Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import type { CurvatureSettings } from "../core/comb";
import { drawCutStation } from "../core/draw2d";
import { SvgView } from "./SvgView";
import "./CutStationView.css";

// The live cut-station panel: the interpolated section at the red cut x0, plus a draft / WL-beam readout.
// Both the drawing (drawCutStation into its <svg>) and the readout react to model / selection changes.
interface CutStationViewProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  curvature: CurvatureSettings;
}

export function CutStationView({
  model,
  modelVersion,
  selection,
  curvature,
}: CutStationViewProps) {
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawCutStation(g, model, selection, [sx, sy], curvature);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, modelVersion, selection, curvature],
  );

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
      <div className="cutbody">
        <SvgView contentWidth={360} contentHeight={360} draw={draw} />
      </div>
    </div>
  );
}
