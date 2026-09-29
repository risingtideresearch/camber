import { loa } from "./hull";
import { unitScale } from "./json";
import type { HullSampling } from "./mesh";
import type { Model } from "./model";
import type { LoadingValues } from "./loading";
import { cut, heightSpan, stationGeometry, type StationGeom } from "./sweep";

export type EquilibriumMode = "displacement" | "balance";
export const MASS_TOLERANCE = 1e-5;
export const BALANCE_TOLERANCE = 1e-5; // fraction of hull length
const MAX_RAKE = Math.PI / 6;

export interface EquilibriumResult {
  readonly waterline: number;
  readonly deckRake: number;
  readonly volumeError: number; // relative
  readonly balanceError: number | null; // metres, horizontal separation of B and G
  readonly values: LoadingValues;
}

function geometry(model: Model, sampling: HullSampling): StationGeom {
  const geom = stationGeometry(model, sampling);
  if (!geom)
    throw new Error("The hull cannot provide hydrostatic measurements.");
  return geom;
}

/** Freeze G as a hull-fixed point. LCG is model x, whereas VCG is world height
 * above K at the INPUT attitude. They must not be compared directly with world B. */
function gravity(model: Model, geom: StationGeom, values: LoadingValues) {
  const scale = unitScale(model.unit, "m");
  if (
    values.lcg === null ||
    values.vcg === null ||
    !Number.isFinite(values.lcg) ||
    !Number.isFinite(values.vcg)
  )
    throw new Error("Balancing requires finite LCG and VCG values.");
  const x = model.plan.at(0)[0] + values.lcg / scale;
  const z = (values.vcg / scale + geom.keelZ - x * geom.sinRake) / geom.cosRake;
  return { x, z };
}

/** Residuals against values expressed in THIS candidate's frame. Used to verify
 * the coupled sheet result after re-evaluating every geometry-dependent formula. */
export function equilibriumResidual(
  model: Model,
  sampling: HullSampling,
  values: LoadingValues,
  density: number,
  mode: EquilibriumMode,
): { volumeError: number; balanceError: number | null } {
  const geom = geometry(model, sampling);
  const scale = unitScale(model.unit, "m");
  const target = values.mass / (density * 1000 * scale ** 3);
  const c = cut(geom, 0, -model.waterline);
  const g = mode === "balance" ? gravity(model, geom, values) : null;
  return {
    volumeError: (c.vol - target) / target,
    balanceError: g
      ? ((c.xB - g.x) * geom.cosRake - (c.zB - g.z) * geom.sinRake) * scale
      : null,
  };
}

/** Pure, bounded solve. Sampling is deck-frame geometry, independent of rake and
 * waterline, so every trial reuses it. Never mutates a model or the live store. */
export function solveEquilibrium(
  model: Model,
  sampling: HullSampling,
  values: LoadingValues,
  density: number,
  mode: EquilibriumMode,
): EquilibriumResult {
  if (
    !(values.mass > 0) ||
    !Number.isFinite(values.mass) ||
    !(density > 0) ||
    !Number.isFinite(density)
  )
    throw new Error(
      "Displacement and water density must be finite and positive.",
    );
  if (Math.abs(model.deckRake) > MAX_RAKE)
    throw new Error("Equilibrium solving supports rake between −30° and 30°.");
  const scale = unitScale(model.unit, "m");
  const target = values.mass / (density * 1000 * scale ** 3);
  const initial = geometry(model, sampling);
  const g = mode === "balance" ? gravity(model, initial, values) : null;
  const length = loa(model);

  const at = (rake: number) => {
    const geom = geometry({ ...model, deckRake: rake }, sampling);
    // Do not solve by treating the open deck as a watertight cap.
    let lo = heightSpan(geom, 0)[0];
    let hi = geom.lowestSheerZ;
    if (cut(geom, 0, hi).vol < target)
      throw new Error(
        "The requested displacement would immerse the sheer at this rake.",
      );
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (cut(geom, 0, mid).vol < target) lo = mid;
      else hi = mid;
    }
    const waterline = -(lo + hi) / 2;
    const c = cut(geom, 0, -waterline, true);
    // Transom-ended columns have a legitimate closing face. A skin which ends
    // before either the transom or centreline must not invent underwater volume.
    if (
      sampling.columns.some(
        (column) =>
          column.pts.length >= 2 &&
          !column.keel &&
          !column.transom &&
          column.pts.some(
            ({ pos }) =>
              pos[0] * geom.sinRake + pos[2] * geom.cosRake < -waterline,
          ),
      )
    )
      throw new Error("The immersed hull has an open section.");
    const balance = g
      ? (c.xB - g.x) * geom.cosRake - (c.zB - g.z) * geom.sinRake
      : 0;
    return { geom, c, waterline, rake, balance };
  };

  let current = at(model.deckRake);
  if (g) {
    // Damped Newton in rake, with a fresh bracketed sinkage solve at every trial.
    for (
      let i = 0;
      i < 35 && Math.abs(current.balance) > length * BALANCE_TOLERANCE;
      i++
    ) {
      const step = 1e-4;
      let probe: ReturnType<typeof at>;
      let delta = step;
      try {
        probe = at(current.rake + step);
      } catch {
        delta = -step;
        probe = at(current.rake - step);
      }
      const derivative = (probe.balance - current.balance) / delta;
      if (!Number.isFinite(derivative) || Math.abs(derivative) < length * 1e-8)
        throw new Error(
          "No longitudinal equilibrium could be found near this attitude.",
        );
      const change = Math.max(
        -0.05,
        Math.min(0.05, -current.balance / derivative),
      );
      let next: ReturnType<typeof at> | null = null;
      for (let damping = 1; damping >= 1 / 128; damping /= 2) {
        const rake = current.rake + change * damping;
        if (Math.abs(rake) > MAX_RAKE) continue;
        try {
          const trial = at(rake);
          if (Math.abs(trial.balance) < Math.abs(current.balance)) {
            next = trial;
            break;
          }
        } catch {
          /* Reduce the step rather than flood the deck. */
        }
      }
      if (!next)
        throw new Error(
          "Balance did not converge within the supported floating attitudes.",
        );
      current = next;
    }
    if (Math.abs(current.balance) > length * BALANCE_TOLERANCE)
      throw new Error("Balance did not converge after 35 iterations.");
  }
  const volumeError = (current.c.vol - target) / target;
  if (
    !Number.isFinite(volumeError) ||
    Math.abs(volumeError) > MASS_TOLERANCE ||
    !Number.isFinite(current.balance)
  )
    throw new Error(
      "The requested loading could not be resolved at this sampling precision.",
    );
  return {
    waterline: current.waterline,
    deckRake: current.rake,
    volumeError,
    balanceError: g ? current.balance * scale : null,
    values: {
      ...values,
      vcg: g
        ? (g.x * current.geom.sinRake +
            g.z * current.geom.cosRake -
            current.geom.keelZ) *
          scale
        : values.vcg,
    },
  };
}
