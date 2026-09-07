// The panel's existing six criteria, extracted without changing thresholds or interpolation.
import {
  gzAreaOf,
  gzAreaTerms,
  limitingKgAt,
  maximumGz,
  vcgForGzArea,
  vcgForMaximumGz,
  vcgForMaximumGzHeel,
  GZ_AREA_HEEL_30,
  GZ_AREA_HEEL_40,
  type CrossCurves,
  type LimitingKgPoint,
  type GzAreaTerms,
} from "./stability";
const DEG = 180 / Math.PI;
const fmtArea = (value: number) => value.toFixed(3);
/**
 * IMO A.749(18) / 2008 IS Code part A, 2.2 — the general intact-stability criteria, as the numbers they are
 * stated in. Said ONCE here because four of them are also the pass contour of a shading of their own, and a
 * threshold that disagreed with itself between the checklist and the drawing would be worse than no
 * checklist at all.
 *
 * The 40° criteria are stated "or to the downflooding angle if that is less". Downflooding is not modelled —
 * there are no openings in the hull — so they are read at 40° flat, and the sheer-immersion overlay is left
 * to say where the deck edge goes under before then. That is a warning here and not a criterion.
 */
export const IMO = {
  area30: 0.055, // m·rad, area under GZ out to 30°
  area40: 0.09, // m·rad, out to 40°
  area3040: 0.03, // m·rad, between 30° and 40°
  gzAt30: 0.2, // m, righting lever at 30° of heel or beyond
  peakDeg: 25, // degrees, the heel maximum GZ must occur at or beyond
  gm: 0.15, // m, initial metacentric height
} as const;

export const MAX_GZ_MIN = IMO.gzAt30;
export const MAX_GZ_MIN_HEEL = 30 / DEG;
export const MAX_GZ_MIN_PEAK_HEEL = IMO.peakDeg / DEG;

/**
 * One criterion of the standard, as everything the panel has to say about it: the reading it takes of a
 * condition, the threshold that reading is held to, and the bound that threshold puts on KG.
 *
 * `bound` is the highest KG at a displacement that still complies, in MODEL units — which every one of the
 * six has, because every one of these readings falls as the centre of gravity rises. The areas and the
 * 30°-and-beyond lever fall because raising G subtracts VCG·sin φ from the arm at every heel; GM₀ falls one
 * for one; and the angle of maximum GZ walks down the heel axis because that subtraction bites hardest
 * where sin φ is largest (see `vcgForMaximumGzHeel`). So the complying region of each column is everything
 * below a single number, the region complying with ALL of them is everything below the LEAST of those
 * numbers, and that lower envelope is the limiting KG curve the standard is usually drawn as.
 */
export interface ImoCheck {
  readonly key: string;
  /** The name as plain text, for the SVG — which has no markup to set a subscript with. */
  readonly label: string;
  /** The requirement as the standard states it, for the label on the curve. */
  readonly rule: string;
  readonly title: string;
  /** The reading for one condition, in the unit `rule` is stated in. */
  readonly read: (vol: number, kg: number) => number;
  /** The threshold that reading is held to, same unit — `rule` is how it is written. */
  readonly min: number;
  /** The highest complying KG at this displacement, in model units. */
  readonly bound: (vol: number) => number;
}

/** Where a criterion stands for one condition, or across the whole tolerance rectangle. */
export interface ImoVerdict {
  readonly pass: boolean;
  /** The rectangle has the threshold running through it: some of it complies and some does not. */
  readonly straddles: boolean;
}

/** SI by default; the legacy chart supplies its explicit metres-per-display-unit scale. */
export function createImoChecks(
  curves: CrossCurves | null,
  limit: readonly LimitingKgPoint[],
  metres = 1,
): readonly ImoCheck[] {
  if (!curves) return [];
  const rad = (deg: number) => deg / DEG,
    area =
      (upTo: number, from = 0) =>
      (vol: number) =>
        gzAreaTerms(curves, vol, upTo, from);
  const areaCheck = (
    key: string,
    label: string,
    min: number,
    title: string,
    terms: (vol: number) => GzAreaTerms,
  ): ImoCheck => ({
    key,
    label,
    rule: `≥ ${fmtArea(min)} m·rad`,
    title,
    read: (vol, kg) => gzAreaOf(terms(vol), kg) * metres,
    min,
    bound: (vol) => vcgForGzArea(terms(vol), min / metres),
  });
  return [
    {
      key: "gm",
      label: "GM₀",
      rule: `≥ ${IMO.gm.toFixed(2)} m`,
      title:
        "Initial metacentric height, KMt − KG. IMO A.749 2.2.4 puts it at 0.15 m or more",
      read: (vol, kg) => (limitingKgAt(limit, vol) - kg) * metres,
      min: IMO.gm,
      bound: (vol) => limitingKgAt(limit, vol) - IMO.gm / metres,
    },
    areaCheck(
      "area30",
      "A₃₀",
      IMO.area30,
      "Area under the righting-lever curve out to 30° of heel. IMO A.749 2.2.1 puts it at 0.055 m·rad or more",
      area(GZ_AREA_HEEL_30),
    ),
    areaCheck(
      "area40",
      "A₄₀",
      IMO.area40,
      "Area under the righting-lever curve out to 40°. IMO A.749 2.2.1 puts it at 0.09 m·rad or more — the standard says 40° or the downflooding angle, which this model does not carry",
      area(GZ_AREA_HEEL_40),
    ),
    areaCheck(
      "area3040",
      "A₃₀₋₄₀",
      IMO.area3040,
      "Area under the righting-lever curve between 30° and 40°. IMO A.749 2.2.2 puts it at 0.03 m·rad or more",
      area(GZ_AREA_HEEL_40, GZ_AREA_HEEL_30),
    ),
    {
      key: "gz30",
      label: "GZ₃₀₊",
      rule: `≥ ${IMO.gzAt30.toFixed(2)} m`,
      title:
        "The largest righting lever at or beyond 30° of heel. IMO A.749 2.2.3 puts it at 0.20 m or more",
      read: (vol, kg) => maximumGz(curves, vol, kg, rad(30)).gz * metres,
      min: IMO.gzAt30,
      bound: (vol) =>
        vcgForMaximumGz(curves, vol, IMO.gzAt30 / metres, rad(30)),
    },
    {
      key: "peak",
      label: "θmax",
      rule: `≥ ${IMO.peakDeg}°`,
      title:
        "The heel at which the righting lever peaks. IMO A.749 2.2.4 puts it at 25° or more",
      read: (vol, kg) => maximumGz(curves, vol, kg).heel * DEG,
      min: IMO.peakDeg,
      bound: (vol) => vcgForMaximumGzHeel(curves, vol, MAX_GZ_MIN_PEAK_HEEL),
    },
  ];
}

export function criterionVerdict(
  value: number,
  minimum: number,
  range: { lo: number; hi: number } | null,
): ImoVerdict {
  return {
    pass: Number.isFinite(value) && value >= minimum,
    straddles: range !== null && range.lo < minimum && range.hi >= minimum,
  };
}
