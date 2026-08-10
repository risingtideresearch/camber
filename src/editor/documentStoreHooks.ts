// React-facing document API. Views subscribe through useSyncExternalStore so publications arriving outside
// React cannot produce tearing. The hooks expose application intentions and keep client/server infrastructure
// out of components.

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import type { DocumentCommand, CommandOutcome } from "../core/commands";
import type { Model } from "../core/model";
import { perfFrame } from "../core/perf";
import type { DocumentStore } from "../document-store/api";
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

/** Shared naming/save intentions; persistence remains entirely behind the store boundary. */
export function useDocumentSave() {
  const store = useDocumentStore();
  return { saveDocument: store.save, setDocumentName: store.setName };
}
