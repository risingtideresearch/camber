import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { evaluateBook, prepareBook } from "../src/core/sheet/evaluate";
import { createSamplingRun } from "../src/core/sheet/sampling";
import { rollupSampleKey } from "../src/core/sheet/sampleRollup";
import { prepareTrials } from "../src/core/sheet/trial";
import { SampledResultsPanel } from "../src/editor/weight/SampledResultsPanel";
import { formulaBook, target } from "./sampling-fixtures";
import { DIMLESS, type Reading } from "../src/core/sheet/quantity";
import {
  inUnit,
  relative,
  showSpread,
  sig,
  spreadText,
} from "../src/editor/weight/weightFormat";

// Cut summaries and other nominal readouts share this formatter, including signed coordinates.
for (const value of [0, -0, 1e-17, -1e-17]) {
  for (const factor of [1, 1000, 0.001]) {
    assert.equal(sig(inUnit(value, factor)), "0");
  }
}
assert.equal(sig(1e-12), "1.00e-12");
assert.equal(sig(-1e-12), "-1.00e-12");
assert.equal(sig(0.001), "0.00100");
assert.equal(sig(1.234), "1.234");
assert.equal(sig(NaN), "—");
assert.equal(sig(Infinity), "—");

// The sampled report follows the sheet's unit and formatter, not the large
// internal kilogram value or locale-dependent significant-digit grouping.
const sampledBook = formulaBook({ mass: { formula: "1250", unit: "t" } });
const sampledResults = evaluateBook(sampledBook, null);
const sampledKey = target("mass");
const sample = createSamplingRun(
  {
    runId: "format",
    context: {
      bookRevision: "1",
      hullRevision: "1",
      geometrySettingsRevision: "1",
    },
    seed: 12345,
    checkpoints: [1],
    targets: [
      { cellKey: sampledKey, dim: { m: 1, l: 0 }, nominal: { value: 1250000 } },
    ],
  },
  prepareTrials(prepareBook(sampledBook)),
);
sample.advance();
const markup = renderToStaticMarkup(
  createElement(SampledResultsPanel, {
    book: sampledBook,
    sampling: null,
    results: sampledResults,
    ready: true,
    selectedKey: sampledKey,
    keys: [sampledKey],
    onPick: () => {},
    run: {
      getRun: () => ({
        result: sample.snapshot(),
        completed: 1,
        error: null,
        starting: false,
        runId: "test",
      }),
      start: () => {},
      prioritize: () => {},
      cancel: () => {},
      refine: () => {},
    },
  }),
);
assert.match(markup, /<td>1250<\/td>/);
assert.match(markup, /\(t\)/);
assert.doesNotMatch(markup, /1,250,000/);
assert.doesNotMatch(markup, /wsampled-invalid|<th>Invalid<\/th>|Reasons/);
assert.doesNotMatch(markup, /Selected field:|experimental/);
assert.match(markup, /aria-label="Sampled trials"/);
assert.match(markup, /<progress[^>]*value="1"[^>]*max="1"/);
// A selected transient total has no authored cell, but still has its own nominal and sample readout.
const rollup = { itemIds: ["i0"], role: "MASS", leaf: "value" as const };
const rollupKey = rollupSampleKey(rollup);
const virtual = {
  target: {
    cellKey: rollupKey,
    rollup,
    dim: { m: 1, l: 0 },
    nominal: { value: 1250000 },
  },
  label: "All items.MASS",
};
const rollupMarkup = renderToStaticMarkup(
  createElement(SampledResultsPanel, {
    book: sampledBook,
    sampling: null,
    results: sampledResults,
    ready: true,
    selectedKey: rollupKey,
    keys: [rollupKey],
    virtual,
    onPick: () => {},
    run: {
      getRun: () => ({
        result: {
          ...sample.snapshot(),
          outputs: [{ ...sample.snapshot().outputs[0], ...virtual.target }],
        },
        completed: 1,
        error: null,
        starting: false,
        runId: "rollup",
      }),
      start: () => {},
      prioritize: () => {},
      cancel: () => {},
      refine: () => {},
    },
  }),
);
assert.match(rollupMarkup, /All items.MASS/);
assert.match(rollupMarkup, /<td>1250000<\/td>/);
assert.match(rollupMarkup, /Sampled mean/);
// Revisiting a field reads its completed report even when another target was
// the most recent worker run.
const revisited = renderToStaticMarkup(
  createElement(SampledResultsPanel, {
    book: sampledBook,
    sampling: null,
    results: sampledResults,
    ready: true,
    selectedKey: sampledKey,
    keys: [sampledKey],
    onPick: () => {},
    run: {
      getRun: (keys) =>
        keys[0] === sampledKey
          ? {
              result: sample.snapshot(),
              completed: 1,
              error: null,
              starting: false,
              runId: "test",
            }
          : null,
      start: () => {},
      prioritize: () => {},
      cancel: () => {},
      refine: () => {},
    },
  }),
);
assert.match(revisited, /<td>1250<\/td>/);
assert.match(revisited, /<progress[^>]*value="1"[^>]*max="1"/);
const preliminary = renderToStaticMarkup(
  createElement(SampledResultsPanel, {
    book: sampledBook,
    sampling: null,
    results: sampledResults,
    ready: true,
    selectedKey: sampledKey,
    keys: [sampledKey],
    onPick: () => {},
    run: {
      getRun: () => ({
        result: {
          ...sample.snapshot(),
          execution: { status: "running" as const },
          progress: { ...sample.snapshot().progress, requestedTrials: 1024 },
        },
        completed: 1,
        error: null,
        starting: false,
        runId: "background",
      }),
      start: () => {},
      prioritize: () => {},
      cancel: () => {},
      refine: () => {},
    },
  }),
);
assert.match(preliminary, /preliminary estimates/);
assert.match(preliminary, /<td>1250<\/td>/);
assert.match(preliminary, /<progress[^>]*value="1"[^>]*max="1024"/);
const queued = renderToStaticMarkup(
  createElement(SampledResultsPanel, {
    book: sampledBook,
    sampling: null,
    results: sampledResults,
    ready: true,
    selectedKey: sampledKey,
    keys: [sampledKey],
    onPick: () => {},
    run: {
      getRun: () => ({
        result: null,
        completed: 0,
        error: null,
        starting: true,
        runId: "queued",
      }),
      start: () => {},
      prioritize: () => {},
      cancel: () => {},
      refine: () => {},
    },
  }),
);
assert.match(queued, /Queued for sampling/);
assert.match(queued, /<progress[^>]*value="0"[^>]*max="1024"/);

