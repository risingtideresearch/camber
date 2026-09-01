// Window-side implementation of the transport-neutral DocumentStore API.
//
// The client is a read replica, not a second authority: it never interprets commands or maintains history.
// It installs whole snapshots published by SessionHost, computes window-local runtime data, and correlates
// asynchronous requests with replies over an injected transport.

import type { DocumentCommand, DocumentOutcome } from "../core/commands";
import type { Model } from "../core/model";
import { assemble } from "../core/runtime";
import type { DocumentStore, SessionSource } from "./api";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "./protocol";
import type { DocumentSnapshot } from "./snapshot";
import type { StoreTransportFactory } from "./transport/transport";

export interface ConnectDocumentStoreOptions {
  readonly sessionId: string;
  readonly source?: SessionSource;
  readonly windowId?: string;
  readonly transport: StoreTransportFactory;
  readonly timeoutMs?: number;
}

export interface ConnectedDocumentStore {
  readonly store: DocumentStore;
  readonly instanceId: string;
  readonly pending: () => number;
}

const newId = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

/** Connects one window-local replica to an authoritative document session. */
export async function connectDocumentStore(
  options: ConnectDocumentStoreOptions,
): Promise<ConnectedDocumentStore> {
  const sessionId = options.sessionId;
  const windowId = options.windowId ?? newId();
  // `snapshot` is the only authored state held in this window. It is replaced atomically on publication.
  let snapshot: DocumentSnapshot | null = null;
  let closed = false;
  const listeners = new Set<() => void>();
  // Several UI intentions may be in flight together; request IDs let replies resolve independently.
  const pending = new Map<string, (message: ServerMessage) => void>();
  let sequence = 0;
  let connected: ((message: ServerMessage) => void) | null = null;
  // Runtime assembly is local because samplers/functions cannot be transported. A per-client cache key keeps
  // this window's memoization independent from the server and every other window.
  const cacheKey = {};
  let model: Model | undefined;

  const receive = (message: ServerMessage): void => {
    // Publications are broadcasts without request IDs. SessionHost sends one before the corresponding
    // outcome, which is the ordering guarantee that makes dispatch() return the authoritative new state.
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
    // Correlated replies settle exactly one request and do not notify snapshot subscribers themselves.
    if (
      message.type === "outcome" ||
      message.type === "ack" ||
      message.type === "save-result" ||
      message.type === "timeline-result"
    ) {
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
    else
      console.error(
        `camber document store [${message.code}]: ${message.message}`,
      );
  };

  const transport = options.transport(windowId, receive);

  // All request/reply operations share this helper; fire-and-forget session commands intentionally bypass it.
  const request = (
    build: (requestId: string) => ClientMessage,
  ): Promise<ServerMessage> =>
    new Promise((resolve) => {
      if (closed) {
        resolve({
          type: "error",
          code: "not-connected",
          message: "store closed",
        });
        return;
      }
      const requestId = `${windowId}:${++sequence}`;
      pending.set(requestId, resolve);
      transport.post(build(requestId));
    });

  // Do not expose a DocumentStore until the handshake has installed a synchronous initial snapshot.
  let first: ServerMessage;
  try {
    first = await new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`server did not answer for session ${sessionId}`)),
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
        source: options.source ?? { type: "new" },
        protocolVersion: PROTOCOL_VERSION,
      });
    });
  } catch (error) {
    transport.close();
    throw error;
  }

  if (first.type !== "connected") {
    transport.close();
    throw new Error(
      `cannot join session ${sessionId}: ${first.type === "error" ? first.message : "unexpected reply"}`,
    );
  }

  const history = async (type: "undo" | "redo"): Promise<boolean> => {
    const reply = await request((requestId) => ({
      type,
      sessionId,
      windowId,
      requestId,
    }));
    return reply.type === "ack" && reply.ok;
  };

  const store: DocumentStore = {
    windowId,
    snapshot: () => snapshot!,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    runtime() {
      // assemble() uses slice revisions rather than object identity because structuredClone replaces every
      // object reference crossing the worker boundary.
      const current = snapshot!;
      model = assemble(current.state.hull, current.session, {
        sliceRevs: current.sliceRevs,
        cacheKey,
      });
      return model;
    },
    async dispatch(command: DocumentCommand): Promise<DocumentOutcome> {
      // The base revision is what this window saw when composing the command. The server decides whether an
      // intervening edit makes a structural command stale.
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
            reply.type === "error" ? reply.message : "unexpected server reply",
        };
      if ("rejected" in reply.outcome)
        return { rejected: reply.outcome.rejected };
      return {
        doc: snapshot!.state,
        touched: reply.outcome.touched,
        result: reply.outcome.result,
      };
    },
    dispatchSession(command) {
      // Session edits are cheap, non-undoable, and carry no result, so they need no request bookkeeping.
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
    async travel(nodeId) {
      const reply = await request((requestId) => ({
        type: "travel",
        sessionId,
        windowId,
        requestId,
        nodeId,
      }));
      return reply.type === "ack" && reply.ok;
    },
    async timeline() {
      const reply = await request((requestId) => ({
        type: "timeline",
        sessionId,
        windowId,
        requestId,
      }));
      if (reply.type === "timeline-result") return reply.timeline;
      // A closed or unreachable store has no history to report rather than a broken one. The caller is a view
      // that would only have to render "no history" anyway, so it is given an empty tree, not an error.
      return {
        steps: [],
        root: null,
        current: null,
        depth: 0,
        truncated: false,
      };
    },
    async setName(name) {
      const reply = await request((requestId) => ({
        type: "set-name",
        sessionId,
        windowId,
        requestId,
        name,
      }));
      if (reply.type !== "ack" || !reply.ok)
        throw new Error(
          reply.type === "error" ? reply.message : "server refused name",
        );
    },
    async save(name) {
      const reply = await request((requestId) => ({
        type: "save",
        sessionId,
        windowId,
        requestId,
        name,
      }));
      if (reply.type === "save-result") return reply.result;
      throw new Error(
        reply.type === "error" ? reply.message : "unexpected save reply",
      );
    },
    close() {
      if (closed) return;
      // Resolve pending callers instead of leaving promises alive after their transport has disappeared.
      closed = true;
      transport.post({ type: "disconnect", sessionId, windowId });
      transport.close();
      listeners.clear();
      for (const resolve of pending.values())
        resolve({
          type: "error",
          code: "not-connected",
          message: "store closed",
        });
      pending.clear();
    },
  };

  return {
    store,
    instanceId: first.instanceId,
    pending: () => pending.size,
  };
}
