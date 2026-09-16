import type { SliceShape } from "./book";

/** Plane positions use the same axes as planar section inputs. Longitudinal
 * positions are world-vertical planes located on the deck-flat z=0 axis. */
export const BOUNDARIES = [
  {
    leaf: "topHeight",
    label: "Top",
    axis: 2,
    sign: 1,
    hint: "Keep below this height above the keel baseline",
  },
  {
    leaf: "bottomHeight",
    label: "Bottom",
    axis: 2,
    sign: -1,
    hint: "Keep above this height above the keel baseline",
  },
  {
    leaf: "aftPosition",
    label: "Aft",
    axis: 0,
    sign: -1,
    hint: "Keep forward of this longitudinal position, using the transverse section datum",
  },
  {
    leaf: "forwardPosition",
    label: "Forward",
    axis: 0,
    sign: 1,
    hint: "Keep aft of this longitudinal position, using the transverse section datum",
  },
  {
    leaf: "portOffset",
    label: "Port",
    axis: 1,
    sign: -1,
    hint: "Keep starboard of this signed offset: negative is port, positive is starboard",
  },
  {
    leaf: "starboardOffset",
    label: "Starboard",
    axis: 1,
    sign: 1,
    hint: "Keep port of this signed offset: negative is port, positive is starboard",
  },
] as const;
export type BoundaryLeaf = (typeof BOUNDARIES)[number]["leaf"];
export type SectionLimits = Readonly<Partial<Record<BoundaryLeaf, number>>>;
/** Formulas stay saved when disabled or made irrelevant by an orientation change.
 * An absent enable flag is false. */
export interface BoundaryFields {
  readonly boundaryEnabled?: Readonly<Partial<Record<BoundaryLeaf, boolean>>>;
  readonly topHeight?: string;
  readonly bottomHeight?: string;
  readonly aftPosition?: string;
  readonly forwardPosition?: string;
  readonly portOffset?: string;
  readonly starboardOffset?: string;
}
export const isBoundaryLeaf = (leaf: string): leaf is BoundaryLeaf =>
  BOUNDARIES.some((b) => b.leaf === leaf);
export const relevantBoundaries = (shape: SliceShape) =>
  BOUNDARIES.filter(
    (b) =>
      shape === "station" ||
      b.axis !== (shape === "plane" ? 2 : shape === "transverse" ? 0 : 1),
  );
/** Inapplicable limits are dormant, not hidden constraints on another orientation. */
export const activeBoundaries = (
  field: BoundaryFields & { shape: SliceShape },
) =>
  relevantBoundaries(field.shape).filter(
    (b) => field.boundaryEnabled?.[b.leaf] === true,
  );
export function validateLimits(limits: SectionLimits): void {
  for (const b of BOUNDARIES)
    if (limits[b.leaf] !== undefined && !Number.isFinite(limits[b.leaf]))
      throw new Error(`${b.label} boundary must be finite`);
  for (const [lo, hi] of [
    ["bottomHeight", "topHeight"],
    ["aftPosition", "forwardPosition"],
    ["portOffset", "starboardOffset"],
  ] as const)
    if (
      limits[lo] !== undefined &&
      limits[hi] !== undefined &&
      limits[lo]! >= limits[hi]!
    )
      throw new Error(
        `${BOUNDARIES.find((b) => b.leaf === lo)!.label} boundary must be less than ${BOUNDARIES.find((b) => b.leaf === hi)!.label} boundary`,
      );
}
