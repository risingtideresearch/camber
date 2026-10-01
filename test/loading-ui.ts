import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canApplyEquilibrium } from "../src/core/equilibrium";
import {
  LoadingAttitudePreview,
  LoadingConstraintFields,
  LoadingPurposePicker,
} from "../src/editor/LoadingAttitudePreview";
import { LoadingScenarioComparison } from "../src/editor/LoadingScenarioComparison";
import {
  readLoadingConstraints,
  radians,
} from "../src/editor/loadingPresentation";
import type {
  LoadingProposal,
  LoadingResponse,
} from "../src/worker/loadingComputation";

const proposal: LoadingProposal = {
  waterline: 600,
  deckTrim: radians(1),
  heel: radians(-4),
  volumeError: 0,
  balanceError: 0,
  transverseBalanceError: 0,
  values: { mass: 2000, lcg: 2, vcg: 0.8, tcg: -0.06 },
  iterations: 1,
};
const renderDesign = (result = proposal) =>
  renderToStaticMarkup(
    createElement(LoadingAttitudePreview, {
      waterline: 550,
      deckTrim: 0,
      scale: 0.001,
      proposal: result,
    }),
  );
const design = renderDesign();
assert.match(design, />Current</);
assert.match(design, />Balanced</);
assert.match(design, /Balanced estimate/);
assert.doesNotMatch(design, />Change</);
assert.match(design, /preview-only/);
assert.equal(canApplyEquilibrium(proposal), false);
assert.equal(canApplyEquilibrium({ heel: NaN }), false);
const upright = { ...proposal, heel: 0, transverseBalanceError: null };
assert.equal(canApplyEquilibrium(upright), true);
assert.doesNotMatch(renderDesign(upright), /preview-only|Define a valid TCG/);
assert.match(renderDesign(upright), /fixed/);

for (const purpose of ["balance-design", "compare-scenarios"] as const) {
  const picker = renderToStaticMarkup(
    createElement(LoadingPurposePicker, {
      purpose,
      onChange: () => {},
      disabled: false,
    }),
  );
  assert.match(picker, /Loading view/);
  assert.match(picker, /Balance the design/);
  assert.match(picker, /Compare loading scenarios/);
  assert.match(picker, /Recalculate.*sheet values/);
  assert.match(picker, /heel held at 0°/);
  assert.match(picker, /heel is not balanced/);
  assert.match(picker, /Freeze each estimate/);
  assert.equal((picker.match(/checked=""/g) ?? []).length, 1);
  assert.doesNotMatch(picker, /Test a loading scenario|<button/);
}

const inputs = { fixTrim: false, trim: "1.2", fixHeel: false, heel: "0" };
assert.deepEqual(readLoadingConstraints(inputs).constraints, {
  trim: null,
  heel: null,
});
assert.deepEqual(
  readLoadingConstraints({ ...inputs, fixTrim: true, fixHeel: true })
    .constraints,
  { trim: radians(1.2), heel: 0 },
);
for (const trim of ["", "NaN", "Infinity", "31", "-31"])
  assert.match(
    readLoadingConstraints({ ...inputs, fixTrim: true, trim }).error!,
    /Trim/,
  );
for (const heel of ["", "46", "-46"])
  assert.match(
    readLoadingConstraints({ ...inputs, fixHeel: true, heel }).error!,
    /Heel/,
  );
