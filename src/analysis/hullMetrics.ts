// Geometry-independent HULL.* catalogue. Values are SI and positions use the weight frame.
// Missing individual measurements are NaN internally, with per-name reasons at the formula boundary.
import {
  AREA,
  DIMLESS,
  LENGTH,
  VOLUME,
  exact,
  type Dim,
  type Quantity,
} from "../core/sheet/quantity";

/**
 * Everything the sheet can read off the hull, already in metres and cubic metres.
 *
 * Structured-cloneable on purpose: it is computed in the stability worker alongside the hydrostatics that
 * feed it and travels back to the window as plain numbers.
 */
export interface HullMetrics {
  readonly unavailable?: Readonly<Record<string, string>>;
  readonly provenance?: Readonly<Record<string, string>>;
  /** Measured transverse shell centroid; absent on legacy symmetric Camber metrics. */
  readonly shellTcg?: number;
  readonly loa: number;
  readonly lwl: number;
  readonly bwl: number;
  readonly draft: number;
  readonly waterline: number;
  readonly deckRakeDeg: number;
  readonly dispVol: number;
  readonly wsa: number;
  readonly waterplaneArea: number;
  readonly midshipArea: number;
  readonly maxSectionArea: number;
  /** From the transom, like every other position here — see the header. */
  readonly lcb: number;
  readonly lcf: number;
  /** Above the keel baseline, as the stability panel reads KG. */
  readonly kb: number;
  readonly bmt: number;
  readonly kmt: number;
  readonly cb: number;
  readonly cp: number;
  readonly cm: number;
  readonly cw: number;
  readonly deadrise: number;
  readonly halfEntrance: number;
  /** The whole trimmed shell, above and below the waterline. */
  readonly shellArea: number;
  /** Everything inside it, up to the sheer. */
  readonly hullVol: number;
  /** Where the whole shell acts: its own area centroid, in the same frame as LCB and KB. */
  readonly shellLcg: number;
  readonly shellVcg: number;
}

export interface MetricSpec {
  /** The name a formula uses, after `HULL.`. */
  readonly name: string;
  readonly dim: Dim;
  /** How it is displayed and what a designer calls it. */
  readonly label: string;
  readonly hint: string;
  readonly read: (m: HullMetrics) => number;
}

const DEG = DIMLESS; // an angle in degrees is a plain number to the algebra

/**
 * The catalogue. Order is the order the panel's reference list shows, grouped roughly the way a hydrostatics
 * table is: principal dimensions, then areas and volumes, then centroids, then the coefficients.
 */
export const HULL_METRICS: readonly MetricSpec[] = [
  {
    name: "LOA",
    dim: LENGTH,
    label: "LOA",
    hint: "Length overall, transom to bow",
    read: (m) => m.loa,
  },
  {
    name: "LWL",
    dim: LENGTH,
    label: "LWL",
    hint: "Waterline length at the design waterline",
    read: (m) => m.lwl,
  },
  {
    name: "BWL",
    dim: LENGTH,
    label: "BWL",
    hint: "Maximum waterline beam",
    read: (m) => m.bwl,
  },
  {
    name: "DRAFT",
    dim: LENGTH,
    label: "T",
    hint: "Deepest immersion below the waterplane",
    read: (m) => m.draft,
  },
  {
    name: "WATERLINE",
    dim: LENGTH,
    label: "WL",
    hint: "Depth of the design waterline below the deck datum",
    read: (m) => m.waterline,
  },
  {
    name: "DECK_RAKE",
    dim: DEG,
    label: "rake",
    hint: "Deck rake in degrees, bow up positive",
    read: (m) => m.deckRakeDeg,
  },

  {
    name: "SHELL_AREA",
    dim: AREA,
    label: "shell area",
    hint: "The whole trimmed shell, above and below the waterline — what a shell weight is estimated from",
    read: (m) => m.shellArea,
  },
  {
    name: "WSA",
    dim: AREA,
    label: "WSA",
    hint: "Wetted surface at the design waterline",
    read: (m) => m.wsa,
  },
  {
    name: "AW",
    dim: AREA,
    label: "Aw",
    hint: "Waterplane area",
    read: (m) => m.waterplaneArea,
  },
  {
    name: "AM",
    dim: AREA,
    label: "Am",
    hint: "Immersed section at amidships",
    read: (m) => m.midshipArea,
  },
  {
    name: "AMAX",
    dim: AREA,
    label: "Amax",
    hint: "Largest immersed section",
    read: (m) => m.maxSectionArea,
  },
  {
    name: "DISP_VOL",
    dim: VOLUME,
    label: "∇",
    hint: "Displaced volume at the design waterline",
    read: (m) => m.dispVol,
  },
  {
    name: "HULL_VOL",
    dim: VOLUME,
    label: "hull volume",
    hint: "Moulded volume inside the whole shell, up to the sheer",
    read: (m) => m.hullVol,
  },

  {
    name: "SHELL_LCG",
    dim: LENGTH,
    label: "shell LCG",
    hint: "Where the shell's own weight acts, fore and aft, from the transom — the skin area's centroid",
    read: (m) => m.shellLcg,
  },
  {
    name: "SHELL_VCG",
    dim: LENGTH,
    label: "shell VCG",
    hint: "…and how high above the keel. Multiply the shell's mass by these and it is placed, not guessed",
    read: (m) => m.shellVcg,
  },
  {
    name: "LCB",
    dim: LENGTH,
    label: "LCB",
    hint: "Longitudinal centre of buoyancy, from the transom",
    read: (m) => m.lcb,
  },
  {
    name: "LCF",
    dim: LENGTH,
    label: "LCF",
    hint: "Longitudinal centre of flotation, from the transom",
    read: (m) => m.lcf,
  },
  {
    name: "KB",
    dim: LENGTH,
    label: "KB",
    hint: "Height of the centre of buoyancy above the keel",
    read: (m) => m.kb,
  },
  {
    name: "BMT",
    dim: LENGTH,
    label: "BMt",
    hint: "Transverse metacentric radius",
    read: (m) => m.bmt,
  },
  {
    name: "KMT",
    dim: LENGTH,
    label: "KMt",
    hint: "Transverse metacentre above the keel",
    read: (m) => m.kmt,
  },

  {
    name: "CB",
    dim: DIMLESS,
    label: "Cb",
    hint: "Block coefficient",
    read: (m) => m.cb,
  },
  {
    name: "CP",
    dim: DIMLESS,
    label: "Cp",
    hint: "Prismatic coefficient",
    read: (m) => m.cp,
  },
  {
    name: "CM",
    dim: DIMLESS,
    label: "Cm",
    hint: "Midship coefficient",
    read: (m) => m.cm,
  },
  {
    name: "CW",
    dim: DIMLESS,
    label: "Cw",
    hint: "Waterplane coefficient",
    read: (m) => m.cw,
  },
  {
    name: "DEADRISE",
    dim: DEG,
    label: "deadrise",
    hint: "Deadrise at amidships, in degrees",
    read: (m) => m.deadrise,
  },
  {
    name: "HALF_ENTRANCE",
    dim: DEG,
    label: "½ entrance",
    hint: "Waterline half-angle of entrance at the bow, in degrees",
    read: (m) => m.halfEntrance,
  },
];

