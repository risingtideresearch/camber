import type { Model } from "../core/model";
import { parseDocument } from "../core/json";
import type { DesignRow } from "../core/supabase";

// A design's control-point counts (and length): shown as stat chips on its card, and used to gate blending.
export interface Topo {
  length: number;
  plan: number;
  trim: number;
  section: number;
  templates: number;
}

// parseDocument infers the counts from the document's arrays (and migrates legacy docs). Returns null if the
// document can't be parsed — the card then shows no chips and is never blend-compatible. The passed model is
// scratch (parseDocument decodes into it), so this is safe to call repeatedly for the whole list.
export function topoOf(model: Model, row: DesignRow): Topo | null {
  try {
    const p = parseDocument(model, JSON.stringify(row.document));
    return {
      length: p.length,
      plan: p.topology.sheerPlan,
      trim: p.topology.sheerTrim,
      section: p.topology.section,
      templates: p.topology.templateCount,
    };
  } catch {
    return null;
  }
}
