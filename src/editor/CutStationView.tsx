import { useCallback, useMemo } from "react";
import { sweptSection, waterlineStats } from "../core/mesh";
import { drawCutStation } from "../core/draw2d";
import { useRuntime } from "./hullStore";
import { useEditorUi } from "./editorUi";
import { STW, STH } from "../core/view";
import { SvgView } from "./SvgView";
import "./CutStationView.css";

// The live cut-station panel: the lofted section at the red cut x0, plus a draft / WL-beam readout.
// Both the drawing (drawCutStation into its <svg>) and the readout react to model / selection changes.

// A measurement in the model's own unit. The coordinates are absolute now, so a hull may legitimately be
// 5000 (mm) or 5 (m) long — rounding everything to the nearest integer would erase a metre-unit hull's
// readout entirely.
const fmt = (v: number): string =>
  Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);

export function CutStationView() {
  const model = useRuntime();
  const { selection, curvature } = useEditorUi();
  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawCutStation(g, model, selection, [sx, sy], curvature);
    },

    [model, selection, curvature],
  );

  // the draft / WL-beam readout for the live cut, measured against the design waterline
  const label = useMemo(() => {
    const at = `x=${fmt(model.x0)} ${model.unit}`;
    const h = sweptSection(model, model.plan.uAtX(model.x0), 4, true);
    if (h.empty) return `${at} · no hull here`;
    const wl = waterlineStats(model, h.pts),
      open = h.keel ? "" : " · open"; // the section never reached the centerline
    return wl.wet
      ? `${at}${open} · draft ${fmt(wl.draft)} · WL beam ${fmt(wl.beam)}`
      : `${at}${open} · above WL`;
  }, [model]);

  return (
    <div className="card cutcard">
      <div className="cap">
        Cut <span className="val">{label}</span>
      </div>
      <div className="cutbody">
        <SvgView contentWidth={STW} contentHeight={STH} draw={draw} />
      </div>
    </div>
  );
}
