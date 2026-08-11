// Transport-free DocumentStore facade used by focused server and React-hook tests.
//
// It preserves the public API's asynchronous mutation shape while calling a server in the same realm. Product
// multi-window behavior uses DocumentStoreClient; this adapter exists so server tests need no fake protocol.

import { assemble } from "../core/runtime";
import type { DocumentStore } from "./api";
import type { PersistenceAdapter } from "./persistence/persistenceAdapter";
import { supabasePersistenceAdapter } from "./persistence/supabasePersistenceAdapter";
import { SaveCoordinator } from "./saveCoordinator";
import type { DocumentStoreServer } from "./server";

/** Transport-free client facade for server and hook tests. */
export function createLocalDocumentStore(
  server: DocumentStoreServer,
  options: { author?: string; persistence?: PersistenceAdapter } = {},
): DocumentStore {
  const author = options.author ?? "local";
  const saves = new SaveCoordinator(
    options.persistence ?? supabasePersistenceAdapter,
  );
  const cacheKey = {};
  let seen = server.snapshot();
  const listeners = new Set<() => void>();
  // Mirror the client contract: retain the latest publication and notify zero-argument subscribers.
  const unsubscribe = server.subscribe((snapshot) => {
    seen = snapshot;
    for (const listener of listeners) listener();
  });
  let closed = false;

  return {
    // The author is this facade's window identity: it is what the server stamps on the revisions it writes,
    // which is exactly what `windowId` means to a view reading the timeline.
    windowId: author,
    snapshot: () => seen,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    runtime: () =>
      assemble(seen.state, seen.session, {
        sliceRevs: seen.sliceRevs,
        cacheKey,
      }),
    dispatch: (command) => Promise.resolve(server.execute({ command, author })),
    dispatchSession: (command) => server.executeSession(command),
    undo: () => Promise.resolve(server.undo(author)),
    redo: () => Promise.resolve(server.redo(author)),
    timeline: () => Promise.resolve(server.timeline()),
    setName: (name) => {
      server.setName(name);
      return Promise.resolve();
    },
    // Local saves still use the same coordinator and persistence contract as hosted sessions.
    save: (name) => saves.save(server, name),
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
