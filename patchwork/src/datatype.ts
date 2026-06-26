// ---------- the camber-hull datatype ----------
//
// A new Patchwork document holding a single-variant `HullDocument`. The default content is generated from
// camber's own built-in default model (the same hull the standalone editor opens with), so a freshly
// created document is immediately a valid, editable hull. `model.ts` / `json.ts` are pure (no DOM), so
// importing them here is safe in the host context where the datatype runs.

import { resetModel } from "../../src/model.js";
import { buildJson } from "../../src/json.js";
import type { DatatypeImplementation } from "./patchwork-types.js";
import type { CamberHullDoc } from "./types.js";

function defaultHull(): Omit<CamberHullDoc, "@patchwork" | "title"> {
  resetModel(); // populate the global model with camber's built-in default hull
  return JSON.parse(buildJson()); // serialize it as a single-variant HullDocument
}

export const CamberHullDatatype: DatatypeImplementation<CamberHullDoc> = {
  init(doc: CamberHullDoc) {
    doc["@patchwork"] = { type: "camber-hull" };
    doc.title = "Untitled Hull";
    const def = defaultHull();
    doc.length = def.length;
    doc.waterline = def.waterline;
    doc.deckRakeDeg = def.deckRakeDeg;
    doc.topology = def.topology;
    doc.variants = def.variants;
  },

  getTitle(doc: CamberHullDoc) {
    const variantName = doc.variants?.[0]?.name;
    return doc.title || variantName || "Untitled Hull";
  },

  setTitle(doc: CamberHullDoc, title: string) {
    doc.title = title;
  },

  markCopy(doc: CamberHullDoc) {
    doc.title = "Copy of " + this.getTitle(doc);
  },
};
