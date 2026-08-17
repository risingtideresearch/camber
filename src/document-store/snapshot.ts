// The complete structured-cloneable read model published by a DocumentStoreServer.
// Whole snapshots are intentionally small enough to transport on every accepted transition. Derived
// samplers and geometry are excluded; each DocumentStoreClient assembles those in its own window.

import type { HullState } from "../core/hull";
import type { SessionMeta } from "../core/meta";
import type { SessionState, SliceRevs } from "../core/runtime";

export interface DocumentSnapshot {
  /** Total order of authored document transitions, including undo and redo. */
  readonly revision: number;
  /** Separate clock for shared, non-persisted session values such as the cut position. */
  readonly sessionRevision: number;
  /** Fine-grained cache keys which survive structured cloning. */
  readonly sliceRevs: SliceRevs;
  /** Exact authored revision captured by the most recently completed save. */
  readonly savedRevision: number;
  readonly state: HullState;
  readonly session: SessionState;
  readonly meta: SessionMeta;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export const isDirty = (snapshot: DocumentSnapshot): boolean =>
  snapshot.revision !== snapshot.savedRevision;
