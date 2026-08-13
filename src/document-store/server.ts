// Authoritative state machine for one document session.
//
// This module coordinates command interpretation, validation, revisions, conflict checks, DocumentHistory,
// metadata, and snapshot publication. It is synchronous and transport-independent. Persistence I/O and
// protocol routing live outside it; only begin/complete/fail save transitions remain here because they alter
// authoritative saved-revision and shared save metadata.

import { assertValidHull } from "../core/invariants";
import {
  interpretDocumentCommand,
  applySessionCommand,
  commandSlices,
  rejected,
  requiresCurrentBase,
  SLICE,
  type DocumentCommand,
  type CommandOutcome,
  type SessionCommand,
  type SliceMask,
} from "../core/commands";
import { cloneHull, defaultHull, type HullState } from "../core/hull";
import {
  applyMetaCommand,
  initialSessionMeta,
  type SessionMeta,
} from "../core/meta";
import type { Model } from "../core/model";
import {
  assemble,
  defaultSession,
  initialSliceRevs,
  type SessionState,
  type SliceRevs,
} from "../core/runtime";
import type { SaveResult } from "./api";
import {
  createDocumentHistory,
  type DocumentHistory,
  type DocumentHistoryOptions,
  type HistoryTimeline,
} from "./history";
import type { PersistenceResult } from "./persistence/persistenceAdapter";
import type { DocumentSnapshot } from "./snapshot";

/** Server context wrapped around a transport-neutral domain command. */
export interface CommandRequest {
  readonly command: DocumentCommand;
  readonly author: string;
  readonly baseRevision?: number;
}

export interface RevisionAuthor {
  readonly revision: number;
  readonly author: string;
  readonly touched: SliceMask;
}

/** Immutable revision handed to SaveCoordinator; the token prevents stale completion. */
export interface SaveCapture {
  readonly token: string;
  readonly revision: number;
  readonly state: HullState;
  readonly model: Model;
  readonly currentId: string | null;
  readonly name: string;
  readonly create: boolean;
}

export interface DocumentStoreServer {
  snapshot(): DocumentSnapshot;
  subscribe(listener: (snapshot: DocumentSnapshot) => void): () => void;
  execute(request: CommandRequest): CommandOutcome;
  executeSession(command: SessionCommand): void;
  undo(author?: string): boolean;
  redo(author?: string): boolean;
  /**
   * Go straight to a kept moment, however far away in the history tree it is. One authoritative transition:
   * the states are absolute, so a jump across a branch costs no more than a single undo.
   */
  travel(id: number, author?: string): boolean;
  /**
   * The history tree, described. A read, not a transition: it is how a window can SHOW the history without
   * being given it, which is what keeps the tree — and the states in it — private to this authority.
   */
  timeline(): HistoryTimeline;
  setName(name: string): void;
  beginSave(name?: string): SaveCapture;
  completeSave(capture: SaveCapture, result: PersistenceResult): SaveResult;
  failSave(capture: SaveCapture): void;
}

export interface DocumentStoreServerOptions {
  readonly state?: HullState;
  readonly session?: SessionState;
  readonly meta?: SessionMeta;
  readonly savedRevision?: number;
  readonly history?: DocumentHistory;
  readonly historyOptions?: DocumentHistoryOptions;
}

const saveToken = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `save-${Math.random().toString(36).slice(2)}`;

const cloneMeta = (meta: SessionMeta): SessionMeta => ({
  ...meta,
  design: {
    ...meta.design,
    savedState: meta.design.savedState
      ? cloneHull(meta.design.savedState)
      : null,
  },
});

