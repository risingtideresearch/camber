import { loa } from "./hull";
import { unitScale } from "./json";
import type { HullSampling } from "./mesh";
import type { Model } from "./model";
import type { LoadingConstraints, LoadingValues } from "./loading";
import { cut, heightSpan, stationGeometry, type StationGeom } from "./sweep";

export type EquilibriumMode = "displacement" | "balance";
export const MASS_TOLERANCE = 1e-5;
export const BALANCE_TOLERANCE = 1e-5; // fraction of hull length
const MAX_TRIM = Math.PI / 6;
const MAX_HEEL = Math.PI / 4;

export interface EquilibriumResult {
  readonly waterline: number;
  readonly deckTrim: number;
  readonly heel: number; // radians, starboard positive; private preview, not authored
  readonly volumeError: number;
  readonly balanceError: number | null; // metres, world-horizontal longitudinal separation
  readonly transverseBalanceError: number | null; // metres, world-horizontal transverse separation
  readonly values: LoadingValues;
}

/** The authored model has no heel field. Do not apply only part of a heeled
 * equilibrium, even though its waterline and trim could be stored individually. */
export const canApplyEquilibrium = (result: Pick<EquilibriumResult, "heel">) =>
  Math.abs(result.heel) < 1e-6;

function geometry(model: Model, sampling: HullSampling): StationGeom {
  const geom = stationGeometry(model, sampling);
  if (!geom)
    throw new Error("The hull cannot provide hydrostatic measurements.");
  return geom;
}

/** Sheet coordinates retain their existing zero-heel, trimmed frame. Convert G
 * to a deck-fixed point ONCE, then rotate that point with every trial attitude. */
function gravity(
  model: Model,
  geom: StationGeom,
  values: LoadingValues,
  requireLcg = true,
  requireTcg = false,
) {
  const scale = unitScale(model.unit, "m");
  if (
    values.vcg === null ||
    !Number.isFinite(values.vcg) ||
    (requireLcg && (values.lcg === null || !Number.isFinite(values.lcg)))
  )
    throw new Error("Balancing requires finite LCG and VCG values.");
  if (requireTcg && (values.tcg == null || !Number.isFinite(values.tcg)))
    throw new Error(
      "Free heel requires a finite TCG. Define it in Weights or fix heel.",
    );
  // LCG is immaterial to roll at an unchanged, fixed trim: VCG already gives
  // the trimmed height. Any representative x produces the same transverse arm.
  const lcg = Number.isFinite(values.lcg) ? values.lcg! : 0;
  const x = model.plan.at(0)[0] + lcg / scale;
  const z = (values.vcg / scale + geom.keelZ - x * geom.sinTrim) / geom.cosTrim;
  return { x, y: (Number.isFinite(values.tcg) ? values.tcg! : 0) / scale, z };
}

function separation(
  geom: StationGeom,
  c: ReturnType<typeof cut>,
  g: ReturnType<typeof gravity>,
  heel: number,
) {
  const dx = c.xB - g.x;
  const dz = c.zB - g.z;
  return {
    longitudinal: dx * geom.cosTrim - dz * geom.sinTrim,
    transverse:
      (c.yB - g.y) * Math.cos(heel) +
      (dx * geom.sinTrim + dz * geom.cosTrim) * Math.sin(heel),
  };
}

function constraintsFor(
  model: Model,
  values: LoadingValues,
  mode: EquilibriumMode,
  constraints?: LoadingConstraints,
): LoadingConstraints {
  // Preserve the old longitudinal/displacement API for existing callers. The
  // automatic UI always supplies explicit constraints, so a missing TCG never
  // silently fixes a supposedly free heel.
  return (
    constraints ?? {
      trim: mode === "displacement" ? model.deckTrim : null,
      heel: mode === "displacement" || values.tcg == null ? 0 : null,
    }
  );
}

/** Residuals with sheet values freshly evaluated in this candidate's frame. */
export function equilibriumResidual(
  model: Model,
  sampling: HullSampling,
  values: LoadingValues,
  density: number,
  mode: EquilibriumMode,
  heel = 0,
  constraints?: LoadingConstraints,
): Pick<
  EquilibriumResult,
  "volumeError" | "balanceError" | "transverseBalanceError"
> {
  const geom = geometry(model, sampling);
  const scale = unitScale(model.unit, "m");
  const target = values.mass / (density * 1000 * scale ** 3);
  const c = cut(geom, heel, -model.waterline);
  const fixed = constraintsFor(model, values, mode, constraints);
  const g =
    fixed.trim === null || fixed.heel === null
      ? gravity(model, geom, values, fixed.trim === null, fixed.heel === null)
      : null;
  const errors = g ? separation(geom, c, g, heel) : null;
  return {
    volumeError: (c.vol - target) / target,
    balanceError:
      errors && fixed.trim === null ? errors.longitudinal * scale : null,
    transverseBalanceError:
      errors && fixed.heel === null ? errors.transverse * scale : null,
  };
}

/** Bounded, damped Newton in trim/heel, with bracketed sinkage at every trial.
 * Sampling stays deck-fixed. No intermediate attitude reaches the live store. */
