// Backend package for one owner-captured save. It is transport-independent: SharedWorker session hosts and
// local stores use the same interface and the same Supabase implementation.

import { buildJson } from "./json";
import { buildPreviewSvg } from "./preview";
import { insertDesign, updateDesign } from "./supabase";
import type { SaveCapture } from "./store";

export interface SaveBackendResult {
  readonly currentId: string;
  readonly created: boolean;
}

export interface SaveBackend {
  save(capture: SaveCapture): Promise<SaveBackendResult>;
}

export const supabaseSaveBackend: SaveBackend = {
  async save(capture) {
    // Both products come from the immutable runtime captured at one revision.
    const document = buildJson(capture.state);
    const preview = buildPreviewSvg(capture.model);
    if (capture.create) {
      return {
        currentId: await insertDesign(capture.name, document, preview),
        created: true,
      };
    }
    await updateDesign(capture.currentId!, document, preview);
    return { currentId: capture.currentId!, created: false };
  },
};
