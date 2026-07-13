import { useEffect, useMemo, useState } from "react";
import type { Model } from "../core/model";
import { L } from "../core/model";
import { michellCurve, type MichellCurve } from "../core/michell";
import type { Unit, Water } from "../components/MetricsPanel";

// ---------- the speed / power curve ----------
// Bare-hull EFFECTIVE (towed) power P_E = R_total · U over the sailing range, with
//   R_total = (C_f + C_w) · ½ρU²S,
// C_w from Michell's integral (src/core/michell.ts) and C_f from the ITTC-57 friction line
// C_f = 0.075/(log₁₀Re − 2)². No form factor, appendage, air, or propulsive allowance — this is the
// hydrodynamic floor a propulsion system must beat, honest for comparing hulls and trims.
//
// The Michell curve C_w(Fn) is scale-free and depends only on the geometry at the current waterline, so
// it is recomputed (debounced) only when the hull or trim changes; the LOA / unit / water inputs
// re-dimensionalize instantly on render.

const FNS: number[] = Array.from({ length: 49 }, (_, i) => 0.05 + i * 0.0125);

// chart geometry (viewBox units)
const CW = 480,
  CH = 260,
  M = { l: 50, r: 12, t: 12, b: 34 };

const G = { m: 9.80665, ft: 32.174 }; // gravity per length unit
const TO_KN = { m: 1.94384, ft: 0.592484 }; // (m/s | ft/s) → knots
// kinematic viscosity at 15 °C (ITTC), per length unit
const NU = {
  m: { salt: 1.188e-6, fresh: 1.139e-6 }, // m²/s
  ft: { salt: 1.188e-6 * 10.7639, fresh: 1.139e-6 * 10.7639 }, // ft²/s
};

interface PowerPanelProps {
  model: Model;
  modelVersion: number;
  active: boolean; // a hull is loaded and the waterplane is valid
  loa: number;
  unit: Unit;
  water: Water;
}

interface PowerPoint {
  kn: number;
  pw: number; // wave part of P_E (kW | hp)
  pf: number; // friction part
  pt: number; // total
  rt: number; // total resistance (N | lbf)
}

