import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSheetJson, parseSheet } from "../src/core/sheet/json";
import { evaluateBook } from "../src/core/sheet/evaluate";
import { ScenarioLoading } from "../src/editor/weight/ScenarioLoading";
import { formulaBook } from "./sampling-fixtures";

const book = {
  ...formulaBook({
    mass: { formula: "2450", unit: "kg" },
    vcg: { formula: "0.82", unit: "m" },
    lcg: { formula: "2.1", unit: "m" },
    tcg: { formula: "-0.125", unit: "m" },
  }),
  outputs: {
    DISPLACEMENT: "Experiment.mass",
    VCG: "Experiment.vcg",
    LCG: "Experiment.lcg",
    TCG: "Experiment.tcg",
  },
};
const render = (outputs = book.outputs) =>
  renderToStaticMarkup(
    createElement(ScenarioLoading, {
      results: evaluateBook({ ...book, outputs }, null),
      scenarioName: "Fully loaded",
      density: 1.025,
    }),
  );
const html = render();
const results = evaluateBook(book, null);
assert.equal(results.outputs.tcg?.v, -0.125);
assert.equal(parseSheet(buildSheetJson(book)).outputs.TCG, "Experiment.tcg");
assert.match(html, /Fully loaded/);
assert.match(html, /2\.450 t/);
assert.match(html, /0\.820 m/);
assert.match(html, /2\.100 m/);
assert.match(html, /-0\.125 m/);
assert.match(html, />TCG</);
assert.match(html, /1025 kg\/m³/);
assert.doesNotMatch(html, /<input|<button|Stability|Manual|equilibrium/i);
// Missing or incorrectly dimensioned outputs do not hide other valid values.
const partial = render({
  ...book.outputs,
  DISPLACEMENT: "",
  VCG: "Experiment.mass",
});
assert.match(partial, /No output formula/);
assert.match(partial, /No valid value available/);
assert.match(partial, /2\.100 m/);
assert.doesNotMatch(partial, /2450.*m/);
// The input summary is compact, with no nested screen/card or duplicated heading.
assert.doesNotMatch(html, /loading-panel|loading-card|<h2/);
assert.ok(html.indexOf(">LCG<") < html.indexOf(">VCG<"));
const nonpositive = render({
  ...book.outputs,
  DISPLACEMENT: "-Experiment.mass",
});
assert.match(nonpositive, /Displacement must be positive/);
assert.match(nonpositive, /0\.820 m/);
console.log(
  "Scenario loading: read-only nominal values, units and partial outputs passed.",
);
