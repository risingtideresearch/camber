// Compare the production transom fix with the independent mesh oracle and with
// historical pre-fix measurements. Never patch an in-memory polygon to hide a gap.
import assert from "node:assert/strict";
import { defaultHull } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import { cut, stationGeometry, type StationGeom } from "../src/core/sweep";
import { meshImmersed } from "./support/meshIntegral";
import { camberPlaneMesh } from "../src/analysis/camber/planeMesh";
import { meshImmersion } from "../src/analysis/mesh/immersion";
import { V } from "../src/core/math";

// Captured during the original investigation, at fixed girthSteps=10, in m³.
const beforeFix = [
  [
    1.6230310501269165, 1.6202741018264073, 1.6202834222908689,
    1.6202622570294647,
  ],
  [
    0.990285279664139, 0.9885860493609533, 0.9880829788576928,
    0.9880222183617782,
  ],
];

const volumes = [];
const waterplanes = [];
const percent = (a: number, b: number) => ((a / b - 1) * 100).toFixed(6);
for (const [caseIndex, rake] of [0, 0.07].entries()) {
  const model = assemble({ ...defaultHull(), deckRake: rake });
  // Hold girth resolution fixed: changing both resolutions obscured convergence.
  for (const [resolutionIndex, ns] of [80, 160, 320, 640].entries()) {
    const sampling = computeHullSampling(model, ns, 10);
    const geom = stationGeometry(model, sampling)!;
    const wl = -model.waterline;
    const actual = cut(geom, 0, wl, true);
    assert.equal(
      actual.deckDown,
      false,
      "The independent oracle requires a dry deck",
    );
    const oracle = meshImmersed(model, sampling, geom.keelZ, 0, wl);
    volumes.push({
      trim: rake,
      sections: ns,
      beforeFixM3: beforeFix[caseIndex][resolutionIndex],
      correctedM3: +(actual.vol * 1e-9).toFixed(9),
      meshM3: +(oracle.vol * 1e-9).toFixed(9),
      beforeErrorPct: percent(
        oracle.vol * 1e-9,
        beforeFix[caseIndex][resolutionIndex],
      ),
      correctedErrorPct: percent(oracle.vol, actual.vol),
    });
    if (ns === 640) {
      assert.ok(
        Math.abs(oracle.vol / actual.vol - 1) < 3e-6,
        "The corrected production sweep should agree within 0.0003% at this resolution",
      );
    }
    if (ns !== 160) continue;
    // The fixed waterplane must equal the derivative of the fixed volume,
    // including strips that are bounded by the transom rather than by skin.
    const derivative = (g: StationGeom) =>
      ((cut(g, 0, wl + 0.1).vol - cut(g, 0, wl - 0.1).vol) / 0.2) * 1e-6;
    const sr = Math.sin(rake),
      cr = Math.cos(rake);
    const mesh = camberPlaneMesh(model, sampling);
    const im = meshImmersion(
      mesh,
      {
        origin: V.scale([sr, 0, cr], wl * 0.001),
        u: [cr, 0, -sr],
        v: [0, 1, 0],
      },
      true,
    );
    assert.equal(im.waterplane?.status, "available");
    if (im.waterplane?.status !== "available")
      throw Error("No mesh waterplane");
    const area = im.waterplane.value.measurements.area;
    if (area.status !== "available") assert.fail(area.reason);
    waterplanes.push({
      trim: rake,
      correctedSweepAreaM2: actual.wp!.area * 1e-6,
      correctedVolumeDerivativeM2: derivative(geom),
      meshAreaM2: area.value,
    });
  }
}
console.log("Dry reference-waterline volume; fixed girthSteps=10");
console.table(volumes);
console.log("Waterplane area versus d(volume)/d(waterline), at 160/10");
console.table(waterplanes);
console.log(
  "Production correction; original pre-extraction baseline.json retained, numerical changes recorded in transom-correction.json.",
);
