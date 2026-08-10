// ---------- the hull store: one owner, one reader per window ----------
//
// The owner is the single authority over the hull. It holds the authored state, the revisions, and the undo
// history, and it is the only thing that runs `applyCommand`. A reader — one per window — holds no hull at
// all: it forwards commands to the owner and reads back immutable snapshots.
//
//     dispatch(cmd) ──▶ owner: applyCommand → validate → bump revisions → publish
//                                     │
//                             Snapshot (plain data)
//                                     │
//              reader: snapshot() · subscribe() · runtime() = memoized assemble()
//
// The editor uses `workerStore` to reach this owner in a SharedWorker. `localStore` remains the transport-free
// reader used by the store tests. Both expose the same API, including asynchronous dispatch, so components do
// not know which side of a message boundary owns the hull.

import { assertValidHull } from "./invariants";
import {
  applyCommand,
  applySessionCommand,
  rejected,
  sameGesture,
  type HullCommand,
  type Outcome,
  type SessionCommand,
  type SliceMask,
  SLICE,
  commandSlices,
  requiresCurrentBase,
} from "./commands";
import { cloneHull, defaultHull, type HullState } from "./hull";
import type { Model } from "./model";
import {
  assemble,
  defaultSession,
  initialSliceRevs,
  type SessionState,
  type SliceRevs,
} from "./runtime";

