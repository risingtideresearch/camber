// ---------- the hull's own numbers, as a weight sheet reads them ----------
//
// One table binding every `HULL.*` name to a value, a dimension and a line of documentation. It is the only
// place that knows what a sheet can ask the geometry, which is what lets the panel build its reference list
// and its autocomplete from the same source the evaluator resolves against.
//
// Two things are settled here rather than at each call site:
//
//   UNITS. A document is drawn in whatever unit its author chose — a 5 m hull in millimetres runs x from 0 to
//   5000 — while a weight sheet works in METRES and KILOGRAMS and nothing else. Every length below is scaled
//   on the way out (areas by s², volumes by s³), so `HULL.LWL` is a number of metres whatever the drawing is
//   in, and a formula never has to know or ask.
//
//   CERTAINTY. Every one of these is EXACT. The hull is drawn, not guessed: its wetted area is whatever the
//   geometry says it is, to the accuracy of the integration. Uncertainty enters a sheet only through the ±
//   literals the user types, which is what keeps the sensitivity list a list of the designer's own guesses.
//
// ---------- the whole shell, from a cut below the keel ----------
//
// `cut` accumulates `wsa` over SKIN edges only — the centerline, the deck cap and the transom face are
// closures of the region, not hull surface — so a cut taken with its waterplane above the highest point of
// the hull returns the area of the ENTIRE trimmed shell, and the volume of everything inside it. That is
// exactly `SHELL_AREA` (what a shell weight is estimated from: area × areal density) and `HULL_VOL` (the
// moulded volume up to the sheer), for one extra cut and no new integration code. `test/sheet.ts` pins both
// against the triangle mesh the STL exporter writes.

import { hydrostatics, type Hydro } from "./hydro";
import { unitScale } from "./json";
import type { HullSampling } from "./mesh";
import type { Model } from "./model";
import {
  AREA,
  DIMLESS,
  LENGTH,
  VOLUME,
  exact,
  type Dim,
  type Quantity,
} from "./sheet/quantity";
import { cut, heightSpan, stationGeometry } from "./sweep";
import { loa } from "./hull";

/**
 * Everything the sheet can read off the hull, already in metres and cubic metres.
 *
 * Structured-cloneable on purpose: it is computed in the stability worker alongside the hydrostatics that
 * feed it and travels back to the window as plain numbers.
 */
export interface HullMetrics {
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
  readonly lcb: number;
  readonly lcf: number;
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
  /** Where the whole shell acts: its own area centroid, referenced like LCB and KB. */
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

const BY_NAME = new Map(HULL_METRICS.map((spec) => [spec.name, spec]));

/** Resolve one `HULL.<name>` to an exact quantity, or `null` if there is no such metric. */
export function hullMetric(
  metrics: HullMetrics,
  name: string,
): Quantity | null {
  const spec = BY_NAME.get(name);
  if (!spec) return null;
  return exact(spec.read(metrics), spec.dim);
}

export const isHullMetricName = (name: string): boolean => BY_NAME.has(name);

/**
 * Measure the hull.
 *
 * `sampling` is the hull already swept, so this costs one extra `cut` on top of the hydrostatics the caller
 * wanted anyway. Returns null for a hull that does not float at its own waterline — the same condition
 * `hydrostatics` refuses on — because a sheet built on NaNs is worse than a sheet that says it has no hull.
 */
export function hullMetrics(
  model: Model,
  sampling: HullSampling,
  hydro: Hydro | null = null,
): HullMetrics | null {
  const geom = stationGeometry(model, sampling);
  if (!geom) return null;
  const h = hydro ?? hydrostatics(model, sampling);
  if (!h) return null;

  // Metres per model unit, and its powers for the area and volume integrals.
  const s = unitScale(model.unit, "m");
  const s2 = s * s;
  const s3 = s2 * s;

  // The whole shell: put the waterplane above everything and cut. `heightSpan` brackets the hull's heeled
  // heights, so `hi` plus a hair is a waterline nothing pokes through. The margin is scaled by the span so it
  // works on a hull drawn in millimetres and one drawn in feet alike.
  const [lo, hi] = heightSpan(geom, 0);
  const submerged = cut(geom, 0, hi + Math.max(1e-6, (hi - lo) * 1e-3));

  return {
    loa: loa(model) * s,
    lwl: h.lwl * s,
    bwl: h.bwl * s,
    draft: h.draft * s,
    waterline: model.waterline * s,
    deckRakeDeg: (model.deckRake * 180) / Math.PI,
    dispVol: h.vol * s3,
    wsa: h.wettedArea * s2,
    waterplaneArea: h.waterplaneArea * s2,
    midshipArea: h.midshipArea * s2,
    maxSectionArea: h.maxSectionArea * s2,
    lcb: h.lcb * s,
    lcf: h.lcf * s,
    kb: h.kb * s,
    bmt: h.bmt * s,
    kmt: h.kmt * s,
    cb: h.cb,
    cp: h.cp,
    cm: h.cm,
    cw: h.cw,
    deadrise: h.deadrise,
    halfEntrance: h.halfEntrance,
    shellArea: submerged.wsa * s2,
    hullVol: submerged.vol * s3,
    // Referenced exactly as LCB and KB are: x from the transom, height above the keel baseline. That is what
    // lets a sheet write `shell * HULL.SHELL_VCG` and have the answer land in the same frame the stability
    // panel reads KG in.
    shellLcg: submerged.wsaX * s,
    shellVcg: (submerged.wsaZWorld - geom.keelZ) * s,
  };
}
