// ---------- the store, as React sees it ----------
//
// One context holding the window's `HullStore`, and three hooks over it. `useSyncExternalStore` is what makes
// this correct rather than merely convenient: the store publishes from outside React (a pointer drag, and
// later a worker message), and it is the hook that guarantees a render never reads a snapshot that has since
// moved on.
//
// The two getters must return identity-stable values while nothing has changed, or the hook would re-render
// forever. Both do: the owner rebuilds its snapshot only when it publishes, and `assemble()` hands back the
// very same `Model` when no slice this window reads has moved.

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import type { HullStore, Snapshot } from "../core/store";
import type { HullCommand, Outcome } from "../core/commands";
import type { Model } from "../core/model";
import { perfFrame } from "../core/perf";

/** Provided by the app root; every panel below it reads the same store. */
export const StoreContext = createContext<HullStore | null>(null);

export function useHullStore(): HullStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useHullStore needs a StoreContext above it");
  return store;
}

/** The window's view of the owner: revisions, saved revision, authored state, session. */
export function useSnapshot(): Snapshot {
  const store = useHullStore();
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

/**
 * The assembled model the geometry reads. Its identity changes exactly when something this window draws has
 * changed, so it is also the right thing to put in a `useCallback` dependency list — which is what replaces
 * the old `modelVersion` counter.
 */
export function useRuntime(): Model {
  const store = useHullStore();
  return useSyncExternalStore(store.subscribe, store.runtime);
}

/**
 * Dispatch an edit. This is what a control calls instead of reaching for a callback its parent handed it —
 * which is what lets a panel be mounted anywhere, including in a window of its own.
 *
 * Every edit goes through here, so it is also where the performance readout's FRAME starts: the redraw an
 * edit sets off costs far more than the passes inside it (React's own render and commit, three's
 * reconciliation, the collector), and the frame is what measures the whole of it — see core/perf.
 */
export function useDispatch(): (cmd: HullCommand) => Promise<Outcome> {
  const store = useHullStore();
  return useCallback(
    (cmd: HullCommand) => {
      perfFrame();
      return store.dispatch(cmd);
    },
    [store],
  );
}
