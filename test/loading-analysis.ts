import assert from "node:assert/strict";
import { defaultHull } from "../src/core/hull";
import { defaultSession, initialSliceRevs } from "../src/core/runtime";
import { emptyBook } from "../src/core/sheet/book";
import { createLoadingAnalysisResource } from "../src/editor/loadingAnalysisResource";
import type {
  LoadingBatchRequest,
  LoadingBatchResponse,
  LoadingProposal,
} from "../src/worker/loadingComputation";

class FakeWorker {
  onmessage: ((event: MessageEvent<LoadingBatchResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: LoadingBatchRequest[] = [];
  terminated = false;
  postMessage(request: LoadingBatchRequest) {
    this.posted.push(structuredClone(request));
  }
  terminate() {
    this.terminated = true;
  }
  reply(response: LoadingBatchResponse) {
    this.onmessage?.({ data: response } as MessageEvent<LoadingBatchResponse>);
  }
}
const state = defaultHull();
const request: LoadingBatchRequest = {
  key: "first",
  state,
  session: defaultSession(state),
  sliceRevs: initialSliceRevs(),
  numSections: 40,
  girthSteps: 4,
  purpose: "compare-scenarios",
  constraints: { trim: null, heel: null },
  entries: [
    { id: "shared", book: emptyBook() },
    { id: "crew", book: emptyBook() },
  ],
};
const proposal: LoadingProposal = {
  waterline: 550,
  deckTrim: 0,
  heel: 0,
  volumeError: 0,
  balanceError: 0,
  transverseBalanceError: 0,
  values: { mass: 2000, lcg: 2, vcg: 0.5, tcg: 0 },
  iterations: 1,
};
const wait = () => new Promise((resolve) => setTimeout(resolve, 10));
const workers: FakeWorker[] = [];
const resource = createLoadingAnalysisResource(() => {
  const worker = new FakeWorker();
  workers.push(worker);
  return worker as unknown as Worker;
}, 0);
let notices = 0;
const unsubscribe = resource.subscribe(() => notices++);
assert.equal(workers.length, 0, "subscribing/rendering never starts work");
resource.request(request);
assert.equal(workers.length, 0, "automatic calculation is debounced");
assert.equal(resource.getSnapshot().results.size, 0);
resource.request({ ...request, key: "second" });
await wait();
assert.equal(
  workers.length,
  1,
  "intermediate edits are dropped before work starts",
);
const first = workers[0];
assert.equal(first.posted[0].key, "second");
resource.request({ ...request, key: "second" });
assert.equal(
  first.posted.length,
  1,
  "same physical key does not recompute for display changes",
);
first.reply({ key: "first", id: "shared", proposal });
first.reply({ key: "second", id: "unknown", proposal });
assert.equal(
  resource.getSnapshot().results.size,
  0,
  "unexpected/obsolete responses are ignored",
);
first.reply({ key: "second", id: "shared", proposal });
assert.equal(
  resource.getSnapshot().results.size,
  1,
  "a row is published without waiting for the whole batch",
);
assert.equal(first.terminated, false);
resource.request({
  ...request,
  key: "third",
  constraints: { trim: 0, heel: null },
});
assert.equal(
  first.terminated,
  true,
  "input edits immediately cancel expensive obsolete work",
);
assert.equal(resource.getSnapshot().key, "third");
assert.equal(
  resource.getSnapshot().results.size,
  0,
  "old values are cleared, not relabelled as current",
);
first.reply({ key: "second", id: "crew", proposal });
assert.equal(resource.getSnapshot().results.size, 0);
await wait();
const second = workers[1];
second.reply({ key: "third", id: "crew", error: "TCG missing" });
second.reply({ key: "third", id: "shared", proposal });
assert.equal(
  resource.getSnapshot().results.size,
  2,
  "errors and valid results coexist",
);
assert.equal(second.terminated, true, "completed private workers are disposed");
const beforeLate = notices;
second.reply({ key: "third", id: "shared", error: "late" });
assert.equal(notices, beforeLate);
resource.request({ ...request, key: "fourth" });
resource.cancel();
await wait();
assert.equal(workers.length, 2, "unmount cancels a scheduled computation");
resource.request(null);
assert.equal(resource.getSnapshot().key, null);
assert.equal(resource.getSnapshot().results.size, 0);
unsubscribe();

const unavailable = createLoadingAnalysisResource(() => {
  throw new Error("Workers disabled");
}, 0);
unavailable.request(request);
await wait();
assert.equal(unavailable.getSnapshot().results.size, 2);
for (const result of unavailable.getSnapshot().results.values())
  assert.ok("error" in result && /Workers disabled/.test(result.error));
unavailable.cancel();

const failingWorker = new FakeWorker();
const failing = createLoadingAnalysisResource(
  () => failingWorker as unknown as Worker,
  0,
);
failing.request(request);
await wait();
failingWorker.reply({ key: request.key, id: "shared", proposal });
failingWorker.onerror?.({ message: "worker failed" } as ErrorEvent);
assert.ok(
  "proposal" in failing.getSnapshot().results.get("shared")!,
  "a later worker error preserves completed rows",
);
assert.deepEqual(failing.getSnapshot().results.get("crew"), {
  error: "worker failed",
});
assert.equal(failingWorker.terminated, true);
failing.cancel();
console.log(
  "Automatic loading: debounce, cancellation, stale-response isolation, streaming, failures and cleanup passed.",
);
