// SharedWorker composition root. This adapter intentionally contains no store logic: it gives each connecting
// MessagePort a HostClient identity and forwards protocol messages to the single SessionHost instance.

import {
  createSessionHost,
  type HostClient,
} from "../document-store/sessionHost";
import type { ClientMessage } from "../document-store/protocol";

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
