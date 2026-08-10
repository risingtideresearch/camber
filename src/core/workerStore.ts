// The window side of the protocol in `protocol.ts`.
//
// connectHullStore performs the connect/connected handshake before exposing a HullStore, then maintains one
// immutable Snapshot replica for this window. `published` replaces that replica wholesale and notifies React;
// no command is ever reduced in a window. Requests that need replies receive a window-unique requestId and
// wait in `pending` for outcome, ack, or a request-scoped error. Session commands and disconnect are the only
// fire-and-forget messages.
//
// Both transports below carry exactly the same message unions. The SharedWorker transport is the product
// path; the in-window host is a graceful fallback and the seam used by protocol tests.

import type { HullCommand, Outcome } from "./commands";
import { assemble } from "./runtime";
import type { Model } from "./model";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type WorkerMessage,
} from "./protocol";
import {
  createSessionHost,
  type HostClient,
  type SessionHost,
} from "./sessionHost";
import type { HullStore, Snapshot } from "./store";

export interface Transport {
  post(message: ClientMessage): void;
  close(): void;
}
export type TransportFactory = (
  windowId: string,
  onMessage: (message: WorkerMessage) => void,
) => Transport;
export interface ConnectOptions {
  sessionId: string;
  windowId?: string;
  transport?: TransportFactory;
  timeoutMs?: number;
}
export interface ConnectedStore {
  store: HullStore;
  fresh: boolean;
  instanceId: string;
  kind: "shared-worker" | "in-window";
  pending: () => number;
}
const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export function sharedWorkerTransport(
  windowId: string,
  receive: (message: WorkerMessage) => void,
): Transport {
  const worker = new SharedWorker(
    new URL("../worker/hullWorker.ts", import.meta.url),
    { type: "module", name: "camber-hull-owner" },
  );
  worker.port.onmessage = (event: MessageEvent<WorkerMessage>) =>
    receive(event.data);
  worker.port.onmessageerror = () =>
    console.error(`camber: owner message failed for ${windowId}`);
  worker.port.start();
  return {
    post: (message) => worker.port.postMessage(message),
    close: () => worker.port.close(),
  };
}

let fallbackHost: SessionHost | undefined;
export function inWindowTransport(
  windowId: string,
  receive: (message: WorkerMessage) => void,
): Transport {
  const host = (fallbackHost ??= createSessionHost());
  const client: HostClient = { id: windowId, post: receive };
  return {
    post: (message) => host.receive(client, message),
    close: () => host.drop(client),
  };
}

export async function connectHullStore(
  options: ConnectOptions,
): Promise<ConnectedStore> {
  const sessionId = options.sessionId;
  const windowId = options.windowId ?? newId();
  const hasSharedWorker = typeof SharedWorker !== "undefined";
  let kind: ConnectedStore["kind"] =
    options.transport || !hasSharedWorker ? "in-window" : "shared-worker";
  let snapshot: Snapshot | null = null;
  let closed = false;
  const listeners = new Set<() => void>();
  const pending = new Map<string, (message: WorkerMessage) => void>();
  let sequence = 0;
  let connected: ((message: WorkerMessage) => void) | null = null;
  const cacheKey = {};
  let model: Model | undefined;

  // Publications are broadcasts and therefore have no requestId. All other post-handshake replies either
  // settle one pending request or report an uncorrelated protocol/connection failure.
  const receive = (message: WorkerMessage) => {
    if (message.type === "connected") {
      snapshot = message.snapshot;
      connected?.(message);
      return;
    }
    if (message.type === "published") {
      snapshot = message.snapshot;
      model = undefined;
      for (const listener of listeners) listener();
      return;
    }
    if (message.type === "outcome" || message.type === "ack") {
      const resolve = pending.get(message.requestId);
      pending.delete(message.requestId);
      resolve?.(message);
      return;
    }
    if (message.requestId) {
      const resolve = pending.get(message.requestId);
      pending.delete(message.requestId);
      if (resolve) {
        resolve(message);
        return;
      }
    }
    if (!snapshot) connected?.(message);
    else console.error(`camber owner [${message.code}]: ${message.message}`);
  };

  const factory =
    options.transport ??
    (kind === "shared-worker" ? sharedWorkerTransport : inWindowTransport);
  let transport: Transport;
  try {
    transport = factory(windowId, receive);
  } catch (error) {
    if (kind === "in-window") throw error;
    console.warn(
      "camber: SharedWorker unavailable; using an in-window owner",
      error,
    );
    kind = "in-window";
    transport = inWindowTransport(windowId, receive);
  }
  // IDs need only be unique for this window lifetime: the windowId prefix keeps concurrent windows apart,
  // and the sequence makes overlapping requests from this store independently awaitable.
  const request = (
    build: (requestId: string) => ClientMessage,
  ): Promise<WorkerMessage> =>
    new Promise((resolve) => {
      if (closed)
        return resolve({
          type: "error",
          code: "not-connected",
          message: "store closed",
        });
      const requestId = `${windowId}:${++sequence}`;
      pending.set(requestId, resolve);
      transport.post(build(requestId));
    });
  const first = await new Promise<WorkerMessage>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`owner did not answer for session ${sessionId}`)),
      options.timeoutMs ?? 10_000,
    );
    connected = (message) => {
      clearTimeout(timer);
      connected = null;
      resolve(message);
    };
    transport.post({
      type: "connect",
      sessionId,
      windowId,
      protocolVersion: PROTOCOL_VERSION,
    });
  });
  if (first.type !== "connected") {
    transport.close();
    throw new Error(
      `cannot join session ${sessionId}: ${first.type === "error" ? first.message : "unexpected reply"}`,
    );
  }

  async function history(type: "undo" | "redo"): Promise<boolean> {
    const reply = await request((requestId) => ({
      type,
      sessionId,
      windowId,
      requestId,
    }));
    return reply.type === "ack" && reply.ok;
  }
  const store: HullStore = {
    sessionId,
    windowId,
    snapshot: () => snapshot!,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    runtime() {
      const current = snapshot!;
      model = assemble(current.state, current.session, {
        sliceRevs: current.sliceRevs,
        cacheKey,
      });
      return model;
    },
    async dispatch(command: HullCommand): Promise<Outcome> {
      const reply = await request((requestId) => ({
        type: "command",
        sessionId,
        windowId,
        requestId,
        baseRevision: snapshot!.revision,
        command,
      }));
      if (reply.type !== "outcome")
        return {
          rejected:
            reply.type === "error" ? reply.message : "unexpected owner reply",
        };
      if ("rejected" in reply.outcome)
        return { rejected: reply.outcome.rejected };
      return {
        state: snapshot!.state,
        touched: reply.outcome.touched,
        result: reply.outcome.result,
      };
    },
    dispatchSession(command) {
      if (!closed)
        transport.post({
          type: "session-command",
          sessionId,
          windowId,
          command,
        });
    },
    undo: () => history("undo"),
    redo: () => history("redo"),
    async markSaved(revision) {
      await request((requestId) => ({
        type: "mark-saved",
        sessionId,
        windowId,
        requestId,
        revision,
      }));
    },
    close() {
      if (closed) return;
      closed = true;
      transport.post({ type: "disconnect", sessionId, windowId });
      transport.close();
      listeners.clear();
    },
  };
  return {
    store,
    fresh: first.fresh,
    instanceId: first.instanceId,
    kind,
    pending: () => pending.size,
  };
}
