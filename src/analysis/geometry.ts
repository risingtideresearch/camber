// Phase-1 weight geometry DTOs and explicit legacy frame mapping.
// These types describe existing Camber station views; arbitrary-plane regions arrive in phase 2.
import type { Vec2, Vec3 } from "../core/math";

/** Model coordinates ↔ the sheet's frame, for one hull. */
export interface PointFrame {
  /** Metres per model unit. */
  readonly s: number;
  /** The model x the plan starts at — the transom, which is the sheet's x origin. */
  readonly x0: number;
  readonly x1: number;
  readonly keelZ: number;
  readonly cosRake: number;
  readonly sinRake: number;
  /** The hull's own extent in the sheet's frame, which is what the views fit themselves to. */
  readonly xSpan: readonly [number, number];
  readonly ySpan: readonly [number, number];
  readonly zSpan: readonly [number, number];
  /**
   * The sweep parameters a trimmed section actually exists at.
   *
   * Not [0, 1]: the plan starts at the transom CONTROL POINT, and the transom plane trims the surface some
   * way forward of it — so the aft few percent of the plan has no hull on it, and the stem is a point rather
   * than a section. A cut asked for outside this range is answered with the nearest one inside it.
   */
  readonly uSpan: readonly [number, number];
}

/** A model point, in the sheet's frame. */
export function toSheet(frame: PointFrame, p: Vec3): Vec3 {
  return [
    (p[0] - frame.x0) * frame.s,
    p[1] * frame.s,
    (p[0] * frame.sinRake + p[2] * frame.cosRake - frame.keelZ) * frame.s,
  ];
}

/** A sheet-frame point, back in model coordinates — what the 3D overlay draws with. */
export function toModel(frame: PointFrame, p: Vec3): Vec3 {
  const mx = p[0] / frame.s + frame.x0;
  const worldZ = p[2] / frame.s + frame.keelZ;
  return [mx, p[1] / frame.s, (worldZ - mx * frame.sinRake) / frame.cosRake];
}

// ---------- the outlines ----------

/** The hull in side view: its upper and lower envelopes, in sheet (x, z). */
export interface ProfileOutline {
  /** Aft to forward along the top of the silhouette — the sheer, in side view. */
  readonly upper: readonly Vec2[];
  /** Aft to forward along the bottom — the keel and stem. */
  readonly lower: readonly Vec2[];
}

/**
 * Which kind of cut an outline is.
 *
 * A VERTICAL slice is the plane x = const. A point's own x puts it exactly in that plane, which is the only
 * way the pane's question — is this inside the boat — can be asked honestly of a point; and from the side the
 * plane is a plain vertical rule, so the point sits on its own marker at every height.
 *
 * A STATION is the hull's own cut, normal to the plan heading. It is what `slices.ts` measures and what a cut
 * field's `pos` names, so a selected cut is previewed as one — otherwise the shape on screen would not be the
 * shape whose area the inspector is reporting.
 */
export type SectionKind = "vertical" | "station";

/** One cut through the hull, in sheet (y, z). Both halves, because a point may sit on either side. */
export interface SectionOutline {
  readonly kind: SectionKind;
  /** The x the cut was actually taken at, which is the requested one clamped into the hull. */
  readonly x: number;
  /** True when the requested x fell outside the hull and the cut was clamped to reach it. */
  readonly clamped: boolean;
  readonly starboard: readonly Vec2[];
  readonly port: readonly Vec2[];
  /**
   * The same cut seen from the side, in sheet (x, z).
   *
   * For a STATION this is a curve, not a rule: the plane is normal to the plan heading rather than square
   * across the boat, so its x runs with the athwartships offset — 38 mm across the beam at the stock hull's
   * first metre, 198 mm by its third. For a VERTICAL slice every point shares the one x, so it is a rule.
   *
   * One half: the two are mirrored in y and carry the same x, so from the side they lie on each other.
   */
  readonly trace: readonly Vec2[];
}

/**
 * Which station to cut.
 *
 * The two are NOT the same station, and the difference is the whole reason this is a union. `at` is the
 * plane whose plan point sits at that x — what a cut's `pos` names, and what `slices.ts` measures. `through`
 * is the plane that CONTAINS a given place, which is the one a point has to be judged against: a point is in
 * the plane through it and is not in the plane its x looks up, and on the stock hull those are up to 300 mm
 * apart because the plan curve is the sheer and runs a metre off the centreline.
 */
export type SectionAt =
  | { readonly k: "at"; readonly x: number }
  | { readonly k: "through"; readonly x: number; readonly y: number };

export interface HullOutlines {
  readonly frame: PointFrame;
  readonly profile: ProfileOutline;
}

export const SLICE_VALUE_FIELDS = [
  "area",
  "closedPerimeter",
  "openPerimeter",
  "x",
  "y",
  "z",
] as const;
export type SliceValueField = (typeof SLICE_VALUE_FIELDS)[number];

export interface SliceMeasurement {
  readonly area: number;
  /** The complete boundary of the cut, including the straight segments that close it. */
  readonly closedPerimeter: number;
  /** The intersection with the hull skin, without deck or other closing segments. */
  readonly openPerimeter: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Local derivative of each reported value with respect to `pos`, used for first-order uncertainty. */
  readonly derivative: Readonly<Record<SliceValueField, number>>;
  readonly curve: readonly Vec3[];
  readonly centroid: Vec3;
}

export type SliceMeasurements = ReadonlyMap<string, SliceMeasurement>;
export const sliceMeasurementKey = (sheetId: string, rowId: string): string =>
  `${sheetId} ${rowId}`;
