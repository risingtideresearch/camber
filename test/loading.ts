import assert from "node:assert/strict";
import { defaultHull, type HullState } from "../src/core/hull";
import {
  assemble,
  defaultSession,
  initialSliceRevs,
} from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import { hullMetrics } from "../src/core/hullMetrics";
import { cut, stationGeometry } from "../src/core/sweep";
import { unitScale } from "../src/core/json";
import {
  solveEquilibrium,
  equilibriumResidual,
  MASS_TOLERANCE,
} from "../src/core/equilibrium";
import { emptyBook, type WeightBook } from "../src/core/sheet/book";
import { evaluateBook } from "../src/core/sheet/evaluate";
import { loadingOutputs } from "../src/core/sheet/loadingOutputs";
import { DEFAULT_LOADING, loadingKey } from "../src/core/loading";
import {
  computeLoading,
  type LoadingRequest,
} from "../src/worker/loadingComputation";
import { createDocumentStoreServer } from "../src/document-store/server";
import { sameGesture, type HullCommand } from "../src/core/commands";

const near = (a: number, b: number, tolerance: number, message: string) =>
  assert.ok(Math.abs(a - b) < tolerance, `${message}: ${a} versus ${b}`);
const state = defaultHull();
const model = assemble(state);
const sampling = computeHullSampling(model, 80, 8);
const metrics = hullMetrics(model, sampling)!;
const values = {
  mass: metrics.dispVol * 1025,
  vcg: metrics.kb,
  lcg: metrics.lcb,
};

// Matching displacement preserves trim and handles absent CG.
const match = solveEquilibrium(
  model,
  sampling,
  { mass: values.mass * 1.1, vcg: null, lcg: null },
  1.025,
  "displacement",
);
assert.equal(match.deckTrim, model.deckTrim);
assert.equal(match.balanceError, null);
assert.ok(match.waterline < model.waterline);
assert.ok(Math.abs(match.volumeError) < MASS_TOLERANCE);
near(
  solveEquilibrium(model, sampling, values, 1.025, "balance").waterline,
  model.waterline,
  1e-5,
  "G at B preserves attitude",
);

// Recover a known trimmed equilibrium. G is ABOVE B on the same world vertical,
// so its model x is deliberately different from LCB. Feed it in the input frame.
for (const trim of [-0.06, 0.055]) {
  const target = { ...model, deckTrim: trim, waterline: model.waterline - 100 };
  const geom = stationGeometry(target, sampling)!;
  const b = cut(geom, 0, -target.waterline);
  const rise = 200;
  const gx = b.xB + rise * Math.sin(trim);
  const gz = b.zB + rise * Math.cos(trim);
  const input = { ...model, deckTrim: 0.025 };
  const originalGeom = stationGeometry(input, sampling)!;
  const s = unitScale(model.unit, "m");
  const loading = {
    mass: b.vol * s ** 3 * 1025,
    lcg: (gx - model.plan.at(0)[0]) * s,
    vcg:
      (gx * originalGeom.sinTrim +
        gz * originalGeom.cosTrim -
        originalGeom.keelZ) *
      s,
  };
  const solved = solveEquilibrium(input, sampling, loading, 1.025, "balance");
  near(solved.deckTrim, trim, 2e-5, "recovers trim with transformed gravity");
  near(solved.waterline, target.waterline, 0.1, "recovers waterline");
  const final = { ...model, ...solved };
  const residual = equilibriumResidual(
    final,
    sampling,
    solved.values,
    1.025,
    "balance",
  );
  assert.ok(Math.abs(residual.balanceError!) < 0.00005);
}

