// ---------- the window's hull sweep: when to take one, how fine, and where ----------
//
// `computeHullSampling` is the most expensive thing one edit sets off, and it is pure, so a window does not
// compute it — it ASKS for it. This module is the whole of that asking, and none of it is React: two small
// objects with lifetimes of their own, which `useHullSampling` does nothing but own and re-render around.
// Keeping them out of the hook is what lets the policy below be read, and tested, as one piece.
//
// The policy exists for one reason — a gesture produces hulls faster than anyone can look at them — and it
// has four parts:
//
//   LAZY — nothing is swept, and no worker is even created, until something asks. Only the plan, the profile
//   and the 3D view ever do, so a window showing none of them (a detached station grid, the history) starts no
//   thread, sweeps no hull, and does not so much as watch the clock. It used to sweep one per edit and throw
//   it away.
//
//   DRAFT WHILE THE HULL IS BEING WORKED — geometry changes arriving closer together than BURST_MS are a
//   gesture somebody is in the middle of, and the lattice drops to a quarter of each axis until they stop.
//   Whose gesture it is and what they are making it with does not matter — a drag in this window, a drag in a
//   panel next door, a slider held down, a held undo all read the same. QUIET_MS after the last of them the
//   full-resolution sweep is asked for. This is a heuristic and is allowed to be: it decides how FINELY the
//   hull is swept, never what the hull is, so guessing wrong costs a coarse frame or an early fine one, and
//   the fine sweep always lands in the end.
//
//   STALE WHILE SWEEPING — an answer arrives a task later than the edit that asked for it, so between the two
//   the caller is handed the LAST good sampling rather than nothing. The control points move with the pointer
//   and the swept surface follows a frame behind. The alternative — holding the frame until the sweep lands —
//   is exactly the blocking this moves off the main thread.
//
//   LATEST WINS — one sweep is in flight at a time and only the newest request waits behind it. A gesture asks
//   faster than the worker can answer, and every superseded request describes a hull that is already gone;
//   queueing them would spend the worker on hulls nobody will ever see and deliver the current one last.
//
// Nothing here knows about pointers. An earlier version took a "a drag is happening in this window" flag from
// the editor so that the first frame of a local drag went straight to draft instead of spending one sweep at
// full resolution. That was worth a signal when the sweep blocked the main thread for 47 ms; now that it runs
// on the worker and the caller has a stale sampling to show meanwhile, the first sweep of a gesture is simply
// one the worker wastes, and the rate alone is a good enough tell — for every source, not just this window's.

import type { HullSampling } from "../core/mesh";
import {
  perfAdd,
  perfBegin,
  perfEnd,
  PERF_SAMPLING,
  type PerfSettings,
} from "../core/perf";
import type { DocumentSnapshot } from "../document-store/snapshot";
import type {
  SamplingRequest,
  SamplingResponse,
} from "../worker/hullSamplingProtocol";
import { createWorkerTaskQueue } from "../worker/taskWorker";

/** Two geometry changes closer together than this are one gesture; this long after the last, it is over. */
export const BURST_MS = 150,
  QUIET_MS = 200;

/** The resolution to sweep at: the settings' own at rest, a quarter of each axis while the hull is worked. */
export type Resolution = Pick<PerfSettings, "numSections" | "girthSteps">;

// A quarter of each axis is a sixteenth of the nodes and roughly a sixth of the time. What it costs is
// fineness in the 3D surface and the plan / profile outlines, none of which is legible while the thing is
// moving, and all of which is back a frame after it stops. Derived from the settings rather than fixed, so
// lowering the Performance sliders lowers the draft with them; floored so that a hull still has a lattice to
// march at the bottom of both ranges.
export const draftResolution = (perf: PerfSettings): Resolution => ({
  numSections: Math.max(32, Math.round(perf.numSections / 4)),
  girthSteps: Math.max(2, Math.round(perf.girthSteps / 4)),
});

export const resolutionFor = (perf: PerfSettings, working: boolean) =>
  working ? draftResolution(perf) : perf;

