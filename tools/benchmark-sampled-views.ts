/** Repeatable large-sheet benchmark: npm run bench:sampled-views.
 * Memory is a Node heap estimate, not a browser-worker measurement. */
import { prepareBook } from "../src/core/sheet/evaluate";
import {
  createSamplingRun,
  type SamplingRequest,
} from "../src/core/sheet/sampling";
import { prepareTrials, type TrialGeometry } from "../src/core/sheet/trial";
import { createTrialValueCache } from "../src/core/sheet/trialCache";
import { createSamplingController } from "../src/worker/samplingController";
import type {
  SamplingCommand,
  SamplingEvent,
} from "../src/worker/samplingProtocol";
import { comparisonFixtures } from "../test/sampling-fixtures";

const fixture = comparisonFixtures().find(
  (item) => item.name === "large-formula-book",
)!;
const plan = prepareTrials(prepareBook(fixture.book));
let peakWorlds = 0;
const noGeometry: TrialGeometry = {
  section: () => {
    throw new Error("Formula fixture has no geometry");
  },
  layout: () => {
    throw new Error("Formula fixture has no geometry");
  },
};
const evaluate = createTrialValueCache(plan, noGeometry, null, 1024, (size) => {
  peakWorlds = Math.max(peakWorlds, size);
});
// This fixture uses only formulas; no section geometry is requested.
const queue: (() => void)[] = [];
const finished: SamplingEvent[] = [];
const dispatch = createSamplingController(
  (command) =>
    createSamplingRun(command.request, plan, undefined, null, evaluate),
  (event) => {
    if (
      event.kind === "snapshot" &&
      event.result.execution.status === "finished"
    )
      finished.push(event);
  },
  (callback) => queue.push(callback),
);
const request = (id: string, cellKey: string): SamplingCommand => ({
  type: "start",
  book: fixture.book,
  hull: {} as Extract<SamplingCommand, { type: "start" }>["hull"],
  sampling: {} as Extract<SamplingCommand, { type: "start" }>["sampling"],
  metrics: null,
  request: {
    runId: id,
    context: {
      bookRevision: "large",
      hullRevision: "large",
      geometrySettingsRevision: "large",
    },
    seed: 12345,
    checkpoints: [64, 256, 1024],
    targets: [{ cellKey, dim: null, nominal: { value: 0 } }],
  } satisfies SamplingRequest,
});
const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const baseline = process.memoryUsage().heapUsed;
const started = performance.now();
dispatch(request("summary", fixture.targets[0]));
queue.shift()!(); // Navigate before the first report is complete.
dispatch(request("part", fixture.targets[0].replace("result", "part50")));
let peakHeap = process.memoryUsage().heapUsed;
while (queue.length) {
  queue.shift()!();
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
}
gc?.();
console.log(
  JSON.stringify(
    {
      fixture: fixture.name,
      fields: plan.prepared.cells.size,
      trialsPerView: 1024,
      views: 2,
      wallMs: Math.round(performance.now() - started),
      workerEvaluation: finished.map((event) =>
        event.kind === "snapshot"
          ? {
              view: event.result.runId,
              elapsedMs: Math.round(event.result.progress.elapsedMs),
            }
          : null,
      ),
      peakCachedWorlds: peakWorlds,
      heapBaselineMiB: +(baseline / 1048576).toFixed(1),
      heapRetainedMiB: +(
        (process.memoryUsage().heapUsed - baseline) /
        1048576
      ).toFixed(1),
      heapPeakAboveBaselineMiB: +((peakHeap - baseline) / 1048576).toFixed(1),
    },
    null,
    2,
  ),
);
