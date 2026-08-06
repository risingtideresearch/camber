import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeResistance,
  holtrop,
  planingCapability,
  DEFAULT_PC,
  type HoltropShip,
} from "resistance";
import type { Model } from "../core/model";
import { buildJson } from "../core/json";
import { hullGeometryOf } from "../core/resistanceHull";
import { G, KNOT, USEFUL_FROUDE } from "../core/michell";
import {
  ResistancePlot,
  CURVE_COLORS,
  type CurvePoint,
  type MichellPoint,
} from "./ResistancePlot";
import type {
  ResistanceWorkerRequest,
  ResistanceWorkerResponse,
  SweepPoint,
} from "./resistance.worker";
import "./ResistancePanel.css";

// ---------- the resistance panel ----------
//
// What it costs to push this hull through the water, over its whole speed range, from two independent
// directions at once.
//
// The EMPIRICAL side is the `resistance` module: Holtrop-Mennen below the hump, Savitsky above it, crossfaded
// by volumetric Froude number and gated by L/B so a slender hull is never pushed onto the planing branch. It
// is a regression, so it is right on average and blind to this particular hull — but it is calibrated in
// absolute terms, which the other side is not, and it carries the viscous drag that the other side has no
// model of at all. That is the number to quote.
//
// The THIN-SHIP side is Michell's integral over the live centreplane, the same calculation the wave panel
// draws the Kelvin pattern from. It sees every edit made to the hull, and its accuracy falls off as
// beam/length grows, so it is carried as a shape diagnostic and never folded into the total. The
// `resistance` module is explicit about this in blend.ts: Michell is deliberately outside the blend.
//
// A beamy hull is where that matters, and camber draws beamy hulls — the default is B/L = 0.38, where thin-
// ship theory is far outside its assumption and the curve can sit above the whole empirical total. The panel
// detects that (see `overTotal`) and says so rather than letting a reader take the magnitude at face value.
// The curve is still worth having there: it is the only thing on the plot that responds to an edit.
//
// EVERY INPUT IS MEASURED, NOT ESTIMATED. The module can build a hull from length and beam alone by filling
// the coefficients from regressions; nothing here does, because hydrostatics() has already integrated C_P,
// C_M, C_WP, LCB, wetted area, entrance angle and deadrise off the actual surface. See resistanceHull.ts —
// it matters most for exactly the unconventional forms this tool draws.

// The plot's x-axis, as length-Froude. It is the useful Michell band, so both curves share one axis and the
// diagnostic never has to be drawn over a range where it means nothing. The empirical curve is sampled
// finely (it is closed-form and free); the Michell curve gets MICHELL_POINTS of it, because each of those is
// a pass over a node cloud per angle.
const FN_LO = USEFUL_FROUDE[0],
  FN_HI = USEFUL_FROUDE[1];
const CURVE_POINTS = 73;
const MICHELL_POINTS = 15;

const froudeAxis = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => FN_LO + ((FN_HI - FN_LO) * i) / (n - 1));

interface ResistancePanelProps {
  model: Model;
  modelVersion: number;
}

interface Sweep {
  key: string;
  pts: SweepPoint[];
  done: boolean;
  err: string | null;
}

const EMPTY: Omit<Sweep, "key"> = { pts: [], done: false, err: null };

