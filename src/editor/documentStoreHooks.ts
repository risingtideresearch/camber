// React-facing document API. Views subscribe through useSyncExternalStore so publications arriving outside
// React cannot produce tearing. The hooks expose application intentions and keep client/server infrastructure
// out of components.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { DocumentCommand, CommandOutcome } from "../core/commands";
import type { Model } from "../core/model";
import { perfFrame } from "../core/perf";
import type { DocumentStore } from "../document-store/api";
import type { HistoryTimeline } from "../document-store/history";
import type { DocumentSnapshot } from "../document-store/snapshot";

export const DocumentStoreContext = createContext<DocumentStore | null>(null);

export function useDocumentStore(): DocumentStore {
  const store = useContext(DocumentStoreContext);
  if (!store) throw new Error("useDocumentStore needs a DocumentStoreProvider");
  return store;
}

export function useDocumentSnapshot(): DocumentSnapshot {
  const store = useDocumentStore();
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

/** Window-local derived model; identity changes only when a consumed snapshot slice changes. */
export function useDocumentRuntime(): Model {
  const store = useDocumentStore();
  return useSyncExternalStore(store.subscribe, store.runtime);
}

/** Authored command dispatch, also marking the start of the editor's frame performance measurement. */
export function useDocumentDispatch(): (
  command: DocumentCommand,
) => Promise<CommandOutcome> {
  const store = useDocumentStore();
  return useCallback(
    (command: DocumentCommand) => {
      perfFrame();
      return store.dispatch(command);
    },
    [store],
  );
}

/** Shared global history state and intentions, without exposing where history is implemented. */
export function useDocumentHistory() {
  const store = useDocumentStore();
  const snapshot = useDocumentSnapshot();
  return {
    canUndo: snapshot.canUndo,
    canRedo: snapshot.canRedo,
    undo: store.undo,
    redo: store.redo,
  };
}

/**
 * The shared history tree as data, refreshed after the document changes. `null` until the first answer.
 *
 * The timeline is PULLED rather than published with the snapshot: only a window showing the history wants it,
 * and it is a per-look request, so no other window pays for it. The fetch is also deliberately late. A pointer
 * drag publishes on every frame and coalesces into a single history step, so refetching per publication would
 * be dozens of round trips describing one entry; waiting for the gesture to pause asks once, at a delay a
 * reader does not notice. The live undo / redo availability comes from the snapshot, so nothing important lags.
 */
export function useDocumentTimeline(): HistoryTimeline | null {
  const store = useDocumentStore();
  const { revision } = useDocumentSnapshot();
  const [timeline, setTimeline] = useState<HistoryTimeline | null>(null);
  // Keyed on the authored revision: session publications (a cut-station scrub) cannot change the history.
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void store.timeline().then((next) => {
        if (active) setTimeline(next);
      });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [store, revision]);
  return timeline;
}

/** Shared naming/save intentions; persistence remains entirely behind the store boundary. */
export function useDocumentSave() {
  const store = useDocumentStore();
  return { saveDocument: store.save, setDocumentName: store.setName };
}
