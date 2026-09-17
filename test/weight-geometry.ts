import assert from "node:assert/strict";
import { defaultHull } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import {
  emptyBook,
  type CutField,
  type RepetitionField,
  type WeightBook,
} from "../src/core/sheet/book";
import { roleTotals } from "../src/core/sheet/rollups";
import { plotPoints } from "../src/editor/weight/pointPlots";
import { showSpread } from "../src/editor/weight/weightFormat";
import { uncertaintyPending } from "../src/worker/weightGeometryProtocol";
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

// Two-pass geometry: publish nominal values before computing spreads. The
// completion reuses integration/endpoints/previews, not just plane intersections.
let stagedCalls = 0;
const stagedMeasure = () => {
  stagedCalls++;
  return raw;
};
const nominalCore = measureRepetition(
  stagedMeasure,
  "transverse",
  1,
  3,
  undefined,
  limits,
  [],
);
assert.ok(nominalCore.value);
assert.equal(stagedCalls, 121);
const completionCore = measureRepetition(
  stagedMeasure,
  "transverse",
  1,
  3,
  0.5,
  limits,
  [],
  nominalCore.value,
);
assert.deepEqual(completionCore, onlyNominal);
assert.equal(stagedCalls, calls, "two passes do no extra section evaluations");

const repetition: RepetitionField = {
  k: "repetition",
  shape: "transverse",
  unit: "m",
  start: "1",
  end: "3",
  repetition: "count",
  count: "4",
  spacing: "",
  boundaryEnabled: { topHeight: true },
  topHeight: "0.65 ± 0.01",
};
const densityBook: WeightBook = {
  ...emptyBook(),
  outputs: { DISPLACEMENT: "frames.weight" },
  items: [
    {
      id: "i",
      name: "frames",
      note: "",
      facets: {},
      fields: {
        section: repetition,
        density: {
          k: "scalar",
          formula: "2 ± 0.1",
          unit: "kg / m",
          role: null,
        },
        weight: {
          k: "scalar",
          formula: "section.openLength * density",
          unit: "kg",
          role: "MASS",
        },
        cg: {
          k: "point",
          x: "",
          y: "",
          z: "",
          from: "section.openLengthCg",
          unit: "m",
          role: "CG",
        },
      },
    },
  ],
};
const stagedPlan = planWeightGeometry(
  densityBook,
  evaluateBook(densityBook, null),
);
const stagedProcess = createWeightGeometryProcessor(model, sampling);
const stage1 = stagedProcess({
  key: "nominal",
  phase: "nominal",
  jobs: stagedPlan.jobs,
});
const nominalResult = stage1.results[0].result;
assert.equal(uncertaintyPending(nominalResult), true);
assert.ok(nominalResult.kind === "repetition" && nominalResult.result.value);
assert.equal(nominalResult.result.value.phaseTotals, undefined);
const nominalGeometry = resolveWeightGeometry(
  stagedPlan,
  new Map(stage1.results.map((r) => [r.key, r.result])),
);
assert.equal(nominalGeometry.pending, false);
assert.equal(nominalGeometry.uncertaintyPending, true);
const nominalBook = evaluateBook(
  densityBook,
  null,
  nominalGeometry.measurements,
  nominalGeometry.repetitions,
);
assert.equal(nominalBook.uncertaintyPending, true);
assert.deepEqual(
  plotPoints(densityBook.items, nominalBook, "worst")[0].xz,
  [],
  "no incomplete CG uncertainty band",
);
assert.ok(nominalBook.outputs.displacement);
assert.equal(nominalBook.outputs.displacement.uncertaintyPending, true);
assert.equal(showSpread(nominalBook.outputs.displacement, 1, "worst"), "…");
assert.equal(resultAt(nominalBook, "i", "weight")!.error, null);
assert.equal(resultAt(nominalBook, "i", "cg", "x")!.error, null);
assert.equal(
  roleTotals(densityBook.items, nominalBook).get("MASS")!.readings.value!
    .uncertaintyPending,
  true,
);

