/// <reference lib="webworker" />

// The resistance panel's compute thread — Michell's wave-making resistance at every speed on the plot.
//
// The empirical half of that plot (Holtrop / Savitsky) is a handful of closed-form regressions and runs on
// the main thread in microseconds. This is the other half, and it is a different kind of calculation: one
// point is a pass over a node cloud for every angle in the θ grid, which the wave panel already measures in
// hundreds of milliseconds. A whole curve is that, times the number of points.
//
// Two things make it bearable.
//
// FIRST, THE SWEEP RUNS DOWNWARD IN SPEED, and points are posted as they finish rather than as a curve at
// the end. The kernel exp(i·ν·secθ·X) has ν = g/U², so cost climbs steeply as speed falls: the fast end of
// the plot is nearly free and the slow end is where the seconds are. Starting at the top means the curve's
// interesting part — the humps around hull speed — is drawn while the expensive tail is still being found.
//
// SECOND, THE NODE CLOUD IS CACHED BY ITS GRID, not by the speed that asked for it. sizeFor() quantizes onto
// a coarse ladder, so a run of adjacent speeds keeps asking for the same grid and only pays for the sample
// once. Re-sampling per point instead would be most of the total cost.
//
// The sweep yields between points via setTimeout rather than running as one long loop, because a worker
// dispatches messages only between tasks: a synchronous sweep could not be told that the hull it is solving
// no longer exists. Every point re-checks the live sweep key and drops out the moment it goes stale.

import { loadJsonText, unitScale } from "../core/json";
import {
  waveResistance,
  G,
  RHO_FRESH,
  RHO_SALT,
  type MichellOptions,
} from "../core/michell";
import { createModel, prepare, type Model } from "../core/model";
import {
  bandwidthOptions,
  prepareHull,
  prepareHullOn,
  type HullWake,
} from "../core/wake";

export interface SweepDims {
  wettedLength: number; // [m]
  draft: number;
  beamMax: number;
  volume: number;
}

export type ResistanceWorkerRequest =
  | { kind: "sample"; key: string; document: string }
  | {
      kind: "sweep";
      key: string;
      sampleKey: string;
      froudes: number[]; // length-Froude, the same x-axis the empirical curves are on
      salt: boolean;
    };

// One solved point of the Michell curve. `converged` and `tail` travel with it because they are per-point
// properties, not per-curve ones: the same sweep is trustworthy at Fn 0.4 and under-resolved at Fn 0.1, and a
// plot that hid that would draw both with the same confident line.
export interface SweepPoint {
  fn: number;
  speed: number; // m/s
  rw: number; // N
  converged: boolean;
  tail: number; // fraction of R_w past the angular cutoff
}

export type ResistanceWorkerResponse =
  | {
      kind: "sample";
      key: string;
      dims: SweepDims | null;
      error: string | null;
    }
  | { kind: "point"; key: string; point: SweepPoint }
  | { kind: "done"; key: string; error: string | null; sweepMs: number };

const ctx: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;

let held: { key: string; model: Model; scale: number; probe: HullWake } | null =
  null;
let cached: { options: MichellOptions; hull: HullWake } | null = null;
// The sweep the worker is currently meant to be running. A newer request overwrites it, and the in-flight
// sweep notices between points and abandons itself.
let liveKey: string | null = null;

const message = (value: ResistanceWorkerResponse): void =>
  ctx.postMessage(value);

const sameGrid = (a: MichellOptions, b: MichellOptions): boolean =>
  a.uPanels === b.uPanels &&
  a.uNodes === b.uNodes &&
  a.vPanels === b.vPanels &&
  a.vNodes === b.vNodes &&
  a.wlGrade === b.wlGrade;

ctx.onmessage = (event: MessageEvent<ResistanceWorkerRequest>) => {
  const request = event.data;

  if (request.kind === "sample") {
    liveKey = null; // a new hull invalidates whatever is being swept
    cached = null;
    sampleHull(request.key, request.document);
    return;
  }

  if (!held || held.key !== request.sampleKey) return;
  liveKey = request.key;
  runSweep(request.key, request.froudes, request.salt);
};

function sampleHull(key: string, document: string): void {
  try {
    const model = createModel();
    loadJsonText(model, document);
    prepare(model);
    const scale = unitScale(model.unit, "m");
    // A geometry-floor probe: it exists only to learn the hull's dimensions, and those are what the sizing
    // rule for every real sample then needs. No speed is in hand yet, so prepareHull is the right call — the
    // sweep re-samples properly, per speed, from here on.
    const probe = prepareHull(model, scale);
    held = probe ? { key, model, scale, probe } : null;
    message({
      kind: "sample",
      key,
      dims: probe
        ? {
            wettedLength: probe.cp.wettedLength,
            draft: probe.cp.draft,
            beamMax: probe.cp.beamMax,
            volume: 2 * probe.cp.volumeHalf,
          }
        : null,
      error: probe ? null : "no wetted hull at this waterline",
    });
  } catch (error) {
    held = null;
    message({
      kind: "sample",
      key,
      dims: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function runSweep(key: string, froudes: number[], salt: boolean): void {
  const t0 = performance.now();
  const rho = salt ? RHO_SALT : RHO_FRESH;
  const L = held!.probe.cp.wettedLength;
  // fastest first: see the header — the cheap end of the curve is drawn while the slow end is still solving
  const order = [...froudes].sort((a, b) => b - a);
  let i = 0;

  const step = (): void => {
    if (liveKey !== key) return; // superseded; drop the rest of the sweep on the floor
    if (i >= order.length) {
      message({
        kind: "done",
        key,
        error: null,
        sweepMs: performance.now() - t0,
      });
      return;
    }
    const fn = order[i++];
    try {
      const U = fn * Math.sqrt(G * L);
      const options = bandwidthOptions(held!.probe.cp, U);
      if (!cached || !sameGrid(cached.options, options)) {
        const hull = prepareHullOn(held!.model, held!.scale, options, U);
        if (!hull) throw new Error("no wetted hull at this waterline");
        cached = { options, hull };
      }
      const hull = cached.hull;
      const res = waveResistance(hull.cp, { U, rho });
      message({
        kind: "point",
        key,
        point: {
          fn,
          speed: U,
          rw: res.rw,
          converged: hull.resolution?.converged ?? false,
          tail: res.tail,
        },
      });
    } catch (error) {
      message({
        kind: "done",
        key,
        error: error instanceof Error ? error.message : String(error),
        sweepMs: performance.now() - t0,
      });
      return;
    }
    // yield, so a hull edit arriving mid-sweep is seen before the next (possibly multi-second) point
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}
