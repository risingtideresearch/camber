import { useEffect, useRef, useState } from "react";
import type { Model } from "../core/model";
import { buildJson } from "../core/json";
import {
  inUsefulRange,
  KNOT,
  NODES_PER_CYCLE,
  USEFUL_FROUDE,
  type FieldGrid,
  type FieldResult,
  type Resolution,
  type WaveResult,
} from "../core/michell";
import { paintWake, rampCss, robustScale } from "../core/wakeImage";

import type {
  WakeDims,
  WakeWorkerRequest,
  WakeWorkerResponse,
} from "./wake.worker";
import "./WakePanel.css";

// ---------- the wave-pattern panel ----------
//
// Michell's integral over the live hull: the Kelvin wave pattern astern, and the wave-making resistance that
// generates it. Both come from one spectrum F(θ), so what is drawn and what is reported cannot disagree.
//
// Everything heavy runs in a worker, so editing the hull never waits on the physics.
//
// THE SPEED RANGE IS THE HULL'S, NOT A FIXED NUMBER OF KNOTS. "Slow" is a Froude number: six knots is Fn 0.8
// on a dinghy and Fn 0.06 on a ship. The slider is bounded by USEFUL_FROUDE mapped through this hull's own
// waterline length, because outside that band the answer is not worth reporting — below Fn 0.1 wave resistance
// is a negligible part of the total while the kernel's cost runs away, and above Fn 1.0 the boat is planing
// and thin-ship theory has no dynamic lift to offer. The panel reports the achieved resolution alongside the
// number, so an under-resolved answer says so instead of looking like a converged one.
//
// The water ahead of the sternmost point is faded rather than drawn. This is the far-field free-wave solution;
// it is physical astern of the hull and not on or ahead of it. See wakeImage.ts.

// Warn once the truncated tail is worth acting on. The angular cutoff follows the Froude number (michell.ts
// secMaxFor) and normally holds the truncation near half a percent, so this only fires on a hull whose
// spectrum runs flatter than the one that rule was calibrated against. The reported tail deliberately
// over-states, so the true understatement at this threshold is nearer one percent.
const TAIL_WARN = 0.02;

interface WakePanelProps {
  model: Model;
  modelVersion: number;
}

interface Solved {
  key: string;
  outline: [number, number][] | null;
  dims: WakeDims | null;
  err: string | null;
  sampleMs: number;
}

interface Painted {
  key: string;
  field: FieldResult;
  grid: FieldGrid;
  nu: number;
  res: WaveResult;
  U: number;
  sternX: number;
  nodes: number;
  resolution: Resolution;
  resampled: boolean;
  solveMs: number;
}

