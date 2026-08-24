// Stability's private computation worker. It builds its own hull lattice rather than asking the UI window for
// one: no mesh-sized structured clone crosses from the meshing worker through the main thread and back out to
// this worker, and neither cross-curve integration nor the upright KM sweep can block pointer handling.

import { hydrostatics } from "../core/hydro";
import {
  crossCurves,
  limitingKgCurve,
  stationGeometry,
} from "../core/stability";
import { requestedHull } from "./hullComputation";
import type {
  StabilityAnalysis,
  StabilityRequest,
  StabilityResponse,
} from "./stabilityProtocol";

const cacheKey = {};

self.onmessage = (event: MessageEvent<StabilityRequest>) => {
  const { key } = event.data;
  const { model, sampling } = requestedHull(event.data, cacheKey),
    curves = crossCurves(model, sampling),
    geom = stationGeometry(model, sampling);
  let analysis: StabilityAnalysis | null = null;
  if (curves && geom) {
    analysis = {
      curves,
      limit: limitingKgCurve(geom, curves),
      hydro: hydrostatics(model, sampling),
      lowestSheerKg: geom.lowestSheerZ - geom.keelZ,
    };
  }
  const response: StabilityResponse = { key, analysis };
  (self as unknown as Worker).postMessage(response);
};