const stage2 = stagedProcess({
  key: "complete",
  phase: "complete",
  jobs: stagedPlan.jobs,
});
const finalResult = stage2.results[0].result;
assert.equal(uncertaintyPending(finalResult), false);
const singlePass = createWeightGeometryProcessor(
  model,
  sampling,
)({ key: "single", jobs: stagedPlan.jobs });
assert.deepEqual(
  stage2.results,
  singlePass.results,
  "two-pass final geometry exactly matches single-pass geometry",
);
const finalGeometry = resolveWeightGeometry(
  stagedPlan,
  new Map(stage2.results.map((r) => [r.key, r.result])),
);
const finalBook = evaluateBook(
  densityBook,
  null,
  finalGeometry.measurements,
  finalGeometry.repetitions,
);
assert.ok(finalBook.outputs.displacement);
assert.equal(
  finalBook.outputs.displacement.v,
  nominalBook.outputs.displacement.v,
);
assert.equal(finalBook.uncertaintyPending, undefined);
assert.ok(plotPoints(densityBook.items, finalBook, "worst")[0].xz.length > 0);
assert.ok(finalBook.outputs.displacement.worst.hi > 0);
assert.equal(
  resultAt(finalBook, "i", "cg", "x")!.reading!.v,
  resultAt(nominalBook, "i", "cg", "x")!.reading!.v,
);
assert.equal(
  stagedProcess({ key: "undo", phase: "nominal", jobs: stagedPlan.jobs })
    .results[0].result,
  finalResult,
  "a cached final answer bypasses both phases",
);

// Cuts with uncertain position/boundaries also produce usable nominal formulas.
const cutBook = makeBook({
  ...field,
  pos: "2 ± 0.01",
  topHeight: "0.65 ± 0.01",
});
const cutPlan = planWeightGeometry(cutBook, evaluateBook(cutBook, null));
const cutProcess = createWeightGeometryProcessor(model, sampling);
const cutNominal = cutProcess({
  key: "cut-nominal",
  phase: "nominal",
  jobs: cutPlan.jobs,
});
const cutGeometry = resolveWeightGeometry(
  cutPlan,
  new Map(cutNominal.results.map((r) => [r.key, r.result])),
);
const cutReadings = evaluateBook(cutBook, null, cutGeometry.measurements);
assert.equal(resultAt(cutReadings, "i", "section", "area")!.error, null);
assert.equal(
  resultAt(cutReadings, "i", "section", "area")!.reading!.uncertaintyPending,
  true,
);
assert.deepEqual(
  cutProcess({ key: "cut-complete", phase: "complete", jobs: cutPlan.jobs })
    .results,
  createWeightGeometryProcessor(
    model,
    sampling,
  )({ key: "cut-single", jobs: cutPlan.jobs }).results,
);

class StagedWorker extends FakeWorker {
  respond(
    request: WeightGeometryRequest,
    result = request.phase === "nominal" ? nominalResult : finalResult,
  ) {
    this.onmessage?.({
      data: {
        key: request.key,
        results: request.jobs.map((job) => ({ key: job.key, result })),
      },
    } as unknown as MessageEvent<WeightGeometryResponse>);
  }
}
const stagedWorker = new StagedWorker();
const staged = createWeightGeometryResource(
  () => stagedWorker as unknown as Worker,
);
const observed: boolean[] = [];
const stopStaged = staged.subscribe(() =>
  observed.push(
    resolveWeightGeometry(stagedPlan, staged.getSnapshot().values)
      .uncertaintyPending,
  ),
);
staged.request(stagedPlan.jobs);
assert.equal(stagedWorker.posted[0].phase, "nominal");
stagedWorker.respond(stagedWorker.posted[0]);
assert.deepEqual(
  observed,
  [true],
  "nominal snapshot is published before completion arrives",
);
assert.equal(stagedWorker.posted[1].phase, "complete");
staged.request(stagedPlan.jobs);
assert.equal(
  stagedWorker.posted.length,
  2,
  "re-render cannot duplicate completion",
);
stagedWorker.respond(stagedWorker.posted[1]);
assert.deepEqual(observed, [true, false]);
staged.request(stagedPlan.jobs);
assert.equal(stagedWorker.posted.length, 2);
stopStaged();