// SI and millimetre hulls agree. The calculation never mutates its inputs.
const metresHull: HullState = {
  ...state,
  unit: "m",
  waterline: state.waterline / 1000,
  sheerPlan: state.sheerPlan.map((p) => ({ x: p.x / 1000, y: p.y / 1000 })),
  sheerTrim: state.sheerTrim.map((p) => ({
    ...p,
    x: p.x / 1000,
    z: p.z / 1000,
  })),
  transom: state.transom.map((p) => ({ x: p.x / 1000, z: p.z / 1000 })),
  stations: state.stations.map((st) => ({
    ...st,
    points: st.points.map((p) => ({ ...p, n: p.n / 1000, z: p.z / 1000 })),
  })),
};
const metricModel = assemble(metresHull);
const metricSampling = computeHullSampling(metricModel, 80, 8);
const changed = { ...values, lcg: values.lcg + 0.1 };
const before = JSON.stringify(state);
const mmResult = solveEquilibrium(model, sampling, changed, 1.025, "balance");
const mResult = solveEquilibrium(
  metricModel,
  metricSampling,
  changed,
  1.025,
  "balance",
);
near(mmResult.deckTrim, mResult.deckTrim, 1e-7, "unit-independent trim");
near(
  mmResult.waterline / 1000,
  mResult.waterline,
  1e-6,
  "unit-independent waterline",
);
assert.equal(JSON.stringify(state), before);
for (const mass of [0, -1, Infinity, NaN, 1e10])
  assert.throws(() =>
    solveEquilibrium(
      model,
      sampling,
      { ...values, mass },
      1.025,
      "displacement",
    ),
  );
assert.throws(() =>
  solveEquilibrium(model, sampling, { ...values, lcg: null }, 1.025, "balance"),
);
assert.throws(() =>
  solveEquilibrium(model, sampling, { ...values, lcg: 100 }, 1.025, "balance"),
);

const request: LoadingRequest = {
  key: "test",
  state,
  session: defaultSession(state),
  sliceRevs: initialSliceRevs(),
  numSections: 80,
  girthSteps: 8,
  values,
  density: 1.025,
  mode: "balance",
  book: null,
  purpose: "compare-scenarios",
};
const manual = computeLoading(request);
assert.equal(manual.iterations, 1);

// Sheet feedback has a known fixed point, away from the authored waterline.
// Δ = 1000 kg + 0.3 ρ ∇ => Δ = 1000 / 0.7 kg at equilibrium.
const book: WeightBook = {
  ...emptyBook(),
  items: [
    {
      id: "inputs",
      name: "inputs",
      note: "",
      facets: {},
      fields: {
        mass: { k: "scalar", role: null, formula: "1000", unit: "kg" },
        density: { k: "scalar", role: null, formula: "1025", unit: "kg/m3" },
        vcg: { k: "scalar", role: null, formula: "0.5", unit: "m" },
        lcg: { k: "scalar", role: null, formula: "2.1", unit: "m" },
      },
    },
  ],
  outputs: {
    DISPLACEMENT: "inputs.mass + HULL.DISP_VOL * inputs.density * 0.3",
    VCG: "inputs.vcg",
    LCG: "inputs.lcg",
  },
};
const coupled = computeLoading({ ...request, book, purpose: "balance-design" });
near(coupled.values.mass, 1000 / 0.7, 0.03, "sheet mass reaches fixed point");
assert.ok(coupled.iterations > 1 && coupled.iterations <= 30);
assert.ok(Math.abs(coupled.volumeError) < MASS_TOLERANCE);
const once = computeLoading({ ...request, book, purpose: "compare-scenarios" });
assert.equal(once.iterations, 1);
assert.ok(Math.abs(once.values.mass - coupled.values.mass) > 10);
assert.throws(
  () =>
    computeLoading({
      ...request,
      book: {
        ...book,
        outputs: { ...book.outputs, DISPLACEMENT: "inputs.vcg" },
      },
    }),
  /finite mass/,
);
const invalid = loadingOutputs(
  evaluateBook(
    { ...book, outputs: { ...book.outputs, DISPLACEMENT: "inputs.vcg" } },
    null,
  ),
);
assert.equal(invalid.values, null);

// Constant nonzero mass residual never converges, even though the steps shrink.
assert.throws(
  () =>
    computeLoading({
      ...request,
      mode: "displacement",
      purpose: "balance-design",
      book: {
        ...book,
        outputs: {
          ...book.outputs,
          DISPLACEMENT: "HULL.DISP_VOL * inputs.density + inputs.mass * 0.001",
        },
      },
    }),
  /did not converge/,
);

