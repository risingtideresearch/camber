import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultHull, type Writable } from "../src/core/hull";
import { parseHullState } from "../src/core/json";
import { assemble } from "../src/core/runtime";
import { buildStep } from "../src/core/step";
import { buildStl } from "../src/core/stl";
import { buildExport, hydrostaticOptions } from "../src/export/exporters";
import { safeExportName } from "../src/export/filename";
import { startExportJob } from "../src/export/job";
import { captureCurrentHull, captureSavedHull } from "../src/export/source";
import type {
  ExportOptions,
  ExportRequest,
  ExportResponse,
} from "../src/export/types";

const generatedAt = "2026-10-06T12:00:00.000Z";
const hull = defaultHull();
const source = captureCurrentHull(hull, "Current / hull", "design-id");
const request = (options: ExportOptions): ExportRequest => ({
  source,
  options,
  generatedAt,
});

assert.equal(JSON.parse(source.json).name, "Current / hull");
assert.equal(source.modelId, "design-id");
assert.equal(captureCurrentHull(hull, "").name, hull.name);
assert.equal(captureCurrentHull(hull, "New hull").modelId, undefined);
const capturedPoint = JSON.parse(source.json).sheerPlan[1].y;
(hull.sheerPlan[1] as Writable<(typeof hull.sheerPlan)[number]>).y += 10;
assert.equal(
  JSON.parse(source.json).sheerPlan[1].y,
  capturedPoint,
  "editor capture is independent of later edits",
);

const stored = JSON.parse(
  readFileSync(
    new URL("../examples/hull-default.json", import.meta.url),
    "utf8",
  ),
);
const saved = captureSavedHull(stored, "Saved hull", "old-id");
assert.equal(saved.json, JSON.stringify(stored, null, 2));
stored.waterline += 10;
assert.notEqual(
  JSON.parse(saved.json).waterline,
  stored.waterline,
  "saved capture is independent of row changes",
);
assert.equal(
  JSON.parse(saved.json).version,
  undefined,
  "saved JSON does not upgrade legacy documents",
);
assert.equal(
  buildExport({ source: saved, options: { format: "json" }, generatedAt }).text,
  saved.json,
);
const json = buildExport(request({ format: "json" }));
assert.equal(json.filename, "Current _ hull.json");
assert.equal(json.mime, "application/json");
assert.equal(json.text, source.json);
assert.equal(safeExportName("../hélice / 船.. "), "_hélice _ 船");
assert.equal(safeExportName("... "), "hull");

const model = assemble(parseHullState(source.json));
const surfaces = { hull: true, transom: false, deck: false };
const stl = buildExport(request({ format: "stl", surfaces }));
assert.equal(stl.text, buildStl(model, "Current _ hull", surfaces));
assert.equal(stl.mime, "model/stl");
assert.throws(
  () =>
    buildExport(
      request({
        format: "stl",
        surfaces: { hull: false, transom: false, deck: false },
      }),
    ),
  /no surface/,
);
const step = buildExport(request({ format: "step" }));
assert.equal(step.text, buildStep(model, "2026-10-06T12:00:00"));
assert.equal(step.filename, "Current _ hull.step");
assert.ok(
  buildExport({
    source: saved,
    options: { format: "step" },
    generatedAt,
  }).text.startsWith("ISO-10303-21;"),
  "legacy geometry exports convert without modifying stored JSON",
);
assert.throws(
  () =>
    buildExport({
      source: { name: "Broken", json: "{}" },
      options: { format: "step" },
      generatedAt,
    }),
  /not a hull/,
);

const upright = hydrostaticOptions(
  { format: "hydrostatics", coverage: "upright", fine: false },
  3,
  generatedAt,
);
assert.deepEqual(upright.heelDeg, [0]);
assert.deepEqual(upright.trimDeg, [0]);
assert.equal(upright.numSections, 240);
const fixed = hydrostaticOptions(
  { format: "hydrostatics", coverage: "fixed", fine: true },
  3,
  generatedAt,
  "id",
);
assert.deepEqual(fixed.trimDeg, [3]);
assert.equal(fixed.heelDeg?.length, 145);
assert.equal(fixed.immersionSteps, 128);
assert.equal(fixed.numSections, 400);
assert.equal(fixed.girthSteps, 16);
assert.equal(fixed.modelId, "id");
const grid = hydrostaticOptions(
  { format: "hydrostatics", coverage: "grid", fine: false },
  3,
  generatedAt,
);
assert.deepEqual(grid.trimDeg, [-5, 0, 5, 3]);
assert.equal(grid.heelDeg?.length, 73);
const progress: number[] = [];
const hydro = buildExport(
  request({ format: "hydrostatics", coverage: "upright", fine: false }),
  (completed) => progress.push(completed),
);
const table = JSON.parse(hydro.text);
assert.equal(hydro.filename, "Current _ hull.hydrostatics.json");
assert.equal(table.source.modelId, "design-id");
assert.equal(table.name, source.name);
assert.ok(progress.length > 0);

class FakeWorker {
  onmessage: ((event: MessageEvent<ExportResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = 0;
  posted: ExportRequest | null = null;
  failPost = false;
  postMessage(value: ExportRequest) {
    if (this.failPost) throw new Error("post failed");
    this.posted = structuredClone(value);
  }
  terminate() {
    this.terminated++;
  }
  reply(value: ExportResponse) {
    this.onmessage?.({ data: value } as MessageEvent<ExportResponse>);
  }
}
const replies: ExportResponse[] = [];
const worker = new FakeWorker();
const job = startExportJob(
  request({ format: "json" }),
  (r) => replies.push(r),
  () => worker as unknown as Worker,
);
assert.deepEqual(worker.posted, request({ format: "json" }));
worker.reply({ type: "progress", completedRows: 1, totalRows: 4 });
assert.equal(worker.terminated, 0);
job.cancel();
job.cancel();
worker.reply({ type: "complete", artifact: json });
assert.equal(replies.length, 1, "cancelled replies cannot trigger a download");
assert.equal(worker.terminated, 1);
const complete = new FakeWorker();
startExportJob(
  request({ format: "json" }),
  (r) => replies.push(r),
  () => complete as unknown as Worker,
);
complete.reply({ type: "complete", artifact: json });
complete.reply({ type: "complete", artifact: json });
assert.equal(complete.terminated, 1);
assert.equal(replies.length, 2, "completion only delivered once");
const failed = new FakeWorker();
startExportJob(
  request({ format: "json" }),
  (r) => replies.push(r),
  () => failed as unknown as Worker,
);
failed.onerror?.({
  message: "Worker crashed",
  preventDefault() {},
} as ErrorEvent);
assert.equal(failed.terminated, 1);
assert.deepEqual(replies[replies.length - 1], {
  type: "error",
  error: "Worker crashed",
});
const postFailed = new FakeWorker();
postFailed.failPost = true;
assert.throws(
  () =>
    startExportJob(
      request({ format: "json" }),
      () => {},
      () => postFailed as unknown as Worker,
    ),
  /post failed/,
);
assert.equal(postFailed.terminated, 1);
assert.throws(
  () =>
    startExportJob(
      request({ format: "json" }),
      () => {},
      () => {
        throw new Error("Worker unavailable");
      },
    ),
  /Worker unavailable/,
);
console.log(
  "Export sources, writers, hydrostatic presets and job lifecycle passed.",
);
