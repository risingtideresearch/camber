// Wire contract between a per-window DocumentStoreClient and SessionHost.
//
// Commands carry intentions, not replacement states. The server broadcasts a complete authoritative snapshot
// before replying to a successful request, so an awaited client operation always observes its resulting state.
// Session commands are fire-and-forget; operations with meaningful results use request IDs for correlation.

import type { DocumentCommand, SessionCommand } from "../core/commands";
import type { SaveResult, SessionSource } from "./api";
import type { HistoryTimeline } from "./history";
import type { DocumentSnapshot } from "./snapshot";

/** Increment whenever either message union changes incompatibly. */
export const PROTOCOL_VERSION = 4;

export type ErrorCode =
  | "protocol-version"
  | "not-connected"
  | "stale"
  | "rejected"
  | "load-failed"
  | "save-failed"
  | "internal";

/** State is omitted because the preceding `published` message already installed it in every client. */
export type DispatchOutcome =
  | {
      readonly revision: number;
      readonly touched: number;
      readonly result?: number | boolean;
    }
  | { readonly rejected: string; readonly code?: ErrorCode };

/** Requests sent by one window. Every post-connect request repeats the negotiated session and window IDs. */
export type ClientMessage =
  | {
      type: "connect";
      sessionId: string;
      windowId: string;
      source: SessionSource;
      protocolVersion: number;
    }
  | {
      type: "command";
      sessionId: string;
      windowId: string;
      requestId: string;
      baseRevision: number;
      command: DocumentCommand;
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
  // Going to a moment by name rather than by counting steps to it. The history is a tree, so a destination
  // may be off the line the document is on and unreachable by any number of undos.
  | {
      type: "travel";
      sessionId: string;
      windowId: string;
      requestId: string;
      nodeId: number;
    }
  // A pull, not a subscription: the timeline is wanted by the one window showing it, so it is asked for rather
  // than broadcast with every snapshot to every window that would throw it away.
  | { type: "timeline"; sessionId: string; windowId: string; requestId: string }
  | {
      type: "set-name";
      sessionId: string;
      windowId: string;
      requestId: string;
      name: string;
    }
  | {
      type: "save";
      sessionId: string;
      windowId: string;
      requestId: string;
      name?: string;
    }
  | { type: "disconnect"; sessionId: string; windowId: string };

/** Direct replies plus session-wide snapshot publications. */
export type ServerMessage =
  | {
      type: "connected";
      sessionId: string;
      snapshot: DocumentSnapshot;
      protocolVersion: number;
      instanceId: string;
    }
  | { type: "published"; sessionId: string; snapshot: DocumentSnapshot }
  | { type: "outcome"; requestId: string; outcome: DispatchOutcome }
  | { type: "ack"; requestId: string; ok: boolean; revision: number }
  | { type: "save-result"; requestId: string; result: SaveResult }
  | { type: "timeline-result"; requestId: string; timeline: HistoryTimeline }
  | {
      type: "error";
      requestId?: string;
      code: ErrorCode;
      message: string;
    };