export function PowerPanel({
  model,
  modelVersion,
  active,
  loa,
  unit,
  water,
}: PowerPanelProps) {
  // the last computed Michell curve, keyed to the model version that produced it ("computing…" is
  // derived, and the stale curve stays up while the fresh one cooks — same pattern as the blender's
  // wave panel)
  const [state, setState] = useState<{
    forVersion: number;
    curve: MichellCurve | null;
  }>({ forVersion: -1, curve: null });
  const [hover, setHover] = useState<number | null>(null);
  const curve = active ? state.curve : null;
  const busy = active && state.forVersion !== modelVersion;

  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => {
      setState({ forVersion: modelVersion, curve: michellCurve(model, FNS) });
    }, 150);
    return () => clearTimeout(id);
  }, [model, modelVersion, active]);

  // dimensionalize the scale-free curve at the chosen LOA / water
  const pts = useMemo<PowerPoint[] | null>(() => {
    if (!curve || !(loa > 0)) return null;
    const s = loa / L,
      lwl = curve.lwl * s,
      area = curve.wettedArea * s * s,
      g = G[unit],
      nu = NU[unit][water],
      rho =
        unit === "m"
          ? water === "salt"
            ? 1025
            : 1000 // kg/m³
          : (water === "salt" ? 64 : 62.4) / G.ft; // slug/ft³
    const out: PowerPoint[] = [];
    for (let i = 0; i < FNS.length; i++) {
      const cw = curve.cw[i];
      if (!Number.isFinite(cw)) continue;
      const u = FNS[i] * Math.sqrt(g * lwl),
        re = (u * lwl) / nu,
        cf = 0.075 / (Math.log10(re) - 2) ** 2,
        q = 0.5 * rho * u * u * area, // ½ρU²S
        rw = cw * q,
        rf = cf * q,
        toP = unit === "m" ? u / 1000 : u / 550; // W → kW | ft·lbf/s → hp
      out.push({
        kn: u * TO_KN[unit],
        pw: rw * toP,
        pf: rf * toP,
        pt: (rw + rf) * toP,
        rt: rw + rf,
      });
    }
    return out.length >= 2 ? out : null;
  }, [curve, loa, unit, water]);

  const plotW = CW - M.l - M.r,
    plotH = CH - M.t - M.b;

  const body = useMemo(() => {
    if (!pts) return null;
    const knMax = pts[pts.length - 1].kn,
      pMax = Math.max(...pts.map((p) => p.pt)) * 1.08;
    if (!(knMax > 0) || !(pMax > 0)) return null;
    const sx = (kn: number): number => M.l + (kn / knMax) * plotW;
    const sy = (p: number): number => M.t + plotH * (1 - p / pMax);
    const line = (f: (p: PowerPoint) => number): string =>
      pts.map((p) => `${sx(p.kn).toFixed(1)},${sy(f(p)).toFixed(1)}`).join(" ");
    // knot ticks at a readable step
    const rawStep = knMax / 7,
      mag = 10 ** Math.floor(Math.log10(rawStep)),
      step = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= rawStep) ?? mag;
    const ticks: number[] = [];
    for (let v = step; v < knMax; v += step) ticks.push(v);
    return {
      sx,
      sy,
      knMax,
      pMax,
      ticks,
      total: line((p) => p.pt),
      wave: line((p) => p.pw),
      friction: line((p) => p.pf),
    };
  }, [pts, plotW, plotH]);

  const hoverPt = hover != null && pts && body ? pts[hover] : null;
  const pUnit = unit === "m" ? "kW" : "hp";
  const fmtP = (v: number): string =>
    `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${pUnit}`;
  const fmtR = (v: number): string =>
    unit === "m"
      ? v >= 1000
        ? `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} kN`
        : `${v.toFixed(0)} N`
      : `${v.toFixed(v < 100 ? 1 : 0)} lbf`;

  return (
    <div className="card">
      <div className="cap">
        <span>Speed / power · effective</span>
        {busy && <span className="powerbusy">computing…</span>}
      </div>
      <div className="ctl">
        <svg
          className="powerchart"
          viewBox={`0 0 ${CW} ${CH}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerMove={(e) => {
            if (!pts || !body) return;
            const r = e.currentTarget.getBoundingClientRect(),
              x = ((e.clientX - r.left) / r.width) * CW,
              kn = ((x - M.l) / plotW) * body.knMax;
            let best = 0;
            for (let i = 1; i < pts.length; i++)
              if (Math.abs(pts[i].kn - kn) < Math.abs(pts[best].kn - kn))
                best = i;
            setHover(best);
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
          {body &&
            body.ticks.map((v) => (
              <g key={v}>
                <line
                  x1={body.sx(v)}
                  x2={body.sx(v)}
                  y1={M.t}
                  y2={M.t + plotH}
                  stroke="#eef2f7"
                />
                <text
                  x={body.sx(v)}
                  y={CH - 20}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#718096"
                >
                  {v}
                </text>
              </g>
            ))}
          <text
            x={M.l + plotW / 2}
            y={CH - 6}
            textAnchor="middle"
            fontSize="11"
            fill="#1a202c"
          >
            speed · kn
          </text>
          {body && (
            <text
              x={M.l - 8}
              y={M.t + 8}
              textAnchor="end"
              fontSize="10"
              fill="#718096"
            >
              {body.pMax.toFixed(body.pMax < 10 ? 1 : 0)}
            </text>
          )}
          <text
            x={M.l - 8}
            y={M.t + plotH}
            textAnchor="end"
            fontSize="10"
            fill="#718096"
          >
            0
          </text>
          <text
            transform={`translate(12 ${M.t + plotH / 2}) rotate(-90)`}
            textAnchor="middle"
            fontSize="11"
            fill="#1a202c"
          >
            {`P_E · ${pUnit}`}
          </text>
          {body && (
            <>
              <polyline
                points={body.friction}
                fill="none"
                stroke="#a0aec0"
                strokeWidth="1.2"
                strokeDasharray="4 3"
              />
              <polyline
                points={body.wave}
                fill="none"
                stroke="#dd6b20"
                strokeWidth="1.2"
              />
              <polyline
                points={body.total}
                fill="none"
                stroke="#2b6cb0"
                strokeWidth="2"
              />
            </>
          )}
          {!body && !busy && (
            <text
              x={CW / 2}
              y={CH / 2}
              textAnchor="middle"
              fontSize="12"
              fill="#94a3b8"
            >
              {!active
                ? "load a design"
                : !(loa > 0)
                  ? "set LOA to scale the curve"
                  : "no wetted hull at this waterline"}
            </text>
          )}
          {hoverPt && body && (
            <g>
              <line
                x1={body.sx(hoverPt.kn)}
                x2={body.sx(hoverPt.kn)}
                y1={M.t}
                y2={M.t + plotH}
                stroke="#cbd5e0"
              />
              <circle
                cx={body.sx(hoverPt.kn)}
                cy={body.sy(hoverPt.pt)}
                r="3.5"
                fill="#2b6cb0"
              />
            </g>
          )}
        </svg>
        <div className="powerlegend">
          <span className="lg lgtotal">total</span>
          <span className="lg lgwave">wave (Michell)</span>
          <span className="lg lgfric">friction (ITTC-57)</span>
        </div>
        <div className="powerreadout">
          {hoverPt
            ? `${hoverPt.kn.toFixed(1)} kn · ${fmtP(hoverPt.pt)} (wave ${fmtP(hoverPt.pw)} + friction ${fmtP(hoverPt.pf)}) · R ${fmtR(hoverPt.rt)}`
            : " "}
        </div>
        <div className="hint">
          Bare-hull effective (towed) power: ITTC-57 friction plus Michell wave
          resistance at the current waterline — no form factor, appendages, air,
          or propulsive losses. Hover for the breakdown at a speed.
        </div>
      </div>
    </div>
  );
}
