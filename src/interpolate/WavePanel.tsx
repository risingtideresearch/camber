import { useEffect, useMemo, useState } from "react";
import type { Model } from "../core/model";
import { L } from "../core/model";
import { michellCurve, type MichellCurve } from "../core/michell";
import type { Unit, Water } from "../components/MetricsPanel";

// ---------- wave resistance (Michell's integral), live from the blended hull ----------
// The C_w(Fn) curve — C_w = R_w/(½ρU²S) by thin-ship theory — recomputed on a short debounce after each
// blend change (the integral is a few hundred ms of work, too heavy for every drag frame). The curve is
// scale-free; hovering it reads out the dimensional speed and resistance at the LOA/water chosen in the
// metrics panel. Humps and hollows (not the absolute value — thin-ship flatters fat hulls) are the
// design signal: they mark speeds the hull fights and speeds it favors.

const FNS: number[] = Array.from({ length: 41 }, (_, i) => 0.1 + i * 0.0125);

// chart geometry (viewBox units)
const CW = 300,
  CH = 170,
  M = { l: 38, r: 10, t: 12, b: 30 };

const G = { m: 9.80665, ft: 32.174 }; // gravity per length unit
const TO_KN = { m: 1.94384, ft: 0.592484 }; // (m/s | ft/s) → knots

interface WavePanelProps {
  model: Model;
  modelVersion: number;
  active: boolean; // hulls loaded and the waterplane is valid
  loa: number;
  unit: Unit;
  water: Water;
}

