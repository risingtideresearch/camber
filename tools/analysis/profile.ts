// Node phase timings, not a browser/GPU benchmark.
// Usage: npx tsx tools/analysis/profile.ts examples/stls/cg40.stl 0.001
import { readFileSync } from "node:fs";
import { WorkspaceEngine } from "../../src/stl-workspace/engine";
import {
  DEFAULT_CONFIGURATION,
  placedReferences,
  type Inspection,
} from "../../src/stl-workspace/setup";
import type { Available, StabilityData } from "../../src/analysis/api";
const [path, scale] = process.argv.slice(2);
const metresPerUnit = Number(scale);
if (!path || !Number.isFinite(metresPerUnit) || metresPerUnit <= 0)
  throw new Error(
    "Usage: npx tsx tools/analysis/profile.ts <file.stl> <metres-per-STL-unit>",
  );
function timed<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(3)} s`);
  return result;
}
const buffer = readFileSync(path);
const engine = timed(
  "Parse",
  () =>
    new WorkspaceEngine(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
    ),
);
const initial = {
  ...DEFAULT_CONFIGURATION,
  metresPerUnit,
  frameConfirmed: true,
};
const preview = timed(
  "Preview",
  () => engine.run(initial, { type: "preview" }) as Inspection,
);
const c = {
  ...initial,
  ...placedReferences([0, 0, 0], preview.geometry!.bounds),
};
console.log(`${preview.geometry!.positions.length / 9} triangles`);
const inspection = timed(
  "Validate and automatically patch",
  () => engine.run(c, { type: "validate" }) as Inspection,
);
console.log(
  inspection.report?.envelopeError ??
    `${inspection.automaticPatches?.holes.length ?? 0} automatically sealed gaps`,
);
const query = {
  type: "query" as const,
  kind: "stability" as const,
  input: null,
};
const result = timed(
  "Build stability tables",
  () => engine.run(c, query) as Available<StabilityData>,
);
console.log(
  result.status === "available" ? "Stability available" : result.reason,
);
timed("Repeat stability (cached)", () => engine.run(c, query));
