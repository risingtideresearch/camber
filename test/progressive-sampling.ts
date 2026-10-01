import assert from "node:assert/strict";
import { prepareBook } from "../src/core/sheet/evaluate";
import {
  createSamplingRun,
  validateCheckpoints,
  type SamplingRequest,
} from "../src/core/sheet/sampling";
import {
  prepareTrials,
  evaluateTrial,
  type TrialValue,
} from "../src/core/sheet/trial";
import {
  prepareSampleRollup,
  rollupSampleKey,
  sampleTargets,
} from "../src/core/sheet/sampleRollup";
import { cellKey } from "../src/core/sheet/evaluate";
import type { WeightBook } from "../src/core/sheet/book";
import { LENGTH, MASS } from "../src/core/sheet/quantity";
import { createSamplingController } from "../src/worker/samplingController";
import { createSampledRunCache } from "../src/editor/sampledRunCache";
import type {
  SamplingCommand,
  SamplingEvent,
} from "../src/worker/samplingProtocol";
import { formulaBook, target } from "./sampling-fixtures";
import { mixedTrialBook, mixedTrialGeometry } from "./trial-fixtures";

const book = formulaBook({
  x: "0 ± 1",
  square: "x * x",
  invalid: "sqrt(x)",
  never: "1 / 0",
});
const plan = prepareTrials(prepareBook(book));
const request: SamplingRequest = {
  runId: "test",
  context: {
    bookRevision: "book1",
    hullRevision: "hull1",
    geometrySettingsRevision: "settings1",
  },
  seed: 12345,
  checkpoints: [64, 256, 1024],
  targets: ["square", "invalid", "never"].map((key) => ({
    cellKey: target(key),
    dim: { m: 0, l: 0 },
    nominal: { value: 0 },
  })),
};
function complete(run: ReturnType<typeof createSamplingRun>, batch: number) {
  const checkpoints: number[] = [];
  while (!run.done)
    if (run.advance(batch, 10000)) checkpoints.push(run.completed);
  return checkpoints;
}
// Transient report totals are not authored cells: evaluate their constituent roles in each world.
const roleBook: WeightBook = {
  ...formulaBook({}),
  items: [
    {
      id: "i0",
      name: "First",
      note: "",
      facets: {},
      fields: {
        mass: { k: "scalar", formula: "10 ± 2", unit: "kg", role: "MASS" },
        cg: {
          k: "point",
          x: "1",
          y: "0",
          z: "0",
          from: "",
          unit: "m",
          role: "CG",
        },
      },
    },
    {
      id: "i1",
      name: "Second",
      note: "",
      facets: {},
      fields: {
        mass: { k: "scalar", formula: "30", unit: "kg", role: "MASS" },
        cg: {
          k: "point",
          x: "5",
          y: "0",
          z: "0",
          from: "",
          unit: "m",
          role: "CG",
        },
      },
    },
  ],
};
const rolePlan = prepareTrials(prepareBook(roleBook));
const rollups = ["MASS", "CG"].map((role) => {
  const descriptor = {
    itemIds: ["i0", "i1"],
    role,
    leaf: role === "MASS" ? ("value" as const) : ("x" as const),
  };
  return {
    key: rollupSampleKey(descriptor),
    prepared: prepareSampleRollup(roleBook, descriptor),
    descriptor,
  };
});
const rollupRun = createSamplingRun(
  {
    ...request,
    targets: rollups.map(({ key, descriptor }) => ({
      cellKey: key,
      rollup: descriptor,
      dim: null,
      nominal: { value: 0 },
    })),
  },
  rolePlan,
  undefined,
  null,
  sampleTargets(
    roleBook,
    rollups.map(({ key, descriptor }) => ({
      cellKey: key,
      rollup: descriptor,
      dim: null,
      nominal: { value: 0 },
    })),
    (trial, keys) =>
      evaluateTrial(rolePlan, trial, undefined, null, keys).values,
  ),
);
complete(rollupRun, 64);
const [massOutput, cgOutput] = rollupRun.snapshot().outputs;
assert.equal(massOutput.validTrials, 1024);
assert.equal(cgOutput.validTrials, 1024);
assert.ok(massOutput.distribution!.standardDeviation > 0);
assert.ok(cgOutput.distribution!.standardDeviation > 0);
const fixedValues = new Map<string, TrialValue>([
  [cellKey("i0", "mass"), { value: 10, dim: MASS, error: null }],
  [cellKey("i1", "mass"), { value: 30, dim: MASS, error: null }],
  [cellKey("i0", "cg", "x"), { value: 1, dim: LENGTH, error: null }],
  [cellKey("i0", "cg", "y"), { value: 0, dim: LENGTH, error: null }],
  [cellKey("i0", "cg", "z"), { value: 0, dim: LENGTH, error: null }],
  [cellKey("i1", "cg", "x"), { value: 5, dim: LENGTH, error: null }],
  [cellKey("i1", "cg", "y"), { value: 0, dim: LENGTH, error: null }],
  [cellKey("i1", "cg", "z"), { value: 0, dim: LENGTH, error: null }],
]);
assert.equal(rollups[0].prepared.evaluate(fixedValues).value, 40);
assert.equal(rollups[1].prepared.evaluate(fixedValues).value, 4);
assert.match(
  rollups[1].prepared.evaluate(
    new Map([
      ...fixedValues,
      [cellKey("i0", "mass"), { value: null, dim: MASS, error: "bad mass" }],
    ]),
  ).error ?? "",
  /bad mass/,
);
assert.match(
  rollups[1].prepared.evaluate(
    new Map([
      ...fixedValues,
      [cellKey("i0", "cg", "y"), { value: null, dim: LENGTH, error: "bad y" }],
    ]),
  ).error ?? "",
  /bad y/,
);
assert.match(
  rollups[1].prepared.evaluate(
    new Map([
      ...fixedValues,
      [cellKey("i0", "mass"), { value: 0, dim: MASS, error: null }],
      [cellKey("i1", "mass"), { value: 0, dim: MASS, error: null }],
    ]),
  ).error ?? "",
  /zero total/,
);
assert.throws(() =>
  createSamplingRun(
    {
      ...request,
      targets: [
        {
          cellKey: "wrong",
          rollup: rollups[0].descriptor,
          dim: null,
          nominal: { value: 0 },
        },
      ],
    },
    rolePlan,
  ),
);
const progressive = createSamplingRun(request, plan);
assert.deepEqual(complete(progressive, 19), [64, 256, 1024]);
const snapshot = progressive.snapshot();
const single = createSamplingRun({ ...request, checkpoints: [1024] }, plan);
complete(single, 1024);
assert.deepEqual(
  snapshot.outputs,
  single.snapshot().outputs,
  "batch/checkpoint partition cannot change results",
);
assert.equal(snapshot.execution.status, "finished");
// Switching views returns a finished reduction without replaying any trials.
const cached = createSampledRunCache(2);
const keys = request.targets.map((target) => target.cellKey);
cached.store({ ...snapshot, execution: { status: "running" } });
assert.equal(
  cached.get(keys),
  null,
  "a preliminary result is not reusable as final",
);
cached.store(snapshot);
assert.strictEqual(cached.get(keys), snapshot);
assert.equal(
  cached.get([...keys].reverse()),
  null,
  "target order belongs to the report",
);
const alternate = { ...snapshot, outputs: [snapshot.outputs[0]] };
cached.store(alternate);
cached.get(keys); // Mark the original reduction as recently visited.
cached.store({ ...snapshot, outputs: [snapshot.outputs[1]] });
assert.strictEqual(cached.get(keys), snapshot);
assert.equal(cached.get([request.targets[0].cellKey]), null);
assert.equal(
  createSampledRunCache().get(keys),
  null,
  "a changed context starts empty",
);
assert.equal(snapshot.outputs[0].validTrials, 1024);
assert.equal(
  snapshot.outputs[0].distribution!.histogram.reduce(
    (sum, bin) => sum + bin.count,
    0,
  ),
  1024,
);
assert.equal(
  snapshot.outputs[1].distribution!.histogram.reduce(
    (sum, bin) => sum + bin.count,
    0,
  ),
  snapshot.outputs[1].validTrials,
);
assert.ok(Math.abs(snapshot.outputs[0].distribution!.mean - 1 / 3) < 0.04);
assert.ok(
  snapshot.outputs[1].invalidTrials > 400 &&
    snapshot.outputs[1].invalidTrials < 600,
);
assert.equal(snapshot.outputs[2].distribution, null);
for (const output of snapshot.outputs) {
  assert.equal(output.validTrials + output.invalidTrials, 1024);
  assert.equal(
    output.failures.reduce((sum, failure) => sum + failure.trials, 0),
    output.invalidTrials,
  );
}
progressive.extend([4096]);
assert.equal(progressive.snapshot().progress.nextCheckpoint, 4096);
complete(progressive, 29);
const extended = progressive.snapshot();
const fresh = createSamplingRun({ ...request, checkpoints: [4096] }, plan);
complete(fresh, 1024);
assert.deepEqual(extended.outputs, fresh.snapshot().outputs);
assert.equal(
  snapshot.progress.completedTrials,
  1024,
  "published snapshots remain immutable",
);
assert.ok(extended.sequence > snapshot.sequence);
for (const bad of [[], [0], [64, 64], [256, 64], [4097], [NaN], [2.5]])
  assert.throws(() => validateCheckpoints(bad));
