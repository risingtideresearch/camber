// A window's hull sweep, off its main thread.
//
// `computeHullSampling` is the editor's dominant per-edit cost and it is PURE — authored hull in, lattice out
// — so nothing about it needs the main thread except the answer. This worker is one window's private sampler:
// it takes the authored state a snapshot carries, assembles a runtime model of its own, sweeps it, and posts
// the sampling back.
//
// It is a DEDICATED worker per window rather than work handed to the SharedWorker. The SharedWorker is the one
// thread that orders every session's commands, and a 47 ms sweep on it would sit in front of the next edit
// from any window; a window's own sampler can only ever make that window wait.
//
// ---------- what crosses the boundary ----------
//
// IN: `HullState` and `SessionState`, which are plain readonly data. The runtime `Model` could not be sent —
// it carries the samplers (`plan.at`, `trimZ`, `loft.at`) as functions — so the worker assembles its own from
// the state, which is what `assemble` is for. Its slice revisions come along, so the loft and the plan curve
// are rebuilt here only when they actually moved, exactly as in a window.
//
// OUT: the whole `HullSampling`. Its cells share their corner `HullSample`s BY IDENTITY — that sharing is what
// makes the mesh crack-free — and structuredClone preserves aliasing within one clone, so the graph arrives
// intact rather than exploded into copies. That is what makes this a transport change and not a rewrite of
// everything downstream of the sampling.

import { computeHullSampling } from "../core/mesh";
import { assemble } from "../core/runtime";
import type { SamplingRequest, SamplingResponse } from "./hullSamplingProtocol";

// One cache slot for this worker's own assemblies, so a sweep whose plan and trim have not moved reuses their
// samplers across messages instead of rebuilding them per edit (see runtime.ts — the key is per READER, and
// this worker is a reader like any window).
const cacheKey = {};

self.onmessage = (event: MessageEvent<SamplingRequest>) => {
  const { key, state, session, sliceRevs, numSections, girthSteps } =
    event.data;
  const model = assemble(state, session, { sliceRevs, cacheKey });
  const sampling = computeHullSampling(model, numSections, girthSteps);
  const response: SamplingResponse = { key, sampling };
  (self as unknown as Worker).postMessage(response);
};
