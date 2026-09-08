import { performance } from "node:perf_hooks";
import { prepareMesh } from "../src/analysis/mesh/prepare";
import { meshSection } from "../src/analysis/mesh/section";
import { meshStability } from "../src/analysis/mesh/compute";
import { camberPlaneMesh } from "../src/analysis/camber/planeMesh";
import { defaultHull } from "../src/core/hull";
import { assemble, defaultSession } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import { cut, stationGeometry } from "../src/core/sweep";
import { meshBackend } from "../src/analysis/mesh/compute";
import { boxSoup, subdivide } from "./support/meshShapes";
function bench(name: string, make: () => ReturnType<typeof prepareMesh>) {
  const t = performance.now(),
    mesh = make(),
    prepareMs = performance.now() - t;
  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t = performance.now();
    const answer = meshSection(mesh, {
      plane: {
        origin: [0.4 + (3.2 * (i + 0.37)) / 100, 0, 0],
        u: [0, 1, 0],
        v: [0, 0, 1],
      },
      envelope: "buoyancy",
    });
    if (answer.status !== "available") throw Error(answer.reason);
    times.push(performance.now() - t);
  }
  const start = performance.now(),
    stability = meshStability(mesh, {
      id: name,
      fixedTrim: 0,
      keelZ: 0,
      referenceWaterlineZ: 1,
    });
  if (stability.status !== "available") throw Error(stability.reason);
  times.sort((a, b) => a - b);
  return {
    name,
    triangles: mesh.faces.length,
    prepareMs: +prepareMs.toFixed(1),
    sectionMedianMs: +times[50].toFixed(3),
    sectionP95Ms: +times[95].toFixed(3),
    stabilityMs: +(performance.now() - start).toFixed(1),
  };
}
let soup = boxSoup();
for (let i = 0; i < 4; i++) soup = subdivide(soup);
const rows = [];
for (let i = 0; i < 3; i++) {
  soup = subdivide(soup);
  rows.push(bench("subdivided box", () => prepareMesh(soup)));
}
console.table(rows);
// Convergence and closure difference are measured separately from floating-point error.
const comparisons = [];
for (const rake of [0, 0.07])
  for (const [ns, girth] of [
    [40, 3],
    [80, 6],
    [160, 10],
  ]) {
    const state = { ...defaultHull(), deckRake: rake },
      model = assemble(state, defaultSession(state)),
      sampling = computeHullSampling(model, ns, girth),
      geom = stationGeometry(model, sampling)!;
    const mesh = camberPlaneMesh(model, sampling),
      b = meshBackend(mesh, {
        id: "convergence",
        fixedTrim: rake,
        keelZ: geom.keelZ * 0.001,
        referenceWaterlineZ: -model.waterline * 0.001,
      });
    for (const heel of [0, 0.5, 1.2]) {
      const wl = -model.waterline,
        expected = cut(geom, heel, wl, true),
        actual = b.at(heel, wl * 0.001, true);
      comparisons.push({
        rake,
        ns,
        girth,
        heel,
        deckDown: expected.deckDown,
        volumeErrorPct: +(
          (actual.vol / (expected.vol * 1e-9) - 1) *
          100
        ).toFixed(4),
        knErrorMm: +(
          (actual.kn -
            (expected.yB * Math.cos(heel) +
              (expected.zBWorld - geom.keelZ) * Math.sin(heel)) *
              0.001) *
          1000
        ).toFixed(3),
      });
    }
  }
console.table(comparisons);