assert.throws(() => progressive.extend([4096]));
assert.throws(() => createSamplingRun({ ...request, seed: -1 }, plan));
assert.throws(() => createSamplingRun({ ...request, targets: [] }, plan));
assert.throws(() =>
  createSamplingRun(
    { ...request, targets: [request.targets[0], request.targets[0]] },
    plan,
  ),
);
assert.throws(() => progressive.advance(0));

// Joint geometry/material sampling uses the same cumulative trial indices.
const jointPlan = prepareTrials(prepareBook(mixedTrialBook()));
const jointRequest = {
  ...request,
  targets: [{ ...request.targets[0], cellKey: target("total") }],
  checkpoints: [8, 32],
};
const joint = createSamplingRun(jointRequest, jointPlan, mixedTrialGeometry());
const jointSingle = createSamplingRun(
  { ...jointRequest, checkpoints: [32] },
  jointPlan,
  mixedTrialGeometry(),
);
complete(joint, 3);
complete(jointSingle, 32);
assert.deepEqual(joint.snapshot().outputs, jointSingle.snapshot().outputs);
assert.equal(joint.snapshot().outputs[0].validTrials, 32);

// Drive worker turns manually: no browser or timing assumptions in lifecycle tests.
const queue: (() => void)[] = [];
const events: SamplingEvent[] = [];
let creations = 0;
const controller = createSamplingController(
  (command) => {
    creations++;
    return createSamplingRun(command.request, plan);
  },
  (event) => events.push(event),
  (callback) => queue.push(callback),
);
// The injected factory only reads request; real geometry initialization is tested separately.
const start = (id: string): SamplingCommand => ({
  type: "start",
  request: { ...request, runId: id },
  book,
  hull: {} as Extract<SamplingCommand, { type: "start" }>["hull"],
  sampling: {} as Extract<SamplingCommand, { type: "start" }>["sampling"],
  metrics: null,
});
const snapshots = () =>
  events.flatMap((event) => (event.kind === "snapshot" ? [event.result] : []));