// Shared selection publishes but never dirties the document. Applying attitude
// changes both scalars in one undo step, with authoritative stale-input checks.
const server = createDocumentStoreServer();
const start = server.snapshot();
server.executeSession({
  type: "setLoading",
  patch: { source: "manual", ...values },
});
assert.equal(server.snapshot().revision, start.revision);
assert.equal(server.snapshot().sessionRevision, start.sessionRevision + 1);
assert.equal(server.snapshot().session.loading?.mass, values.mass);
const command: HullCommand = {
  type: "applyFloatingAttitude",
  waterline: mmResult.waterline,
  deckTrim: mmResult.deckTrim,
  expectedRevision: server.snapshot().revision,
  expectedLoading: loadingKey(server.snapshot().session.loading),
  vcg: mmResult.values.vcg,
  label: "Manual loading",
};
assert.equal(sameGesture(command, command), false);
assert.ok(!("rejected" in server.execute({ author: "loading", command })));
assert.equal(server.snapshot().state.hull.waterline, mmResult.waterline);
assert.equal(server.snapshot().state.hull.deckTrim, mmResult.deckTrim);
assert.equal(
  server.snapshot().session.lastBalance?.revision,
  server.snapshot().revision,
);
assert.ok("rejected" in server.execute({ author: "loading", command }));
assert.ok(server.undo());
assert.equal(
  server.snapshot().state.hull.waterline,
  start.state.hull.waterline,
);
assert.equal(server.snapshot().state.hull.deckTrim, start.state.hull.deckTrim);
assert.equal(server.snapshot().canUndo, false);
assert.ok(server.redo());
const fresh = {
  ...command,
  expectedRevision: server.snapshot().revision,
  expectedLoading: loadingKey(server.snapshot().session.loading),
};
server.executeSession({ type: "setLoading", patch: { lcg: 3 } });
assert.ok("rejected" in server.execute({ author: "loading", command: fresh }));
// A weight-scenario solve is independent of Stability's transient selection.
const scenarioCommand: HullCommand = {
  ...command,
  expectedRevision: server.snapshot().revision,
  expectedLoading: null,
  scenarioId: null,
  vcg: 99, // Must not overwrite the manual Stability point's VCG.
  label: "Shared estimate",
};
server.executeSession({ type: "setLoading", patch: { mass: 4200, vcg: 0.75 } });
const stabilityBefore = server.snapshot().session.loading;
assert.ok(
  !(
    "rejected" in
    server.execute({ author: "weights", command: scenarioCommand })
  ),
);
assert.deepEqual(server.snapshot().session.loading, stabilityBefore);
assert.equal(server.snapshot().state.hull.waterline, scenarioCommand.waterline);
assert.equal(server.snapshot().state.hull.deckTrim, scenarioCommand.deckTrim);
assert.equal(
  server.snapshot().session.lastBalance?.loadingKey,
  loadingKey(DEFAULT_LOADING),
);
// Geometry/document revision checks still protect scenario-based applications.
assert.ok(
  "rejected" in server.execute({ author: "weights", command: scenarioCommand }),
);
assert.equal(loadingKey(undefined), loadingKey(DEFAULT_LOADING));
console.log(
  "Loading: numerical equilibrium, sheet feedback, validation, shared state and atomic application passed.",
);

