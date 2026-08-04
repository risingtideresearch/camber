import { useEffect, useRef } from "react";
import type { FleetResult } from "../core/michell";

// ---------- where the wave energy goes ----------
//
// dR_w/dθ against the propagation angle. Its integral IS the reported R_w, so this is not an illustration of
// the number — it is the number, spread out over the angles that make it. Transverse waves sit near θ = 0 and
// diverging waves run out toward 90°, and the notches a fleet's interference cuts into the curve are exactly
// the angles at which the two hulls' waves cancel. Moving a hull moves the notches: that is the whole
// mechanism behind the interference factor, made visible.

interface SpectrumPlotProps {
  result: FleetResult;
}

export function SpectrumPlot({ result }: SpectrumPlotProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const W = (c.width = c.clientWidth * devicePixelRatio),
      H = (c.height = 120 * devicePixelRatio);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const { theta, thetaMax } = result.grid,
      d = result.density;
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, d[i]);
    if (!(peak > 0)) return;
    const px = (t: number): number => (t / thetaMax) * W,
      py = (v: number): number => H - 4 - (v / peak) * (H - 12);

    // gridlines every 15°, so the transverse/diverging split can be read off
    ctx.strokeStyle = "rgba(148,163,184,0.35)";
    ctx.lineWidth = 1;
    ctx.font = `${10 * devicePixelRatio}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = "rgba(113,128,150,0.9)";
    for (let deg = 0; deg <= 90; deg += 15) {
      const t = (deg * Math.PI) / 180;
      if (t > thetaMax) break;
      ctx.beginPath();
      ctx.moveTo(px(t), 0);
      ctx.lineTo(px(t), H - 12 * devicePixelRatio);
      ctx.stroke();
      ctx.fillText(
        `${deg}°`,
        px(t) + 3 * devicePixelRatio,
        H - 2 * devicePixelRatio,
      );
    }

    ctx.beginPath();
    ctx.moveTo(px(theta[0]), py(d[0]));
    for (let i = 1; i < d.length; i++) ctx.lineTo(px(theta[i]), py(d[i]));
    ctx.lineTo(px(theta[d.length - 1]), py(0));
    ctx.lineTo(px(theta[0]), py(0));
    ctx.closePath();
    ctx.fillStyle = "rgba(43,108,176,0.22)";
    ctx.fill();
    ctx.strokeStyle = "#2b6cb0";
    ctx.lineWidth = 1.4 * devicePixelRatio;
    ctx.beginPath();
    ctx.moveTo(px(theta[0]), py(d[0]));
    for (let i = 1; i < d.length; i++) ctx.lineTo(px(theta[i]), py(d[i]));
    ctx.stroke();
  }, [result]);

  return (
    <div className="mspec">
      <div className="cap">
        Wave energy by angle
        <span className="val">dR_w/dθ — its integral is R_w</span>
      </div>
      <canvas ref={ref} className="mspeccv" />
    </div>
  );
}
