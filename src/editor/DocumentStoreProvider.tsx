// React composition boundary for document-store infrastructure.
//
// This is the only editor module that chooses transports and constructs DocumentStoreClient. Components below
// it receive the neutral DocumentStore through hooks and cannot tell whether a SharedWorker or fallback host
// serves the session.

import { useEffect, useState, type ReactNode } from "react";
import type { DocumentStore } from "../document-store/api";
import { connectDocumentStore } from "../document-store/client";
import { inWindowTransport } from "../document-store/transport/inWindowTransport";
import { sharedWorkerTransport } from "../document-store/transport/sharedWorkerTransport";
import type { StoreTransportFactory } from "../document-store/transport/transport";
import { DocumentStoreContext } from "./documentStoreHooks";
import type { SessionDescriptor } from "./editorSession";

export function DocumentStoreProvider({
  session,
  children,
}: {
  readonly session: SessionDescriptor;
  readonly children: ReactNode;
}) {
  const [store, setStore] = useState<DocumentStore | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let connectedStore: DocumentStore | undefined;

    const connect = async (): Promise<void> => {
      // Only transport construction falls back. A real session/load error from an established SharedWorker is
      // surfaced to the user rather than silently opening a second in-window session.
      try {
        const fallback = inWindowTransport();
        const transport: StoreTransportFactory =
          typeof SharedWorker === "undefined"
            ? fallback
            : (windowId, receive) => {
                try {
                  return sharedWorkerTransport(windowId, receive);
                } catch (workerError) {
                  console.warn(
                    "camber: SharedWorker unavailable; using an in-window store",
                    workerError,
                  );
                  return fallback(windowId, receive);
                }
              };
        // The client handshake installs the initial authoritative snapshot before returning the store.
        const connected = await connectDocumentStore({
          ...session,
          transport,
        });
        connectedStore = connected.store;
        if (active) setStore(connectedStore);
        else connectedStore.close();
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    };

    void connect();
    // pagehide handles navigation/reload; effect cleanup also covers unmount and an abandoned async connect.
    const unload = () => connectedStore?.close();
    window.addEventListener("pagehide", unload);
    return () => {
      active = false;
      window.removeEventListener("pagehide", unload);
      connectedStore?.close();
    };
  }, [session]);

  if (error)
    return <div className="app">Could not open the document: {error}</div>;
  if (!store) return <div className="app" />;
  return (
    <DocumentStoreContext.Provider value={store}>
      {children}
    </DocumentStoreContext.Provider>
  );
}
