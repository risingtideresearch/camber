import { useEffect, useMemo, useState } from "react";
import type { Model } from "../core/model";
import { L } from "../core/model";
import { michellCurve, type MichellCurve } from "../core/michell";
import { formFactor, type Hydro } from "../core/hydro";
import { holtrop, type HoltropShip } from "../core/holtrop";
import type { Unit, Water } from "../components/MetricsPanel";

// ---------- the speed / power curve ----------
// Estimated BRAKE power P_B = P_E / PC in kW over the sailing range, from two independent estimates the
// user can compare:
//
//  • MICHELL (default): P_E = R_total · U with R_total = ((1+k)·C_f + C_w)·½ρU²S — C_w from Michell's
//    integral (src/core/michell.ts), C_f from the ITTC-57 line C_f = 0.075/(log₁₀Re − 2)², and (1+k)
//    the Holtrop form factor (src/core/hydro.ts) lifting flat-plate friction to include viscous-pressure
//    drag. This curve is shape-true (Michell reads the actual offsets, so humps/hollows are real) but
//    thin-ship, so it UNDER-reads the absolute level for beamy (low L/B) hulls.
//  • HOLTROP (optional overlay): the full Holtrop-Mennen statistical total (src/core/holtrop.ts). It only
//    sees bulk coefficients so it can't show a hull's individual humps, but it is calibrated across L/B
//    and gives a trustworthy absolute LEVEL — the beam-driven magnitude Michell misses. Toggle it on to
//    sanity-check the Michell curve's height against a known hull.
//
// Both are effective (tow) power ÷ the same lumped propulsive coefficient PC → brake power; neither adds
// air drag. A first-order estimate for comparing hulls and trims, not a substitute for a propulsion match.
//
// The Michell curve C_w(Fn) is scale-free and depends only on the geometry at the current waterline, so
// it is recomputed (debounced) only when the hull or trim changes; Holtrop is cheap and re-evaluated per
// render from the live hydrostatics. The LOA / unit / water inputs re-dimensionalize instantly.

const FNS: number[] = Array.from({ length: 49 }, (_, i) => 0.05 + i * 0.0125);

// chart geometry (viewBox units)
const CW = 480,
  CH = 260,
  M = { l: 50, r: 12, t: 12, b: 34 };

const G = { m: 9.80665, ft: 32.174 }; // gravity per length unit
const TO_KN = { m: 1.94384, ft: 0.592484 }; // (m/s | ft/s) → knots
// effective power → kilowatts, per length unit: m/s·N = W (÷1000); ft/s·lbf = 1.355818 W (÷1000)
const TO_KW = { m: 1 / 1000, ft: 1.355818 / 1000 };
// overall (lumped) propulsive coefficient P_B = P_E / PC — quasi-propulsive × shaft, appendages, etc.
// 0.6 is a mid-range value for a small displacement hull; edit to match a known propulsion package
const PC = 0.6;
// kinematic viscosity at 15 °C (ITTC), per length unit
const NU = {
  m: { salt: 1.188e-6, fresh: 1.139e-6 }, // m²/s
  ft: { salt: 1.188e-6 * 10.7639, fresh: 1.139e-6 * 10.7639 }, // ft²/s
};

interface PowerPanelProps {
  model: Model;
  modelVersion: number;
  active: boolean; // a hull is loaded and the waterplane is valid
  hydro: Hydro | null; // live hydrostatics — feeds the form factor and the Holtrop overlay
  loa: number;
  unit: Unit;
  water: Water;
}

interface PowerPoint {
  kn: number;
  pw: number; // Michell wave share of brake power P_B (kW)
  pf: number; // friction share (kW)
  pt: number; // Michell total brake power (kW)
  rt: number; // Michell total resistance (N | lbf)
  ph: number; // Holtrop total brake power (kW); NaN when unavailable
}

