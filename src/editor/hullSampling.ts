// The React end of the hull sweep: it owns a `HullSampler` and a `GestureClock` for the window's lifetime and
// re-renders around them. Everything that decides ANYTHING — how fine to sweep, when a gesture is running,
// which request supersedes which, where the work runs — is in `hullSampler.ts`, which knows nothing about
// React. What is left here is the three things only a component can do: keep those objects alive across
// renders, turn a sweep that landed into a render, and dispose of both when the window goes.

import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { computeHullSampling, type HullSampling } from "../core/mesh";
import type { Model } from "../core/model";
import type { PerfSettings } from "../core/perf";
import type { DocumentSnapshot } from "../document-store/snapshot";
import {
  createGestureClock,
  createHullSampler,
  geometryKey,
  resolutionFor,
  samplingKey,
} from "./hullSampler";

export function useHullSampling(
  snapshot: DocumentSnapshot,
  model: Model,
  perf: PerfSettings,
  /** Bumped by the Performance toggle to force one more sweep with nothing having moved. */
  redraws: number,
): () => HullSampling {
  // A landed sweep is not a value React can subscribe to — the sampling is PULLED, by whichever view asks —
  // so the sampler only says "look again" and this is what it says it to.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // Built through the first render rather than in an effect: the getter returned below may be called before
  // any effect has run. Neither constructor starts a thread or a timer, so a render React discards costs
  // nothing — the worker is not made until a sweep is actually asked for.
  const [sampler] = useState(() => createHullSampler(rerender));
  const [clock] = useState(() => createGestureClock());
  useEffect(() => {
    return () => {
      sampler.dispose();
      clock.dispose();
    };
  }, [sampler, clock]);

  // Whether anything in this window has ever wanted a sampling. Until something has, the clock is not even
  // wound: a station grid or a history window would otherwise re-render twice per gesture to track a
  // resolution it never uses.
  const wanted = useRef(false);
  const geometry = geometryKey(snapshot, redraws);
  useEffect(() => {
    if (wanted.current) clock.note();
  }, [clock, geometry]);

  // Subscribed rather than read: the clock turns over on a timer, outside any render.
  const working = useSyncExternalStore(clock.subscribe, clock.working);
  const resolution = resolutionFor(perf, working);
  const key = samplingKey(geometry, resolution);

  return (): HullSampling => {
    wanted.current = true; // from here this window is one that sweeps, and starts watching the rate
    return sampler.get(
      {
        key,
        state: snapshot.state,
        session: snapshot.session,
        sliceRevs: snapshot.sliceRevs,
        ...resolution,
      },
      () =>
        computeHullSampling(
          model,
          resolution.numSections,
          resolution.girthSteps,
        ),
    );
  };
}
