import { assemble } from "../core/runtime";
import { prepareBook } from "../core/sheet/evaluate";
import { createSamplingRun } from "../core/sheet/sampling";
import { createSectionMeasurer } from "../core/sheet/slices";
import { createTrialValueCache } from "../core/sheet/trialCache";
import { directTrialGeometry, prepareTrials } from "../core/sheet/trial";
import { createSamplingController } from "./samplingController";
import type { SamplingCommand, SamplingEvent } from "./samplingProtocol";

// The hook owns a worker per document/geometry context. A seed change discards
// trial worlds, while target changes reuse prepared formulas and upstream geometry.
let prepared: ReturnType<typeof prepareTrials> | null = null;
let geometry: ReturnType<typeof directTrialGeometry> | null = null;
let seed: number | null = null;
let evaluateCached: ReturnType<typeof createTrialValueCache> | null = null;
const process = createSamplingController(
  (command) => {
    if (!prepared) {
      prepared = prepareTrials(prepareBook(command.book));
      const section = createSectionMeasurer(
        assemble(command.hull),
        command.sampling,
      );
      geometry = directTrialGeometry(
        ({ shape, position, limits }) =>
          section(shape, position, limits).measures,
      );
    }
    if (seed !== command.request.seed || !evaluateCached) {
      seed = command.request.seed;
      evaluateCached = createTrialValueCache(
        prepared,
        geometry!,
        command.metrics,
      );
    }
    return createSamplingRun(
      command.request,
      prepared,
      geometry!,
      command.metrics,
      evaluateCached,
    );
  },
  (event: SamplingEvent) => {
    self.postMessage(event);
  },
);
self.onmessage = (event: MessageEvent<SamplingCommand>) => process(event.data);
