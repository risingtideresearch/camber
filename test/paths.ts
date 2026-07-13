// Shared path helper for the tests: the example hulls live alongside the repo; resolve from this file
// so the cwd does not matter.

import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

export function examplesDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 4; up++) {
    const cand = join(d, "examples");
    if (existsSync(cand)) return cand;
    d = dirname(d);
  }
  return join(process.cwd(), "examples");
}
