// Server-side application boundary for all document sessions in one SharedWorker (or fallback host).
//
// SessionHost maps session IDs to DocumentStoreServers, serializes requests from different ports, broadcasts
// snapshots, and coordinates persistence. It does not interpret document commands or implement undo/redo;
// those operations are delegated to the session's server and its DocumentHistory.

import { rejected } from "../core/commands";
import { documentVersion, VERSION } from "../core/document";
import { parseHullState } from "../core/json";
import {
  cloneDocument,
  defaultDocument,
  documentOf,
  type SessionDocument,
} from "../core/sessionDocument";
import { parseSheet } from "../core/sheet/json";
import type { SessionMeta } from "../core/meta";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "./protocol";
import type { SessionSource } from "./api";
import type { PersistenceAdapter } from "./persistence/persistenceAdapter";
import { supabasePersistenceAdapter } from "./persistence/supabasePersistenceAdapter";
import { SaveCoordinator } from "./saveCoordinator";
import { createDocumentStoreServer, type DocumentStoreServer } from "./server";
import type { DocumentSnapshot } from "./snapshot";

export interface HostClient {
  readonly id: string;
  post(message: ServerMessage): void;
}

export interface SessionHostOptions {
  readonly instanceId?: string;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  readonly persistence?: PersistenceAdapter;
}

export interface SessionDiagnostics {
  readonly sessionId: string;
  readonly clients: string[];
  readonly revision: number;
  readonly savedRevision: number;
  readonly sessionRevision: number;
}

export interface SessionHost {
  readonly instanceId: string;
  receive(client: HostClient, message: ClientMessage): void;
  drop(client: HostClient): void;
  settled(): Promise<void>;
  diagnostics(): SessionDiagnostics[];
}

// One server and history exist per session regardless of how many windows are connected.
interface HostedSession {
  readonly id: string;
  readonly server: DocumentStoreServer;
  readonly clients: Map<string, HostClient>;
}

const initializedMeta = (
  state: SessionDocument,
  identity: {
    currentId: string | null;
    savedName: string | null;
    name: string;
  },
): SessionMeta => ({
  initialized: true,
  name: identity.name,
  design: {
    currentId: identity.currentId,
    savedName: identity.savedName,
    savedState: cloneDocument(state),
  },
  saving: false,
});

