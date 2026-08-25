// Durable-storage boundary. These DTOs contain storage-shaped data only: the adapter does not know about
// revisions, history, snapshots, or save lifecycle state. SessionHost parses loaded documents, while
// SaveCoordinator serializes server captures before calling saveDesign().

export interface LoadedDesign {
  readonly name: string;
  readonly documentText: string;
  /**
   * The weight sheet, stored in its own column beside the document. `null` for a design saved before the
   * sheet existed, or one that never had rows — a design without an estimate is the normal case, not an
   * error.
   */
  readonly weightsText: string | null;
}

export interface PersistDesignRequest {
  readonly currentId: string | null;
  readonly name: string;
  /** A pure `HullDocument`. The sheet is never folded into it — see `sessionDocument.ts`. */
  readonly document: string;
  /** The weight sheet, or `null` where there is nothing worth storing. */
  readonly weights: string | null;
  readonly preview: string;
  readonly create: boolean;
}

export interface PersistenceResult {
  readonly currentId: string;
  readonly created: boolean;
  /**
   * Whether the weight sheet reached the store.
   *
   * False only where the design HAD a sheet and the database has no column to put it in — a database that
   * predates the feature. The hull is saved either way: losing a hull edit over a missing column would be a
   * far worse trade than saving it and saying the estimate did not go with it.
   */
  readonly weightsStored: boolean;
}

/** Implemented by Supabase in production and lightweight fakes in store/host tests. */
export interface PersistenceAdapter {
  loadDesign(id: string): Promise<LoadedDesign>;
  saveDesign(request: PersistDesignRequest): Promise<PersistenceResult>;
}
