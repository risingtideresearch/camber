// Diagnostic only: locate the Phase 2 mesh/sweep volume residual without changing
// production calculations or regenerating the pre-extraction regression fixtures.
import assert from "node:assert/strict";
import { defaultHull } from "../src/core/hull";
import { assemble } from "../src/core/runtime";
import { computeHullSampling, type HullSampling } from "../src/core/mesh";
import { type Model } from "../src/core/model";
import { cut, stationGeometry, type StationGeom } from "../src/core/sweep";
import { meshImmersed } from "./support/meshIntegral";
import { camberPlaneMesh } from "../src/analysis/camber/planeMesh";
import { meshImmersion } from "../src/analysis/mesh/immersion";
import { V } from "../src/core/math";

/** Hypothesis: transom-ended station polygons must close along the transom,
 * not along a horizontal line from the skin endpoint. This intentionally fixes
 * ONLY a copied polygon's lower closure, NOT waterplane moments, missing
 * columns, other closure cases, or production stationGeometry(). */
function probeTransomClosure(
  model: Model,
  sampling: HullSampling,
  original: StationGeom,
): StationGeom {
  const copy = structuredClone(original);
  const [top, bottom] = model.transom;
  const dx = bottom.x - top.x;
  assert.notEqual(dx, 0, "This diagnostic requires a raked transom");
  const dzdx = (bottom.z - top.z) / dx;
  const transomColumns = new Set(
    sampling.columns.filter((c) => c.transom).map((c) => sampling.uParams[c.i]),
  );
  for (const c of copy.cols) {
    if (!transomColumns.has(c.u)) continue;
    // Current layout: skin endpoint, bottom centreline closure, top centreline closure.
    const end = c.poly[c.poly.length - 3];
    const centreline = c.poly[c.poly.length - 2];
    centreline[1] = end[1] + (c.aC - end[0]) * c.nx * dzdx;
  }
  return copy;
}

const volumes = [];
const waterplanes = [];
const percent = (a: number, b: number) => ((a / b - 1) * 100).toFixed(6);
for (const rake of [0, 0.07]) {
  const model = assemble({ ...defaultHull(), deckRake: rake });
  // Hold girth resolution fixed: changing both resolutions obscured convergence.
  for (const ns of [80, 160, 320, 640]) {
    const sampling = computeHullSampling(model, ns, 10);
    const geom = stationGeometry(model, sampling)!;
    const probe = probeTransomClosure(model, sampling, geom);
    const wl = -model.waterline;
    const original = cut(geom, 0, wl, true);
    const adjusted = cut(probe, 0, wl, true);
    assert.equal(
      original.deckDown,
      false,
      "The independent oracle requires a dry deck",
    );
    const oracle = meshImmersed(model, sampling, geom.keelZ, 0, wl);
    volumes.push({
      trim: rake,
      sections: ns,
      sweepM3: +(original.vol * 1e-9).toFixed(9),
      meshM3: +(oracle.vol * 1e-9).toFixed(9),
      missingLitres: +((oracle.vol - original.vol) * 1e-6).toFixed(6),
      originalErrorPct: percent(oracle.vol, original.vol),
      probeErrorPct: percent(oracle.vol, adjusted.vol),
    });
    if (ns === 640) {
      assert.ok(
        Math.abs(oracle.vol / adjusted.vol - 1) < 1e-5,
        "The transom-plane probe should agree within 0.001% at this resolution",
      );
    }
    if (ns !== 160) continue;
    // A polygon-only patch is NOT a complete fix: the waterplane code still
    // integrates from the skin crossing, missing strips bounded by the transom.
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
      reportedSweepAreaM2: original.wp!.area * 1e-6,
      originalVolumeDerivativeM2: derivative(geom),
      probeReportedAreaM2: adjusted.wp!.area * 1e-6,
      probeVolumeDerivativeM2: derivative(probe),
      meshAreaM2: area.value,
    });
  }
}
console.log("Dry reference-waterline volume; fixed girthSteps=10");
console.table(volumes);
console.log("Waterplane area versus d(volume)/d(waterline), at 160/10");
console.table(waterplanes);
console.log(
  "Diagnostic copies only. Production sweep and regression baselines are unchanged.",
);