export interface Snapshot {
  /** The document's total order. This is what `modelVersion` used to be, except that it means something. */
  readonly revision: number;
  /** `x0` and `viewLen` move on their own clock: scrubbing the cut station does not dirty the design. */
  readonly sessionRevision: number;
  readonly sliceRevs: SliceRevs;
  readonly savedRevision: number;
  readonly state: HullState;
  readonly session: SessionState;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export const isDirty = (s: Snapshot): boolean => s.revision !== s.savedRevision;

// ---------- the owner ----------

export interface RevisionAuthor {
  readonly revision: number;
  readonly author: string;
  readonly touched: SliceMask;
}

export interface HullOwner {
  dispatch(cmd: HullCommand, author: string, baseRevision?: number): Outcome;
  dispatchSession(cmd: SessionCommand): void;
  snapshot(): Snapshot;
  subscribe(fn: (s: Snapshot) => void): () => void;
  markSaved(revision: number): void;
  undo(author?: string): boolean;
  redo(author?: string): boolean;
}

// A hull is a few kB of numbers, so a snapshot stack is affordable and a command log is not needed — which is
// just as well, because commands are not replayable (see `commands.ts`).
const HISTORY_DEPTH = 200;
// Consecutive commands of the same gesture, by the same author, inside this window collapse into one undo
// step. Long enough that a drag is a single step; short enough that two deliberate nudges are two.
const COALESCE_MS = 400;

interface HistoryEntry {
  /** The hull as it was BEFORE the gesture — restoring this is what undo does. */
  state: HullState;
  /** Every slice the gesture touched, so undo bumps exactly those revisions and no more. */
  touched: SliceMask;
  cmd: HullCommand;
  author: string;
  at: number;
}

export interface OwnerOptions {
  state?: HullState;
  session?: SessionState;
  /** Injectable for tests; the coalescing window is the only thing that reads a clock. */
  now?: () => number;
}

export function createOwner(opts: OwnerOptions = {}): HullOwner {
  let state = opts.state ? cloneHull(opts.state) : defaultHull();
  let session = opts.session ?? defaultSession(state);
  let revision = 0,
    sessionRevision = 0,
    savedRevision = 0;
  let sliceRevs = initialSliceRevs();
  const undoStack: HistoryEntry[] = [],
    redoStack: HistoryEntry[] = [];
  const authors: RevisionAuthor[] = [];
  const listeners = new Set<(s: Snapshot) => void>();
  const now = opts.now ?? Date.now;
  // The owner needs an assembled model to hand `applyCommand` — `addStation` reads the loft, and the station
  // commands clamp against `viewLen`. Its own cache key, so a window's reader cache is never disturbed by it.
  const cacheKey = {};

  let current: Snapshot;
  const publish = (): void => {
    current = {
      revision,
      sessionRevision,
      sliceRevs,
      savedRevision,
      state,
      session,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    };
    for (const fn of listeners) fn(current);
  };
  const bump = (touched: SliceMask): void => {
    sliceRevs = {
      plan: sliceRevs.plan + (touched & SLICE.plan ? 1 : 0),
      trim: sliceRevs.trim + (touched & SLICE.trim ? 1 : 0),
      transom: sliceRevs.transom + (touched & SLICE.transom ? 1 : 0),
      stations: sliceRevs.stations + (touched & SLICE.stations ? 1 : 0),
      scalars: sliceRevs.scalars + (touched & SLICE.scalars ? 1 : 0),
    };
  };
  const runtime = (): Model =>
    assemble(state, session, { sliceRevs, cacheKey });
  publish();

  return {
    snapshot: () => current,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    dispatch(cmd, author, baseRevision = revision) {
      if (requiresCurrentBase(cmd) && baseRevision < revision) {
        const slices = commandSlices(cmd);
        const intervening = authors.find(
          (entry) =>
            entry.revision > baseRevision &&
            entry.author !== author &&
            (entry.touched & slices) !== 0,
        );
        if (intervening)
          return {
            rejected: `stale: revision ${intervening.revision} was written by another window`,
          };
      }
      const out = applyCommand(runtime(), cmd);
      if (rejected(out)) return out;
      // The check is at the DOCUMENT level, not the editor level, and deliberately so. A hull opened from a
      // file may sit outside what the edit operations would ever write — fewer control points, stations
      // packed tighter than U_GAP — and it is still a hull worth editing; validating each edit against the
      // stricter promise would refuse every command on such a hull rather than the one that broke something.
      // What must never become observable is a hull that cannot be drawn, and that is what this catches. The
      // editor-level promise is a property of the operations, and `test/hull-state.ts` is where it is proved.
      try {
        assertValidHull(out.state, "document");
      } catch (e) {
        return { rejected: e instanceof Error ? e.message : String(e) };
      }

      const before = state,
        t = now();
      state = out.state;
      if (out.session) session = { ...session, ...out.session };
      revision++;
      authors.push({ revision, author, touched: out.touched });
      if (out.session) sessionRevision++;
      bump(out.touched);

      // One undo step per gesture: a drag arrives as a stream of `movePlanPoint`s against one index, and they
      // collapse onto the entry holding the hull as it was when the drag began.
      const top = undoStack[undoStack.length - 1];
      if (
        top &&
        top.author === author &&
        t - top.at < COALESCE_MS &&
        sameGesture(top.cmd, cmd)
      ) {
        top.touched |= out.touched;
        top.cmd = cmd;
        top.at = t;
      } else {
        undoStack.push({
          state: before,
          touched: out.touched,
          cmd,
          author,
          at: t,
        });
        if (undoStack.length > HISTORY_DEPTH) undoStack.shift();
      }
      redoStack.length = 0;
      publish();
      return out;
    },

    // Session commands bump only `sessionRevision`, so scrubbing the cut station neither dirties the design
    // nor creates an undo step — which is exactly how it behaved before there was a store.
    dispatchSession(cmd) {
      const next = applySessionCommand(runtime(), session, cmd);
      if (next.x0 === session.x0 && next.viewLen === session.viewLen) return;
      session = next;
      sessionRevision++;
      publish();
    },

    undo(author = "history") {
      const entry = undoStack.pop();
      if (!entry) return false;
      redoStack.push({ ...entry, state });
      state = entry.state;
      revision++;
      authors.push({ revision, author, touched: entry.touched });
      bump(entry.touched);
      publish();
      return true;
    },
    redo(author = "history") {
      const entry = redoStack.pop();
      if (!entry) return false;
      undoStack.push({ ...entry, state });
      state = entry.state;
      revision++;
      authors.push({ revision, author, touched: entry.touched });
      bump(entry.touched);
      publish();
      return true;
    },

    // Dirty is `revision !== savedRevision` — exact, and free. It replaces comparing a freshly built JSON
    // string against the last saved one on a 300 ms poll.
    markSaved(at) {
      if (at < 0 || at > revision)
        throw new Error(`cannot mark unknown revision ${at} saved`);
      if (savedRevision === at) return;
      savedRevision = at;
      publish();
    },
  };
}

// ---------- the reader ----------

export interface HullStore {
  readonly sessionId?: string;
  readonly windowId?: string;
  snapshot(): Snapshot;
  subscribe(fn: () => void): () => void;
  /** The assembled model, memoized: its identity is stable while nothing this window reads has changed. */
  runtime(): Model;
  dispatch(cmd: HullCommand): Promise<Outcome>;
  dispatchSession(cmd: SessionCommand): void;
  undo(): void | Promise<boolean>;
  redo(): void | Promise<boolean>;
  markSaved(revision: number): void | Promise<void>;
  close?(): void;
}

/**
 * A reader over an owner in this same window. `dispatch` resolves in a microtask rather than returning
 * synchronously, so every call site is already written the way `workerStore` will need it.
 */
export function localStore(owner: HullOwner, author = "local"): HullStore {
  const cacheKey = {};
  let seen = owner.snapshot();
  let model = assemble(seen.state, seen.session, {
    sliceRevs: seen.sliceRevs,
    cacheKey,
  });
  const listeners = new Set<() => void>();
  owner.subscribe((s) => {
    seen = s;
    for (const fn of listeners) fn();
  });
  return {
    snapshot: () => seen,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Rebuilt only when a slice this window reads has moved; `assemble` returns the very same object when
    // nothing has, which is what keeps `useSyncExternalStore` from looping.
    runtime() {
      model = assemble(seen.state, seen.session, {
        sliceRevs: seen.sliceRevs,
        cacheKey,
      });
      return model;
    },
    dispatch: (cmd) => Promise.resolve(owner.dispatch(cmd, author)),
    dispatchSession: (cmd) => owner.dispatchSession(cmd),
    undo: () => void owner.undo(),
    redo: () => void owner.redo(),
    markSaved: (revision) => owner.markSaved(revision),
  };
}
