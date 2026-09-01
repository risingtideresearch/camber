// Thin mapping from the generic persistence DTOs to the existing Supabase REST functions. Document parsing,
// preview generation, revision capture, and save-state publication deliberately happen outside this adapter.

import { getDesign, insertDesign, updateDesign } from "../../core/supabase";
import type { PersistenceAdapter } from "./persistenceAdapter";

export const supabasePersistenceAdapter: PersistenceAdapter = {
  loadDesign: getDesign,
  async saveDesign(request) {
    if (request.create) {
      const { id, weightsStored } = await insertDesign(
        request.name,
        request.document,
        request.preview,
        request.weights,
      );
      return { currentId: id, created: true, weightsStored };
    }
    const { weightsStored } = await updateDesign(
      request.currentId!,
      request.document,
      request.preview,
      request.weights,
    );
    return { currentId: request.currentId!, created: false, weightsStored };
  },
};