export function PowerPanel({
  model,
  modelVersion,
  active,
  hydro,
  loa,
  unit,
  water,
}: PowerPanelProps) {
  const [showHoltrop, setShowHoltrop] = useState(true);
  // Holtrop form factor (1+k) on the Michell curve's friction term; 1 = flat-plate only
  const formK = useMemo(() => (hydro ? formFactor(hydro) : 1), [hydro]);

  // the live hull as a full-scale SI ship for Holtrop: model-unit geometry × the metrics scale, then
  // converted to metres (Holtrop is calibrated in SI). Coefficients and LCB% are already scale-free.
  const ship = useMemo<HoltropShip | null>(() => {
    if (!hydro || !hydro.validWaterplane || !(loa > 0)) return null;
    const lin = (loa / L) * (unit === "m" ? 1 : 0.3048); // model unit → metres
    const amid = (hydro.xAft + hydro.xFwd) / 2;
    return {
      L: hydro.lwl * lin,
      B: hydro.bwl * lin,
      T: hydro.draft * lin,
      vol: hydro.vol * lin ** 3,
      cp: hydro.cp,
      cm: hydro.cm,
      cwp: hydro.cw,
      lcb: (100 * (hydro.lcb - amid)) / hydro.lwl, // % of L fwd of amidships
      S: hydro.wettedArea * lin ** 2,
      iE: hydro.halfEntrance, // NaN → Holtrop estimates it
      salt: water === "salt",
    };
  }, [hydro, loa, unit, water]);
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
        rf = formK * cf * q, // (1+k) form factor lifts flat-plate friction to viscous total
        // resistance·speed → effective power in kW, then ÷PC for brake power
        toP = (u * TO_KW[unit]) / PC,
        kn = u * TO_KN[unit];
      // Holtrop total at the same speed (SI throughout): R_total[N]·V[m/s]/1000 = kW, then ÷PC
      const vMs = kn / TO_KN.m;
      const ph = ship ? (holtrop(ship, vMs).rTotal * vMs) / 1000 / PC : NaN;
      out.push({
        kn,
        pw: rw * toP,
        pf: rf * toP,
        pt: (rw + rf) * toP,
        rt: rw + rf,
        ph,
      });
    }
    return out.length >= 2 ? out : null;
  }, [curve, formK, ship, loa, unit, water]);

  const plotW = CW - M.l - M.r,
    plotH = CH - M.t - M.b;

  const holtropOn = showHoltrop && !!ship;
  // whether the hull sits inside Holtrop's fitted envelope (per-hull, so evaluate once at any speed)
  const holtropInRange = useMemo(
    () => (ship ? holtrop(ship, 1).inRange : true),
    [ship],
  );
  const body = useMemo(() => {
    if (!pts) return null;
    const knMax = pts[pts.length - 1].kn,
      // scale to whichever curve is taller so the overlay never clips
      peak = Math.max(
        ...pts.map((p) => p.pt),
        ...(holtropOn ? pts.map((p) => p.ph).filter(Number.isFinite) : []),
      ),
      pMax = peak * 1.08;
    if (!(knMax > 0) || !(pMax > 0)) return null;
    const sx = (kn: number): number => M.l + (kn / knMax) * plotW;
    const sy = (p: number): number => M.t + plotH * (1 - p / pMax);
    // a polyline over only the finite samples of f (Holtrop can be NaN at the extremes)
    const line = (f: (p: PowerPoint) => number): string =>
      pts
        .filter((p) => Number.isFinite(f(p)))
        .map((p) => `${sx(p.kn).toFixed(1)},${sy(f(p)).toFixed(1)}`)
        .join(" ");
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
      holtrop: line((p) => p.ph),
    };
  }, [pts, plotW, plotH, holtropOn]);

  const hoverPt = hover != null && pts && body ? pts[hover] : null;
  const pUnit = "kW";
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
        <span>Speed / power · brake</span>
        {busy && <span className="powerbusy">computing…</span>}
        <span style={{ flex: 1 }} />
        <label
          className="holtroptoggle"
          title="Overlay the Holtrop-Mennen total-power estimate"
        >
          <input
            type="checkbox"
            checked={showHoltrop}
            onChange={(e) => setShowHoltrop(e.target.checked)}
          />
          Holtrop
        </label>
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
            {`P_B · ${pUnit}`}
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
              {holtropOn && (
                <polyline
                  points={body.holtrop}
                  fill="none"
                  stroke="#2f855a"
                  strokeWidth="2.4"
                  strokeDasharray="9 5"
                  strokeLinecap="round"
                />
              )}
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
              {holtropOn && Number.isFinite(hoverPt.ph) && (
                <circle
                  cx={body.sx(hoverPt.kn)}
                  cy={body.sy(hoverPt.ph)}
                  r="3.5"
                  fill="#2f855a"
                />
              )}
            </g>
          )}
        </svg>
        <div className="powerlegend">
          <span className="lg lgtotal">Michell total</span>
          <span className="lg lgwave">wave (Michell)</span>
          <span className="lg lgfric">friction (ITTC-57 · 1+k)</span>
          {holtropOn && (
            <span className="lg lgholtrop">
              Holtrop total{!holtropInRange && " · extrapolated"}
            </span>
          )}
        </div>
        <div className="powerreadout">
          {hoverPt
            ? `${hoverPt.kn.toFixed(1)} kn · Michell ${fmtP(hoverPt.pt)} (wave ${fmtP(hoverPt.pw)} + friction ${fmtP(hoverPt.pf)})` +
              (holtropOn && Number.isFinite(hoverPt.ph)
                ? ` · Holtrop ${fmtP(hoverPt.ph)}`
                : ` · R ${fmtR(hoverPt.rt)}`)
            : " "}
        </div>
        <div className="hint">
          Estimated brake (engine) power ÷ propulsive coefficient
          PC&nbsp;=&nbsp;{PC.toFixed(2)}. Solid line: Michell wave + ITTC-57
          friction (form factor 1+k&nbsp;=&nbsp;{formK.toFixed(2)}) — shape-true
          but thin-ship, so it under-reads beamy hulls. Dashed: the
          Holtrop-Mennen statistical total, an absolute-level anchor (no
          individual humps). They agree on friction and diverge where wave
          resistance does.
          {holtropOn && !holtropInRange
            ? " This hull is outside Holtrop's fitted envelope (L/B, C_P or LCB), so its dashed level is extrapolated — treat it as indicative."
            : " No appendage or air drag."}
        </div>
      </div>
    </div>
  );
}