/** Authoritative, transport-independent state machine for one document session. */
export function createDocumentStoreServer(
  options: DocumentStoreServerOptions = {},
): DocumentStoreServer {
  // Canonical mutable references are replaced only after accepted transitions. Inputs are cloned so callers
  // cannot mutate server state behind its revision and publication machinery.
  let state = options.state ? cloneHull(options.state) : defaultHull();
  let session = options.session
    ? { ...options.session }
    : defaultSession(state);
  // Authored and session-only changes use separate clocks: moving the cut position must not dirty a design.
  let revision = 0;
  let sessionRevision = 0;
  let savedRevision = options.savedRevision ?? 0;
  let sliceRevs: SliceRevs = initialSliceRevs();
  let meta = options.meta ? cloneMeta(options.meta) : initialSessionMeta(state);
  let activeSaveToken: string | null = null;
  // History owns the tree and coalescing; the server owns installation, revision bumps, and publication. It
  // is planted with the opening state, so a window asking for the history before anything has been edited is
  // still shown the moment the session started from.
  const history =
    options.history ??
    createDocumentHistory({ ...options.historyOptions, initial: state });
  // Accepted revision authors are retained for overlapping-slice stale-command checks.
  const authors: RevisionAuthor[] = [];
  const listeners = new Set<(snapshot: DocumentSnapshot) => void>();
  const cacheKey = {};
  let current: DocumentSnapshot;

  // A few command semantics need derived pre-state values. This private cache is distinct from client caches.
  const runtime = (): Model =>
    assemble(state, session, { sliceRevs, cacheKey });

  // Slice clocks are durable memoization keys: unlike references, integers survive structuredClone.
  const bump = (touched: SliceMask): void => {
    sliceRevs = {
      plan: sliceRevs.plan + (touched & SLICE.plan ? 1 : 0),
      trim: sliceRevs.trim + (touched & SLICE.trim ? 1 : 0),
      transom: sliceRevs.transom + (touched & SLICE.transom ? 1 : 0),
      stations: sliceRevs.stations + (touched & SLICE.stations ? 1 : 0),
      scalars: sliceRevs.scalars + (touched & SLICE.scalars ? 1 : 0),
    };
  };

  // Publication is synchronous. SessionHost relies on subscribers broadcasting this snapshot before it sends
  // the request's outcome, and clients rely on that ordering when dispatch() resolves.
  const publish = (): void => {
    current = {
      revision,
      sessionRevision,
      sliceRevs,
      savedRevision,
      state,
      session,
      meta,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    };
    for (const listener of listeners) listener(current);
  };

  // All authored transitions, including undo and redo, pass through this one revision/publication boundary.
  const install = (
    next: HullState,
    touched: SliceMask,
    author: string,
  ): void => {
    state = next;
    revision++;
    authors.push({ revision, author, touched });
    bump(touched);
    publish();
  };

  publish();

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    execute(request) {
      // Structural commands use indices, so reject one only when another author changed an overlapping slice
      // after the base revision. An author's own queued commands remain valid.
      const baseRevision = request.baseRevision ?? revision;
      if (requiresCurrentBase(request.command) && baseRevision < revision) {
        const slices = commandSlices(request.command);
        const intervening = authors.find(
          (entry) =>
            entry.revision > baseRevision &&
            entry.author !== request.author &&
            (entry.touched & slices) !== 0,
        );
        if (intervening)
          return {
            rejected: `stale: revision ${intervening.revision} was written by another window`,
          };
      }

      // Domain interpretation is pure: no canonical state changes until its candidate has also validated.
      const outcome = interpretDocumentCommand(runtime(), request.command);
      if (rejected(outcome)) return outcome;
      try {
        assertValidHull(outcome.state, "document");
      } catch (error) {
        return {
          rejected: error instanceof Error ? error.message : String(error),
        };
      }

      // Record the pre-state before installing the candidate. A command may also adjust session bounds, but
      // only authored HullState belongs to snapshot-based undo history.
      const before = state;
      if (outcome.session) {
        session = { ...session, ...outcome.session };
        sessionRevision++;
      }
      history.record({
        before,
        after: outcome.state,
        touched: outcome.touched,
        command: request.command,
        author: request.author,
      });
      install(outcome.state, outcome.touched, request.author);
      return outcome;
    },
    executeSession(command) {
      // Session transitions publish on their own clock and deliberately create neither dirtiness nor history.
      const next = applySessionCommand(runtime(), session, command);
      if (next.x0 === session.x0 && next.viewLen === session.viewLen) return;
      session = next;
      sessionRevision++;
      publish();
    },
    undo(author = "history") {
      // History chooses the snapshot; install() makes its restoration an ordinary authoritative revision.
      const transition = history.undo();
      if (!transition) return false;
      install(transition.state, transition.touched, author);
      return true;
    },
    redo(author = "history") {
      const transition = history.redo();
      if (!transition) return false;
      install(transition.state, transition.touched, author);
      return true;
    },
    travel(id, author = "history") {
      // A jump is the same kind of transition as an undo, and goes through the same door: history names the
      // state and the slices the journey crossed, and install() makes it an ordinary authoritative revision.
      const transition = history.travel(id);
      if (!transition) return false;
      install(transition.state, transition.touched, author);
      return true;
    },
    timeline: () => history.timeline(),
    setName(name) {
      // Design identity is shared metadata, not authored hull geometry, so naming publishes without revision.
      const next = applyMetaCommand(meta, { type: "setName", name });
      if (next === meta) return;
      meta = next;
      publish();
    },
    beginSave(name) {
      // Capture first, then permit later commands to continue. The immutable capture remains the save target.
      if (activeSaveToken || meta.saving)
        throw new Error("a save is already in progress");
      const requested = (name ?? meta.name).trim();
      if (meta.design.currentId === null && !requested)
        throw new Error("a name is required to create a design");
      const create =
        meta.design.currentId === null ||
        (requested !== "" && requested !== meta.design.savedName);
      const finalName = create ? requested : meta.design.savedName!;
      const token = saveToken();
      activeSaveToken = token;
      meta = applyMetaCommand(meta, { type: "beginSave", name: finalName });
      const capture: SaveCapture = {
        token,
        revision,
        state,
        model: runtime(),
        currentId: meta.design.currentId,
        name: finalName,
        create,
      };
      publish();
      return capture;
    },
    completeSave(capture, result) {
      // Only the currently active token may change identity or savedRevision; late callbacks are rejected.
      if (activeSaveToken !== capture.token)
        throw new Error("save capture is no longer active");
      activeSaveToken = null;
      meta = applyMetaCommand(meta, {
        type: "completeSave",
        currentId: result.currentId,
        name: capture.name,
        savedState: cloneHull(capture.state),
      });
      // Newer edits are intentionally left dirty when an older in-flight revision completes.
      savedRevision = capture.revision;
      publish();
      return {
        revision: capture.revision,
        currentId: result.currentId,
        name: capture.name,
        created: result.created,
      };
    },
    failSave(capture) {
      // A failure only clears the matching interlock; stale failures cannot cancel a newer save.
      if (activeSaveToken !== capture.token) return;
      activeSaveToken = null;
      meta = applyMetaCommand(meta, { type: "failSave" });
      publish();
    },
  };
}
