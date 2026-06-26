// ---------- Patchwork module entry ----------
//
// Exports the `plugins` array the Patchwork host loads: the `camber-hull` datatype and the editor tool
// that opens it. The implementations are loaded lazily via `load()`, matching the host's plugin contract.

import type { Plugin } from "./patchwork-types.js";
import type { CamberHullDoc } from "./types.js";
import { CamberHullDatatype } from "./datatype.js";
import { CamberHullTool } from "./tool.js";

// The implementations are bundled into this single module file, so `load()` simply resolves the already-
// imported values (none touch the DOM at import time, so this is safe to evaluate when the host reads the
// plugin list).
export const plugins: Plugin<CamberHullDoc>[] = [
  {
    type: "patchwork:datatype",
    id: "camber-hull",
    name: "Camber Hull",
    icon: "Sailboat",
    async load() {
      return CamberHullDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "camber-hull",
    name: "Camber",
    icon: "Sailboat",
    supportedDatatypes: ["camber-hull"],
    async load() {
      return CamberHullTool;
    },
  },
];
