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
): () => HullSampling | null {
  // A landed sweep is not a value React can subscribe to — the sampling is PULLED, by whichever view asks —
  // so the sampler only says "look again" and this is what it says it to.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // Built through the first render rather than in an effect: the getter returned below may be called before
  // any effect has run. Neither constructor starts a thread or a timer, so a render React discards costs
  // nothing — the worker is not made until a sweep is actually asked for.
  const [sampler] = useState(() => createHullSampler(rerender));
  const [clock] = useState(() => createGestureClock());
  // Delay disposal by one task. React StrictMode performs a setup → cleanup → setup probe on mount; immediate
  // cleanup would kill the first worker request after the render that made it, leaving the blank first paint
  // with no event capable of asking again. A real unmount gets no second setup and disposes normally.
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    clearTimeout(disposeTimer.current);
    return () => {
      disposeTimer.current = setTimeout(() => {
        sampler.dispose();
        clock.dispose();
      }, 0);
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

  return (): HullSampling | null => {
    wanted.current = true; // from here this window is one that sweeps, and starts watching the rate
    return sampler.get(
      {
        key,
        state: snapshot.state.hull,
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
