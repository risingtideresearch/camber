import { useMemo, useRef, type ReactNode } from "react";
import {
  clampPoly,
  padVerts,
  PAD,
  HEAT_G,
  type Hull,
  type Pt,
  type Sample,
} from "./blend";
import { HEAT_METRICS, metricByKey, heatColor, fmtMetric } from "./metrics";

// ---------- the blend control: a single slider for 2 hulls, a barycentric pad for 3+ ----------
// The control's position is the source of truth (tTwo for the slider, puck for the pad); the hull weights are
// read off it upstream. A 2-hull blend is a 1-D simplex (the slider); 3 hulls a triangle (the pad is exact);
// 4–5 a regular polygon (the pad explores a 2-D slice of the simplex).

const PALETTE = ["#2b6cb0", "#dd6b20", "#0f766e", "#7c3aed", "#b45309"];
const col = (i: number): string => PALETTE[i % PALETTE.length];

interface BlendControlProps {
  hulls: Hull[];
  weights: number[]; // barycentric weights implied by the control (Σ = 1)
  promoted: boolean;
  tTwo: number;
  puck: Pt;
  onTTwo: (t: number) => void;
  onPuck: (p: Pt) => void;
  samples: Sample[];
  heatMetric: string;
  onHeatMetric: (key: string) => void;
}

function statusText(n: number, promoted: boolean): string {
  if (n === 0) return "Open a blend from the design library to begin.";
  if (n === 1) return "1 hull loaded — needs at least one more to interpolate.";
  return (
    `${n} hulls · blending` +
    (promoted
      ? " · mixed topologies promoted to a common form (pure-hull ends approximate to a few mm)"
      : "")
  );
}

