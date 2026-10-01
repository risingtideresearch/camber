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
  iterate: false,
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
const coupled = computeLoading({ ...request, book, iterate: true });
near(coupled.values.mass, 1000 / 0.7, 0.03, "sheet mass reaches fixed point");
assert.ok(coupled.iterations > 1 && coupled.iterations <= 30);
assert.ok(Math.abs(coupled.volumeError) < MASS_TOLERANCE);
const once = computeLoading({ ...request, book, iterate: false });
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
      iterate: true,
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