controller(start("cancel"));
queue.shift()!();
const count = events.find((event) => event.kind === "progress");
assert.ok(
  count?.kind === "progress" &&
    count.completedTrials > 0 &&
    count.completedTrials < 64,
);
controller({ type: "cancel", runId: "cancel" });
const cancelled = snapshots()[snapshots().length - 1];
assert.equal(cancelled.execution.status, "cancelled");
assert.equal(cancelled.progress.completedTrials, count.completedTrials);
const eventCount = events.length;
while (queue.length) queue.shift()!();
assert.equal(events.length, eventCount, "cancel invalidates queued turns");
controller(start("old"));
queue.shift()!(); // Incomplete when the view changes.
const oldPrefix = snapshots().filter((s) => s.runId === "old");
controller(start("new"));
assert.equal(creations, 3, "the visible field starts without waiting");
while (queue.length) queue.shift()!();
const finishedOld = snapshots().findIndex(
  (s) => s.runId === "old" && s.execution.status === "finished",
);
const firstNew = snapshots().findIndex((s) => s.runId === "new");
assert.ok(oldPrefix.length && firstNew >= 0 && finishedOld > firstNew);
assert.equal(creations, 3, "resuming a suspended run keeps its accumulator");
assert.equal(snapshots()[snapshots().length - 1].runId, "old");
// A run that was no longer visible can still be refined after another run.
controller({ type: "extend", runId: "old", checkpoints: [4096] });
while (queue.length) queue.shift()!();
assert.equal(snapshots()[snapshots().length - 1].runId, "old");
// Returning to a partially sampled field preempts the newer one, without
// resetting either trial prefix or creating either run twice.
controller(start("back"));
queue.shift()!();
const backCount = events.find(
  (e) => e.kind === "progress" && e.runId === "back",
);
assert.ok(backCount?.kind === "progress" && backCount.completedTrials > 0);
controller(start("other"));
queue.shift()!();
const createdBeforeReturn = creations;
controller({ type: "prioritize", runId: "back" });
const resumed = snapshots().filter((s) => s.runId === "back");
assert.ok(
  resumed[resumed.length - 1].progress.completedTrials >=
    backCount.completedTrials,
);
while (queue.length) queue.shift()!();
assert.equal(creations, createdBeforeReturn);
assert.ok(
  snapshots().some(
    (s) => s.runId === "other" && s.execution.status === "finished",
  ),
);
// Cancelling a queued view does not interrupt view work already in progress.
controller(start("in-flight"));
controller(start("waiting"));
controller({ type: "cancel", runId: "waiting" });
assert.ok(
  snapshots().some(
    (s) => s.runId === "waiting" && s.execution.status === "cancelled",
  ),
);
while (queue.length) queue.shift()!();
assert.equal(snapshots()[snapshots().length - 1]?.runId, "in-flight");
controller(start("first"));
controller(start("middle"));
controller(start("latest"));
while (queue.length) queue.shift()!();
const order = snapshots()
  .filter(
    (s) =>
      s.execution.status === "finished" &&
      ["first", "middle", "latest"].includes(s.runId),
  )
  .map((s) => s.runId);