export function BlendControl({
  hulls,
  weights,
  promoted,
  tTwo,
  puck,
  onTTwo,
  onPuck,
  samples,
  heatMetric,
  onHeatMetric,
}: BlendControlProps) {
  const n = hulls.length;
  const total = weights.reduce((a, x) => a + x, 0) || 1;
  const pct = (i: number): string =>
    `${((weights[i] / total) * 100).toFixed(0)}%`;

  // the pad geometry + the metric heatmap (recomputed only when the samples / metric / family change)
  const V = useMemo(() => padVerts(n), [n]);
  const polyD = useMemo(
    () =>
      V.map(
        (v, i) => `${i ? "L" : "M"}${v.x.toFixed(1)} ${v.y.toFixed(1)}`,
      ).join(" ") + "Z",
    [V],
  );
  const heat = useMemo<{
    rects: ReactNode;
    legend: { label: string; lo: number; hi: number } | null;
  }>(() => {
    const def = metricByKey(heatMetric);
    if (!def || n < 3 || !samples.length) return { rects: null, legend: null };
    const cell = PAD / HEAT_G;
    const vals = samples.map((s) =>
      s.h && s.h.validWaterplane ? def.get(s.h) : NaN,
    );
    let lo = Infinity,
      hi = -Infinity;
    for (const v of vals)
      if (Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    if (!(hi > lo)) return { rects: null, legend: null };
    const span = hi - lo,
      s = (cell + 0.7).toFixed(1); // slight overlap to hide seams
    const rects = samples.map((smp, i) => (
      <rect
        key={i}
        x={(smp.gx * cell).toFixed(1)}
        y={(smp.gy * cell).toFixed(1)}
        width={s}
        height={s}
        fill={
          Number.isFinite(vals[i])
            ? heatColor((vals[i] - lo) / span)
            : "#e5e7eb"
        }
        opacity="0.85"
      />
    ));
    return { rects, legend: { label: def.label, lo, hi } };
  }, [samples, heatMetric, n]);

  // drag the puck (or press anywhere in the pad to jump it there)
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef(false);
  const toVB = (e: React.PointerEvent): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * PAD,
      y: ((e.clientY - r.top) / r.height) * PAD,
    };
  };
  const move = (e: React.PointerEvent): void => onPuck(clampPoly(toVB(e), V));
  const onPadDown = (e: React.PointerEvent): void => {
    draggingRef.current = true;
    svgRef.current?.setPointerCapture(e.pointerId);
    e.preventDefault();
    move(e);
  };
  const onPadMove = (e: React.PointerEvent): void => {
    if (draggingRef.current) move(e);
  };
  const onPadUp = (e: React.PointerEvent): void => {
    draggingRef.current = false;
    if (svgRef.current?.hasPointerCapture(e.pointerId))
      svgRef.current.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="card">
      <div className="cap">
        <span>Hull family &amp; blend weights</span>
      </div>
      <div className="ctl">
        <div id="status">{statusText(n, promoted)}</div>
        <div id="hullList">
          {n === 2 && (
            <div className="twoslider">
              <div className="twoends">
                <span className="e">
                  <span className="dot" style={{ background: col(0) }} />
                  <span className="nm" title={hulls[0].name}>
                    {hulls[0].name}
                  </span>
                </span>
                <span className="e r">
                  <span className="dot" style={{ background: col(1) }} />
                  <span className="nm" title={hulls[1].name}>
                    {hulls[1].name}
                  </span>
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={Math.round(tTwo * 100)}
                onChange={(e) => onTTwo(+e.target.value / 100)}
              />
              <div className="twopct">
                <span className="pa">{pct(0)}</span>
                <span className="pb">{pct(1)}</span>
              </div>
            </div>
          )}
          {n >= 3 && (
            <>
              <div className="padwrap">
                <svg
                  ref={svgRef}
                  id="blendPad"
                  viewBox={`0 0 ${PAD} ${PAD}`}
                  preserveAspectRatio="xMidYMid meet"
                  onPointerDown={onPadDown}
                  onPointerMove={onPadMove}
                  onPointerUp={onPadUp}
                  onPointerCancel={onPadUp}
                >
                  <defs>
                    <clipPath id="padClip">
                      <path d={polyD} />
                    </clipPath>
                  </defs>
                  <path d={polyD} fill="#f8fafc" stroke="none" />
                  <g id="heat" clipPath="url(#padClip)">
                    {heat.rects}
                  </g>
                  <path
                    d={polyD}
                    fill="none"
                    stroke="#e2e8f0"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  {V.map((v, i) => (
                    <line
                      key={`spoke-${i}`}
                      x1={puck.x}
                      y1={puck.y}
                      x2={v.x.toFixed(1)}
                      y2={v.y.toFixed(1)}
                      stroke={col(i)}
                      strokeWidth="2"
                      strokeOpacity={(
                        0.12 +
                        0.88 * (weights[i] / total)
                      ).toFixed(2)}
                    />
                  ))}
                  {V.map((v, i) => (
                    <circle
                      key={`dot-${i}`}
                      cx={v.x.toFixed(1)}
                      cy={v.y.toFixed(1)}
                      r="6"
                      fill={col(i)}
                      stroke="#fff"
                      strokeWidth="1.5"
                    />
                  ))}
                  <circle
                    className="puck"
                    cx={puck.x}
                    cy={puck.y}
                    r="9"
                    fill="#fff"
                    stroke="var(--ink)"
                    strokeWidth="2.5"
                  />
                </svg>
              </div>
              <div className="padlegend">
                {hulls.map((h, i) => (
                  <div className="legrow" key={i}>
                    <span className="dot" style={{ background: col(i) }} />
                    <span className="nm" title={h.name}>
                      {h.name}
                    </span>
                    <span className="pct">{pct(i)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="heatrow">
          <label htmlFor="metricSel">Colour by</label>
          <select
            id="metricSel"
            title="Colour the pad by a metric's value across the blend space"
            value={heatMetric}
            onChange={(e) => onHeatMetric(e.target.value)}
          >
            <option value="none">none</option>
            {HEAT_METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {heat.legend && (
          <div id="heatLegend">
            <span className="hl-k">{heat.legend.label}</span>
            <span className="hl-lo">{fmtMetric(heat.legend.lo)}</span>
            <span className="hl-bar" />
            <span className="hl-hi">{fmtMetric(heat.legend.hi)}</span>
          </div>
        )}
        <div className="hint">
          Drag toward a hull for more of it; the centre is an equal blend. Pick
          a metric to colour the pad by its value across the blend space.
        </div>
      </div>
    </div>
  );
}