/**
 * A hull measurement that is a PLACE rather than a number.
 *
 * The shell's centroid is already here as `SHELL_LCG` and `SHELL_VCG`, and multiplying a mass by each of
 * them is how a shell weight has always been placed. But a centre of gravity is a sum of masses times
 * POSITIONS, and written that way the hull's own contribution had to be spelled out per axis while every
 * other term named a point — three copies of the schedule instead of one.
 *
 * So the same numbers are offered under one name, as a place: `HULL.SHELL_CG` in a coordinate cell is that
 * cell's own coordinate, exactly as a point row or a slice's centroid is (see `evaluate.ts`). It weighs into
 * a CG beside them, in one expression:
 *
 *   (Weights.shell * HULL.SHELL_CG + Weights.engine * engine + …) / Weights.total
 *
 * `y` is zero because an authored hull is symmetric about its centreline, and a shell centroid that was
 * anywhere else would be saying the surface is not. It is stated rather than omitted so that the place is a
 * whole place, and the day an asymmetric hull exists this is the line that changes.
 */
export interface MetricPointSpec {
  readonly name: string;
  readonly label: string;
  readonly hint: string;
  readonly x: (m: HullMetrics) => number;
  readonly y: (m: HullMetrics) => number;
  readonly z: (m: HullMetrics) => number;
}

export const HULL_POINTS: readonly MetricPointSpec[] = [
  {
    name: "SHELL_CG",
    label: "shell CG",
    hint: "Where the shell's own weight acts, as a place — weigh it into a centre of gravity beside the points",
    x: (m) => m.shellLcg,
    y: (m) => m.shellTcg ?? 0,
    z: (m) => m.shellVcg,
  },
];

const BY_NAME = new Map(HULL_METRICS.map((spec) => [spec.name, spec]));
const POINTS_BY_NAME = new Map(HULL_POINTS.map((spec) => [spec.name, spec]));

/** Resolve one `HULL.<name>` to an exact quantity, or `null` if there is no such metric. */
export function hullMetric(
  metrics: HullMetrics,
  name: string,
): Quantity | null {
  const spec = BY_NAME.get(name);
  if (!spec) return null;
  return exact(spec.read(metrics), spec.dim);
}

export const isHullMetricName = (name: string): boolean =>
  BY_NAME.has(name) || POINTS_BY_NAME.has(name);

/**
 * Resolve one coordinate of a `HULL.<name>` that is a place, or null if there is no such place.
 *
 * A length in every case, and exact — the hull is drawn, not guessed, so nothing here carries a spread.
 */
export function hullPoint(
  metrics: HullMetrics,
  name: string,
  axis: "x" | "y" | "z",
): Quantity | null {
  const spec = POINTS_BY_NAME.get(name);
  return spec ? exact(spec[axis](metrics), LENGTH) : null;
}

export const isHullPointName = (name: string): boolean =>
  POINTS_BY_NAME.has(name);