export function ResistancePanel({ model, modelVersion }: ResistancePanelProps) {
  const [salt, setSalt] = useState(true);
  const [logY, setLogY] = useState(true);
  const [pc, setPc] = useState(DEFAULT_PC);
  const [hover, setHover] = useState<number | null>(null);
  // The Michell diagnostic is OFF until asked for. Everything else on this panel is closed-form and costs
  // microseconds; this one is a worker sweep of seconds, and it is the only thing here that has to be
  // recomputed from scratch on every edit. Opening the panel should not start that — see the worker effect,
  // which does not even construct the thread until this is on.
  const [michellOn, setMichellOn] = useState(false);
  // The Michell sweep, as one value KEYED BY THE HULL IT BELONGS TO. Keeping the key inside the state rather
  // than clearing the state when the hull changes means there is nothing to clear: a sweep whose key no
  // longer matches is simply not this hull's, and reads as empty. The alternative — resetting from an effect
  // — would have the render after an edit briefly showing the previous hull's curve.
  const [sweep, setSweep] = useState<Sweep>({
    key: "",
    pts: [],
    done: false,
    err: null,
  });
  const worker = useRef<Worker | null>(null);
  const desired = useRef("");

  // ---- the empirical curve: closed-form, so it is simply derived from the model on every edit ----
  const spec = useMemo(
    () => hullGeometryOf(model),
    // the model object is mutated in place, so the version is the real dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, modelVersion],
  );

  const solved = useMemo(() => {
    if (!spec) return null;
    const g = spec.geometry;
    const froudes = froudeAxis(CURVE_POINTS);
    const result = computeResistance(g, {
      water: salt ? "salt" : "fresh",
      pc,
      froudeNumbers: froudes,
    });
    // The Holtrop split alongside the blend. computeResistance returns only totals, and the split is the
    // whole reason for the picture — viscous drag is what a hull shape cannot much change, wave-making is
    // what it can. Re-running holtrop() per point is a few regression evaluations; it costs nothing.
    const ship: HoltropShip = {
      L: g.lwl,
      B: g.beam,
      T: g.draft,
      vol: g.vol,
      cp: g.cp,
      cm: g.cm,
      cwp: g.cwp,
      lcb: g.lcbPct,
      S: g.wettedArea,
      iE: g.halfEntrance,
      aT: g.transomArea,
      salt,
    };
    const curve: CurvePoint[] = result.points.map((p) => {
      const h = holtrop(ship, p.speed);
      return {
        kn: p.kn,
        total: p.rBlend,
        // "viscous" here is everything Michell has no model of: skin friction with its form factor, plus
        // the correlation allowance and the transom/appendage terms that ride with it. Grouping them means
        // total − viscous is comparable to a wave-resistance curve, which is what the plot is asking of it.
        viscous: h.rvisc + h.ra + h.rtr + h.rapp,
        waveHoltrop: h.rw + h.rb,
        planingWeight: p.planingWeight,
      };
    });
    return { result, curve, ship };
  }, [spec, salt, pc]);

  // ---- the Michell curve: a worker sweep, streamed point by point ----
  //
  // The thread is built and torn down with the toggle rather than with the panel. Turning the diagnostic off
  // mid-sweep therefore stops the work immediately — terminate() kills a point already in flight, which the
  // worker's own key check cannot do, since that is only consulted between points.
  const sweepKey = `${modelVersion}|${salt}`;
  useEffect(() => {
    if (!michellOn) return;
    const instance = new Worker(
      new URL("./resistance.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.current = instance;
    instance.onmessage = (event: MessageEvent<ResistanceWorkerResponse>) => {
      const m = event.data;
      if (m.key !== desired.current) return;
      setSweep((prev) => {
        // a message for a key we have nothing for yet starts that key's sweep from empty
        const base = prev.key === m.key ? prev : { key: m.key, ...EMPTY };
        if (m.kind === "sample")
          return m.error ? { ...base, done: true, err: m.error } : base;
        if (m.kind === "point") return { ...base, pts: [...base.pts, m.point] };
        return { ...base, done: true, err: m.error ?? base.err };
      });
    };
    return () => {
      worker.current = null;
      instance.terminate();
    };
  }, [michellOn]);

  // Posts after the effect above, which is what makes the ordering work: on the turn the toggle goes on,
  // the thread is constructed first and this finds it, rather than having to wait a render for it.
  useEffect(() => {
    desired.current = sweepKey;
    const w = worker.current;
    if (!w) return;
    // The sample and the sweep carry the SAME key. The worker drops a sweep whose key is no longer live, so
    // an edit landing in the middle of a multi-second point abandons the rest of that curve rather than
    // finishing a hull that is no longer on screen.
    const sample: ResistanceWorkerRequest = {
      kind: "sample",
      key: sweepKey,
      document: buildJson(model),
    };
    const sweep: ResistanceWorkerRequest = {
      kind: "sweep",
      key: sweepKey,
      sampleKey: sweepKey,
      froudes: froudeAxis(MICHELL_POINTS),
      salt,
    };
    w.postMessage(sample);
    w.postMessage(sweep);
  }, [model, sweepKey, salt, michellOn]);

  // this hull's sweep, or an empty one while the worker is still on the previous hull's. With the diagnostic
  // off it is always empty, so every reader below — the curve, the readout row, the warnings — falls away on
  // its own without a second condition threaded through each one.
  const live: Sweep =
    michellOn && sweep.key === sweepKey ? sweep : { key: sweepKey, ...EMPTY };

  // ---- the readout, at the hovered speed (or at the hull's own hull-speed Fn 0.4 when not hovering) ----
  const curve = solved?.curve ?? [];
  const lwl = spec?.geometry.lwl ?? 0;
  const defaultKn = (0.4 * Math.sqrt(G * lwl)) / KNOT;
  const at = hover ?? defaultKn;
  const idx = curve.length
    ? curve.reduce(
        (best, p, i) =>
          Math.abs(p.kn - at) < Math.abs(curve[best].kn - at) ? i : best,
        0,
      )
    : -1;
  const point = idx >= 0 ? solved!.result.points[idx] : null;
  const bar = idx >= 0 ? curve[idx] : null;

  const michellPts: MichellPoint[] = useMemo(
    () =>
      live.pts.map((p) => ({
        kn: p.speed / KNOT,
        rw: p.rw,
        converged: p.converged,
      })),
    [live.pts],
  );
  // the Michell value at the readout speed, interpolated between the two samples that bracket it — the sweep
  // is coarse, and snapping to the nearest sample would report a hump's peak at the wrong speed
  const rwAt = useMemo(() => {
    const s = [...michellPts].sort((a, b) => a.kn - b.kn);
    if (s.length < 2) return s.length === 1 ? s[0].rw : NaN;
    if (at <= s[0].kn || at >= s[s.length - 1].kn) return NaN;
    const j = s.findIndex((p) => p.kn > at);
    const a = s[j - 1],
      b = s[j];
    return a.rw + ((b.rw - a.rw) * (at - a.kn)) / (b.kn - a.kn);
  }, [michellPts, at]);

  const num = (v: number | undefined, d = 1): string =>
    v !== undefined && Number.isFinite(v) ? v.toFixed(d) : "—";
  const force = (n: number | undefined): string =>
    n === undefined || !Number.isFinite(n)
      ? "—"
      : n >= 1000
        ? `${(n / 1000).toFixed(2)} kN`
        : `${n.toFixed(0)} N`;

  const capability = spec ? planingCapability(spec.lengthBeam) : 0;
  const swept = michellPts.length;
  const unconverged = michellPts.filter((p) => !p.converged).length;
  // Michell above the whole empirical total is thin-ship theory reporting that it is outside its envelope —
  // a wave component cannot exceed the drag that contains it. Counted against the total at the same speed
  // rather than against a fixed threshold, because what makes it wrong is the comparison, not the size.
  const overTotal = michellPts.filter((p) => {
    const j = curve.findIndex((q) => q.kn >= p.kn);
    return j >= 0 && p.rw > curve[j].total;
  }).length;
  const beamLength = spec ? spec.geometry.beam / spec.geometry.lwl : NaN;

  return (
    <div className="card rescard">
      <div className="cap">
        Resistance · Holtrop–Savitsky
        {michellOn && !live.done && (
          <span className="val">
            Michell {swept}/{MICHELL_POINTS}…
          </span>
        )}
      </div>

      {!spec ? (
        <div className="reserr">
          No valid waterplane at this waterline — resistance needs a floating
          hull. Lower the design waterline.
        </div>
      ) : (
        <>
          <div className="resctl">
            <label
              className="ctl"
              title={`Lumped propulsive coefficient: brake power = effective power / PC. It folds hull, relative-rotative and open-water propeller efficiency plus shaft losses into one number. ${DEFAULT_PC} is the module's default, fitted to sea-trial data for a ~12 m semi-displacement hull.`}
            >
              PC
              <input
                type="range"
                min="0.4"
                max="0.75"
                step="0.01"
                value={pc}
                onChange={(e) => setPc(+e.target.value)}
              />
              <span className="ctlval">{pc.toFixed(2)}</span>
            </label>
            <label
              className="ctl reswater"
              title="Water density: salt 1025, fresh 1000 kg/m³"
            >
              <input
                type="checkbox"
                checked={salt}
                onChange={(e) => setSalt(e.target.checked)}
              />
              Salt
            </label>
            <label
              className="ctl reswater"
              title="Logarithmic resistance axis. A hull's resistance covers decades between the bottom and the top of its speed range, and on a linear axis everything below hull speed lies flat on the floor. Turn it off for the conventional linear curve, which shows how much of the total the hump really is."
            >
              <input
                type="checkbox"
                checked={logY}
                onChange={(e) => setLogY(e.target.checked)}
              />
              Log
            </label>
          </div>
          <div className="resctl">
            <label
              className="ctl resmich"
              title="Michell's thin-ship wave-making resistance, integrated over this hull's own centreplane at each speed. It is the only curve here that responds to an edit — the empirical methods see the hull only through its bulk coefficients — but it is seconds of work per hull rather than microseconds, and its accuracy falls off as beam/length grows. Off by default for both reasons."
            >
              <input
                type="checkbox"
                checked={michellOn}
                onChange={(e) => setMichellOn(e.target.checked)}
              />
              Michell wave curve
              <span className="ctlnote">
                {michellOn
                  ? live.done
                    ? `${swept} points`
                    : `solving ${swept}/${MICHELL_POINTS}`
                  : "slow · shape diagnostic"}
              </span>
            </label>
          </div>

          <div className="resfig">
            <ResistancePlot
              curve={curve}
              michell={michellPts}
              logY={logY}
              hover={idx >= 0 ? curve[idx].kn : null}
              onHover={setHover}
            />
          </div>

          <div className="reslegend">
            <span className="resaxis">N vs kn</span>
            <span style={{ ["--c" as string]: CURVE_COLORS.total }}>
              <i /> total
            </span>
            <span style={{ ["--c" as string]: CURVE_COLORS.viscous }}>
              <i /> viscous
            </span>
            <span style={{ ["--c" as string]: CURVE_COLORS.waveHoltrop }}>
              <i /> wave (Holtrop)
            </span>
            {michellOn && (
              <span style={{ ["--c" as string]: CURVE_COLORS.michell }}>
                <i className="dash" /> wave (Michell)
              </span>
            )}
          </div>

          <div className="resrows">
            <div className="resrow ressp">
              <span>{hover != null ? "At cursor" : "At Fn 0.40"}</span>
              <b>
                {num(bar?.kn)} kn · Fn {num(point?.fn, 2)}
              </b>
            </div>
            <div className="resrow">
              <span>Total resistance</span>
              <b>{force(bar?.total)}</b>
            </div>
            <div className="resrow">
              <span>· viscous</span>
              <b>{force(bar?.viscous)}</b>
            </div>
            <div className="resrow">
              <span>· wave (Holtrop)</span>
              <b>{force(bar?.waveHoltrop)}</b>
            </div>
            {michellOn && (
              <div className="resrow">
                <span>· wave (Michell)</span>
                <b className="mich">{force(rwAt)}</b>
              </div>
            )}
            <div className="resrow">
              <span>Brake power</span>
              <b>{num(point?.brakeKW, 1)} kW</b>
            </div>
            <div className="resrow">
              <span>Specific power</span>
              <b>{num(point?.specificKWperT, 2)} kW/t</b>
            </div>
            <div className="resrow resdim">
              <span>Planing weight</span>
              <b>
                {num((point?.planingWeight ?? 0) * 100, 0)}% · Fn_∇{" "}
                {num(point?.fnVol, 2)}
              </b>
            </div>
            <div className="resrow resdim">
              <span>LWL · beam · draft</span>
              <b>
                {num(spec.geometry.lwl, 2)} · {num(spec.geometry.beam, 2)} ·{" "}
                {num(spec.geometry.draft, 2)} m
              </b>
            </div>
            <div className="resrow resdim">
              <span>∇ · C_P · L/B</span>
              <b>
                {num(spec.geometry.vol, 3)} m³ · {num(spec.geometry.cp, 3)} ·{" "}
                {num(spec.lengthBeam, 2)}
              </b>
            </div>
          </div>

          {(solved?.result.warnings.length ||
            unconverged > 0 ||
            overTotal > 0 ||
            live.err) && (
            <div className="reswarn">
              {solved?.result.warnings.map((w) => (
                <div key={w}>{w}.</div>
              ))}
              {overTotal > 0 && (
                <div>
                  Michell exceeds the total resistance at {overTotal} of {swept}{" "}
                  speeds — impossible for a component of it. At B/L{" "}
                  {num(beamLength, 2)} this hull is nowhere near thin, and
                  thin-ship theory has left its envelope. Read that curve for
                  which way an edit moves its humps, not for its magnitude.
                </div>
              )}
              {unconverged > 0 && (
                <div>
                  {unconverged} of {swept} Michell points could not resolve the
                  kernel at their speed (hollow markers) — they are not
                  converged. This is the slow end of the range, where the
                  kernel's wavelength collapses as U².
                </div>
              )}
              {live.err && <div>Michell sweep: {live.err}.</div>}
            </div>
          )}

          <div className="resnote">
            Calm water, bare hull — no appendages, windage, or added resistance
            in waves. Holtrop below the hump and Savitsky above it, crossfaded
            by Fn_∇ and gated at L/B {num(spec.lengthBeam, 1)} (
            {capability > 0.5 ? "planing-capable" : "displacement only"}). All
            coefficients are measured off this hull, not estimated — but the
            methods see them only as bulk numbers, so nothing here moves until
            an edit moves a coefficient.{" "}
            {michellOn
              ? "The Michell curve is the exception and is a shape diagnostic, deliberately outside the total: its accuracy falls off as beam/length grows."
              : "Switch on the Michell curve for a wave-making number that does follow the shape itself."}
          </div>
        </>
      )}
    </div>
  );
}
