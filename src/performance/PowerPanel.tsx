import { useEffect, useMemo, useState } from "react";
import type { Model } from "../core/model";
import { L } from "../core/model";
import { michellCurve, type MichellCurve } from "../core/michell";
import { formFactor, type Hydro } from "../core/hydro";
import { holtrop, type HoltropShip } from "../core/holtrop";
import { savitsky, type SavitskyShip, DEFAULT_SPRAY } from "../core/savitsky";
import { blendResistance, planingCapability, BLEND_LO } from "../core/blend";
import type { Unit, Water } from "../components/MetricsPanel";

// ---------- the speed / power curve ----------
// Estimated BRAKE power P_B = P_E / PC in kW over the sailing range. The primary line is a BLEND of three
// resistance methods, each used where it is physically valid and crossfaded by volumetric Froude number
// (src/core/blend.ts):
//
//   • displacement (low Fn_∇): Holtrop-Mennen statistical total (src/core/holtrop.ts)
//   • planing (high Fn_∇):     Savitsky, incl. a whisker-spray allowance (src/core/savitsky.ts)
//   • the crossfade spans the semi-displacement hump.
//
// Michell (thin-ship wave resistance + ITTC-57 friction with a Holtrop form factor) is NOT in the blend —
// it under-reads beamy hulls badly — but rides along as a shape diagnostic. All three methods are
// available as faint underlays behind the "methods" toggle so the handoff is visible; the readout shows
// the blend plus how much planing weight is in play.
//
// Everything is computed at full scale in SI (metres, newtons, m/s) regardless of the metric/imperial
// display toggle — brake power in kW and speed in knots are unit-system independent. The Michell curve
// C_w(Fn) is scale-free and recomputed (debounced) only when the hull/trim changes; Holtrop and Savitsky
// are cheap and re-evaluated per render. Calibrated against S38ish/NPish2 sea-trial data (PC and the
// blend band); no appendage or air-drag allowance.

// Froude range runs to 0.9 (not the displacement blender's 0.65) so a short-LWL planing hull's speed
// range — well past the hump — is on screen. Michell is only diagnostic up here; the blend leans on
// Holtrop/Savitsky at these speeds anyway.
const FNS: number[] = Array.from({ length: 69 }, (_, i) => 0.05 + i * 0.0125);

// chart geometry (viewBox units)
const CW = 480,
  CH = 260,
  M = { l: 50, r: 12, t: 12, b: 34 };

const G = 9.80665; // m/s²
const TO_KN = 1.94384; // m/s → knots
// overall (lumped) propulsive coefficient P_B = P_E / PC — quasi-propulsive × shaft, appendages, etc.
// 0.57 was fitted to the NPish2 sea-trial data; edit to match a known propulsion package.
const PC = 0.57;
// seawater / freshwater density (kg/m³) and kinematic viscosity (m²/s) at 15 °C (ITTC), for Michell
const RHO = { salt: 1025, fresh: 1000 };
const NU = { salt: 1.18831e-6, fresh: 1.13902e-6 };

interface PowerPanelProps {
  model: Model;
  modelVersion: number;
  active: boolean; // a hull is loaded and the waterplane is valid
  hydro: Hydro | null; // live hydrostatics — feeds every method
  loa: number;
  unit: Unit;
  water: Water;
}

interface PowerPoint {
  kn: number;
  w: number; // planing weight in the blend [0,1]
  pBlend: number; // primary brake-power estimate (kW)
  pMichell: number; // Michell wave + friction, diagnostic (kW)
  pHoltrop: number; // Holtrop total, diagnostic (kW)
  pSavitsky: number; // Savitsky total, diagnostic (kW); NaN below the planing band
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
  const [showMethods, setShowMethods] = useState(false);
  // Holtrop form factor (1+k) on the Michell diagnostic's friction term
  const formK = useMemo(() => (hydro ? formFactor(hydro) : 1), [hydro]);