// Recover both rotations from a known floating attitude. Construct G above B
// along the WORLD vertical, then express it in the INPUT sheet frame.
for (const heel of [-0.1, 0.1]) {
  const trim = 0.04;
  const target = { ...model, deckTrim: trim, waterline: model.waterline - 60 };
  const geom = stationGeometry(target, sampling)!;
  const b = cut(geom, heel, -target.waterline);
  assert.equal(b.deckDown, false);
  const rise = 160;
  const gx = b.xB + rise * Math.sin(trim) * Math.cos(heel);
  const gy = b.yB - rise * Math.sin(heel);
  const gz = b.zB + rise * Math.cos(trim) * Math.cos(heel);
  const initialGeom = stationGeometry(model, sampling)!;
  const s = unitScale(model.unit, "m");
  const loading = {
    mass: b.vol * s ** 3 * 1025,
    lcg: (gx - model.plan.at(0)[0]) * s,
    tcg: gy * s,
    vcg:
      (gx * initialGeom.sinTrim +
        gz * initialGeom.cosTrim -
        initialGeom.keelZ) *
      s,
  };
  const solved = solveEquilibrium(model, sampling, loading, 1.025, "balance");
  near(solved.deckTrim, trim, 2e-5, "recovers coupled trim");
  near(solved.heel, heel, 2e-5, "recovers coupled heel");
  near(solved.waterline, target.waterline, 0.1, "recovers coupled waterline");
  const residual = equilibriumResidual(
    { ...model, ...solved },
    sampling,
    solved.values,
    1.025,
    "balance",
    solved.heel,
  );
  assert.ok(Math.abs(residual.balanceError!) < 0.00005);
  assert.ok(Math.abs(residual.transverseBalanceError!) < 0.00005);
  const metres = solveEquilibrium(
    metricModel,
    metricSampling,
    loading,
    1.025,
    "balance",
  );
  near(solved.heel, metres.heel, 1e-7, "unit-independent heel");
  near(solved.deckTrim, metres.deckTrim, 1e-7, "unit-independent coupled trim");
}

const offCentre = { ...changed, tcg: 0.05 };
const starboard = solveEquilibrium(
  model,
  sampling,
  offCentre,
  1.025,
  "balance",
);
const port = solveEquilibrium(
  model,
  sampling,
  { ...offCentre, tcg: -0.05 },
  1.025,
  "balance",
);
assert.ok(starboard.heel > 0);
near(port.heel, -starboard.heel, 1e-8, "mirrored TCG mirrors heel");
near(port.deckTrim, starboard.deckTrim, 1e-8, "mirrored TCG preserves trim");
near(
  port.waterline,
  starboard.waterline,
  1e-5,
  "mirrored TCG preserves sinkage",
);
near(
  solveEquilibrium(model, sampling, { ...values, tcg: 0 }, 1.025, "balance")
    .heel,
  0,
  1e-8,
  "centred load remains upright",
);
assert.throws(
  () =>
    solveEquilibrium(
      model,
      sampling,
      { ...values, tcg: NaN },
      1.025,
      "balance",
    ),
  /TCG/,
);
assert.throws(
  () =>
    solveEquilibrium(
      model,
      sampling,
      { ...values, tcg: 0, vcg: 100 },
      1.025,
      "balance",
    ),
  /stable|equilibrium|converge/,
);
assert.throws(
  () =>
    solveEquilibrium(
      model,
      sampling,
      { ...values, tcg: 100 },
      1.025,
      "balance",
    ),
  /sheer|equilibrium|converge/,
);

// Heeled waterplane integration agrees with the derivative of displaced volume.
const heeledGeom = stationGeometry(model, sampling)!;
const height = -starboard.waterline;
const step = 0.01;
const heeledCut = cut(heeledGeom, starboard.heel, height, true);
const areaFromVolume =
  (cut(heeledGeom, starboard.heel, height + step).vol -
    cut(heeledGeom, starboard.heel, height - step).vol) /
  (2 * step);
near(
  heeledCut.wp!.area,
  areaFromVolume,
  areaFromVolume * 0.0001,
  "heeled waterplane is volume derivative",
);
assert.ok(heeledCut.wp!.it > 0 && heeledCut.wp!.il > 0);

