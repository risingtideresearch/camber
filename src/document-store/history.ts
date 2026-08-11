// Snapshot-based undo/redo policy for one document session.
//
// DocumentHistory owns stack mechanics, depth limits, and gesture coalescing. It deliberately does not
// install states, increment revisions, validate hulls, or publish snapshots; DocumentStoreServer performs
// those authoritative operations around the transitions returned here.

import {
  describeCommand,
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

// ---------- the stacks, described ----------
// What a reader can be told about history without being handed it. A step names a gesture and says who made
// it and when; the HullState it would restore stays here, because it is large, private to the authority, and
// no use to a reader anyway — travelling to a step is undo / redo, not installing a state from outside.

export interface HistoryStep {
  /** Stable identity, in the order the gestures were recorded. Survives moving between the stacks. */
  readonly seq: number;
  readonly kind: DocumentCommand["type"];
  /** `describeCommand` of the gesture as it last stood — a coalesced drag reads as its final move. */
  readonly label: string;
  /** The window that made the edit (its windowId), so a timeline shows who did what. */
  readonly author: string;
  readonly at: number;
  readonly touched: SliceMask;
}

export interface HistoryTimeline {
  /** Applied gestures, oldest first. The last is the one `undo` would take back. */
  readonly done: readonly HistoryStep[];
  /** Undone gestures, in the order `redo` would put them back. */
  readonly undone: readonly HistoryStep[];
  /** The depth cap. `done.length === depth` means older steps have already been dropped. */
  readonly depth: number;
}

export interface DocumentHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  record(record: HistoryRecord): void;
  undo(current: HullState): HistoryTransition | null;
  redo(current: HullState): HistoryTransition | null;
  /** A transportable description of both stacks. Holds no HullState, so it is cheap to send to a window. */
  timeline(): HistoryTimeline;
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
// `seq` is the gesture's identity rather than its position: the stacks reorder and shift, so a reader needs
// something that does not move under it between one look at the timeline and the next.
interface Entry {
  seq: number;
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
  let nextSeq = 1;

  const step = (entry: Entry): HistoryStep => ({
    seq: entry.seq,
    kind: entry.command.type,
    label: describeCommand(entry.command),
    author: entry.author,
    at: entry.at,
    touched: entry.touched,
  });

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
          seq: nextSeq++,
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
    timeline() {
      // `undone` is the redo stack read from the top down: undo pushes the newest gesture first, so the LAST
      // element is the oldest undone gesture and therefore the next one redo would put back. Reversing it
      // puts the whole timeline — done then undone — into one document order the reader can follow.
      return {
        done: undoStack.map(step),
        undone: redoStack.map(step).reverse(),
        depth,
      };
    },
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
}