  // the live hull as full-scale SI ships for Holtrop and Savitsky: model-unit geometry × the metrics
  // scale, converted to metres. Coefficients / LCB% are already scale-free.
  const ships = useMemo(() => {
    if (!hydro || !hydro.validWaterplane || !(loa > 0)) return null;
    const lin = (loa / L) * (unit === "m" ? 1 : 0.3048); // model unit → metres
    const amid = (hydro.xAft + hydro.xFwd) / 2;
    const salt = water === "salt";
    const hol: HoltropShip = {
      L: hydro.lwl * lin,
      B: hydro.bwl * lin,
      T: hydro.draft * lin,
      vol: hydro.vol * lin ** 3,
      cp: hydro.cp,
      cm: hydro.cm,
      cwp: hydro.cw,
      lcb: (100 * (hydro.lcb - amid)) / hydro.lwl, // % of L fwd of amidships
      S: hydro.wettedArea * lin ** 2,
      iE: hydro.halfEntrance,
      salt,
    };
    const sav: SavitskyShip = {
      weight: RHO[salt ? "salt" : "fresh"] * hydro.vol * lin ** 3 * G,
      beam: hydro.bwl * lin, // waterline beam as a proxy for chine/planing beam
      beta: hydro.deadrise, // amidships deadrise as a proxy for the planing area
      lcg: (hydro.lcb - hydro.xAft) * lin, // forward of the transom
      salt,
    };
    return { hol, sav };
  }, [hydro, loa, unit, water]);

  // the last computed Michell curve, keyed to the model version that produced it ("computing…" is
  // derived, and the stale curve stays up while the fresh one cooks)
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

  // dimensionalize every method at the chosen LOA / water, all in SI, → brake power in kW
  const pts = useMemo<PowerPoint[] | null>(() => {
    if (!curve || !ships || !(loa > 0)) return null;
    const lin = (loa / L) * (unit === "m" ? 1 : 0.3048);
    const lwlM = curve.lwl * lin,
      areaM = curve.wettedArea * lin ** 2,
      rho = RHO[water],
      nu = NU[water],
      cbrtVol = Math.cbrt(ships.hol.vol),
      // per-hull planing capability (form gate) — keeps slender displacement hulls off the Savitsky branch
      capability = planingCapability(ships.hol.L / ships.hol.B);
    const toBrake = (R: number, V: number): number => (R * V) / 1000 / PC; // N·m/s → kW
    const out: PowerPoint[] = [];
    for (let i = 0; i < FNS.length; i++) {
      const cw = curve.cw[i];
      if (!Number.isFinite(cw)) continue;
      const V = FNS[i] * Math.sqrt(G * lwlM),
        fnVol = V / Math.sqrt(G * cbrtVol),
        re = (V * lwlM) / nu,
        cf = 0.075 / (Math.log10(re) - 2) ** 2,
        q = 0.5 * rho * V * V * areaM;
      const rMich = (cw + formK * cf) * q,
        rHol = holtrop(ships.hol, V).rTotal,
        rSav = savitsky(ships.sav, V, DEFAULT_SPRAY).rTotal;
      const { r: rBlend, w } = blendResistance(fnVol, rHol, rSav, capability);
      out.push({
        kn: V * TO_KN,
        w,
        pBlend: toBrake(rBlend, V),
        pMichell: toBrake(rMich, V),
        pHoltrop: toBrake(rHol, V),
        // Savitsky shown only for planing-capable hulls, in the speed range where it feeds the blend
        pSavitsky:
          capability > 0.5 && fnVol >= BLEND_LO ? toBrake(rSav, V) : NaN,
      });
    }
    return out.length >= 2 ? out : null;
  }, [curve, ships, formK, loa, unit, water]);

  const plotW = CW - M.l - M.r,
    plotH = CH - M.t - M.b;

