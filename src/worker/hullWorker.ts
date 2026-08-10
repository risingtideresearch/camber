// Thin SharedWorker transport adapter. The protocol and all ordering rules live in `protocol.ts` and
// `sessionHost.ts`; this file only converts each connecting MessagePort into a HostClient.
//
// The first client message is expected to be `connect`. Its windowId becomes the stable identity attached to
// this port for the rest of its lifetime. The host validates the handshake before accepting any later message.
// Replies are posted on the same port; session-wide publications are fanned out by SessionHost.

import { createSessionHost, type HostClient } from "../core/sessionHost";
import type { ClientMessage } from "../core/protocol";

interface SharedWorkerScope {
  onconnect: ((event: MessageEvent) => void) | null;
}
const scope = self as unknown as SharedWorkerScope;
const host = createSessionHost();

scope.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  let client: HostClient | null = null;
  port.onmessage = (message: MessageEvent<ClientMessage>) => {
    client ??= {
      id: message.data.windowId,
      post: (out) => port.postMessage(out),
    };
    host.receive(client, message.data);
  };
  port.start();
};
