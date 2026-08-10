// ---------- the authored hull: plain, serializable, deeply readonly ----------
//
// This is the hull as the AUTHOR states it, and nothing else: control points, the two scalars, and the
// document's identity. No curves, no samplers, no `x0`, no `viewLen` — those are derived or session state and
// live in `runtime.ts`. A `HullState` survives `structuredClone` and `JSON.stringify` unchanged, which is the
// whole point of separating it: it is what a document holds, what a blend produces, and (from phase 5) what
// crosses a `postMessage` boundary between the owner and a window.
//
// The `readonly` is load-bearing rather than decorative. It is the migration tool: every in-place mutation of
// authored data becomes a compile error, so the type checker enumerates the work instead of a grep. The
// mutable control-point types in `model.ts` are the pre-store editor's own, and go away with it.

import { clamp } from "./math";
import type { Unit } from "./document";

// ---------- authored control points ----------
// Same fields as `model.ts`'s, read-only. See there for what each coordinate means.
export interface PlanCP {
  readonly x: number;
  readonly y: number;
}
export interface TrimCP {
  readonly x: number;
  readonly z: number;
  readonly k: number;
}
export interface TransomCP {
  readonly x: number;
  readonly z: number;
}
export interface StationPointCP {
  readonly n: number;
  readonly z: number;
  readonly k: number;
}
export interface StationCP {
  readonly u: number;
  readonly keelK: number;
  readonly points: readonly StationPointCP[];
}

export interface HullState {
  readonly name: string;
  readonly unit: Unit;
  readonly sheerPlan: readonly PlanCP[];
  readonly sheerTrim: readonly TrimCP[];
  readonly transom: readonly TransomCP[]; // exactly 2: [top, bottom]
  readonly stations: readonly StationCP[]; // K ≥ 1, strictly increasing in u
  readonly waterline: number; // depth (≥ 0) of the design waterline below the deck datum
  readonly deckRake: number; // radians, +ve = bow up
}

// ---------- the hull's own scale ----------
// The plan's first control point is pinned at the transom, so its last one is the length overall. Stated over
// the authored plan alone, so a document can be measured without being assembled.
export const loa = (hull: { readonly sheerPlan: readonly PlanCP[] }): number =>
  hull.sheerPlan[hull.sheerPlan.length - 1].x - hull.sheerPlan[0].x;

// ---------- editor policy ----------
// The minimum spacing the edit operations keep between two stations, in the plan's parameter. A document may
// legally carry stations closer than this and still be a readable hull — `invariants.ts` checks the two
// levels apart.
export const U_GAP = 0.02;

// The fewest control points the remove operations will reduce a curve to.
export const MIN_PLAN_CP = 3;
export const MIN_TRIM_CP = 3;
export const MIN_STATION_PTS = 3;

// How big the 2D panels are drawn: the half-breadth band the plan strip reserves, and the box the station
// editor is fitted to. A normalized model could hard-code these; an absolute one can't, so they are fractions
// of a hull length, chosen to reproduce the original numbers on a 1000-long hull.
//
// They are NOT limits on the sheer plan or the sheer trim — those two are dragged freely, and a control point
// taken past the edge of its panel simply lands outside it, to be reached by panning or zooming out. The
// station editor still clamps its section points to this box, which is why the drawn box and those clamps come
// from one place.
//
// The length they are taken against is `viewLen`, which is session state, so these are NOT invariants of an
// authored hull — a station point's `n` cannot be checked without knowing which hull the views were laid out
// for.
export interface Bounds {
  yMax: number; // plan half-breadth the strip is sized for
  yMin: number; // band below the centerline, where a tumblehome bow's plan crosses
  nMin: number; // outboard (tumblehome) limit of a station point
  nMax: number; // inboard limit
  zMin: number; // deepest a station point may go
}
export function boundsOf(len: number): Bounds {
  const l = len || 1;
  return {
    yMax: 0.275 * l,
    yMin: -0.055 * l,
    nMin: -0.113 * l,
    nMax: 0.338 * l,
    zMin: -0.338 * l,
  };
}

