// Application service joining authoritative save state to external persistence.
//
// The server captures and finalizes revisions; the adapter performs I/O. Keeping this orchestration between
// them means the server never imports Supabase and the adapter never controls revisions or shared save status.

import { buildJson } from "../core/json";
import { buildPreviewSvg } from "../core/preview";
import type { SaveResult } from "./api";
import type { PersistenceAdapter } from "./persistence/persistenceAdapter";
import type { DocumentStoreServer } from "./server";

/** Coordinates authoritative save transitions around persistence I/O. */
export class SaveCoordinator {
  constructor(private readonly persistence: PersistenceAdapter) {}

  async save(server: DocumentStoreServer, name?: string): Promise<SaveResult> {
    // beginSave synchronously publishes `saving` and freezes the exact immutable revision to serialize.
    const capture = server.beginSave(name);
    try {
      // Build both persisted artifacts from the same capture, even if newer commands arrive while I/O waits.
      const result = await this.persistence.saveDesign({
        currentId: capture.currentId,
        name: capture.name,
        document: buildJson(capture.state),
        preview: buildPreviewSvg(capture.model),
        create: capture.create,
      });
      // Completion marks capture.revision saved, not whichever revision is current now.
      return server.completeSave(capture, result);
    } catch (error) {
      // Serialization failures and adapter failures both release the shared save interlock.
      server.failSave(capture);
      throw error;
    }
  }
}
