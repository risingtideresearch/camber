// The transport-independent server side of the protocol in `protocol.ts`.
//
// `hullWorker.ts` turns MessagePorts into HostClients; tests use the same interface without a browser. The
// host maps session IDs to independent owners and serializes every incoming message through one promise
// chain. That global queue makes command ordering deterministic even when several ports post at once.
//
// HullOwner publication is synchronous. Its subscription broadcasts `published` while dispatch is still
// running, and only afterwards does the command branch post `outcome` to the requester. Keep that ordering:
// workerStore relies on an awaited dispatch seeing its new Snapshot already installed.

import { rejected } from "./commands";
import { supabaseSaveBackend, type SaveBackend } from "./saveBackend";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type WorkerMessage,
} from "./protocol";
import { createOwner, type HullOwner, type Snapshot } from "./store";

export interface HostClient {
  readonly id: string;
  post(message: WorkerMessage): void;
}

export interface SessionHostOptions {
  instanceId?: string;
  now?: () => number;
  onError?: (error: unknown) => void;
  saveBackend?: SaveBackend;
}

export interface SessionDiagnostics {
  sessionId: string;
  clients: string[];
  revision: number;
  savedRevision: number;
  sessionRevision: number;
}

export interface SessionHost {
  readonly instanceId: string;
  receive(client: HostClient, message: ClientMessage): void;
  drop(client: HostClient): void;
  settled(): Promise<void>;
  diagnostics(): SessionDiagnostics[];
}

interface Session {
  id: string;
  owner: HullOwner;
  clients: Map<string, HostClient>;
}

export function createSessionHost(
  options: SessionHostOptions = {},
): SessionHost {
  const instanceId =
    options.instanceId ?? `w-${Math.random().toString(36).slice(2, 8)}`;
  const onError =
    options.onError ??
    ((error: unknown) => console.error("camber owner:", error));
  const saveBackend = options.saveBackend ?? supabaseSaveBackend;
  const sessions = new Map<string, Session>();
  let queue: Promise<unknown> = Promise.resolve();

  const fail = (
    client: HostClient,
    code: ErrorCode,
    message: string,
    requestId?: string,
  ) => client.post({ type: "error", code, message, requestId });

  // A session is created by its first successful connect and remains in this worker's memory after its last
  // client leaves. There is intentionally no on-disk recovery at this stage.
  const openSession = (id: string): Session => {
    const existing = sessions.get(id);
    if (existing) return existing;
    const session: Session = {
      id,
      owner: createOwner({ now: options.now, saveBackend }),
      clients: new Map(),
    };
    session.owner.subscribe((snapshot) => {
      for (const client of session.clients.values())
        client.post({ type: "published", sessionId: id, snapshot });
    });
    sessions.set(id, session);
    return session;
  };

  const save = async (
    session: Session,
    client: HostClient,
    requestId: string,
    name: string,
  ): Promise<void> => {
    try {
      const result = await session.owner.save(name);
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

  const process = (client: HostClient, message: ClientMessage): void => {
    if (message.type === "connect") {
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        fail(
          client,
          "protocol-version",
          `owner speaks protocol ${PROTOCOL_VERSION}`,
        );
        return;
      }
      const session = openSession(message.sessionId);
      const snapshot = session.owner.snapshot();
      // Only one window bootstraps an uninitialized session from the backend. Other windows adopt the
      // owner's publications instead of racing a second install of the same design.
      const fresh = !snapshot.meta.initialized && session.clients.size === 0;
      session.clients.set(client.id, client);
      client.post({
        type: "connected",
        sessionId: session.id,
        snapshot,
        fresh,
        protocolVersion: PROTOCOL_VERSION,
        instanceId,
      });
      return;
    }

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
        const out = session.owner.dispatch(
          message.command,
          message.windowId,
          message.baseRevision,
        );
        client.post({
          type: "outcome",
          requestId: message.requestId,
          outcome: rejected(out)
            ? {
                rejected: out.rejected,
                code: out.rejected.startsWith("stale:") ? "stale" : "rejected",
              }
            : {
                revision: session.owner.snapshot().revision,
                touched: out.touched,
                result: out.result,
              },
        });
        return;
      }
      case "session-command":
        session.owner.dispatchSession(message.command);
        return;
      case "undo":
      case "redo": {
        const ok =
          message.type === "undo"
            ? session.owner.undo(message.windowId)
            : session.owner.redo(message.windowId);
        client.post({
          type: "ack",
          requestId: message.requestId,
          ok,
          revision: session.owner.snapshot().revision,
        });
        return;
      }
      case "meta-command":
        session.owner.dispatchMeta(message.command);
        client.post({
          type: "ack",
          requestId: message.requestId,
          ok: true,
          revision: session.owner.snapshot().revision,
        });
        return;
      case "save":
        // owner.save captures and publishes synchronously before its first await, but the backend request does
        // not block the host's command queue. Later edits can land while that exact revision is being saved.
        void save(session, client, message.requestId, message.name);
        return;
      case "disconnect":
        session.clients.delete(client.id);
        return;
    }
  };

  // MessagePort preserves order per port; this chain additionally gives messages from different ports one
  // total order before any of them reaches an owner.
  const enqueue = (run: () => void) => {
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
        const snapshot: Snapshot = session.owner.snapshot();
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