// ---------- defaults ----------
// A 5 m hull in millimetres. The v1 defaults at their original numbers, reading the old unitless 1000-long
// scale as millimetres and scaling ×5 to a believable boat — the same shape at a size the unit makes sense of.
// Stations sit where v1's two templates had their weight peaks: the ends.
const DEF_LEN = 5000;
const S = (v: number): number => (v * DEF_LEN) / 1000; // v1 units → this default's millimetres

const PLAN_DEF: readonly (readonly [number, number])[] = [
  [0, 205],
  [250, 225],
  [500, 220],
  [750, 160],
  [1000, 0],
];
const TRIM_DEF: readonly (readonly [number, number])[] = [
  [0, -15],
  [333, -70],
  [667, -65],
  [1000, -10],
];
const TRANSOM_DEF: readonly (readonly [number, number])[] = [
  [38, -14],
  [95, -180],
];
// [n, z, k] per point, aft station then forward. The bilge (index 2) is a hard chine aft (k=1) fading to a
// round bilge forward (k=0): a hard-chine planing stern blending into a soft bow along the one hull.
const STATION_DEFS: readonly {
  readonly u: number;
  readonly keelK: number;
  readonly pts: readonly (readonly [number, number, number])[];
}[] = [
  {
    u: 0,
    keelK: 0,
    pts: [
      [0, 0, 0],
      [23, -80, 0],
      [65, -160, 1],
      [140, -220, 0],
      [245, -250, 0],
    ],
  },
  {
    u: 1,
    keelK: 0,
    pts: [
      [0, 0, 0],
      [38, -108, 0],
      [100, -210, 0],
      [180, -280, 0],
      [255, -305, 0],
    ],
  },
];

/** A newly allocated default hull. No branch is shared with another call. */
export function defaultHull(): HullState {
  return {
    name: "",
    unit: "mm",
    sheerPlan: PLAN_DEF.map(([x, y]) => ({ x: S(x), y: S(y) })),
    sheerTrim: TRIM_DEF.map(([x, z]) => ({ x: S(x), z: S(z), k: 0 })),
    transom: TRANSOM_DEF.map(([x, z]) => ({ x: S(x), z: S(z) })),
    stations: STATION_DEFS.map((st) => ({
      u: st.u,
      keelK: st.keelK,
      points: st.pts.map(([n, z, k]) => ({ n: S(n), z: S(z), k })),
    })),
    waterline: S(150),
    deckRake: 0,
  };
}

/** Deep copy at the authored-data boundary. Also the way out of a legacy mutable model. */
export function cloneHull(state: HullState): HullState {
  return {
    name: state.name,
    unit: state.unit,
    sheerPlan: state.sheerPlan.map((p) => ({ ...p })),
    sheerTrim: state.sheerTrim.map((p) => ({ ...p })),
    transom: state.transom.map((p) => ({ ...p })),
    stations: state.stations.map((st) => ({
      u: st.u,
      keelK: st.keelK,
      points: st.points.map((p) => ({ ...p })),
    })),
    waterline: state.waterline,
    deckRake: state.deckRake,
  };
}

/** Rescale the length-dimensioned coordinates into `unit`, keeping the hull the same physical size. */
export function withUnit(
  state: HullState,
  unit: Unit,
  scale: number,
): HullState {
  if (scale === 1) return { ...cloneHull(state), unit };
  return {
    name: state.name,
    unit,
    sheerPlan: state.sheerPlan.map((p) => ({ x: p.x * scale, y: p.y * scale })),
    sheerTrim: state.sheerTrim.map((p) => ({
      x: p.x * scale,
      z: p.z * scale,
      k: p.k,
    })),
    transom: state.transom.map((p) => ({ x: p.x * scale, z: p.z * scale })),
    stations: state.stations.map((st) => ({
      u: st.u,
      keelK: st.keelK,
      points: st.points.map((p) => ({
        n: p.n * scale,
        z: p.z * scale,
        k: p.k,
      })),
    })),
    waterline: state.waterline * scale,
    deckRake: state.deckRake,
  };
}

/** The knuckle clamp the authored schema promises, applied where a value is admitted from outside. */
export const knuckleOf = (k: number): number =>
  isFinite(k) ? clamp(k, 0, 1) : 0;

// The invariants these types promise live in `invariants.ts`, imported from there rather than re-exported
// here: they read this module's policy constants, and a re-export would make the pair a cycle.