// Invalidity is an exception badge in the overview and a count with reasons
// in the selected detail, rather than a column of mostly zeroes.
const reportBook = formulaBook({
  mass: { formula: "1250", unit: "t" },
  other: "1",
});
const otherKey = target("other");
const base = sample.snapshot();
const report = {
  ...base,
  progress: { ...base.progress, requestedTrials: 1024, completedTrials: 1024 },
  outputs: [
    {
      ...base.outputs[0],
      validTrials: 1023,
      invalidTrials: 1,
      failures: [{ message: "Bad contour", trials: 1 }],
    },
    {
      ...base.outputs[0],
      cellKey: otherKey,
      validTrials: 0,
      invalidTrials: 1024,
      distribution: null,
      failures: [{ message: "Undefined geometry", trials: 1024 }],
    },
  ],
};
const renderReport = (selectedKey: string) =>
  renderToStaticMarkup(
    createElement(SampledResultsPanel, {
      book: reportBook,
      sampling: null,
      results: evaluateBook(reportBook, null),
      ready: true,
      selectedKey,
      keys: [sampledKey, otherKey],
      onPick: () => {},
      run: {
        getRun: () => ({
          result: report,
          completed: 1024,
          error: null,
          starting: false,
          runId: "test",
        }),
        start: () => {},
        prioritize: () => {},
        cancel: () => {},
        refine: () => {},
      },
    }),
  );
const partial = renderReport(sampledKey);
assert.match(partial, /<progress[^>]*value="1024"[^>]*max="1024"/);
assert.doesNotMatch(partial, /<th>Invalid<\/th>/);
assert.match(partial, /&lt;0\.1% invalid/);
assert.match(partial, /1 of 1,024 trials invalid/);
assert.match(partial, /Bad contour/);
const whollyInvalid = renderReport(otherKey);
assert.match(whollyInvalid, /All trials invalid/);
assert.match(whollyInvalid, /No valid samples/);
assert.match(whollyInvalid, /All 1,024 trials invalid/);
assert.match(whollyInvalid, /Undefined geometry/);

assert.equal(spreadText(0, 0, 1), "");
assert.equal(spreadText(1e-12, 1e-12, 1000), ""); // Never display ± 0.
for (const factor of [1, 1000, 0.001]) {
  assert.equal(spreadText(1e-17, 2e-17, factor), "");
}
assert.equal(spreadText(1e-17, 0.2, 1), "−0 / +0.200");
assert.equal(spreadText(0.2, 1e-17, 1), "−0.200 / +0");
assert.equal(spreadText(0.2, 0.2, 1), "± 0.200");
assert.equal(spreadText(100, 200, 1000), "−0.100 / +0.200");
assert.equal(spreadText(0, 1e-12, 1), "−0 / +1.00e-12");
assert.equal(spreadText(1e-12, 1e-12, 1), "± 1.00e-12");
assert.equal(relative(1e-17, 2e-17, 1), "0%");
assert.equal(relative(0, 0, 1), "0%");
assert.equal(relative(0.0001, 0.0001, 1), "<0.1%");
assert.equal(relative(0.2, 0.2, 1), "20%");
assert.equal(relative(1e-17, 1e-17, 0), null);

const reading: Reading = {
  v: 1,
  dim: DIMLESS,
  worst: { lo: 1e-17, hi: 2e-17 },
  likely: { lo: 1e-18, hi: 2e-18 },
  terms: [],
};
assert.equal(showSpread(reading, 1, "worst"), "");
assert.equal(showSpread(reading, 1, "likely"), "");
assert.equal(reading.worst.lo, 1e-17); // Formatting never changes the reading.
console.log("Weight formatting tests passed");
assert.equal(
  showSpread({ ...reading, uncertaintyPending: true }, 1, "worst"),
  "…",
);
assert.equal(
  showSpread({ ...reading, uncertaintyPending: true }, 1000, "likely"),
  "…",
);
