// Minimal byte/message carrier used by DocumentStoreClient. The transport has no store semantics: production
// uses a SharedWorker port, fallback uses an in-window SessionHost, and tests inject a structured-clone seam.

import type { ClientMessage, ServerMessage } from "../protocol";

export interface StoreTransport {
  post(message: ClientMessage): void;
  close(): void;
}

export type StoreTransportFactory = (
  windowId: string,
  receive: (message: ServerMessage) => void,
) => StoreTransport;
