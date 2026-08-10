// ---------- window ↔ SharedWorker message protocol ----------
//
// One SharedWorker hosts any number of sessions. A browser window owns one MessagePort and identifies itself
// with a lifetime-stable `windowId`; `sessionId` selects the authoritative HullOwner that port wants to use.
// Every message after `connect` repeats both IDs so the host can reject traffic sent before negotiation or to
// the wrong session.
//
// Connection:
//
//   window  ── connect(protocolVersion) ──▶ owner
//   window  ◀─ connected(snapshot) ──────── owner
//
// A protocol mismatch produces `error` instead of `connected`. The initial whole Snapshot makes the window a
// synchronous read replica before the editor mounts. Sessions currently live only as long as this worker;
// this protocol deliberately contains no persistence or restart-recovery messages.
//
// Authored command:
//
//   window  ── command(requestId, baseRevision) ──▶ owner
//   windows ◀─ published(new whole snapshot) ───── owner
//   caller  ◀─ outcome(requestId) ──────────────── owner
//
// The host broadcasts `published` synchronously while applying a command, before it sends the correlated
// `outcome`. Therefore, once dispatch() resolves, the calling window has already observed the resulting
// revision. Commands carry semantic edits rather than replacement states. Structural commands may be refused
// as stale when another author changed an overlapping slice after `baseRevision`; an invalid command is also
// refused without publishing. Whole snapshots are intentionally used instead of patches: hulls are small,
// and every publication independently brings a receiver fully up to date.
//
// Session commands are fire-and-forget and publish through the same Snapshot channel. Metadata commands,
// undo, and redo use requestId-correlated `ack` replies. Save has a correlated `save-result`; its
// backend work is owned and serialized by the session owner. Starting and finishing a save each publish the
// shared save status. Commands continue while the request is in flight, and completion marks only the
// captured revision saved. `error` includes a requestId when it rejects one request; without one it is a
// connection/protocol error. `disconnect` removes only that window from the session.

import type { HullCommand, SessionCommand } from "./commands";
import type { MetaCommand } from "./meta";
import type { SaveResult, Snapshot } from "./store";

/** Increment whenever either message union changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Stable machine-readable categories; `message` carries the human-readable detail. */
export type ErrorCode =
  | "protocol-version"
  | "not-connected"
  | "stale"
  | "rejected"
  | "save-failed"
  | "internal";

/** A command response omits state because the authoritative state was already sent in `published`. */
export type DispatchOutcome =
  | {
      readonly revision: number;
      readonly touched: number;
      readonly result?: number | boolean;
    }
  | { readonly rejected: string; readonly code?: ErrorCode };

/** Messages sent by one window's HullStore to the session owner. */
export type ClientMessage =
  | {
      type: "connect";
      sessionId: string;
      windowId: string;
      protocolVersion: number;
    }
  | {
      type: "command";
      sessionId: string;
      windowId: string;
      requestId: string;
      baseRevision: number;
      command: HullCommand;
    }
  | {
      type: "session-command";
      sessionId: string;
      windowId: string;
      command: SessionCommand;
    }
  | {
      type: "undo" | "redo";
      sessionId: string;
      windowId: string;
      requestId: string;
    }
  | {
      type: "meta-command";
      sessionId: string;
      windowId: string;
      requestId: string;
      command: MetaCommand;
    }
  | {
      type: "save";
      sessionId: string;
      windowId: string;
      requestId: string;
      name: string;
    }
  | { type: "disconnect"; sessionId: string; windowId: string };

/** Messages sent by the owner to one window; `published` is broadcast to every session client. */
export type WorkerMessage =
  | {
      type: "connected";
      sessionId: string;
      snapshot: Snapshot;
      fresh: boolean;
      protocolVersion: number;
      instanceId: string;
    }
  | { type: "published"; sessionId: string; snapshot: Snapshot }
  | { type: "outcome"; requestId: string; outcome: DispatchOutcome }
  | { type: "ack"; requestId: string; ok: boolean; revision: number }
  | { type: "save-result"; requestId: string; result: SaveResult }
  | {
      type: "error";
      requestId?: string;
      code: ErrorCode;
      message: string;
    };
