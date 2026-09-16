import assert from "node:assert/strict";
import { defaultHull } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import {
  emptyBook,
  type CutField,
  type WeightBook,
} from "../src/core/sheet/book";
import { evaluateBook, resultAt } from "../src/core/sheet/evaluate";
import { createSectionMeasurer } from "../src/core/sheet/slices";
import { measureRepetition } from "../src/core/sheet/repetitions";
import {
  planWeightGeometry,
  resolveWeightGeometry,
  type WeightGeometryPlan,
} from "../src/editor/weightGeometryPlan";
import { createWeightGeometryResource } from "../src/editor/weightGeometryResource";
import { createWeightGeometryProcessor } from "../src/worker/weightGeometryComputation";
import type {
  WeightGeometryJob,
  WeightGeometryRequest,
  WeightGeometryResponse,
} from "../src/worker/weightGeometryProtocol";

const field: CutField = {
  k: "cut",
  shape: "transverse",
  pos: "2",
  unit: "m",
  boundaryEnabled: { topHeight: true },
  topHeight: "0.65",
};
const makeBook = (section: CutField): WeightBook => ({
  ...emptyBook(),
  items: [
    { id: "i", name: "frames", note: "", facets: {}, fields: { section } },
  ],
});
const planFor = (section: CutField) => {
  const book = makeBook(section);
  return planWeightGeometry(book, evaluateBook(book, null));
};
const exact = planFor(field);
assert.equal(exact.jobs.length, 1);
assert.deepEqual(exact.jobs[0].boundarySensitivities, []);
assert.equal(
  exact.jobs[0].kind === "cut" && exact.jobs[0].positionSensitivity,
  false,
);
const uncertain = planFor({ ...field, topHeight: "0.65 ± 0.01" });
assert.deepEqual(uncertain.jobs[0].boundarySensitivities, ["topHeight"]);
assert.notEqual(uncertain.jobs[0].key, exact.jobs[0].key);
assert.equal(
  planFor({ ...field, topHeight: "0.65 ± 0.02" }).jobs[0].key,
  uncertain.jobs[0].key,
  "uncertainty magnitude does not change geometry or slopes",
);
assert.notEqual(
  planFor({ ...field, pos: "2 ± 0.1" }).jobs[0].key,
  exact.jobs[0].key,
);
const invalid = planFor({ ...field, topHeight: "invalid" });
assert.equal(invalid.jobs.length, 0);
const duplicateBook = makeBook(field);
const duplicate: WeightBook = {
  ...duplicateBook,
  items: [{ ...duplicateBook.items[0], fields: { a: field, b: { ...field } } }],
};
const duplicates = planWeightGeometry(duplicate, evaluateBook(duplicate, null));
assert.equal(duplicates.jobs.length, 1);
assert.equal(duplicates.fields.length, 2);

const model = assemble(defaultHull()),
  sampling = computeHullSampling(model, 40, 4);
const process = createWeightGeometryProcessor(model, sampling);
const exactResponse = process(
  structuredClone({ key: "exact", jobs: exact.jobs }),
);
const exactValue = exactResponse.results[0].result;
assert.ok(exactValue.kind === "cut" && exactValue.value);
assert.deepEqual(exactValue.value.boundaryDerivatives, {});
assert.deepEqual(
  structuredClone(exactResponse),
  exactResponse,
  "worker payload must be plain cloneable data",
);
assert.equal(
  process({ key: "again", jobs: exact.jobs }).results[0].result,
  exactValue,
  "completed jobs are cached",
);
const uncertainResponse = process({ key: "uncertain", jobs: uncertain.jobs });
const uncertainValue = uncertainResponse.results[0].result;
assert.ok(uncertainValue.kind === "cut" && uncertainValue.value);
assert.equal(uncertainValue.value.area, exactValue.value.area);
assert.ok(uncertainValue.value.boundaryDerivatives!.topHeight!.area > 0);
const resolved = resolveWeightGeometry(
  uncertain,
  new Map(uncertainResponse.results.map((r) => [r.key, r.result])),
);
const uncertaintyResult = evaluateBook(
  makeBook({ ...field, topHeight: "0.65 ± 0.01" }),
  null,
  resolved.measurements,
);
assert.ok(
  resultAt(uncertaintyResult, "i", "section", "area")!.reading!.worst.hi > 0,
);
assert.equal(resolved.pending, false);
assert.equal(
  resolveWeightGeometry(
    uncertain,
    new Map(exactResponse.results.map((r) => [r.key, r.result])),
  ).measurements.size,
  0,
  "exact-input results cannot answer an uncertain-input request without sensitivities",
);

// Deterministic work-count regression: exact boundaries require only nominal
// quadrature. Placement uncertainty still runs, even when all inputs are exact.
const raw = createSectionMeasurer(model, sampling)("transverse", 2);
let calls = 0;
const counted = () => {
  calls++;
  return raw;
};
const limits = { topHeight: 0.65, bottomHeight: 0.3 };
const all = measureRepetition(counted, "transverse", 1, 3, 0.5, limits);
const allCalls = calls;
calls = 0;
const onlyNominal = measureRepetition(
  counted,
  "transverse",
  1,
  3,
  0.5,
  limits,
  [],
);
assert.ok(all.value && onlyNominal.value);
assert.deepEqual(onlyNominal.value.integrals, all.value.integrals);
assert.deepEqual(onlyNominal.value.phaseTotals, all.value.phaseTotals);
assert.ok(onlyNominal.value.phaseTotals!.length > 0);
assert.ok(
  calls < allCalls / 2,
  `${calls} exact-input evaluations vs ${allCalls} with sensitivities`,
);
assert.deepEqual(onlyNominal.value.boundaryDerivatives, {});