export function WakePanel({ model, modelVersion }: WakePanelProps) {
  const [knots, setKnots] = useState(6);
  const [salt, setSalt] = useState(true);
  const [sampled, setSampled] = useState<Solved | null>(null);
  const [wake, setWake] = useState<Painted | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const worker = useRef<Worker | null>(null);
  const sampleKey = `${modelVersion}`;
  const desiredSampleKey = useRef(sampleKey);
  const desiredSolveKey = useRef("");
  const workerSolving = useRef(false);
  const queuedSolve = useRef<WakeWorkerRequest | null>(null);

  // Keep one worker alive so its sampled node cloud can be reused for every speed.
  useEffect(() => {
    const instance = new Worker(new URL("./wake.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = instance;
    instance.onmessage = (event: MessageEvent<WakeWorkerResponse>) => {
      const message = event.data;
      if (message.kind === "sample") {
        if (message.key !== desiredSampleKey.current) return;
        setSampled({
          key: message.key,
          outline: message.outline,
          dims: message.dims,
          err: message.error,
          sampleMs: message.sampleMs,
        });
      } else {
        workerSolving.current = false;
        const next = queuedSolve.current;
        queuedSolve.current = null;
        if (next) {
          workerSolving.current = true;
          instance.postMessage(next);
        }
        if (message.key !== desiredSolveKey.current) return;
        if (message.error || !message.result) {
          setSampled((value) =>
            value
              ? { ...value, err: message.error ?? "wake solve failed" }
              : value,
          );
          return;
        }
        setWake({ key: message.key, ...message.result });
      }
    };
    return () => {
      worker.current = null;
      workerSolving.current = false;
      queuedSolve.current = null;
      instance.terminate();
    };
  }, []);

  // ---- sample the hull in the worker: once per edit ----
  useEffect(() => {
    desiredSampleKey.current = sampleKey;
    queuedSolve.current = null;
    const request: WakeWorkerRequest = {
      kind: "sample",
      key: sampleKey,
      document: buildJson(model),
    };
    worker.current?.postMessage(request);
  }, [model, sampleKey]);

  // ---- spectrum + field in the worker: once per speed / hull ----
  //
  // The speed is CLAMPED rather than stored clamped: a new hull brings a new useful band (it scales with
  // √LWL), and deriving the working speed each render means the slider follows the hull without an effect
  // chasing it. `knots` is only ever what the user last pointed at.
  const dims = sampled?.key === sampleKey ? sampled.dims : null;
  const kMin = dims ? Math.max(0.1, dims.minSpeed / KNOT) : 1,
    kMax = dims ? dims.maxSpeed / KNOT : 20;
  const speed = Math.min(kMax, Math.max(kMin, knots));
  const ready = sampled?.key === sampleKey && !!sampled.dims;
  const solveKey = `${sampleKey}|${speed}|${salt}`;
  useEffect(() => {
    desiredSolveKey.current = solveKey;
    if (!ready) return;
    const request: WakeWorkerRequest = {
      kind: "solve",
      key: solveKey,
      sampleKey,
      knots: speed,
      salt,
    };
    if (workerSolving.current) {
      // Keep only the latest slider value rather than making the worker solve
      // every intermediate value while one calculation is already running.
      queuedSolve.current = request;
    } else if (worker.current) {
      workerSolving.current = true;
      worker.current.postMessage(request);
    }
  }, [ready, speed, salt, sampleKey, solveKey]);

  const fresh = wake?.key === solveKey;

  // ---- paint ----
  useEffect(() => {
    const c = canvas.current;
    const outline = sampled?.key === sampleKey ? sampled.outline : null;
    if (!c || !wake || !fresh || !outline) return;
    c.width = wake.grid.nx;
    c.height = wake.grid.ny;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(
      paintWake(wake.field, wake.grid, wake.nu, {
        scale: robustScale(wake.field.z),
        validAft: wake.sternX,
      }),
      0,
      0,
    );
    // the hull's own waterline, over its wake, in the same frame as the field
    const toX = (x: number): number => (x - wake.grid.x0) / wake.grid.dx,
      toY = (y: number): number => (y - wake.grid.y0) / wake.grid.dy;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.25;
    for (const side of [1, -1]) {
      ctx.beginPath();
      outline.forEach(([x, y], i) => {
        if (i) ctx.lineTo(toX(x), toY(side * y));
        else ctx.moveTo(toX(x), toY(side * y));
      });
      ctx.stroke();
    }
  }, [wake, fresh, sampled, sampleKey]);

  const num = (v: number | undefined, d = 1): string =>
    v !== undefined && Number.isFinite(v) ? v.toFixed(d) : "—";
  const show = fresh ? wake : null;
  const rw = show?.res.rw;
  const froude = show?.res.froude;
  const outOfRange = froude !== undefined && !inUsefulRange(froude);
  const unconverged = show ? !show.resolution.converged : false;

  return (
    <div className="card wakecard">
      <div className="cap">
        Wave pattern · Michell
        {!fresh && <span className="val">solving…</span>}
      </div>
      <div className="wakectl">
        <label
          className="ctl"
          title={`Speed through the water. The range is this hull's useful Froude band, Fn ${USEFUL_FROUDE[0]}–${USEFUL_FROUDE[1]} on a ${num(dims?.wettedLength, 2)} m waterline: below it wave resistance is a negligible part of the total, above it the boat is planing and thin-ship theory does not apply.`}
        >
          Speed
          <input
            type="range"
            min={kMin}
            max={kMax}
            step={(kMax - kMin) / 200}
            value={speed}
            onChange={(e) => setKnots(+e.target.value)}
          />
          <span className="ctlval">{speed.toFixed(1)} kn</span>
        </label>
        <label
          className="ctl wakewater"
          title="Water density: salt 1025, fresh 1000 kg/m³"
        >
          <input
            type="checkbox"
            checked={salt}
            onChange={(e) => setSalt(e.target.checked)}
          />
          Salt
        </label>
      </div>

      <div className="wakefig">
        {sampled?.err ? (
          <div className="wakeerr">{sampled.err}</div>
        ) : (
          <canvas ref={canvas} className="wakecanvas" />
        )}
      </div>

      <div className="wakelegend">
        <span>trough</span>
        <i style={{ background: `linear-gradient(to right, ${rampCss()})` }} />
        <span>crest</span>
      </div>

      <div className="wakerows">
        <div className="wakerow">
          <span>Froude number</span>
          <b className={outOfRange ? "warn" : ""}>{num(froude, 3)}</b>
        </div>
        <div className="wakerow">
          <span>Wave resistance R_w</span>
          <b>
            {rw === undefined
              ? "—"
              : rw >= 1000
                ? `${num(rw / 1000, 2)} kN`
                : `${num(rw)} N`}
          </b>
        </div>
        <div className="wakerow">
          <span>Effective power R_w·U</span>
          <b>{show ? `${num((show.res.rw * show.U) / 1000, 2)} kW` : "—"}</b>
        </div>
        <div className="wakerow">
          <span>Transverse wavelength</span>
          <b>{show ? `${num((2 * Math.PI) / show.nu, 2)} m` : "—"}</b>
        </div>
        <div className="wakerow wakedim">
          <span>LWL · draft · beam</span>
          <b>
            {num(dims?.wettedLength, 2)} · {num(dims?.draft, 2)} ·{" "}
            {num(dims?.beamMax, 2)} m
          </b>
        </div>
        <div className="wakerow wakedim">
          <span>Displacement ∇</span>
          <b>{dims ? `${num(dims.volume, 3)} m³` : "—"}</b>
        </div>
        <div className="wakerow wakedim">
          <span>Sample · solve</span>
          <b>
            {num(sampled?.sampleMs, 0)} ms · {num(show?.solveMs, 0)} ms
            {show?.resampled ? " (re-sampled)" : ""}
          </b>
        </div>
        {/* Nodes per wavelength of the kernel, which is the number that decides whether R_w means anything.
            It is shown next to the node count rather than buried, because a grid that resolves the HULL can
            still be far too coarse for the KERNEL at low speed — that failure is silent otherwise. */}
        <div className="wakerow wakedim">
          <span>Nodes · θ angles · per wave</span>
          <b className={unconverged ? "warn" : ""}>
            {show?.nodes ?? 0} · {show?.res.grid.theta.length ?? 0} ·{" "}
            {num(show?.resolution.perCycleLong, 1)}
          </b>
        </div>
      </div>

      {(outOfRange || unconverged || (show?.res.tail ?? 0) > TAIL_WARN) && (
        <div className="wakewarn">
          {outOfRange
            ? `Fn ${num(froude, 2)} is outside Fn ${USEFUL_FROUDE[0]}–${USEFUL_FROUDE[1]}, where this is worth reporting: below it wave-making is a negligible part of the total, above it the hull is planing and thin-ship theory has no dynamic lift. Treat R_w as indicative only. `
            : ""}
          {unconverged
            ? `The sampling could not resolve the kernel at this speed (${num(show?.resolution.perCycleLong, 1)} nodes per wave, ${NODES_PER_CYCLE} needed) — R_w is not converged. `
            : ""}
          {(show?.res.tail ?? 0) > TAIL_WARN
            ? `About ${num((show!.res.tail ?? 0) * 100, 1)}% of R_w lies past the angular cutoff, so the total is understated by roughly that much.`
            : ""}
        </div>
      )}

      <div className="wakenote">
        Wave-making only — no viscous drag, sinkage or trim. Thin-ship theory,
        so accuracy falls off as beam/length grows. The pattern is the far-field
        free-wave part: physical astern of the hull, faded where it is not.
        {show?.field.bandLimited
          ? " Short diverging waves are band-limited to this grid."
          : ""}
      </div>
    </div>
  );
}
