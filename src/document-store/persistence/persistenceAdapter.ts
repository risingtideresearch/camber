// Durable-storage boundary. These DTOs contain storage-shaped data only: the adapter does not know about
// revisions, history, snapshots, or save lifecycle state. SessionHost parses loaded documents, while
// SaveCoordinator serializes server captures before calling saveDesign().

export interface LoadedDesign {
  readonly name: string;
  readonly documentText: string;
}

export interface PersistDesignRequest {
  readonly currentId: string | null;
  readonly name: string;
  readonly document: string;
  readonly preview: string;
  readonly create: boolean;
}

export interface PersistenceResult {
  readonly currentId: string;
  readonly created: boolean;
}

/** Implemented by Supabase in production and lightweight fakes in store/host tests. */
export interface PersistenceAdapter {
  loadDesign(id: string): Promise<LoadedDesign>;
  saveDesign(request: PersistDesignRequest): Promise<PersistenceResult>;
}