// A changed input must get a new nominal pass, not completion of the obsolete
// request. A late completion remains useful only under its original exact key.
const editedJobs = stagedPlan.jobs.map((job) => ({
  ...job,
  key: `${job.key}:edited`,
}));
const editedPlan = {
  jobs: editedJobs,
  fields: [{ key: "i section", job: editedJobs[0] }],
};
const editWorker = new StagedWorker();
const edits = createWeightGeometryResource(
  () => editWorker as unknown as Worker,
);
edits.request(stagedPlan.jobs);
edits.request(editedJobs);
editWorker.respond(editWorker.posted[0]);
assert.equal(editWorker.posted[1].phase, "nominal");
assert.equal(editWorker.posted[1].jobs[0].key, editedJobs[0].key);
assert.equal(
  resolveWeightGeometry(editedPlan, edits.getSnapshot().values).pending,
  true,
);
editWorker.respond(editWorker.posted[1]);
assert.equal(editWorker.posted[2].phase, "complete");
edits.request(stagedPlan.jobs); // undo while edited uncertainty is in flight
editWorker.respond(editWorker.posted[2]);
assert.equal(
  resolveWeightGeometry(stagedPlan, edits.getSnapshot().values)
    .uncertaintyPending,
  true,
);
assert.equal(editWorker.posted[3].jobs[0].key, stagedPlan.jobs[0].key);
editWorker.respond(editWorker.posted[3]);
assert.equal(
  resolveWeightGeometry(stagedPlan, edits.getSnapshot().values)
    .uncertaintyPending,
  false,
);

// Completion failure is terminal, not a perpetual spinner or an exact reading.
const badJob = { ...stagedPlan.jobs[0], key: "invalid-pitch", pitch: 0 };
const errorProcess = createWeightGeometryProcessor(model, sampling);
assert.equal(
  uncertaintyPending(
    errorProcess({ key: "bad-nominal", phase: "nominal", jobs: [badJob] })
      .results[0].result,
  ),
  true,
);
const badFinal = errorProcess({
  key: "bad-complete",
  phase: "complete",
  jobs: [badJob],
}).results[0].result;
assert.ok(badFinal.kind === "repetition" && badFinal.result.error);
assert.equal(uncertaintyPending(badFinal), false);
const failureWorker = new StagedWorker();
const failure = createWeightGeometryResource(
  () => failureWorker as unknown as Worker,
);
failure.request(stagedPlan.jobs);
failureWorker.respond(failureWorker.posted[0]);
failureWorker.respond(failureWorker.posted[1], badFinal);
assert.equal(
  failureWorker.posted.length,
  2,
  "failed uncertainty is not automatically retried",
);
assert.equal(
  resolveWeightGeometry(stagedPlan, failure.getSnapshot().values)
    .uncertaintyPending,
  false,
);

// A transport error after nominal retains the usable values, still explicitly
// incomplete, and exposes an error instead of ever labelling their spread exact.
const transportWorker = new StagedWorker();
const transport = createWeightGeometryResource(
  () => transportWorker as unknown as Worker,
);
transport.request(stagedPlan.jobs);
transportWorker.postMessage = () => {
  throw new Error("completion failed");
};
transportWorker.respond(transportWorker.posted[0]);
assert.match(transport.getSnapshot().error!, /completion failed/);
assert.equal(
  resolveWeightGeometry(stagedPlan, transport.getSnapshot().values)
    .uncertaintyPending,
  true,
);
console.log(
  "Two-phase geometry: nominal values, completion reuse, unchanged results, pending spreads, edits and failures passed",
);

