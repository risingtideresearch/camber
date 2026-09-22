/** Small joint-input experiment; a JSON trial can be saved and replayed separately. */
import { readFileSync } from "node:fs";
import { prepareBook } from "../src/core/sheet/evaluate";
import {
  evaluateTrial,
  prepareTrials,
  type Trial,
} from "../src/core/sheet/trial";
import { generateTrial } from "../test/generate-trials";
import { mixedTrialBook, mixedTrialGeometry } from "../test/trial-fixtures";
import { sampleStatistics } from "../test/compare-sampling";
import { target } from "../test/sampling-fixtures";
const plan = prepareTrials(prepareBook(mixedTrialBook())),
  geometry = mixedTrialGeometry();
if (process.argv[2] === "--replay") {
  const trial = JSON.parse(readFileSync(process.argv[3], "utf8")) as Trial;
  const result = evaluateTrial(plan, trial, geometry);
  console.log(
    JSON.stringify(
      {
        trial,
        values: Object.fromEntries(result.values),
        requests: Object.fromEntries(result.requests),
      },
      null,
      2,
    ),
  );
} else {
  const count = Number(process.argv[2] ?? 1024),
    seed = Number(process.argv[3] ?? 12345);
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("Expected a positive trial count");
  const names = ["total", "cg", "cutMass"];
  const samples = names.map(() => [] as number[]),
    failures = names.map(() => new Map<string, number>());
  const firstTrial = generateTrial(plan, seed, 0);
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const result = evaluateTrial(plan, generateTrial(plan, seed, i), geometry);
    names.forEach((name, j) => {
      const cell = result.values.get(target(name))!;
      if (cell.error || cell.value === null) {
        const error = cell.error ?? "missing value";
        failures[j].set(error, (failures[j].get(error) ?? 0) + 1);
      } else samples[j].push(cell.value);
    });
  }
  console.log(
    JSON.stringify(
      {
        fixture:
          "two repetitions + cut; shared uncertain materials, extent, pitch and trimming",
        geometry: "analytic deterministic sections",
        generator: "keyed-uniform-v1",
        count,
        seed,
        firstTrial,
        elapsedMs: performance.now() - started,
        outputs: names.map((name, j) => ({
          name,
          invalid: count - samples[j].length,
          failures: Object.fromEntries(failures[j]),
          statistics: sampleStatistics(samples[j], 0),
          rmsReference: "zero, not continuous nominal",
        })),
      },
      null,
      2,
    ),
  );
}
