// Public application boundary for document editing.
//
// React hooks and other consumers depend on this interface only. A DocumentStore may be backed by a
// SharedWorker, an in-window host, or a test server; none of those implementation details appear here.
// Reads are synchronous from the window-local replica, while authoritative mutations are asynchronous.

import type {
  DocumentCommand,
  CommandOutcome,
  SessionCommand,
} from "../core/commands";
import type { Model } from "../core/model";
import type { HistoryTimeline } from "./history";
import type { DocumentSnapshot } from "./snapshot";

/** How the server initializes a session the first time it sees its session ID. */
export type SessionSource =
  | { readonly type: "new" }
  | { readonly type: "design"; readonly designId: string };

export interface SaveResult {
  readonly revision: number;
  readonly currentId: string;
  readonly name: string;
  readonly created: boolean;
}

/** Transport-neutral document API exposed to the editor. */
export interface DocumentStore {
  /**
   * This window's identity in the session — the `author` the server stamps on the revisions it writes. Exposed
   * so a view can tell this window's own edits from another window's; nothing else needs it.
   */
  readonly windowId: string;
  snapshot(): DocumentSnapshot;
  subscribe(listener: () => void): () => void;
  runtime(): Model;
  dispatch(command: DocumentCommand): Promise<CommandOutcome>;
  dispatchSession(command: SessionCommand): void;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  /**
   * Go straight to a moment in the history, named by its step id. `false` if that moment is gone — the depth
   * cap drops old branches, and the window holding the id learns about it here.
   */
  travel(nodeId: number): Promise<boolean>;
  /**
   * The shared history tree, described, so a window can show it. Asynchronous and pulled rather than part of
   * the snapshot: only a window displaying the history wants it, and it changes on exactly the publications
   * that would carry it.
   */
  timeline(): Promise<HistoryTimeline>;
  setName(name: string): Promise<void>;
  save(name?: string): Promise<SaveResult>;
  close(): void;
}
