import assert from "node:assert/strict";
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