// Invalid dormant inputs do not constrain a free angle.
assert.equal(
  readLoadingConstraints({ ...inputs, trim: "", heel: "" }).error,
  null,
);
const controls = renderToStaticMarkup(
  createElement(LoadingConstraintFields, {
    inputs,
    onChange: () => {},
    disabled: false,
  }),
);
assert.match(controls, /<details[^>]*><summary>Floating attitude constraints/);
assert.doesNotMatch(controls, /<details[^>]*\bopen(?:=|[ >])/);
assert.match(controls, /Trim free.*Heel free/);
const fixedControls = renderToStaticMarkup(
  createElement(LoadingConstraintFields, {
    inputs: { ...inputs, fixTrim: true, fixHeel: true },
    onChange: () => {},
    disabled: false,
  }),
);
assert.match(fixedControls, /Trim fixed at 1\.2°.*Heel fixed at 0°/);
assert.doesNotMatch(fixedControls, /<details[^>]*\bopen(?:=|[ >])/);
assert.match(controls, /Fix trim at/);
assert.match(controls, /Fix heel at/);
assert.match(controls, /recomputes automatically/);
const designConstraints = renderToStaticMarkup(
  createElement(LoadingConstraintFields, {
    inputs: { ...inputs, fixHeel: true, heel: "12" },
    onChange: () => {},
    disabled: false,
    allowHeel: false,
  }),
);
assert.match(designConstraints, /Heel held at 0°/);
assert.match(designConstraints, /Design balance stays upright/);
assert.doesNotMatch(designConstraints, /Fix heel at|Fixed heel in degrees/);
assert.equal((designConstraints.match(/type="checkbox"/g) ?? []).length, 1);
assert.deepEqual(
  readLoadingConstraints(
    { ...inputs, fixHeel: true, heel: "invalid" },
    "balance-design",
  ),
  {
    constraints: { trim: null, heel: 0 },
    error: null,
  },
);
assert.deepEqual(readLoadingConstraints(inputs, "balance-design").constraints, {
  trim: null,
  heel: 0,
});
assert.equal((controls.match(/type="checkbox"/g) ?? []).length, 2);
assert.doesNotMatch(controls, /checked=""|<button/);

const scenarios = [
  { id: "shared", name: "Shared" },
  { id: "crew", name: "Crew to starboard" },
  { id: "bad", name: "Incomplete" },
];
const second = {
  ...proposal,
  waterline: 650,
  deckTrim: radians(2),
  heel: radians(1),
  values: { ...proposal.values, mass: 2100 },
};
const results = new Map<string, LoadingResponse>([
  ["shared", { proposal }],
  ["crew", { proposal: second }],
  ["bad", { error: "TCG has no formula." }],
]);
const renderComparison = (
  showChanges: boolean,
  values: ReadonlyMap<string, LoadingResponse> = results,
  referenceId = "shared",
) =>
  renderToStaticMarkup(
    createElement(LoadingScenarioComparison, {
      scenarios,
      results: values,
      scale: 0.001,
      referenceId,
      onReferenceChange: () => {},
      showChanges,
      onShowChanges: () => {},
    }),
  );
const absolute = renderComparison(false);
assert.match(absolute, /Calculated floating attitudes/);
assert.match(absolute, />0\.6</);
assert.match(absolute, />0\.65</);
assert.match(absolute, /TCG has no formula/);
assert.doesNotMatch(absolute, /Apply|<button|Match displacement|Try another/);
const deltas = renderComparison(true);
assert.match(deltas, /Changes from Shared/);
assert.match(deltas, />\+0\.1</); // mass, tonnes
assert.match(deltas, />\+0\.05</); // waterline depth, metres
assert.match(deltas, />\+5</); // heel, relative to CALCULATED Shared, not upright
const otherReference = renderComparison(true, results, "crew");
assert.match(otherReference, /Changes from Crew to starboard/);
assert.match(otherReference, />-5</);
const pending = renderComparison(
  true,
  new Map([["crew", { proposal: second }]]),
);
assert.match(pending, /Computing…/);
assert.match(pending, /Waiting for the calculated reference/);
assert.doesNotMatch(pending, />0\.65<|>2\.1<|>\+5</);
const unavailable = renderComparison(
  true,
  new Map([
    ["shared", { error: "Missing mass" }],
    ["crew", { proposal: second }],
  ]),
);
assert.match(unavailable, /Reference unavailable/);
assert.match(unavailable, /Missing mass/);
assert.doesNotMatch(unavailable, />0\.65</);
console.log(
  "Loading UI: distinct design/comparison views, constraints, independent statuses and calculated-reference deltas passed.",
);
