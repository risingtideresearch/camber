// Graceful transport fallback for browsers without SharedWorker support.
//
// It runs the same SessionHost and protocol in the window, rather than introducing a second store behavior.
// The module-level default host lets multiple clients in the same realm still share sessions.

import {
  createSessionHost,
  type HostClient,
  type SessionHost,
} from "../sessionHost";
import type { StoreTransportFactory } from "./transport";

let defaultHost: SessionHost | undefined;

/** Composition helper for browsers without SharedWorker support. */
export function inWindowTransport(
  host: SessionHost = (defaultHost ??= createSessionHost()),
): StoreTransportFactory {
  return (windowId, receive) => {
    const client: HostClient = { id: windowId, post: receive };
    return {
      post: (message) => host.receive(client, message),
      close: () => host.drop(client),
    };
  };
}
