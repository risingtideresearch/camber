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
  snapshot(): DocumentSnapshot;
  subscribe(listener: () => void): () => void;
  runtime(): Model;
  dispatch(command: DocumentCommand): Promise<CommandOutcome>;
  dispatchSession(command: SessionCommand): void;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  setName(name: string): Promise<void>;
  save(name?: string): Promise<SaveResult>;
  close(): void;
}
