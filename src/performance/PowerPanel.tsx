import { useEffect, useMemo, useState } from "react";
import type { Model } from "../core/model";
import { michellCurve, type MichellCurve } from "../core/michell";
import type { Hydro } from "../core/hydro";
import { fromHydrostatics, linScale } from "../core/hullResistance";
import { computeResistance, FROUDES, DEFAULT_PC } from "../resistance/compute";
import { formFactor } from "../resistance/formFactor";
import type { HullGeometry, ResistancePoint } from "../resistance/types";
import type { Unit, Water } from "../components/MetricsPanel";

// ---------- the speed / power curve ----------
// The primary line is the blended best estimate from the resistance module (Holtrop → Savitsky by
// volumetric Froude number); Holtrop and Savitsky ride behind the "methods" toggle as diagnostics. The
// module owns all of that. This panel additionally overlays a Michell thin-ship wave curve as its own
// shape diagnostic — Michell is the app's choice and lives here, not in the module: it debounces the
// (heavy) Michell computation and dimensionalizes it with the module's form factor.

const G = 9.80665; // m/s²
const RHO = { salt: 1025, fresh: 1000 };
const NU = { salt: 1.18831e-6, fresh: 1.13902e-6 };

// chart geometry (viewBox units)
const CW = 480,
  CH = 260,
  M = { l: 50, r: 12, t: 12, b: 34 };

const PC = DEFAULT_PC;

interface PowerPanelProps {
  model: Model;
  modelVersion: number;
  active: boolean; // a hull is loaded and the waterplane is valid
  hydro: Hydro | null; // live hydrostatics — feeds the geometry spec
  loa: number;
  unit: Unit;
  water: Water;
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
  const [hover, setHover] = useState<number | null>(null);

  // the Michell wave curve is the one heavy computation and is scale-free (depends only on hull/trim, not
  // LOA/unit/water), so it is recomputed on a debounce keyed to the model version — the blend itself
  // (Holtrop + Savitsky) is cheap and updates live. "computing…" is derived (result version ≠ live).
  const [state, setState] = useState<{
    forVersion: number;
    curve: MichellCurve | null;
  }>({ forVersion: -1, curve: null });
  const michell = active ? state.curve : null;
  const busy = active && state.forVersion !== modelVersion;

  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => {
      setState({
        forVersion: modelVersion,
        curve: michellCurve(model, FROUDES),
      });
    }, 150);
    return () => clearTimeout(id);
  }, [model, modelVersion, active]);

  // geometry spec from the live hydrostatics (cheap; rebuilds as LOA/unit change)
  const geometry = useMemo<HullGeometry | null>(() => {
    if (!hydro || !hydro.validWaterplane || !(loa > 0)) return null;
    return fromHydrostatics(hydro, linScale(loa, unit));
  }, [hydro, loa, unit]);

  const result = useMemo(
    () => (geometry ? computeResistance(geometry, { water, pc: PC }) : null),
    [geometry, water],
  );
  const pts = result?.points ?? null;

  // Michell thin-ship diagnostic, computed here (the module doesn't do wave resistance): brake power per
  // Froude point = (C_w + (1+k)·C_f)·½ρV²S · V / PC. Aligned index-for-index with the result points
  // (both sweep FROUDES). NaN where Michell can't evaluate.
  const michellBrake = useMemo<number[] | null>(() => {
    if (!michell || !geometry) return null;
    const rho = RHO[water],
      nu = NU[water],
      { lwl, wettedArea: S } = geometry,
      fk = formFactor({
        lwl,
        beam: geometry.beam,
        draft: geometry.draft,
        cp: geometry.cp,
        lcbPct: geometry.lcbPct,
      });
    return michell.fns.map((fn, i) => {
      const cw = michell.cw[i];
      if (!Number.isFinite(cw)) return NaN;
      const V = fn * Math.sqrt(G * lwl),
        re = (V * lwl) / nu,
        cf = 0.075 / (Math.log10(re) - 2) ** 2,
        q = 0.5 * rho * V * V * S;
      return ((cw + fk * cf) * q * V) / 1000 / PC;
    });
  }, [michell, geometry, water]);

  const plotW = CW - M.l - M.r,
    plotH = CH - M.t - M.b;

  const body = useMemo(() => {
    if (!pts || pts.length < 2) return null;
    const knMax = pts[pts.length - 1].kn,
      // scale to the blend, plus the method underlays when shown, so nothing clips
      peak = Math.max(
        ...pts.map((p) => p.brakeKW),
        ...(showMethods
          ? [
              ...pts
                .flatMap((p) => [p.brakeHoltrop, p.brakeSavitsky])
                .filter(Number.isFinite),
              ...(michellBrake ?? []).filter(Number.isFinite),
            ]
          : []),
      ),
      pMax = peak * 1.1;
    if (!(knMax > 0) || !(pMax > 0)) return null;
    const sx = (kn: number): number => M.l + (kn / knMax) * plotW;
    const sy = (p: number): number => M.t + plotH * (1 - p / pMax);
    // polyline from a per-point accessor…
    const line = (f: (p: ResistancePoint) => number): string =>
      pts
        .filter((p) => Number.isFinite(f(p)))
        .map((p) => `${sx(p.kn).toFixed(1)},${sy(f(p)).toFixed(1)}`)
        .join(" ");
    // …or from an index-aligned array (the Michell overlay)
    const lineIdx = (vals: number[] | null): string =>
      vals
        ? pts
            .map((p, i) =>
              Number.isFinite(vals[i])
                ? `${sx(p.kn).toFixed(1)},${sy(vals[i]).toFixed(1)}`
                : null,
            )
            .filter(Boolean)
            .join(" ")
        : "";
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
      blend: line((p) => p.brakeKW),
      michell: lineIdx(michellBrake),
      holtrop: line((p) => p.brakeHoltrop),
      savitsky: line((p) => p.brakeSavitsky),
    };
  }, [pts, plotW, plotH, showMethods, michellBrake]);

  const hoverPt = hover != null && pts && body ? pts[hover] : null;
  const holtropInRange = result?.holtropInRange ?? true;
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
                cy={body.sy(hoverPt.brakeKW)}
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
            ? `${hoverPt.kn.toFixed(1)} kn · ${fmtP(hoverPt.brakeKW)} · ${hoverPt.specificKWperT.toFixed(2)} kW/t · ${(hoverPt.planingWeight * 100).toFixed(0)}% planing` +
              (showMethods
                ? (hover != null && Number.isFinite(michellBrake?.[hover])
                    ? ` · Michell ${fmtP(michellBrake![hover])}`
                    : "") +
                  ` · Holtrop ${fmtP(hoverPt.brakeHoltrop)}` +
                  (Number.isFinite(hoverPt.brakeSavitsky)
                    ? ` · Savitsky ${fmtP(hoverPt.brakeSavitsky)}`
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