// Design balance is explicitly upright and updates the sheet. Scenario
// comparison freezes its estimate and can solve heel. Neither edits the input.
const heeledBook: WeightBook = {
  ...book,
  outputs: { ...book.outputs, TCG: "0.04 * inputs.vcg / 0.5" },
};
const bookBefore = JSON.stringify(heeledBook);
const design = computeLoading({
  ...request,
  book: heeledBook,
  purpose: "balance-design",
});
const experiment = computeLoading({
  ...request,
  book: heeledBook,
  purpose: "compare-scenarios",
});
assert.equal(design.heel, 0);
assert.equal(design.transverseBalanceError, null);
assert.ok(experiment.heel > 0);
assert.ok(design.iterations > 1);
assert.equal(experiment.iterations, 1);
near(
  design.values.mass,
  1000 / 0.7,
  0.03,
  "upright design sheet reaches fixed point",
);
near(
  experiment.values.mass,
  loadingOutputs(evaluateBook(heeledBook, metrics)).values!.mass,
  0.001,
  "scenario keeps starting mass",
);
assert.equal(JSON.stringify(heeledBook), bookBefore);
assert.equal(JSON.stringify(state), before);

const missingTcg = loadingOutputs(evaluateBook(book, metrics));
assert.equal(missingTcg.values!.tcg, null);
assert.ok(missingTcg.errors.some((error) => error.includes("TCG")));
const invalidTcg = loadingOutputs(
  evaluateBook(
    { ...book, outputs: { ...book.outputs, TCG: "inputs.mass" } },
    metrics,
  ),
);
assert.equal(invalidTcg.values!.tcg, null);
assert.ok(invalidTcg.errors.some((error) => /TCG.*finite length/.test(error)));
console.log(
  "Loading: coupled trim/heel, symmetry, stability, heeled integration and calculation purposes passed.",
);

// TCG is not a required design-balance output and cannot tip its result.
for (const tcg of ["", "inputs.mass", "inputs.vcg * 100"]) {
  const uprightDesign = computeLoading({
    ...request,
    purpose: "balance-design",
    constraints: { trim: null, heel: null },
    book: { ...heeledBook, outputs: { ...heeledBook.outputs, TCG: tcg } },
  });
  assert.equal(uprightDesign.heel, 0);
  assert.equal(uprightDesign.transverseBalanceError, null);
  near(
    uprightDesign.waterline,
    design.waterline,
    1e-8,
    "TCG does not affect design sinkage",
  );
  near(
    uprightDesign.deckTrim,
    design.deckTrim,
    1e-10,
    "TCG does not affect design trim",
  );
}

// The explicit constraints used by the automatic UI support all four combinations.
const free = { trim: null, heel: null };
const fixedTrim = solveEquilibrium(
  model,
  sampling,
  offCentre,
  1.025,
  "balance",
  0,
  { trim: starboard.deckTrim, heel: null },
);
near(fixedTrim.deckTrim, starboard.deckTrim, 1e-12, "fixed trim is exact");
near(fixedTrim.heel, starboard.heel, 2e-5, "heel remains free at fixed trim");
assert.equal(fixedTrim.balanceError, null);
assert.ok(Math.abs(fixedTrim.transverseBalanceError!) < 0.00005);
const fixedHeel = solveEquilibrium(
  model,
  sampling,
  offCentre,
  1.025,
  "balance",
  0,
  { trim: null, heel: starboard.heel },
);
near(fixedHeel.heel, starboard.heel, 1e-12, "fixed heel is exact");
near(
  fixedHeel.deckTrim,
  starboard.deckTrim,
  2e-5,
  "trim remains free at fixed heel",
);
assert.equal(fixedHeel.transverseBalanceError, null);
const held = { trim: starboard.deckTrim, heel: starboard.heel };
const fixedBoth = solveEquilibrium(
  model,
  sampling,
  { mass: offCentre.mass, lcg: null, vcg: null, tcg: null },
  1.025,
  "balance",
  0,
  held,
);
near(
  fixedBoth.waterline,
  starboard.waterline,
  0.1,
  "both fixed angles find sinkage only",
);
assert.equal(fixedBoth.deckTrim, held.trim);
assert.equal(fixedBoth.heel, held.heel);
assert.equal(fixedBoth.balanceError, null);
assert.equal(fixedBoth.transverseBalanceError, null);
const rollOnly = solveEquilibrium(
  model,
  sampling,
  { ...offCentre, lcg: null },
  1.025,
  "balance",
  0,
  { trim: model.deckTrim, heel: null },
);
assert.ok(rollOnly.heel > 0);
assert.equal(rollOnly.deckTrim, model.deckTrim);
assert.throws(
  () =>
    solveEquilibrium(
      model,
      sampling,
      { ...offCentre, tcg: null },
      1.025,
      "balance",
      0,
      free,
    ),
  /TCG/,
);
assert.throws(
  () =>
    solveEquilibrium(model, sampling, offCentre, 1.025, "balance", 0, {
      trim: 1,
      heel: 0,
    }),
  /trim/,
);
assert.throws(
  () =>
    solveEquilibrium(model, sampling, offCentre, 1.025, "balance", 0, {
      trim: 0,
      heel: 1,
    }),
  /heel/,
);
// Zero is a fixed angle, not a falsy spelling of "free".
const fixedZero = solveEquilibrium(
  model,
  sampling,
  offCentre,
  1.025,
  "balance",
  0,
  { trim: 0, heel: 0 },
);
assert.equal(fixedZero.deckTrim, 0);
assert.equal(fixedZero.heel, 0);
const fixedResidual = equilibriumResidual(
  { ...model, ...fixedTrim },
  sampling,
  fixedTrim.values,
  1.025,
  "balance",
  fixedTrim.heel,
  { trim: fixedTrim.deckTrim, heel: null },
);
assert.equal(fixedResidual.balanceError, null);
assert.ok(Math.abs(fixedResidual.transverseBalanceError!) < 0.00005);

