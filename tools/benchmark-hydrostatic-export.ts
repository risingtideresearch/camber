/** Node-side timings for the editor's presets, not a browser-worker benchmark.
 * Run: node --import tsx tools/benchmark-hydrostatic-export.ts [--fine]
 * Use --repeat=3 to compare medians across identical runs. */
import { performance } from "node:perf_hooks";
import { defaultHull } from "../src/core/hull";
import { buildHydrostaticTable } from "../src/core/hydrostaticExport";
import { computeHullSampling } from "../src/core/mesh";
import { assemble } from "../src/core/runtime";

const fine = process.argv.includes("--fine");
const repeatArg = process.argv.find((arg) => arg.startsWith("--repeat="));
const repeats = repeatArg ? Number(repeatArg.split("=")[1]) : 1;
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20)
  throw new Error("--repeat must be an integer from 1 to 20");
const model = assemble(defaultHull());
const options = {
  heelDeg: Array.from(
    { length: fine ? 145 : 73 },
    (_, i) => -180 + i * (fine ? 2.5 : 5),
  ),
  immersionSteps: fine ? 128 : 64,
  numSections: fine ? 400 : 240,
  girthSteps: fine ? 16 : 10,
};
const timings = [];
for (let run = 1; run <= repeats; run++) {
  const start = performance.now();
  const sampling = computeHullSampling(
    model,
    options.numSections,
    options.girthSteps,
  );
  const sampled = performance.now();
  const table = buildHydrostaticTable(model, options, undefined, sampling);
  const built = performance.now();
  const json = JSON.stringify(table, null, 2);
  const end = performance.now();
  const timing = {
    samplingMs: sampled - start,
    tableMs: built - sampled,
    jsonMs: end - built,
    totalMs: end - start,
  };
  timings.push(timing);
  console.log(
    JSON.stringify({
      preset: fine ? "fine" : "standard",
      run,
      ...timing,
      rows: table.table.rows.length,
      samples: table.table.rows.reduce((n, r) => n + r.samples.length, 0),
      bytes: Buffer.byteLength(json),
    }),
  );
}
if (repeats > 1) {
  const median = (values: number[]) => {
    const sorted = values.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  console.log(
    JSON.stringify({
      preset: fine ? "fine" : "standard",
      median: Object.fromEntries(
        (["samplingMs", "tableMs", "jsonMs", "totalMs"] as const).map((key) => [
          key,
          median(timings.map((t) => t[key])),
        ]),
      ),
    }),
  );
}
