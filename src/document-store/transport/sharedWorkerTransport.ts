// Production transport adapter. Its only job is to map protocol messages onto one SharedWorker MessagePort;
// session routing, ordering, command handling, and persistence all remain in SessionHost.

import type { ServerMessage } from "../protocol";
import type { StoreTransportFactory } from "./transport";

export const sharedWorkerTransport: StoreTransportFactory = (
  windowId,
  receive,
) => {
  const worker = new SharedWorker(
    new URL("../../worker/documentStoreWorker.ts", import.meta.url),
    { type: "module", name: "camber-document-store" },
  );
  worker.port.onmessage = (event: MessageEvent<ServerMessage>) =>
    receive(event.data);
  worker.port.onmessageerror = () =>
    console.error(`camber: document-store message failed for ${windowId}`);
  worker.port.start();
  return {
    post: (message) => worker.port.postMessage(message),
    close: () => worker.port.close(),
  };
};