/**
 * Everything a sweep depends on, as one comparable string: two equal keys are the same lattice.
 *
 * The GEOMETRY half is the four authored slice revisions and nothing else — `computeHullSampling` reads the
 * plan curve, the trim graph, the transom and the loft, so the waterline, the deck rake and the cut station
 * are deliberately absent. It is exposed on its own because the clock below must watch geometry alone: a
 * waterline drag or a cut-station scrub cannot stale a sampling and must not read as a gesture to draft
 * through. `redraws` rides with it — it is how the Performance toggle forces one more sweep with nothing
 * having moved.
 */
export const geometryKey = (
  snapshot: DocumentSnapshot,
  redraws: number,
): string => {
  const { plan, trim, transom, stations } = snapshot.sliceRevs;
  return `${plan}|${trim}|${transom}|${stations}|${redraws}`;
};

export const samplingKey = (geometry: string, res: Resolution): string =>
  `${geometry}|${res.numSections}|${res.girthSteps}`;

// ---------- is the hull being worked? ----------

export interface GestureClock {
  /** Whether edits are still arriving in a stream. */
  working(): boolean;
  subscribe(listener: () => void): () => void;
  /** Record one geometry change. */
  note(): void;
  dispose(): void;
}

/**
 * A clock that watches the RATE of geometry changes and says whether one gesture is still running.
 *
 * Shaped as a subscribable store rather than a value with a callback, because a React caller must be able to
 * read it through `useSyncExternalStore`: `working` changes outside any render, and a component that merely
 * looked at it would be reading state React had no way to know had moved. Listeners are notified only on the
 * two EDGES, never per edit, so a subscriber never re-renders for a gesture merely continuing.
 */
export function createGestureClock(): GestureClock {
  let working = false,
    last = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: boolean): void => {
    if (next === working) return;
    working = next;
    for (const listener of listeners) listener();
  };
  return {
    working: () => working,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    note() {
      const now = performance.now(),
        gap = now - last;
      last = now;
      if (gap < BURST_MS) set(true);
      clearTimeout(timer);
      timer = setTimeout(() => set(false), QUIET_MS);
    },
    dispose() {
      clearTimeout(timer);
      listeners.clear();
    },
  };
}

// ---------- the sweep itself ----------

export interface HullSampler {
  /**
   * The sampling for `request.key`.
   *
   * Returns the cached one when it is current, the last good one while the worker replaces it, and null while
   * the first worker task is still building. Main-thread computation is only the unavailable-worker fallback.
   */
  get(
    request: SamplingRequest,
    sweepHere: () => HullSampling,
  ): HullSampling | null;
  dispose(): void;
}

/**
 * One window's sampler. `onSettled` is called when a sweep has landed and the answer has changed, which is an
 * owner's cue to show it; nothing else is published, because everything else is asked for through `get`.
 */
export function createHullSampler(onSettled: () => void): HullSampler {
  let cache: { key: string; value: HullSampling } | null = null;
  const tasks = createWorkerTaskQueue<SamplingRequest, SamplingResponse>(
    () =>
      new Worker(new URL("../worker/hullSamplingWorker.ts", import.meta.url), {
        type: "module",
      }),
    ({ key, sampling }, roundTripMs) => {
      // The readout's "Hull sampling" pass is nearly free ON THIS THREAD now, which is the point, so what it
      // reports is the round trip instead — the wait a view actually sees.
      perfBegin(PERF_SAMPLING);
      perfAdd(
        PERF_SAMPLING,
        "Swept off-thread (round trip)",
        roundTripMs,
        sampling.sheet.length * (sampling.sheet[0]?.length ?? 0),
        "pts",
      );
      perfEnd(PERF_SAMPLING);
      cache = { key, value: sampling };
      onSettled();
    },
    (error) =>
      console.error("camber: sweeping the hull on the main thread —", error),
  );

  return {
    get(request, sweepHere) {
      const hit = cache;
      if (hit?.key === request.key) return hit.value;
      // A normal first paint is empty for one worker turn rather than sweeping on the UI thread. A stale
      // lattice remains visible on later edits. Only a browser that cannot create the worker computes here.
      if (tasks.post(request)) return hit?.value ?? null;
      perfBegin(PERF_SAMPLING);
      const value = sweepHere();
      perfEnd(PERF_SAMPLING);
      cache = { key: request.key, value };
      return value;
    },
    dispose: tasks.dispose,
  };
}