// Closing a panel between phases disposes its worker, but leaves nominal data
// reusable. Reopening must resume completion rather than mistake it for final.
const lifecycleWorkers: StagedWorker[] = [];
const lifecycle = createWeightGeometryResource(() => {
  const worker = new StagedWorker();
  lifecycleWorkers.push(worker);
  return worker as unknown as Worker;
});
const closePanel = lifecycle.subscribe(() => {});
lifecycle.request(stagedPlan.jobs);
lifecycleWorkers[0].respond(lifecycleWorkers[0].posted[0]);
closePanel();
await new Promise((r) => setTimeout(r, 5));
assert.equal(lifecycleWorkers[0].terminated, true);
const closeAgain = lifecycle.subscribe(() => {});
lifecycle.request(stagedPlan.jobs);
assert.equal(lifecycleWorkers.length, 2);
assert.equal(lifecycleWorkers[1].posted[0].phase, "complete");
lifecycleWorkers[1].respond(lifecycleWorkers[1].posted[0]);
assert.equal(
  resolveWeightGeometry(stagedPlan, lifecycle.getSnapshot().values)
    .uncertaintyPending,
  false,
);
closeAgain();

// UI retention is isolated from evaluation: only the presentation can use the
// previous snapshot while a new nominal calculation is in flight.
const { weightPresentation } =
  await import("../src/editor/weight/weightPresentation");
const completeComputation = {
  positions: finalBook,
  results: finalBook,
  ...finalGeometry,
  error: null,
};
const completeDisplay = weightPresentation(
  null,
  completeComputation,
  sampling,
  "design",
);
const missingGeometry = resolveWeightGeometry(stagedPlan, new Map());
const waiting = {
  positions: evaluateBook(densityBook, null),
  results: evaluateBook(densityBook, null),
  ...missingGeometry,
  error: null,
};
const retained = weightPresentation(
  completeDisplay,
  waiting,
  sampling,
  "design",
);
assert.equal(retained.stale, true);
assert.equal(retained.readout.results, finalBook);
assert.equal(
  waiting.results.outputs.displacement,
  null,
  "retention cannot change actual calculations",
);
assert.equal(
  weightPresentation(retained, waiting, sampling, "design"),
  retained,
  "pending rerenders are stable",
);
const nominalDisplay = weightPresentation(
  retained,
  {
    positions: nominalBook,
    results: nominalBook,
    ...nominalGeometry,
    error: null,
  },
  sampling,
  "design",
);
assert.equal(nominalDisplay.stale, false);
assert.equal(
  nominalDisplay.readout.results,
  nominalBook,
  "new nominal values appear immediately",
);
assert.equal(
  weightPresentation(nominalDisplay, completeComputation, sampling, "design")
    .readout.results,
  finalBook,
);
assert.equal(
  weightPresentation(retained, waiting, sampling, "different-design").stale,
  false,
);
assert.equal(
  weightPresentation(retained, waiting, { ...sampling }, "design").stale,
  false,
);
assert.equal(
  weightPresentation(
    retained,
    { ...waiting, error: "worker failed" },
    sampling,
    "design",
  ).stale,
  false,
);
const initialWaiting = weightPresentation(null, waiting, sampling, "design");
assert.equal(
  weightPresentation(initialWaiting, waiting, sampling, "design").stale,
  false,
  "an initial missing result is not a reusable nominal snapshot",
);
assert.equal(
  weightPresentation(
    retained,
    { ...waiting, pending: false },
    sampling,
    "design",
  ).stale,
  false,
  "real invalid-input errors replace the retained readout",
);
console.log(
  "Weight presentation: stable pending snapshots, immediate nominal updates and scope/error invalidation passed",
);