assert.deepEqual(
  order,
  ["latest", "middle", "first"],
  "the visible target takes priority",
);
controller(start("active-again"));
controller(start("queued-earlier"));
controller(start("queued-later"));
controller({ type: "prioritize", runId: "queued-earlier" });
while (queue.length) queue.shift()!();
assert.deepEqual(
  snapshots()
    .filter(
      (s) =>
        s.execution.status === "finished" &&
        ["active-again", "queued-earlier", "queued-later"].includes(s.runId),
    )
    .map((s) => s.runId),
  ["queued-earlier", "queued-later", "active-again"],
  "returning to a queued view moves it to the front",
);
const beforeRefine = creations;
controller({ type: "extend", runId: "new", checkpoints: [4096] });
while (queue.length) queue.shift()!();
assert.equal(
  creations,
  beforeRefine,
  "refinement keeps geometry and accumulators alive",
);
assert.equal(
  snapshots()[snapshots().length - 1].progress.completedTrials,
  4096,
);
assert.deepEqual(
  snapshots()[snapshots().length - 1].outputs,
  fresh.snapshot().outputs,
);

const errors: SamplingEvent[] = [];
const failing = createSamplingController(
  () => {
    throw new Error("initialization failed");
  },
  (event) => errors.push(event),
);
failing(start("broken"));
assert.deepEqual(errors, [
  { kind: "error", runId: "broken", message: "initialization failed" },
]);
// A runtime/infrastructure failure preserves the completed prefix and is not
// counted as an invalid physical draw.
const runtimeQueue: (() => void)[] = [];
const runtimeEvents: SamplingEvent[] = [];
const failingRuntime = createSamplingController(
  (command) => {
    const run = createSamplingRun(command.request, plan);
    let turns = 0;
    return {
      ...run,
      advance: () => {
        if (++turns === 2) throw new Error("evaluation interrupted");
        return run.advance(1);
      },
    };
  },
  (event) => runtimeEvents.push(event),
  (callback) => runtimeQueue.push(callback),
);
failingRuntime(start("runtime"));
failingRuntime(start("after-runtime"));
while (runtimeQueue.length) runtimeQueue.shift()!();
const runtimeSnapshots = runtimeEvents.flatMap((event) =>
  event.kind === "snapshot" ? [event.result] : [],
);
const failed = runtimeSnapshots.find(
  (result) =>
    result.runId === "runtime" && result.execution.status === "failed",
);
assert.ok(failed);
assert.equal(failed.progress.completedTrials, 1);
for (const output of failed.outputs)
  assert.equal(output.validTrials + output.invalidTrials, 1);
assert.ok(
  runtimeSnapshots.some(
    (result) =>
      result.runId === "after-runtime" && result.execution.status === "failed",
  ),
  "later jobs are still visited after failure",
);

const unknownDimension = createSamplingRun(
  {
    ...request,
    checkpoints: [64],
    targets: [
      {
        cellKey: target("invalid"),
        dim: null,
        nominal: { error: "Nominal unavailable" },
      },
    ],
  },
  plan,
);
complete(unknownDimension, 8);
assert.deepEqual(unknownDimension.snapshot().outputs[0].dim, { m: 0, l: 0 });

console.log(
  "Progressive sampling: prefixes, refinement, validity, budgets, cancellation and stale work passed",
);