  // whether the hull sits inside Holtrop's fitted envelope (per-hull; evaluate once at any speed)
  const holtropInRange = useMemo(
    () => (ships ? holtrop(ships.hol, 1).inRange : true),
    [ships],
  );
  const body = useMemo(() => {
    if (!pts) return null;
    const knMax = pts[pts.length - 1].kn,
      // scale to the blend, plus the method underlays when shown, so nothing clips
      peak = Math.max(
        ...pts.map((p) => p.pBlend),
        ...(showMethods
          ? pts
              .flatMap((p) => [p.pMichell, p.pHoltrop, p.pSavitsky])
              .filter(Number.isFinite)
          : []),
      ),
      pMax = peak * 1.1;
    if (!(knMax > 0) || !(pMax > 0)) return null;
    const sx = (kn: number): number => M.l + (kn / knMax) * plotW;
    const sy = (p: number): number => M.t + plotH * (1 - p / pMax);
    const line = (f: (p: PowerPoint) => number): string =>
      pts
        .filter((p) => Number.isFinite(f(p)))
        .map((p) => `${sx(p.kn).toFixed(1)},${sy(f(p)).toFixed(1)}`)
        .join(" ");
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
      blend: line((p) => p.pBlend),
      michell: line((p) => p.pMichell),
      holtrop: line((p) => p.pHoltrop),
      savitsky: line((p) => p.pSavitsky),
    };
  }, [pts, plotW, plotH, showMethods]);

  const hoverPt = hover != null && pts && body ? pts[hover] : null;
  const fmtP = (v: number): string =>
    `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} kW`;

  return (
    <div className="card">
      <div className="cap">
        <span>Speed / power · brake</span>
        {busy && <span className="powerbusy">computing…</span>}
        <span style={{ flex: 1 }} />
        <label
          className="holtroptoggle"
          title="Show the individual method curves behind the blend"
        >
          <input
            type="checkbox"
            checked={showMethods}
            onChange={(e) => setShowMethods(e.target.checked)}
          />
          methods
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
            P_B · kW
          </text>
          {body && (
            <>
              {showMethods && (
                <>
                  <polyline
                    points={body.michell}
                    fill="none"
                    stroke="#dd6b20"
                    strokeWidth="1.2"
                    strokeDasharray="4 3"
                  />
                  <polyline
                    points={body.holtrop}
                    fill="none"
                    stroke="#2f855a"
                    strokeWidth="1.2"
                    strokeDasharray="4 3"
                  />
                  <polyline
                    points={body.savitsky}
                    fill="none"
                    stroke="#805ad5"
                    strokeWidth="1.2"
                    strokeDasharray="4 3"
                  />
                </>
              )}
              <polyline
                points={body.blend}
                fill="none"
                stroke="#2b6cb0"
                strokeWidth="2.6"
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
                cy={body.sy(hoverPt.pBlend)}
                r="3.5"
                fill="#2b6cb0"
              />
            </g>
          )}
        </svg>
        <div className="powerlegend">
          <span className="lg lgblend">best estimate</span>
          {showMethods && (
            <>
              <span className="lg lgmich">Michell</span>
              <span className="lg lgholt">Holtrop{!holtropInRange && "*"}</span>
              <span className="lg lgsavi">Savitsky</span>
            </>
          )}
        </div>
        <div className="powerreadout">
          {hoverPt
            ? `${hoverPt.kn.toFixed(1)} kn · ${fmtP(hoverPt.pBlend)} · ${(hoverPt.w * 100).toFixed(0)}% planing` +
              (showMethods
                ? ` · Michell ${fmtP(hoverPt.pMichell)} · Holtrop ${fmtP(hoverPt.pHoltrop)}` +
                  (Number.isFinite(hoverPt.pSavitsky)
                    ? ` · Savitsky ${fmtP(hoverPt.pSavitsky)}`
                    : "")
                : "")
            : " "}
        </div>
        <div className="hint">
          Estimated brake power ÷ propulsive coefficient PC&nbsp;=&nbsp;
          {PC.toFixed(2)}. The line blends Holtrop (displacement) into Savitsky
          (planing) by volumetric Froude number, crossfading through the
          semi-displacement hump. Turn on <em>methods</em> to see the three
          curves behind it. Calibrated to sea-trial data; no appendage or air
          drag.
          {showMethods && !holtropInRange
            ? " *Holtrop is outside its fitted envelope for this hull (extrapolated)."
            : ""}
        </div>
      </div>
    </div>
  );
}