/** Transport-independent router and lifetime manager for document sessions. */
export function createSessionHost(
  options: SessionHostOptions = {},
): SessionHost {
  const instanceId =
    options.instanceId ?? `server-${Math.random().toString(36).slice(2, 8)}`;
  const onError =
    options.onError ??
    ((error: unknown) => console.error("camber document store:", error));
  // Infrastructure dependencies are composed here rather than injected into DocumentStoreServer.
  const persistence = options.persistence ?? supabasePersistenceAdapter;
  const saves = new SaveCoordinator(persistence);
  const sessions = new Map<string, HostedSession>();
  // A single promise chain imposes a deterministic total order across messages from different ports. It also
  // serializes asynchronous first-load, preventing two initial connections from loading one session twice.
  let queue: Promise<unknown> = Promise.resolve();

  const fail = (
    client: HostClient,
    code: ErrorCode,
    message: string,
    requestId?: string,
  ) => client.post({ type: "error", code, message, requestId });

  // Existing sessions always win over the source in a later connect request. The source is initialization
  // data only; this prevents a second window from replacing a live session.
  const openSession = async (
    id: string,
    source: SessionSource,
  ): Promise<HostedSession> => {
    const existing = sessions.get(id);
    if (existing) return existing;

    let state = defaultDocument();
    let meta: SessionMeta;
    if (source.type === "design") {
      // Persistence returns storage data. Parsing, version conversion, and session identity are application
      // concerns performed before the server is exposed to any client.
      //
      // The two parts are parsed independently and on purpose. A hull that will not decode must stop the
      // load — the design cannot be opened at all — while a weight sheet that will not decode comes back
      // empty rather than taking the design down with it (see `parseSheet`).
      const loaded = await persistence.loadDesign(source.designId);
      const version = documentVersion(JSON.parse(loaded.documentText));
      state = documentOf(
        parseHullState(loaded.documentText),
        parseSheet(loaded.weightsText),
      );
      const name =
        version < VERSION
          ? `${loaded.name} converted to v${VERSION}`
          : loaded.name;
      meta = initializedMeta(state, {
        currentId: source.designId,
        savedName: loaded.name,
        name,
      });
    } else {
      meta = initializedMeta(state, {
        currentId: null,
        savedName: null,
        name: "",
      });
    }

    const session: HostedSession = {
      id,
      server: createDocumentStoreServer({
        state,
        meta,
        historyOptions: { now: options.now },
      }),
      clients: new Map(),
    };
    // Server publication is synchronous. Fan it out immediately so the requesting client's snapshot arrives
    // before the correlated command outcome sent below.
    session.server.subscribe((snapshot) => {
      for (const client of session.clients.values())
        client.post({ type: "published", sessionId: id, snapshot });
    });
    sessions.set(id, session);
    return session;
  };

  // SaveCoordinator keeps persistence I/O outside the server while preserving server-owned save transitions.
  const save = async (
    session: HostedSession,
    client: HostClient,
    requestId: string,
    name?: string,
  ): Promise<void> => {
    try {
      const result = await saves.save(session.server, name);
      client.post({ type: "save-result", requestId, result });
    } catch (error) {
      fail(
        client,
        "save-failed",
        error instanceof Error ? error.message : String(error),
        requestId,
      );
    }
  };

  const process = async (
    client: HostClient,
    message: ClientMessage,
  ): Promise<void> => {
    // Connection is the only request allowed before session membership has been established.
    if (message.type === "connect") {
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        fail(
          client,
          "protocol-version",
          `server speaks protocol ${PROTOCOL_VERSION}`,
        );
        return;
      }
      try {
        const session = await openSession(message.sessionId, message.source);
        session.clients.set(client.id, client);
        client.post({
          type: "connected",
          sessionId: session.id,
          snapshot: session.server.snapshot(),
          protocolVersion: PROTOCOL_VERSION,
          instanceId,
        });
      } catch (error) {
        fail(
          client,
          "load-failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    // Every later message repeats both identities; reject traffic sent before negotiation or to another
    // session instead of trusting the MessagePort implicitly.
    const session = sessions.get(message.sessionId);
    const requestId = "requestId" in message ? message.requestId : undefined;
    if (!session || !session.clients.has(client.id)) {
      fail(
        client,
        "not-connected",
        `window is not connected to ${message.sessionId}`,
        requestId,
      );
      return;
    }

    switch (message.type) {
      case "command": {
        // Protocol fields become a server request here. No command semantics are duplicated in the host.
        const outcome = session.server.execute({
          command: message.command,
          author: message.windowId,
          baseRevision: message.baseRevision,
        });
        client.post({
          type: "outcome",
          requestId: message.requestId,
          outcome: rejected(outcome)
            ? {
                rejected: outcome.rejected,
                code: outcome.rejected.startsWith("stale:")
                  ? "stale"
                  : "rejected",
              }
            : {
                revision: session.server.snapshot().revision,
                touched: outcome.touched,
                result: outcome.result,
              },
        });
        return;
      }
      case "session-command":
        session.server.executeSession(message.command);
        return;
      case "undo":
      case "redo":
      case "travel": {
        // The host contributes author identity only; DocumentHistory remains private to the server. A jump is
        // routed exactly like an undo because it IS one to the server: a single authoritative transition.
        const ok =
          message.type === "travel"
            ? session.server.travel(message.nodeId, message.windowId)
            : message.type === "undo"
              ? session.server.undo(message.windowId)
              : session.server.redo(message.windowId);
        client.post({
          type: "ack",
          requestId: message.requestId,
          ok,
          revision: session.server.snapshot().revision,
        });
        return;
      }
      case "timeline":
        // A pure read, answered from the session's own history. It joins the same ordered queue as every
        // mutation, so the timeline a window receives is the one that goes with the snapshot it last saw.
        client.post({
          type: "timeline-result",
          requestId: message.requestId,
          timeline: session.server.timeline(),
        });
        return;
      case "set-name":
        session.server.setName(message.name);
        client.post({
          type: "ack",
          requestId: message.requestId,
          ok: true,
          revision: session.server.snapshot().revision,
        });
        return;
      case "save":
        // Save I/O deliberately does not block command ordering. beginSave publishes synchronously before
        // the coordinator reaches its first await, so later edits remain ordered after the captured revision.
        void save(session, client, message.requestId, message.name);
        return;
      case "disconnect":
        session.clients.delete(client.id);
        return;
    }
  };

  // MessagePort orders one client's messages; this queue additionally orders messages between clients.
  const enqueue = (run: () => void | Promise<void>): void => {
    queue = queue.then(run).catch(onError);
  };

  return {
    instanceId,
    receive: (client, message) => enqueue(() => process(client, message)),
    drop: (client) =>
      enqueue(() => {
        for (const session of sessions.values())
          if (session.clients.get(client.id) === client)
            session.clients.delete(client.id);
      }),
    async settled() {
      await queue;
    },
    diagnostics: () =>
      [...sessions.values()].map((session) => {
        const snapshot: DocumentSnapshot = session.server.snapshot();
        return {
          sessionId: session.id,
          clients: [...session.clients.keys()],
          revision: snapshot.revision,
          savedRevision: snapshot.savedRevision,
          sessionRevision: snapshot.sessionRevision,
        };
      }),
  };
}
