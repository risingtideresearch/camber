// ---------- hull → wake, the layer both wake views share ----------
//
// michell.ts is deliberately geometry-agnostic: it takes a node cloud and gives back a spectrum. This is the
// thin layer that turns a camber Model into one, adds the bits a picture needs (the waterline outline in the
// same frame as the field, where the valid region starts), and sizes the θ grid for a requested view.
//
// The split matters for interactivity, but it is NOT as clean as it first looks. Sampling a hull is the
// expensive step; the spectrum depends on the sample and the SPEED; the field on those and the VIEW. So a view
// that re-renders while a hull is dragged touches none of them. But the SAMPLE ITSELF depends on the speed —
// the kernel's wavelength goes as U², and a grid that resolves it at one speed aliases at a lower one (see
// michell.ts §1b). So the sample is keyed by the resolution class the speed demands, not by the model alone,
// and prepareHullFor is the entry point that gets this right.

import { dwlPointAt } from "./mesh";
import { loa, type Model } from "./model";
import {
  fleetResistance,
  sampleCenterplane,
  sampleForBandwidth,
  sizeFor,
  resolutionOf,
  thetaCutoff,
  thetaGrid,
  waveField,
  DEFAULT_OPTIONS,
  secMaxFor,
  USEFUL_FROUDE,
  G,
  type Centerplane,
  type Conditions,
  type FieldGrid,
  type FieldResult,
  type FleetResult,
  type MichellOptions,
  type Placement,
  type Resolution,
} from "./michell";

export interface HullWake {
  cp: Centerplane;
  outline: [number, number][]; // the design waterline in hydrodynamic (X, Y) metres, starboard side
  sternX: number; // aftmost X [m] — the wake is only physical astern of this
  bowX: number;
  scale: number; // metres per model unit
  // What this sample resolves at the speed it was built for, or null when it was built without one. A cloud
  // sampled for one speed and reused at a LOWER one is under-resolved, silently — see michell.ts §1b — so this
  // travels with the hull rather than being recomputed by whoever happens to use it.
  resolution: Resolution | null;
  options: MichellOptions; // the grid it was built on — cache on this to know when a re-sample is due
}

// The speed band worth reporting on for a hull of this waterline length, in m/s. Both ends are USEFUL_FROUDE;
// see michell.ts for why they are where they are. Views should bound their speed control by this rather than
// by a fixed number of knots, because "slow" is a Froude number, not a speed — 6 knots is Fn 0.8 on a dinghy
// and Fn 0.06 on a ship.
export function usefulSpeeds(wettedLength: number): [number, number] {
  const c = Math.sqrt(G * Math.max(wettedLength, 1e-6));
  return [USEFUL_FROUDE[0] * c, USEFUL_FROUDE[1] * c];
}

// The sampling grid a given speed demands of an already-probed hull. Exposed so a caller holding a sample can
// tell whether a new speed needs a fresh one, without paying for the probe again.
// The cutoff this speed calls for on this hull, and the sampling grid that cutoff then demands. The two must
// be chosen together: sizing a cloud for sec 8 and then integrating to sec 26 aliases the very tail the higher
// cutoff was for.
export const secMaxOf = (probe: Centerplane, U: number): number =>
  secMaxFor(U / Math.sqrt(G * probe.wettedLength));

export const bandwidthOptions = (
  probe: Centerplane,
  U: number,
  secMax?: number,
): MichellOptions => sizeFor(probe, G / (U * U), secMax ?? secMaxOf(probe, U));

// The hull's design-waterline contour in the hydrodynamic frame, so it can be drawn straight over the field.
// The DWL sits at Z = 0 by construction, which makes the rotation a plain X = x·cos(rake) − z·sin(rake).
function dwlOutline(model: Model, scale: number, N = 200): [number, number][] {
  const cr = Math.cos(model.deckRake),
    sr = Math.sin(model.deckRake),
    out: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const p = dwlPointAt(model, i / N);
    if (p) out.push([(p[0] * cr - p[2] * sr) * scale, p[1] * scale]);
  }
  return out;
}

// Sample a hull for a KNOWN speed. Prefer this everywhere a speed is in hand: the resolution the kernel needs
// depends on it, and getting that wrong is silent (see michell.ts §1b).
export function prepareHullFor(
  model: Model,
  scale: number,
  U: number,
  secMax?: number,
): HullWake | null {
  const probe = sampleCenterplane(model, scale);
  if (!probe) return null;
  const sec = secMax ?? secMaxFor(U / Math.sqrt(G * probe.wettedLength));
  const got = sampleForBandwidth(model, scale, G / (U * U), sec);
  if (!got) return null;
  return {
    cp: got.cp,
    outline: dwlOutline(model, scale),
    sternX: got.cp.xAft,
    bowX: got.cp.xFwd,
    scale,
    resolution: got.resolution,
    options: got.options,
  };
}

// Build a HullWake on an options set the caller has already chosen (from bandwidthOptions), reporting what it
// resolves at that speed. This is the path a cache takes: decide the grid, compare it to the one in hand,
// re-sample only when it has actually changed.
export function prepareHullOn(
  model: Model,
  scale: number,
  options: MichellOptions,
  U: number,
  secMax?: number,
): HullWake | null {
  const cp = sampleCenterplane(model, scale, options);
  if (!cp) return null;
  const sec = secMax ?? secMaxFor(U / Math.sqrt(G * cp.wettedLength));
  return {
    cp,
    outline: dwlOutline(model, scale),
    sternX: cp.xAft,
    bowX: cp.xFwd,
    scale,
    resolution: resolutionOf(cp, G / (U * U), sec),
    options,
  };
}