export function WavePanel({
  model,
  modelVersion,
  active,
  loa,
  unit,
  water,
}: WavePanelProps) {
  // the last computed curve, keyed to the model version that produced it — "computing…" is DERIVED
  // (result version ≠ live version), so no synchronous setState in the effect; the stale curve stays
  // on screen while the fresh one cooks
  const [state, setState] = useState<{
    forVersion: number;
    curve: MichellCurve | null;
  }>({ forVersion: -1, curve: null });
  const [hover, setHover] = useState<number | null>(null);
  const curve = active ? state.curve : null;
  const busy = active && state.forVersion !== modelVersion;

  // recompute deferred: the blend writes the shared model during render; compute from it once the drag
  // pauses (the timeout restarts on every model version), keeping the sliders responsive
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => {
      setState({ forVersion: modelVersion, curve: michellCurve(model, FNS) });
    }, 150);
    return () => clearTimeout(id);
  }, [model, modelVersion, active]);

  // dimensionalization at the metrics length scale (readout only; the curve itself is scale-free)
  const scale = useMemo(() => {
    if (!curve || !(loa > 0)) return null;
    const s = loa / L,
      lwl = curve.lwl * s,
      area = curve.wettedArea * s * s,
      rho =
        unit === "m"
          ? water === "salt"
            ? 1025
            : 1000 // kg/m³
          : (water === "salt" ? 64 : 62.4) / G.ft; // slug/ft³
    const speed = (fn: number): number => fn * Math.sqrt(G[unit] * lwl);
    return {
      kn: (fn: number): number => speed(fn) * TO_KN[unit],
      rw: (fn: number, cw: number): number =>
        cw * 0.5 * rho * speed(fn) ** 2 * area, // N | lbf
    };
  }, [curve, loa, unit, water]);

  const fmtRw = (v: number): string =>
    unit === "m"
      ? v >= 1000
        ? `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} kN`
        : `${v.toFixed(0)} N`
      : `${v.toFixed(v < 100 ? 1 : 0)} lbf`;

  const plotW = CW - M.l - M.r,
    plotH = CH - M.t - M.b,
    fn0 = FNS[0],
    fn1 = FNS[FNS.length - 1];
  const sx = (fn: number): number => M.l + ((fn - fn0) / (fn1 - fn0)) * plotW;

  // the plot body — the curve in C_w·10³, y-scaled to its own maximum
  const body = useMemo(() => {
    if (!curve) return null;
    const kcw = curve.cw.map((c) => c * 1e3);
    if (!kcw.some((c) => Number.isFinite(c) && c > 0)) return null;
    const ymax = Math.max(...kcw.filter((c) => Number.isFinite(c))) * 1.08;
    const sy = (c: number): number => M.t + plotH * (1 - c / ymax);
    const pts = kcw
      .map((c, i) =>
        Number.isFinite(c)
          ? `${sx(FNS[i]).toFixed(1)},${sy(c).toFixed(1)}`
          : null,
      )
      .filter(Boolean)
      .join(" ");
    return { pts, sy, ymax };
    // sx/plotH are module-constant geometry; only the curve matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curve]);

  const hoverPt =
    hover != null && curve && Number.isFinite(curve.cw[hover]) && body
      ? {
          x: sx(FNS[hover]),
          y: body.sy(curve.cw[hover] * 1e3),
          fn: FNS[hover],
          cw: curve.cw[hover],
        }
      : null;

  return (
    <div className="card">
      <div className="cap">
        <span>Wave resistance · Michell</span>
        {busy && <span className="wavebusy">computing…</span>}
      </div>
      <div className="ctl">
        <svg
          className="wavechart"
          viewBox={`0 0 ${CW} ${CH}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect(),
              x = ((e.clientX - r.left) / r.width) * CW,
              fn = fn0 + ((x - M.l) / plotW) * (fn1 - fn0),
              i = Math.round((fn - fn0) / (FNS[1] - FNS[0]));
            setHover(i >= 0 && i < FNS.length ? i : null);
          }}
          onPointerLeave={() => setHover(null)}
        >
          <rect
            x={M.l}
            y={M.t}
            width={plotW}
            height={plotH}
            fill="#fbfcfe"
            stroke="#e2e8f0"
          />
          {[0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((fn) => (
            <g key={fn}>
              <line
                x1={sx(fn)}
                x2={sx(fn)}
                y1={M.t}
                y2={M.t + plotH}
                stroke="#eef2f7"
              />
              <text
                x={sx(fn)}
                y={CH - 18}
                textAnchor="middle"
                fontSize="9"
                fill="#718096"
              >
                {fn.toFixed(1)}
              </text>
              {scale && (
                <text
                  x={sx(fn)}
                  y={CH - 7}
                  textAnchor="middle"
                  fontSize="8"
                  fill="#a0aec0"
                >
                  {scale.kn(fn).toFixed(1)}kn
                </text>
              )}
            </g>
          ))}
          <text
            x={M.l - 6}
            y={M.t + 8}
            textAnchor="end"
            fontSize="9"
            fill="#718096"
          >
            {body ? body.ymax.toFixed(body.ymax < 10 ? 1 : 0) : ""}
          </text>
          <text
            x={M.l - 6}
            y={M.t + plotH}
            textAnchor="end"
            fontSize="9"
            fill="#718096"
          >
            0
          </text>
          <text
            transform={`translate(10 ${M.t + plotH / 2}) rotate(-90)`}
            textAnchor="middle"
            fontSize="9"
            fill="#1a202c"
          >
            C_w ×10³
          </text>
          <text
            x={M.l + plotW / 2}
            y={CH - 18}
            textAnchor="middle"
            fontSize="9"
            fill="#1a202c"
          >
            {/* Fn label sits between the tick rows when the knots row is present */}
            {scale ? "" : "Fn"}
          </text>
          {body && (
            <polyline
              points={body.pts}
              fill="none"
              stroke="#2b6cb0"
              strokeWidth="1.6"
            />
          )}
          {!body && !busy && (
            <text
              x={CW / 2}
              y={CH / 2}
              textAnchor="middle"
              fontSize="11"
              fill="#94a3b8"
            >
              {active ? "no wetted hull" : "load hulls"}
            </text>
          )}
          {hoverPt && (
            <g>
              <line
                x1={hoverPt.x}
                x2={hoverPt.x}
                y1={M.t}
                y2={M.t + plotH}
                stroke="#cbd5e0"
              />
              <circle cx={hoverPt.x} cy={hoverPt.y} r="3" fill="#2b6cb0" />
            </g>
          )}
        </svg>
        <div className="wavereadout">
          {hoverPt
            ? `Fn ${hoverPt.fn.toFixed(3)} · C_w ${(hoverPt.cw * 1e3).toFixed(2)}×10⁻³` +
              (scale
                ? ` · ${scale.kn(hoverPt.fn).toFixed(1)} kn · R_w ${fmtRw(scale.rw(hoverPt.fn, hoverPt.cw))}`
                : "")
            : " "}
        </div>
        <div className="hint">
          Thin-ship wave resistance (Michell&apos;s integral) vs Froude number,
          at the design waterline. Trust the humps and hollows more than the
          absolute value; an immersed transom is treated as dry (no closure).
        </div>
      </div>
    </div>
  );
}