// A controllable worker verifies scheduling without running geometry inside the
// resource. This also exercises the same queue used by real dedicated workers.
class FakeWorker {
  onmessage: ((event: MessageEvent<WeightGeometryResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: WeightGeometryRequest[] = [];
  terminated = false;
  postMessage(request: WeightGeometryRequest) {
    this.posted.push(structuredClone(request));
  }
  terminate() {
    this.terminated = true;
  }
  reply(request: WeightGeometryRequest) {
    this.onmessage?.({
      data: {
        key: request.key,
        results: request.jobs.map((job) => ({
          key: job.key,
          result: exactValue,
        })),
      },
    } as unknown as MessageEvent<WeightGeometryResponse>);
  }
}
const worker = new FakeWorker();
let made = 0;
const resource = createWeightGeometryResource(() => {
  made++;
  return worker as unknown as Worker;
});
let notices = 0;
const unsubscribe = resource.subscribe(() => notices++);
const unsubscribeOther = resource.subscribe(() => {});
assert.equal(made, 0, "no worker or geometry during render/subscription");
resource.request(exact.jobs);
assert.equal(made, 1);
assert.equal(
  resource.getSnapshot().values.size,
  0,
  "posting is asynchronous, not a synchronous fallback",
);
resource.request(exact.jobs);
assert.equal(worker.posted.length, 1);
const middle = planFor({ ...field, topHeight: "0.7" });
const newest = planFor({ ...field, topHeight: "0.75" });
resource.request(middle.jobs);
resource.request(newest.jobs);
assert.equal(worker.posted.length, 1, "only one task in flight");
worker.reply(worker.posted[0]);
assert.equal(worker.posted.length, 2);
assert.equal(
  worker.posted[1].jobs[0].key,
  newest.jobs[0].key,
  "intermediate edits are dropped",
);
assert.equal(
  resolveWeightGeometry(newest, resource.getSnapshot().values).pending,
  true,
);
assert.equal(
  resolveWeightGeometry(newest, resource.getSnapshot().values).measurements
    .size,
  0,
  "late replies never masquerade as the newest cut",
);
worker.reply(worker.posted[1]);
assert.equal(
  resolveWeightGeometry(newest, resource.getSnapshot().values).pending,
  false,
);
resource.request(exact.jobs);
assert.equal(worker.posted.length, 2, "undo can reuse a cached result");
assert.equal(notices, 2);
unsubscribe();
await new Promise((r) => setTimeout(r, 5));
assert.equal(worker.terminated, false, "another panel still uses this worker");
unsubscribeOther();
await new Promise((r) => setTimeout(r, 5));
assert.equal(worker.terminated, true);
worker.reply(worker.posted[0]);
assert.equal(notices, 2, "messages from a disposed worker are ignored");

const undoWorker = new FakeWorker();
const undo = createWeightGeometryResource(
  () => undoWorker as unknown as Worker,
);
const stopUndo = undo.subscribe(() => {});
undo.request(exact.jobs);
undo.request(middle.jobs);
undo.request(exact.jobs);
undoWorker.reply(undoWorker.posted[0]);
assert.equal(
  undoWorker.posted.length,
  1,
  "undo to the running request cancels the obsolete queued edit",
);
stopUndo();
const failed = createWeightGeometryResource(() => {
  throw new Error("Workers disabled");
});
failed.request(exact.jobs);
assert.match(failed.getSnapshot().error!, /Workers disabled/);
assert.equal(failed.getSnapshot().values.size, 0);
const throwingWorker = new FakeWorker();
throwingWorker.postMessage = () => {
  throw new Error("clone failed");
};
const throwing = createWeightGeometryResource(
  () => throwingWorker as unknown as Worker,
);
throwing.request(exact.jobs);
assert.match(throwing.getSnapshot().error!, /clone failed/);
assert.equal(throwingWorker.terminated, true);

// Do not evict current fields when the book exceeds the historical cache budget.
const manyWorker = new FakeWorker();
const many = createWeightGeometryResource(
  () => manyWorker as unknown as Worker,
);
const stopMany = many.subscribe(() => {});
const jobs: WeightGeometryJob[] = Array.from({ length: 300 }, (_, i) => ({
  ...exact.jobs[0],
  key: String(i),
}));
const large: WeightGeometryPlan = {
  jobs,
  fields: jobs.map((job) => ({ key: job.key, job })),
};
many.request(jobs);
manyWorker.reply(manyWorker.posted[0]);
assert.equal(
  resolveWeightGeometry(large, many.getSnapshot().values).pending,
  false,
);
stopMany();
console.log(
  "Weight geometry: worker planning, selective sensitivities, caching, latest-only scheduling, stale replies, disposal and failure handling passed",
);

// A transport failure starting the queued task must survive publishing the
// successful reply to its predecessor (the queue starts next before publishing).
const nextFailsWorker = new FakeWorker();
const nextFails = createWeightGeometryResource(
  () => nextFailsWorker as unknown as Worker,
);
nextFails.request(exact.jobs);
nextFails.request(newest.jobs);
nextFailsWorker.postMessage = () => {
  throw new Error("queued clone failed");
};
nextFailsWorker.reply(nextFailsWorker.posted[0]);
assert.match(nextFails.getSnapshot().error!, /queued clone failed/);
assert.equal(nextFailsWorker.terminated, true);
