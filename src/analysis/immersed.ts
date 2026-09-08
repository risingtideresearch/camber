// Worker-local numerical boundary: a sweep and a triangle envelope answer the same
// immersed operations without pretending triangles are authored stations.
import { pchipSlopes } from "../core/pchip";
import type { CrossCurves, LimitingKgPoint } from "./stability";
export interface ImmersedSample {
  vol: number;
  yB: number;
  zB: number; // above K, in the fixed-trim upright frame
  kn: number;
  deckDown: boolean | null;
  sheerZ: number; // NaN when no annotated reference exists
  waterplane?: { it: number };
}
export interface ImmersedBackend {
  keelZ: number;
  heightSpan(heel: number): [number, number];
  at(heel: number, waterline: number, moments?: boolean): ImmersedSample;
  /** Preserve Camber's existing open/capped-hull KMt domain. */
  omitImmersedReference: boolean;
  volumeEpsilon?: number;
  /** Camber retains its historical dry endpoint; new backends can exclude an
   * undefined dry-limit KN rather than interpolate from an invented arm. */
  retainDryEndpoint?: boolean;
}
export interface CrossCurveOptions {
  heel?: number[];
  steps?: number;
}
export function buildCrossCurves(
  backend: ImmersedBackend,
  opts: CrossCurveOptions = {},
): CrossCurves {
  const steps = Math.max(4, Math.round(opts.steps ?? 32));
  if (!Number.isFinite(steps) || steps > 512)
    throw new Error("Use 4…512 sinkage steps");
  if (opts.heel?.some((h) => !Number.isFinite(h)))
    throw new Error("Heel angles must be finite");
  const heel = (opts.heel ?? Array.from({ length: 19 }, (_, i) => i * 5))
    .map((d) => d * (Math.PI / 180))
    .sort((a, b) => a - b)
    .filter((v, i, a) => i === 0 || v > a[i - 1] + 1e-12);
  if (
    !heel.length ||
    heel.length > 181 ||
    heel.some((h) => !Number.isFinite(h))
  )
    throw new Error("Use 1…181 finite heel angles");
  const out: CrossCurves = {
    keelZ: backend.keelZ,
    heel,
    vol: [],
    kn: [],
    wl: [],
    deckDown: [],
    sheerZ: [],
    knSlope: [],
    wlSlope: [],
  };
  for (const phi of heel) {
    const [hMin, hMax] = backend.heightSpan(phi),
      vol: number[] = [],
      kn: number[] = [],
      wl: number[] = [],
      dd: (boolean | null)[] = [];
    let sheerZ = Infinity;
    for (let k = 0; k <= steps; k++) {
      const wlZ = hMin + ((hMax - hMin) * k) / steps,
        im = backend.at(phi, wlZ);
      sheerZ = im.sheerZ;
      if (
        backend.retainDryEndpoint === false &&
        im.vol <= (backend.volumeEpsilon ?? 1e-12)
      )
        continue;
      if (
        vol.length &&
        im.vol <= vol[vol.length - 1] + (backend.volumeEpsilon ?? 1e-12)
      )
        continue;
      vol.push(im.vol);
      kn.push(im.kn);
      wl.push(wlZ);
      dd.push(im.deckDown);
    }
    out.vol.push(vol);
    out.kn.push(kn);
    out.wl.push(wl);
    out.deckDown.push(dd);
    out.sheerZ.push(sheerZ);
    out.knSlope.push(vol.length >= 2 ? pchipSlopes(vol, kn) : [0]);
    out.wlSlope.push(vol.length >= 2 ? pchipSlopes(vol, wl) : [0]);
  }
  return out;
}
export function buildInitialStability(
  backend: ImmersedBackend,
  cc: CrossCurves,
): LimitingKgPoint[] {
  const upright = cc.heel.findIndex((heel) => Math.abs(heel) < 1e-12);
  if (upright < 0) return [];
  const out: LimitingKgPoint[] = [];
  for (const wl of cc.wl[upright]) {
    const c = backend.at(0, wl, true);
    if (
      c.vol <= (backend.volumeEpsilon ?? 1e-12) ||
      (backend.omitImmersedReference && c.deckDown) ||
      !c.waterplane
    )
      continue;
    out.push({ vol: c.vol, kg: c.zB + c.waterplane.it / c.vol });
  }
  return out;
}