export function solveEquilibrium(
  model: Model,
  sampling: HullSampling,
  values: LoadingValues,
  density: number,
  mode: EquilibriumMode,
  initialHeel = 0,
  constraints?: LoadingConstraints,
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
  const fixed = constraintsFor(model, values, mode, constraints);
  const startingTrim = fixed.trim ?? model.deckTrim;
  const startingHeel = fixed.heel ?? initialHeel;
  if (!Number.isFinite(startingTrim) || Math.abs(startingTrim) > MAX_TRIM)
    throw new Error("Equilibrium solving supports trim between −30° and 30°.");
  if (!Number.isFinite(startingHeel) || Math.abs(startingHeel) > MAX_HEEL)
    throw new Error("Equilibrium solving supports heel between −45° and 45°.");
  const scale = unitScale(model.unit, "m");
  const target = values.mass / (density * 1000 * scale ** 3);
  const solveTrim = fixed.trim === null;
  const solveHeel = fixed.heel === null;
  const g =
    solveTrim || solveHeel
      ? gravity(
          model,
          geometry(model, sampling),
          values,
          solveTrim || Math.abs(startingTrim - model.deckTrim) > 1e-12,
          solveHeel,
        )
      : null;
  const tolerance = loa(model) * BALANCE_TOLERANCE;

  const at = (trim: number, heel: number) => {
    const geom = geometry({ ...model, deckTrim: trim }, sampling);
    let lo = heightSpan(geom, heel)[0];
    // Sheer height is independent of sinkage. Never let a deck cap carry load.
    let hi = cut(geom, heel, lo).sheerZ;
    if (!Number.isFinite(hi) || cut(geom, heel, hi).vol < target)
      throw new Error(
        "The requested loading would immerse the sheer before equilibrium.",
      );
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (cut(geom, heel, mid).vol < target) lo = mid;
      else hi = mid;
    }
    const waterline = -(lo + hi) / 2;
    const c = cut(geom, heel, -waterline);
    if (
      sampling.columns.some(
        (column) =>
          column.pts.length >= 2 &&
          !column.keel &&
          !column.transom &&
          column.pts.some(({ pos }) => {
            const z = pos[0] * geom.sinTrim + pos[2] * geom.cosTrim;
            return (
              z * Math.cos(heel) - Math.abs(pos[1] * Math.sin(heel)) <
              -waterline
            );
          }),
      )
    )
      throw new Error("The immersed hull has an open section.");
    const errors = g
      ? separation(geom, c, g, heel)
      : { longitudinal: 0, transverse: 0 };
    return { geom, c, waterline, trim, heel, ...errors };
  };
  type Trial = ReturnType<typeof at>;
  const norm = (trial: Trial) =>
    Math.hypot(
      solveTrim ? trial.longitudinal : 0,
      solveHeel ? trial.transverse : 0,
    );
  const derivatives = (trial: Trial) => {
    const probe = (axis: "trim" | "heel") => {
      let step = 1e-4;
      let next: Trial;
      try {
        next = at(
          trial.trim + (axis === "trim" ? step : 0),
          trial.heel + (axis === "heel" ? step : 0),
        );
      } catch {
        step = -step;
        next = at(
          trial.trim + (axis === "trim" ? step : 0),
          trial.heel + (axis === "heel" ? step : 0),
        );
      }
      return [
        (next.longitudinal - trial.longitudinal) / step,
        (next.transverse - trial.transverse) / step,
      ];
    };
    const [a, c] = solveTrim ? probe("trim") : [1, 0];
    const [b, d] = solveHeel ? probe("heel") : [0, 1];
    return { a, b, c, d };
  };

  let current = at(startingTrim, startingHeel);
  if (g) {
    for (let i = 0; i < 45 && norm(current) > tolerance; i++) {
      const { a, b, c, d } = derivatives(current);
      const det = solveTrim && solveHeel ? a * d - b * c : solveTrim ? a : d;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-12)
        throw new Error("No equilibrium could be found near this attitude.");
      let dt = !solveTrim
        ? 0
        : solveHeel
          ? (-d * current.longitudinal + b * current.transverse) / det
          : -current.longitudinal / a;
      let dh = !solveHeel
        ? 0
        : solveTrim
          ? (c * current.longitudinal - a * current.transverse) / det
          : -current.transverse / d;
      const limit = Math.max(1, Math.abs(dt) / 0.05, Math.abs(dh) / 0.05);
      dt /= limit;
      dh /= limit;
      let next: Trial | null = null;
      for (let damping = 1; damping >= 1 / 128; damping /= 2) {
        const trim = current.trim + dt * damping;
        const heel = current.heel + dh * damping;
        if (Math.abs(trim) > MAX_TRIM || Math.abs(heel) > MAX_HEEL) continue;
        try {
          const trial = at(trim, heel);
          if (norm(trial) < norm(current)) {
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
    if (norm(current) > tolerance)
      throw new Error("Balance did not converge after 45 iterations.");
    {
      // Hessian of gravitational potential (apart from a positive weight factor).
      // A zero moment at an unstable attitude is not a usable floating equilibrium.
      const { a, b, c, d } = derivatives(current);
      const k11 = -Math.cos(current.heel) * a;
      const k12 = (-Math.cos(current.heel) * b + c) / 2;
      const stable =
        solveTrim && solveHeel
          ? k11 > 0 && d > 0 && k11 * d - k12 * k12 > 0
          : solveTrim
            ? k11 > 0
            : d > 0;
      if (!stable)
        throw new Error(
          "The calculated attitude is not a stable trim/heel equilibrium.",
        );
    }
  }
  const volumeError = (current.c.vol - target) / target;
  if (
    !Number.isFinite(volumeError) ||
    Math.abs(volumeError) > MASS_TOLERANCE ||
    !Number.isFinite(norm(current))
  )
    throw new Error(
      "The requested loading could not be resolved at this sampling precision.",
    );
  return {
    waterline: current.waterline,
    deckTrim: current.trim,
    heel: current.heel,
    volumeError,
    balanceError: solveTrim ? current.longitudinal * scale : null,
    transverseBalanceError: solveHeel ? current.transverse * scale : null,
    values: {
      ...values,
      vcg: g
        ? (g.x * current.geom.sinTrim +
            g.z * current.geom.cosTrim -
            current.geom.keelZ) *
          scale
        : values.vcg,
    },
  };
}
