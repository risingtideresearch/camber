/// <reference lib="webworker" />

// The wave panel's compute thread. Michell's integral is hundreds of milliseconds at a displacement speed and
// seconds at the slow end, and none of that may block the editor the hull is being drawn in.
//
// It holds three things between messages, in increasing order of how expensive they are to lose:
//
//   • the MODEL, rebuilt from the document the panel sends on every edit;
//   • a cheap PROBE sample, which exists only to measure the hull — its length, draft and station fan are what
//     the sizing rule needs, and none of them can be known before sampling something;
//   • the working SAMPLE, the weighted node cloud every θ is then evaluated against.
//
// The sample is keyed by the GRID it was built on, not by the model alone. That is the subtlety here: the
// kernel exp(i·ν·secθ·X) has wavelength 2π/(ν·secθ) and ν = g/U², so a cloud that resolves it at six knots
// aliases badly at one — and the arithmetic gives no sign of it, just a confident wrong number (michell.ts
// §1b). So each solve asks bandwidthOptions() what its speed needs and re-samples only when that has actually
// changed. The ladder those options are quantized onto is what keeps a speed slider from re-sampling on every
// tick.

import { loadJsonText, unitScale } from "../core/json";
import {
  waveResistance,
  KNOT,
  RHO_FRESH,
  RHO_SALT,
  type FieldGrid,
  type FieldResult,
  type MichellOptions,
  type Resolution,
  type WaveResult,
} from "../core/michell";
import { createModel, prepare, type Model } from "../core/model";
import {
  bandwidthOptions,
  defaultView,
  fleetWake,
  prepareHull,
  prepareHullOn,
  usefulSpeeds,
  type HullWake,
} from "../core/wake";

const RES = 460;

export interface WakeDims {
  wettedLength: number;
  draft: number;
  beamMax: number;
  volume: number;
  minSpeed: number; // m/s — the ends of the useful Froude band for this hull
  maxSpeed: number;
}

export type WakeWorkerRequest =
  | { kind: "sample"; key: string; document: string }
  | {
      kind: "solve";
      key: string;
      sampleKey: string;
      knots: number;
      salt: boolean;
    };

export type WakeWorkerResponse =
  | {
      kind: "sample";
      key: string;
      outline: [number, number][] | null;
      dims: WakeDims | null;
      error: string | null;
      sampleMs: number;
    }
  | {
      kind: "solve";
      key: string;
      error: string | null;
      result?: {
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
      };
    };

const ctx: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;

let held: {
  key: string;
  model: Model;
  scale: number;
  probe: HullWake;
} | null = null;
let cached: { options: MichellOptions; hull: HullWake } | null = null;

const message = (
  value: WakeWorkerResponse,
  transfer: Transferable[] = [],
): void => ctx.postMessage(value, transfer);

const sameGrid = (a: MichellOptions, b: MichellOptions): boolean =>
  a.uPanels === b.uPanels &&
  a.uNodes === b.uNodes &&
  a.vPanels === b.vPanels &&
  a.vNodes === b.vNodes &&
  a.wlGrade === b.wlGrade;

ctx.onmessage = (event: MessageEvent<WakeWorkerRequest>) => {
  const request = event.data;

  if (request.kind === "sample") {
    const t0 = performance.now();
    cached = null;
    try {
      const model = createModel();
      loadJsonText(model, request.document);
      prepare(model);
      const scale = unitScale(model.unit, "m");
      const probe = prepareHull(model, scale);
      held = probe ? { key: request.key, model, scale, probe } : null;
      const [minSpeed, maxSpeed] = probe
        ? usefulSpeeds(probe.cp.wettedLength)
        : [0, 0];
      message({
        kind: "sample",
        key: request.key,
        outline: probe ? probe.outline : null,
        dims: probe
          ? {
              wettedLength: probe.cp.wettedLength,
              draft: probe.cp.draft,
              beamMax: probe.cp.beamMax,
              volume: 2 * probe.cp.volumeHalf,
              minSpeed,
              maxSpeed,
            }
          : null,
        error: probe ? null : "no wetted hull at this waterline",
        sampleMs: performance.now() - t0,
      });
    } catch (error) {
      held = null;
      message({
        kind: "sample",
        key: request.key,
        outline: null,
        dims: null,
        error: error instanceof Error ? error.message : String(error),
        sampleMs: performance.now() - t0,
      });
    }
    return;
  }

  if (!held || held.key !== request.sampleKey) return;
  const t0 = performance.now();
  try {
    const U = Math.max(0.05, request.knots * KNOT);
    // the grid this speed needs — and a re-sample only when it differs from the one already in hand
    const options = bandwidthOptions(held.probe.cp, U);
    let resampled = false;
    if (!cached || !sameGrid(cached.options, options)) {
      const hull = prepareHullOn(held.model, held.scale, options, U);
      if (!hull) throw new Error("no wetted hull at this waterline");
      cached = { options, hull };
      resampled = true;
    }
    const hull = cached.hull;
    const cond = { U, rho: request.salt ? RHO_SALT : RHO_FRESH };
    const view = defaultView([{ h: hull, at: { dx: 0, dy: 0 } }], 3, RES);
    const wake = fleetWake([{ h: hull, at: { dx: 0, dy: 0 } }], cond, view);
    // the fleet solve already evaluated the spectrum on this grid; hand it back rather than paying twice
    const res = waveResistance(
      hull.cp,
      cond,
      wake.resistance.grid,
      undefined,
      wake.resistance.parts[0],
    );
    const result = {
      field: wake.field,
      grid: wake.grid,
      nu: wake.nu,
      res,
      U,
      sternX: hull.sternX,
      nodes: hull.cp.nodes,
      resolution: hull.resolution ?? {
        perCycleLong: 0,
        perCycleFan: 0,
        converged: false,
        nodes: hull.cp.nodes,
      },
      resampled,
      solveMs: performance.now() - t0,
    };
    message({ kind: "solve", key: request.key, error: null, result }, [
      result.field.z.buffer,
      result.res.grid.theta.buffer,
      result.res.grid.weight.buffer,
      result.res.re.buffer,
      result.res.im.buffer,
      result.res.density.buffer,
    ]);
  } catch (error) {
    message({
      kind: "solve",
      key: request.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