// Sample at the geometry floor, with no speed in mind. Only for callers that genuinely have no speed yet (a
// dimensions readout, a probe); anything that will compute resistance or a wake must use prepareHullFor.
export function prepareHull(
  model: Model,
  scale: number,
  options?: Partial<MichellOptions>,
): HullWake | null {
  const cp = sampleCenterplane(model, scale, options);
  if (!cp) return null;
  return {
    cp,
    outline: dwlOutline(model, scale),
    sternX: cp.xAft,
    bowX: cp.xFwd,
    scale,
    resolution: null,
    options: { ...DEFAULT_OPTIONS, ...options },
  };
}

export const loaMetres = (model: Model, scale: number): number =>
  loa(model) * scale;

export interface WakeView {
  xMin: number; // hydrodynamic X range of the picture [m]
  xMax: number;
  yMax: number; // ± transverse extent [m]
  nx: number; // pixels
  ny: number;
}

// A view sized to the hulls: mostly wake astern, a little water ahead of the bow so the hull is not on the
// edge, and a transverse half-width comfortably outside the Kelvin wedge over the visible length.
export function defaultView(
  hulls: { at: Placement; h: HullWake }[],
  wakeLengths = 3,
  nx = 520,
): WakeView {
  const aft = Math.min(...hulls.map((k) => k.h.sternX + k.at.dx)),
    fwd = Math.max(...hulls.map((k) => k.h.bowX + k.at.dx));
  const L = Math.max(fwd - aft, 1e-6);
  const xMin = aft - wakeLengths * L,
    xMax = fwd + 0.25 * L;
  // the wedge over the visible wake, with room for the caustic's outer skirt
  const yMax = Math.max(
    0.55 * (xMax - xMin) * Math.tan((19.47 * Math.PI) / 180) + 0.6 * L,
    0.9 * L,
  );
  return {
    xMin,
    xMax,
    yMax,
    nx,
    ny: Math.max(2, Math.round((nx * 2 * yMax) / (xMax - xMin))),
  };
}

export const gridOf = (v: WakeView): FieldGrid => ({
  x0: v.xMin,
  dx: (v.xMax - v.xMin) / (v.nx - 1),
  nx: v.nx,
  y0: -v.yMax,
  dy: (2 * v.yMax) / (v.ny - 1),
  ny: v.ny,
});

export interface FleetWake {
  resistance: FleetResult;
  field: FieldResult;
  grid: FieldGrid;
  validAft: number; // X astern of which the free-wave field is physical
  nu: number;
}

// The largest secθ a raster of this cell size can carry. The wave along the propagation direction has length
// 2π·cos²θ/ν, which collapses as θ → π/2, so beyond some angle every remaining wave is shorter than a few
// pixels — waveField() tapers those to zero, and generating them at all is pure waste. This is the cutoff that
// makes a wake picture affordable: at displacement speeds it is well under half the resistance integral's
// range, and it costs the picture nothing, because what it removes could not have been drawn.
export function fieldSecMax(
  nu: number,
  cell: number,
  cellsPerWave = 3,
): number {
  const lamMin = cellsPerWave * cell;
  return Math.max(1.2, Math.sqrt((2 * Math.PI) / Math.max(nu * lamMin, 1e-12)));
}

// Everything a wake picture needs, in one call.
//
// The resistance and the picture want DIFFERENT angular grids, and using one for both is either wrong or
// wasteful. Resistance is an integral over the hull: its panels are sized by ν·L and it must run out to the
// full cutoff, because the diverging tail carries real resistance. The picture is a reconstruction over a
// raster: its panels are sized by ν·R for the view's reach R (a field point far astern accumulates phase
// ν·secθ·R, so a longer picture needs finer angular sampling or the diverging waves alias), and it stops at
// the angle the raster can resolve. So each gets its own.
export function fleetWake(
  hulls: { h: HullWake; at: Placement }[],
  cond: Conditions,
  view: WakeView,
  dPhase = 2.0,
  secMaxOverride?: number,
): FleetWake {
  const nu = 9.80665 / (cond.U * cond.U);
  const members = hulls.map((k) => ({ cp: k.h.cp, at: k.at }));

  // resistance: panels sized by the longest hull, out to the cutoff this Froude number calls for
  const L = Math.max(...hulls.map((k) => k.h.cp.wettedLength));
  const secMax = secMaxOverride ?? secMaxFor(cond.U / Math.sqrt(G * L));
  const resistance = fleetResistance(
    members,
    cond,
    thetaGrid(nu, L, thetaCutoff(secMax), dPhase),
  );

  // the picture: panels sized by the view's reach, stopped at what the raster can show
  const grid = gridOf(view);
  const reach = Math.max(view.xMax - view.xMin, 2 * view.yMax);
  const cell = Math.max(Math.abs(grid.dx), Math.abs(grid.dy));
  const fg = thetaGrid(
    nu,
    reach,
    thetaCutoff(Math.min(secMax, fieldSecMax(nu, cell))),
    dPhase,
  );
  const fieldParts = fleetResistance(members, cond, fg).parts;
  const field = waveField(fieldParts, fg, nu, grid);

  return {
    resistance,
    field,
    grid,
    validAft: Math.min(...hulls.map((k) => k.h.sternX + k.at.dx)),
    nu,
  };
}

export type { Centerplane, Conditions, Placement };
