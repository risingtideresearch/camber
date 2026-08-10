// Snapshot-based undo/redo policy for one document session.
//
// DocumentHistory owns stack mechanics, depth limits, and gesture coalescing. It deliberately does not
// install states, increment revisions, validate hulls, or publish snapshots; DocumentStoreServer performs
// those authoritative operations around the transitions returned here.

import {
  sameGesture,
  type DocumentCommand,
  type SliceMask,
} from "../core/commands";
import type { HullState } from "../core/hull";

export interface HistoryRecord {
  readonly before: HullState;
  readonly touched: SliceMask;
  readonly command: DocumentCommand;
  readonly author: string;
  readonly at?: number;
}

export interface HistoryTransition {
  readonly state: HullState;
  readonly touched: SliceMask;
}

export interface DocumentHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  record(record: HistoryRecord): void;
  undo(current: HullState): HistoryTransition | null;
  redo(current: HullState): HistoryTransition | null;
  clear(): void;
}

export interface DocumentHistoryOptions {
  readonly depth?: number;
  readonly coalesceMs?: number;
  readonly now?: () => number;
  readonly sameGesture?: (
    before: DocumentCommand,
    after: DocumentCommand,
  ) => boolean;
}

// An entry stores the state before a gesture. Moving it to the opposite stack replaces `state` with the
// state current at the transition, which makes the same representation work symmetrically for undo and redo.
interface Entry {
  state: HullState;
  touched: SliceMask;
  command: DocumentCommand;
  author: string;
  at: number;
}

/** Snapshot-based document history. It owns stack policy, but never mutates or publishes document state. */
export function createDocumentHistory(
  options: DocumentHistoryOptions = {},
): DocumentHistory {
  const depth = options.depth ?? 200;
  const coalesceMs = options.coalesceMs ?? 400;
  const now = options.now ?? Date.now;
  const gesturesEqual = options.sameGesture ?? sameGesture;
  const undoStack: Entry[] = [];
  const redoStack: Entry[] = [];

  return {
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    record(record) {
      // A pointer drag emits many commands. Commands only coalesce when gesture identity, author, and timing
      // all agree, so another window's edit can never disappear into this window's undo step.
      const at = record.at ?? now();
      const top = undoStack[undoStack.length - 1];
      if (
        top &&
        top.author === record.author &&
        at - top.at < coalesceMs &&
        gesturesEqual(top.command, record.command)
      ) {
        top.touched |= record.touched;
        top.command = record.command;
        top.at = at;
      } else {
        undoStack.push({
          state: record.before,
          touched: record.touched,
          command: record.command,
          author: record.author,
          at,
        });
        if (undoStack.length > depth) undoStack.shift();
      }
      redoStack.length = 0;
    },
    undo(current) {
      // Preserve the state being left on the redo stack before returning the state to restore.
      const entry = undoStack.pop();
      if (!entry) return null;
      redoStack.push({ ...entry, state: current });
      return { state: entry.state, touched: entry.touched };
    },
    redo(current) {
      // Redo is the mirror image of undo: preserve the current state as the next undo target.
      const entry = redoStack.pop();
      if (!entry) return null;
      undoStack.push({ ...entry, state: current });
      return { state: entry.state, touched: entry.touched };
    },
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
}