const constrainedDesign = computeLoading({
  ...request,
  book: heeledBook,
  purpose: "balance-design",
  constraints: { trim: 0.02, heel: 0.04 },
});
assert.equal(constrainedDesign.deckTrim, 0.02);
assert.equal(constrainedDesign.heel, 0);
assert.equal(constrainedDesign.balanceError, null);
assert.equal(constrainedDesign.transverseBalanceError, null);
near(
  constrainedDesign.values.mass,
  1000 / 0.7,
  0.03,
  "held angles still update the design sheet",
);
assert.throws(
  () => computeLoading({ ...request, book, constraints: free }),
  /TCG/,
);

const batchResults: import("../src/worker/loadingComputation").LoadingBatchResponse[] =
  [];
const batchBase = {
  ...request,
  purpose: "compare-scenarios" as const,
  constraints: free,
};
const { computeLoadingBatch } =
  await import("../src/worker/loadingComputation");
computeLoadingBatch(
  {
    ...batchBase,
    entries: [
      { id: "shared", book: heeledBook },
      {
        id: "invalid",
        book: {
          ...heeledBook,
          outputs: { ...heeledBook.outputs, TCG: "inputs.mass" },
        },
      },
      {
        id: "port",
        book: {
          ...heeledBook,
          outputs: { ...heeledBook.outputs, TCG: "-0.04 * inputs.vcg / 0.5" },
        },
      },
    ],
  },
  (result) => batchResults.push(result),
);
assert.deepEqual(
  batchResults.map(({ id }) => id),
  ["shared", "invalid", "port"],
);
assert.ok("error" in batchResults[1]);
assert.ok("proposal" in batchResults[0] && "proposal" in batchResults[2]);
if ("proposal" in batchResults[0] && "proposal" in batchResults[2]) {
  const a = batchResults[0].proposal,
    b = batchResults[2].proposal;
  assert.equal(a.iterations, 1);
  assert.equal(b.iterations, 1);
  near(
    a.values.mass,
    b.values.mass,
    1e-9,
    "comparison rows use the same starting immersion",
  );
  near(
    a.heel,
    -b.heel,
    1e-8,
    "comparison independently mirrors port/starboard loads",
  );
}
assert.equal(JSON.stringify(state), before);
console.log(
  "Loading: explicit constraints, held-angle feedback and independent streaming scenario comparison passed.",
);
