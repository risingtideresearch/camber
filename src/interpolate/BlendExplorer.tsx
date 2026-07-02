import { useMemo, type ReactNode } from "react";
import type { Hydro } from "../core/hydro";
import {
  HEAT_METRICS,
  metricByKey,
  fmtMetric,
  type MetricDef,
} from "./metrics";
import type { Sample } from "./blend";

// ---------- the scatter explorer: sampled blends plotted against two metrics; click a point to jump there ----------
// Each dot is a sampled blend, plotted by the two chosen metrics. Click one to jump the live blend there; the
// red ring marks the current blend.
const SCW = 480,
  SCH = 270,
  SCM = { l: 56, r: 14, t: 12, b: 36 }; // viewBox + plot margins

interface BlendExplorerProps {
  samples: Sample[];
  sampling: boolean;
  liveHydro: Hydro | null;
  scatterX: string;
  scatterY: string;
  onScatterX: (key: string) => void;
  onScatterY: (key: string) => void;
  onJump: (sampleIndex: number) => void;
}

interface ScatterMap {
  sx: (v: number) => number;
  sy: (v: number) => number;
  defX: MetricDef;
  defY: MetricDef;
}

const noteText = (t: string): ReactNode => (
  <text
    x={SCW / 2}
    y={SCH / 2}
    textAnchor="middle"
    fontSize="12"
    fill="#94a3b8"
  >
    {t}
  </text>
);

export function BlendExplorer({
  samples,
  sampling,
  liveHydro,
  scatterX,
  scatterY,
  onScatterX,
  onScatterY,
  onJump,
}: BlendExplorerProps) {
  // the plot body (axes + sample points) — recomputed only when the samples or the chosen axes change
  const plot = useMemo<{ body: ReactNode; map: ScatterMap | null }>(() => {
    if (sampling)
      return { body: noteText("sampling the blend space…"), map: null };
    const defX = metricByKey(scatterX),
      defY = metricByKey(scatterY);
    if (!defX || !defY)
      return { body: noteText("pick two metrics"), map: null };
    if (samples.length < 2)
      return { body: noteText("load a blend to explore"), map: null };
    const pts = samples
      .map((smp, i) => ({
        i,
        x: smp.h && smp.h.validWaterplane ? defX.get(smp.h) : NaN,
        y: smp.h && smp.h.validWaterplane ? defY.get(smp.h) : NaN,
      }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 2)
      return {
        body: noteText("no valid samples at this waterline"),
        map: null,
      };
    let xlo = Infinity,
      xhi = -Infinity,
      ylo = Infinity,
      yhi = -Infinity;
    for (const p of pts) {
      xlo = Math.min(xlo, p.x);
      xhi = Math.max(xhi, p.x);
      ylo = Math.min(ylo, p.y);
      yhi = Math.max(yhi, p.y);
    }
    const padR = (lo: number, hi: number): [number, number] => {
      const d = (hi - lo) * 0.06 || Math.abs(hi) * 0.06 || 1;
      return [lo - d, hi + d];
    };
    [xlo, xhi] = padR(xlo, xhi);
    [ylo, yhi] = padR(ylo, yhi);
    const plotW = SCW - SCM.l - SCM.r,
      plotH = SCH - SCM.t - SCM.b;
    const sx = (v: number): number => SCM.l + ((v - xlo) / (xhi - xlo)) * plotW;
    const sy = (v: number): number =>
      SCM.t + (1 - (v - ylo) / (yhi - ylo)) * plotH;
    const body = (
      <>
        <rect
          x={SCM.l}
          y={SCM.t}
          width={plotW}
          height={plotH}
          fill="#fbfcfe"
          stroke="#e2e8f0"
        />
        <text x={SCM.l} y={SCH - 22} fontSize="10" fill="#718096">
          {fmtMetric(xlo)}
        </text>
        <text
          x={SCW - SCM.r}
          y={SCH - 22}
          textAnchor="end"
          fontSize="10"
          fill="#718096"
        >
          {fmtMetric(xhi)}
        </text>
        <text
          x={SCW / 2}
          y={SCH - 8}
          textAnchor="middle"
          fontSize="11"
          fill="#1a202c"
        >
          {defX.label}
        </text>
        <text
          x={SCM.l - 8}
          y={SCM.t + 8}
          textAnchor="end"
          fontSize="10"
          fill="#718096"
        >
          {fmtMetric(yhi)}
        </text>
        <text
          x={SCM.l - 8}
          y={SCM.t + plotH}
          textAnchor="end"
          fontSize="10"
          fill="#718096"
        >
          {fmtMetric(ylo)}
        </text>
        <text
          transform={`translate(14 ${SCM.t + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          fontSize="11"
          fill="#1a202c"
        >
          {defY.label}
        </text>
        {pts.map((p) => (
          <circle
            key={p.i}
            className="spt"
            cx={sx(p.x).toFixed(1)}
            cy={sy(p.y).toFixed(1)}
            r="3.5"
            fill="#2b6cb0"
            fillOpacity="0.5"
            stroke="#fff"
            strokeWidth="0.75"
            onPointerDown={() => onJump(p.i)}
          />
        ))}
      </>
    );
    return { body, map: { sx, sy, defX, defY } };
  }, [samples, sampling, scatterX, scatterY, onJump]);

  // the current-blend marker (cheap; follows the live hydrostatics without recomputing the plot)
  const marker = useMemo(() => {
    const map = plot.map;
    if (!map || !liveHydro || !liveHydro.validWaterplane) return null;
    const x = map.defX.get(liveHydro),
      y = map.defY.get(liveHydro);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { cx: map.sx(x).toFixed(1), cy: map.sy(y).toFixed(1) };
  }, [plot, liveHydro]);

  const axisSelect = (
    value: string,
    onChange: (key: string) => void,
    title: string,
  ): ReactNode => (
    <select
      title={title}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {HEAT_METRICS.map((m) => (
        <option key={m.key} value={m.key}>
          {m.label}
        </option>
      ))}
    </select>
  );

  return (
    <div className="card">
      <div className="cap">
        <span>Blend explorer</span>
        <span className="scataxes">
          <label>Y</label>
          {axisSelect(scatterY, onScatterY, "Vertical-axis metric")}
          <label>vs X</label>
          {axisSelect(scatterX, onScatterX, "Horizontal-axis metric")}
        </span>
      </div>
      <svg
        id="scatter"
        viewBox="0 0 480 270"
        preserveAspectRatio="xMidYMid meet"
      >
        {plot.body}
        {marker && (
          <circle
            id="scatterMark"
            cx={marker.cx}
            cy={marker.cy}
            r="6"
            fill="none"
            stroke="var(--slider)"
            strokeWidth="2.5"
          />
        )}
      </svg>
      <div className="hint">
        Each dot is a sampled blend, plotted by the two metrics. Click one to
        jump the blend there; the red ring is the current blend.
      </div>
    </div>
  );
}
