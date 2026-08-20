import { useMemo, useState } from "react";
import { unitScale } from "../core/json";
import {
  gzAreaOf,
  gzAreaTerms,
  gzAtHeel,
  gzCurve,
  limitingKgAt,
  maximumGz,
  sheerImmersionAngle,
  vcgForGzArea,
  vcgForMaximumGz,
  GZ_AREA_HEEL_30,
  GZ_AREA_HEEL_40,
  type GzAreaTerms,
  type LimitingKgPoint,
} from "../core/stability";
import { useDocumentSnapshot } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { useStabilityAnalysis } from "./useStabilityAnalysis";
import { ChartFrame, type ChartScale } from "./ChartFrame";
import "./StabilityPanel.css";

interface Condition {
  vol: number;
  kg: number;
}

const EMPTY_LIMIT: readonly LimitingKgPoint[] = [];
const DEG = 180 / Math.PI;
const sub = (n: number): string =>
  String(n).replace(/\d/g, (d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)]);
const fmtArea = (value: number): string => value.toFixed(3);
const fmt = (value: number): string =>
  Math.abs(value) >= 1000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : value.toLocaleString(undefined, { maximumSignificantDigits: 4 });

// ---------- how the displacement / KG plane is shaded ----------

type Coloring = "gmt" | "gzmax" | "gz30" | "gz40";

interface AreaBand {
  readonly key: string;
  readonly min: number; // the band's lower bound in the displayed metric (−∞ for the lowest one)
  readonly range: string;
  readonly name: string;
  readonly note: string; // the reading, shown against the selected condition
}

// The five readings are the same whichever heel the area is taken to; only where the thresholds sit moves,
// because the standard asks for more area the further out it looks. `edges` are those four thresholds in
// m·rad, ascending.
const bandsAt = (
  edges: readonly [number, number, number, number],
): readonly AreaBand[] => [
  {
    key: "fail",
    min: -Infinity,
    range: `< ${fmtArea(edges[0])}`,
    name: "Non-compliant",
    note: `below the ${fmtArea(edges[0])} m·rad IMO minimum`,
  },
  {
    key: "limited",
    min: edges[0],
    range: `${fmtArea(edges[0])} – ${fmtArea(edges[1])}`,
    name: "Limited margin",
    note: "compliant, but with relatively little margin",
  },
  {
    key: "comfortable",
    min: edges[1],
    range: `${fmtArea(edges[1])} – ${fmtArea(edges[2])}`,
    name: "Comfortable margin",
    note: "an appreciable margin above the minimum",
  },
  {
    key: "large",
    min: edges[2],
    range: `${fmtArea(edges[2])} – ${fmtArea(edges[3])}`,
    name: "Large static area",
    note: "a large static area for this range",
  },
  {
    key: "vast",
    min: edges[3],
    range: `> ${fmtArea(edges[3])}`,
    name: "Very large static area",
    note: "assess stiffness and dynamics separately",
  },
];

// IMO A.749's two area criteria. Everything above each minimum is MARGIN, not a score: the ramp runs
// red → amber → green and then LEAVES the ramp, because a large static area is a finding to be read rather
// than a better boat — it usually buys reserve energy with a stiff, snappy roll, which is a dynamics
// question these bands do not answer.
interface AreaCriterion {
  readonly key: Coloring;
  readonly deg: number; // the heel it runs out to, for labels
  readonly upTo: number; // the same heel in radians, for the integration
  readonly bands: readonly AreaBand[];
}
const AREA_CRITERIA: readonly AreaCriterion[] = [
  {
    key: "gz30",
    deg: 30,
    upTo: GZ_AREA_HEEL_30,
    bands: bandsAt([0.055, 0.07, 0.12, 0.2]),
  },
  {
    key: "gz40",
    deg: 40,
    upTo: GZ_AREA_HEEL_40,
    bands: bandsAt([0.09, 0.115, 0.2, 0.33]),
  },
];
/** The pass/fail contour the standard actually draws — the first band's floor. */
const passArea = (criterion: AreaCriterion): number => criterion.bands[1].min;

const MAX_GZ_MIN = 0.2; // metres, at a heel of at least 30°
const MAX_GZ_MIN_HEEL = 30 / DEG;
const MAX_GZ_MIN_PEAK_HEEL = 25 / DEG;
const MAX_GZ_BANDS: readonly AreaBand[] = [
  {
    key: "fail",
    min: -Infinity,
    range: "< 0.20",
    name: "Below 0.20 m",
    note: "maximum righting lever below 0.20 m",
  },
  {
    key: "limited",
    min: 0.2,
    range: "0.20 – 0.30",
    name: "Limited margin",
    note: "maximum righting lever from 0.20 to 0.30 m",
  },
  {
    key: "comfortable",
    min: 0.3,
    range: "0.30 – 0.50",
    name: "Substantial lever",
    note: "maximum righting lever from 0.30 to 0.50 m",
  },
  {
    key: "vast",
    min: 0.5,
    range: "> 0.50",
    name: "Very large lever",
    note: "assess stiffness and dynamics separately",
  },
];

const bandFor = (criterion: AreaCriterion, area: number): AreaBand | null =>
  Number.isFinite(area)
    ? criterion.bands.reduce((best, band) => (area >= band.min ? band : best))
    : null;

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

// Put a useful-width window around the design displacement, shifting rather than shrinking it when it meets
// either end of the complete analysis range. Very light designs still get at least a quarter of that range.
const focusAround = (domain: readonly [number, number], center: number) => {
  const fullSpan = domain[1] - domain[0];
  if (!(fullSpan > 0) || !Number.isFinite(center)) return domain;
  const span = Math.min(fullSpan, Math.max(center, fullSpan * 0.25));
  let lo = center - span / 2,
    hi = center + span / 2;
  if (lo < domain[0]) {
    lo = domain[0];
    hi = lo + span;
  }
  if (hi > domain[1]) {
    hi = domain[1];
    lo = hi - span;
  }
  return [lo, hi] as const;
};

// Split samples into the maximal runs of consecutive usable ones, so a displacement the KN table cannot
// answer for — or a contour that has left the plot — breaks the path instead of being bridged across.
const runsOf = <T,>(
  samples: readonly T[],
  usable: (sample: T) => boolean,
): T[][] => {
  const runs: T[][] = [];
  let run: T[] = [];
  for (const sample of samples) {
    if (usable(sample)) run.push(sample);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
};

const linePath = (
  points: readonly { x: number; y: number }[],
  scale: ChartScale,
): string =>
  points
    .map(
      (point, i) => `${i ? "L" : "M"}${scale.x(point.x)},${scale.y(point.y)}`,
    )
    .join(" ");

// A filled ribbon between a lower and an upper KG boundary, one x per sample.
const bandPath = (
  samples: readonly { x: number; lo: number; hi: number }[],
  scale: ChartScale,
): string =>
  runsOf(samples, (s) => Number.isFinite(s.lo) && Number.isFinite(s.hi))
    .filter((run) => run.length >= 2)
    .map(
      (run) =>
        `${linePath(
          run.map((s) => ({ x: s.x, y: s.hi })),
          scale,
        )} ${run
          .slice()
          .reverse()
          .map((s) => `L${scale.x(s.x)},${scale.y(s.lo)}`)
          .join(" ")} Z`,
    )
    .join(" ");

export function StabilityPanel() {
  const snapshot = useDocumentSnapshot();
  const { perf } = useEditorUi();
  const { analysis, error } = useStabilityAnalysis(snapshot, perf);
  const curves = analysis?.curves ?? null,
    limit = analysis?.limit ?? EMPTY_LIMIT,
    hydro = analysis?.hydro ?? null,
    lowestSheerKg = analysis?.lowestSheerKg ?? NaN;
  const [condition, setCondition] = useState<Condition | null>(null);
  const [coloring, setColoring] = useState<Coloring>("gmt");
  const [showSheerReference, setShowSheerReference] = useState(true);
  const [sheerReferenceDeg, setSheerReferenceDeg] = useState(30);
  const [sheerReferenceInput, setSheerReferenceInput] = useState("30");
  // The area criterion being shaded by, or null for the initial-stability and maximum-GZ readings. The area
  // readout falls back to the standard's first one, so switching away from area shading never blanks it.
  const criterion = AREA_CRITERIA.find((c) => c.key === coloring) ?? null;
  const isInitial = coloring === "gmt";
  const isMaximum = coloring === "gzmax";
  const readout = criterion ?? AREA_CRITERIA[0];
  // Metric tonnes of seawater per model-volume unit: 1.025 t/m³.
  const unit = snapshot.state.unit;
  const metres = unitScale(unit, "m");
  const tonsPerVolume = metres ** 3 * 1.025;
  const volumeDomain = useMemo<readonly [number, number]>(() => {
    if (!limit.length) return [0, 1];
    return [limit[0].vol, limit[limit.length - 1].vol];
  }, [limit]);
  const xDomain = useMemo<readonly [number, number]>(
    () => [volumeDomain[0] * tonsPerVolume, volumeDomain[1] * tonsPerVolume],
    [tonsPerVolume, volumeDomain],
  );
  const yMax = useMemo(
    () =>
      Math.max(
        1,
        hydro?.kb ?? 0,
        ...limit.map((point) => Math.max(0, point.kg)),
      ) * 1.18,
    [hydro, limit],
  );
  const designXDomain = useMemo<readonly [number, number]>(
    () =>
      focusAround(
        xDomain,
        (hydro?.vol ?? (volumeDomain[0] + volumeDomain[1]) / 2) * tonsPerVolume,
      ),
    [hydro, tonsPerVolume, volumeDomain, xDomain],
  );
  // KMt commonly rises sharply as displacement tends to zero. Base the design framing on only the useful
  // displacement window so that this physically valid extreme does not flatten normal loading conditions.
  const designYMax = useMemo(() => {
    const x0 = designXDomain[0] / tonsPerVolume,
      x1 = designXDomain[1] / tonsPerVolume,
      local = limit
        .filter((point) => point.vol >= x0 && point.vol <= x1)
        .map((point) => point.kg)
        .filter(Number.isFinite),
      edgeValues = [limitingKgAt(limit, x0), limitingKgAt(limit, x1)].filter(
        Number.isFinite,
      ),
      usefulMax = Math.max(
        ...[hydro?.kb ?? 0, lowestSheerKg, ...local, ...edgeValues].filter(
          Number.isFinite,
        ),
      );
    return Math.min(yMax, Math.max(yMax / 1000, usefulMax * 1.18));
  }, [designXDomain, hydro, limit, lowestSheerKg, tonsPerVolume, yMax]);
  // Only the KN curve behind the area costs table lookups, and it does not depend on KG — so ONE pass per
  // displacement carries every contour on this chart. See `gzAreaTerms`.
  const areaField = useMemo<readonly { x: number; terms: GzAreaTerms }[]>(
    () =>
      curves && criterion
        ? limit.map((point) => ({
            x: point.vol * tonsPerVolume,
            terms: gzAreaTerms(curves, point.vol, criterion.upTo),
          }))
        : [],
    [curves, criterion, limit, tonsPerVolume],
  );
  // Sample only the warning overlay. The coloured maximum-GZ bands and the 0.20 m criterion contour below
  // are exact envelopes of the tabulated heel lines; this modest grid cross-hatches the secondary finding
  // that the peak occurs before 25°.
  const earlyPeakCells = useMemo(() => {
    if (!curves || !isMaximum) return [];
    const cells: { x0: number; x1: number; y0: number; y1: number }[] = [],
      nx = 40,
      ny = 24;
    for (let ix = 0; ix < nx; ix++) {
      const v0 =
          volumeDomain[0] + ((volumeDomain[1] - volumeDomain[0]) * ix) / nx,
        v1 =
          volumeDomain[0] +
          ((volumeDomain[1] - volumeDomain[0]) * (ix + 1)) / nx,
        vol = (v0 + v1) / 2;
      for (let iy = 0; iy < ny; iy++) {
        const y0 = (yMax * iy) / ny,
          y1 = (yMax * (iy + 1)) / ny,
          peak = maximumGz(curves, vol, (y0 + y1) / 2),
          beyond30 = maximumGz(curves, vol, (y0 + y1) / 2, MAX_GZ_MIN_HEEL);
        if (
          beyond30.gz * metres >= MAX_GZ_MIN &&
          peak.heel < MAX_GZ_MIN_PEAK_HEEL
        )
          cells.push({
            x0: v0 * tonsPerVolume,
            x1: v1 * tonsPerVolume,
            y0,
            y1,
          });
      }
    }
    return cells;
  }, [curves, isMaximum, metres, tonsPerVolume, volumeDomain, yMax]);
  // Sheer immersion is independent of VCG in the fixed-trim model, so its comparison with a reference angle
  // occupies whole displacement columns. Sample those columns for a light warning hatch over every shading.
  const earlySheerCells = useMemo(() => {
    if (!curves || !showSheerReference) return [];
    const cells: { x0: number; x1: number }[] = [],
      nx = 80;
    for (let i = 0; i < nx; i++) {
      const v0 =
          volumeDomain[0] + ((volumeDomain[1] - volumeDomain[0]) * i) / nx,
        v1 =
          volumeDomain[0] +
          ((volumeDomain[1] - volumeDomain[0]) * (i + 1)) / nx,
        heel = sheerImmersionAngle(curves, (v0 + v1) / 2) * DEG;
      if (Number.isFinite(heel) && heel < sheerReferenceDeg)
        cells.push({ x0: v0 * tonsPerVolume, x1: v1 * tonsPerVolume });
    }
    return cells;
  }, [
    curves,
    sheerReferenceDeg,
    showSheerReference,
    tonsPerVolume,
    volumeDomain,
  ]);

  if (!curves || limit.length < 2)
    return (
      <div className="card stabilityempty">
        {error
          ? `Could not compute stability: ${error}`
          : analysis
            ? "The hull does not provide enough immersed volume to build stability curves."
            : "Computing stability…"}
      </div>
    );

  // Begin at the authored waterline with G at B. If an edit changes the envelope, clamp the displayed
  // condition while retaining the raw click, so derived data never has to be copied into state by an effect.
  const selectedVol = Math.min(
    volumeDomain[1],
    Math.max(volumeDomain[0], condition?.vol ?? hydro?.vol ?? volumeDomain[0]),
  );
  const bound = limitingKgAt(limit, selectedVol);
  const selected: Condition = {
    vol: selectedVol,
    kg: Math.min(
      yMax,
      Math.max(
        0,
        condition?.kg ?? Math.min(bound * 0.75, hydro?.kb ?? bound * 0.5),
      ),
    ),
  };
  const safe = selected.kg < bound;
  const gz = gzCurve(curves, selected.vol, selected.kg).filter((p) =>
    Number.isFinite(p.gz),
  );
  const selectedMaximum = maximumGz(curves, selected.vol, selected.kg),
    selectedBeyond30 = maximumGz(
      curves,
      selected.vol,
      selected.kg,
      MAX_GZ_MIN_HEEL,
    ),
    maximumMetres = selectedMaximum.gz * metres,
    selectedMaximumBand = MAX_GZ_BANDS.reduce((best, band) =>
      maximumMetres >= band.min ? band : best,
    ),
    maximumPass =
      selectedBeyond30.gz * metres >= MAX_GZ_MIN &&
      selectedMaximum.heel >= MAX_GZ_MIN_PEAK_HEEL,
    displayedPass = isMaximum ? maximumPass : safe,
    selectedSheerHeel = sheerImmersionAngle(curves, selected.vol),
    selectedSheerDeg = selectedSheerHeel * DEG,
    selectedSheerGz = gzAtHeel(
      curves,
      selected.vol,
      selected.kg,
      selectedSheerHeel,
    );
  const gzMin = Math.min(0, ...gz.map((p) => p.gz)),
    gzMax = Math.max(0, ...gz.map((p) => p.gz)),
    gzPad = Math.max((gzMax - gzMin) * 0.1, yMax * 0.01),
    gzDomain: readonly [number, number] = [gzMin - gzPad, gzMax + gzPad];

  // the selected condition's own area, converted out of model units into the m·rad the criteria are stated in
  const selectedTerms = gzAreaTerms(curves, selected.vol, readout.upTo);
  const selectedArea = gzAreaOf(selectedTerms, selected.kg) * metres;
  const selectedBand = bandFor(readout, selectedArea);
  // KG at a stated area, per column of the chart. Clipping GZ at zero costs the closed-form inverse, so each
  // of these is a bisection down the column — see `vcgForGzArea`. Areas are given in m·rad and converted
  // back into the model's own units to land on the axis.
  const kgAtArea = (terms: GzAreaTerms, area: number): number =>
    vcgForGzArea(terms, area / metres);

  return (
    <div className="stabilitypanel">
      <section className="card stabilitycard">
        <div className="cap">
          Limiting KG
          <span className="capctls">
            <label className="shadepick">
              Shade
              <select
                value={coloring}
                onChange={(e) => setColoring(e.target.value as Coloring)}
              >
                <option value="gmt">Initial stability</option>
                <option value="gzmax">Maximum GZ</option>
                {AREA_CRITERIA.map((c) => (
                  <option key={c.key} value={c.key}>
                    GZ area to {c.deg}°
                  </option>
                ))}
              </select>
            </label>
            <span className={`tag ${displayedPass ? "issafe" : "isunsafe"}`}>
              {isMaximum
                ? displayedPass
                  ? "PASS"
                  : "FAIL"
                : safe
                  ? "SAFE"
                  : "UNSAFE"}
            </span>
          </span>
        </div>
        <div className="sheerreferencebar">
          <label className="sheerreferencectl">
            <input
              type="checkbox"
              checked={showSheerReference}
              onChange={(e) => setShowSheerReference(e.target.checked)}
            />
            Sheer reference
            <input
              className="sheerreferenceinput"
              type="number"
              min="5"
              max="90"
              step="1"
              value={sheerReferenceInput}
              disabled={!showSheerReference}
              aria-label="Sheer immersion reference angle in degrees"
              onChange={(e) => setSheerReferenceInput(e.target.value)}
              onBlur={() => {
                const value = Number(sheerReferenceInput),
                  next =
                    sheerReferenceInput.trim() && Number.isFinite(value)
                      ? clamp(value, 5, 90)
                      : sheerReferenceDeg;
                setSheerReferenceDeg(next);
                setSheerReferenceInput(String(next));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            °
          </label>
          <span>
            {showSheerReference
              ? `Hatched where the sheer immerses before ${sheerReferenceDeg}°; clear where it immerses at or after it.`
              : "Sheer-reference hatching hidden."}
          </span>
        </div>
        <p className="stabilityhint">
          {criterion
            ? `Shaded by the area under GZ out to ${criterion.deg}°, which the IMO criterion puts at ${fmtArea(passArea(criterion))} m·rad or more.`
            : isMaximum
              ? "Shaded by maximum GZ. The dashed contour requires GZ ≥ 0.20 m at or beyond 30°; cross-hatching marks a qualifying lever whose peak occurs before 25°."
              : "Green is where the transverse metacenter M is above G (GMt > 0)."}{" "}
          Click anywhere to inspect that displacement and KG.
        </p>
        <ChartFrame
          xDomain={xDomain}
          yDomain={[0, yMax]}
          initialXDomain={designXDomain}
          initialYDomain={[0, designYMax]}
          initialViewLabel="Design"
          panZoom
          xLabel="Displacement Δ (t, seawater)"
          yLabel={`KG / VCG (${unit})`}
          formatX={fmt}
          formatY={fmt}
          ariaLabel={
            criterion
              ? `Limiting KG by displacement, shaded by the area under the GZ curve out to ${criterion.deg} degrees`
              : isMaximum
                ? "Displacement and VCG conditions shaded by maximum righting lever, with the 0.20 metre criterion and early peak warning"
                : "Limiting KG by displacement; green below the curve is safe and red above it is unsafe"
          }
          onPlotClick={(tons, kg) =>
            setCondition({ vol: tons / tonsPerVolume, kg })
          }
        >
          {(scale) => {
            const points = limit.map((p) => ({
              x: p.vol * tonsPerVolume,
              y: p.kg,
            }));
            const safeArea = `${linePath(points, scale)} L${scale.x(xDomain[1])},${scale.bottom} L${scale.x(xDomain[0])},${scale.bottom} Z`;
            const areaPassLine = runsOf(
              areaField.map((column) => ({
                x: column.x,
                y: criterion
                  ? kgAtArea(column.terms, passArea(criterion))
                  : NaN,
              })),
              (p) => Number.isFinite(p.y) && p.y >= 0 && p.y <= yMax,
            );
            const maximumColumns = limit.map((point) => ({
              x: point.vol * tonsPerVolume,
              vol: point.vol,
            }));
            const maximumPassLine = runsOf(
              maximumColumns.map((column) => ({
                x: column.x,
                y: vcgForMaximumGz(
                  curves,
                  column.vol,
                  MAX_GZ_MIN / metres,
                  MAX_GZ_MIN_HEEL,
                ),
              })),
              (p) => Number.isFinite(p.y) && p.y >= 0 && p.y <= yMax,
            );
            return (
              <>
                <defs>
                  <pattern
                    id="early-sheer-hatch"
                    width="8"
                    height="8"
                    patternUnits="userSpaceOnUse"
                    patternTransform="rotate(45)"
                  >
                    <line
                      className="earlysheerstroke"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="8"
                    />
                  </pattern>
                </defs>
                {isInitial ? (
                  <>
                    <rect
                      className="unsafearea"
                      x={scale.left}
                      y={scale.top}
                      width={scale.right - scale.left}
                      height={scale.bottom - scale.top}
                    />
                    <path className="safearea" d={safeArea} />
                    {/* KMt is the initial-stability criterion itself — the edge of the green — so it is drawn
                        with the reading it belongs to rather than over every one of them. */}
                    <path className="limitline" d={linePath(points, scale)} />
                  </>
                ) : isMaximum ? (
                  <>
                    <defs>
                      <pattern
                        id="early-maximum-hatch"
                        width="8"
                        height="8"
                        patternUnits="userSpaceOnUse"
                      >
                        <line
                          className="earlypeakstroke"
                          x1="0"
                          y1="0"
                          x2="8"
                          y2="8"
                        />
                        <line
                          className="earlypeakstroke"
                          x1="8"
                          y1="0"
                          x2="0"
                          y2="8"
                        />
                      </pattern>
                    </defs>
                    {MAX_GZ_BANDS.map((band, i) => (
                      <path
                        key={band.key}
                        className={`gzband ${band.key}`}
                        d={bandPath(
                          maximumColumns.map((column) => ({
                            x: column.x,
                            lo: clamp(
                              vcgForMaximumGz(
                                curves,
                                column.vol,
                                (MAX_GZ_BANDS[i + 1]?.min ?? Infinity) / metres,
                              ),
                              0,
                              yMax,
                            ),
                            hi: clamp(
                              vcgForMaximumGz(
                                curves,
                                column.vol,
                                band.min / metres,
                              ),
                              0,
                              yMax,
                            ),
                          })),
                          scale,
                        )}
                      >
                        <title>{`${band.name} · ${band.range} m — ${band.note}`}</title>
                      </path>
                    ))}
                    <path
                      className="earlypeakarea"
                      d={earlyPeakCells
                        .map(
                          (cell) =>
                            `M${scale.x(cell.x0)},${scale.y(cell.y0)} L${scale.x(cell.x1)},${scale.y(cell.y0)} L${scale.x(cell.x1)},${scale.y(cell.y1)} L${scale.x(cell.x0)},${scale.y(cell.y1)} Z`,
                        )
                        .join(" ")}
                    >
                      <title>Maximum GZ occurs before 25°</title>
                    </path>
                    {maximumPassLine.map((run, i) => (
                      <path
                        key={i}
                        className="passcontour"
                        d={linePath(run, scale)}
                      />
                    ))}
                  </>
                ) : criterion ? (
                  <>
                    {criterion.bands.map((band, i) => (
                      <path
                        key={band.key}
                        className={`gzband ${band.key}`}
                        d={bandPath(
                          areaField.map((column) => ({
                            x: column.x,
                            lo: clamp(
                              kgAtArea(
                                column.terms,
                                criterion.bands[i + 1]?.min ?? Infinity,
                              ),
                              0,
                              yMax,
                            ),
                            hi: clamp(
                              kgAtArea(column.terms, band.min),
                              0,
                              yMax,
                            ),
                          })),
                          scale,
                        )}
                      >
                        <title>{`${band.name} · ${band.range} m·rad — ${band.note}`}</title>
                      </path>
                    ))}
                    {areaPassLine.map((run, i) => (
                      <path
                        key={i}
                        className="passcontour"
                        d={linePath(run, scale)}
                      />
                    ))}
                  </>
                ) : null}
                <path
                  className="earlysheerarea"
                  d={earlySheerCells
                    .map(
                      (cell) =>
                        `M${scale.x(cell.x0)},${scale.top} L${scale.x(cell.x1)},${scale.top} L${scale.x(cell.x1)},${scale.bottom} L${scale.x(cell.x0)},${scale.bottom} Z`,
                    )
                    .join(" ")}
                >
                  <title>{`Sheer immersion before ${sheerReferenceDeg}°`}</title>
                </path>
                {lowestSheerKg >= 0 && lowestSheerKg <= yMax && (
                  <>
                    <line
                      className="lowestsheerguide"
                      x1={scale.left}
                      y1={scale.y(lowestSheerKg)}
                      x2={scale.right}
                      y2={scale.y(lowestSheerKg)}
                    />
                    <text
                      className="lowestsheerlabel"
                      x={scale.right - 6}
                      y={
                        scale.y(lowestSheerKg) < scale.top + 22
                          ? scale.y(lowestSheerKg) + 15
                          : scale.y(lowestSheerKg) - 6
                      }
                      textAnchor="end"
                    >
                      Lowest sheer · {fmt(lowestSheerKg)} {unit}
                    </text>
                  </>
                )}
                {hydro &&
                  hydro.vol >= volumeDomain[0] &&
                  hydro.vol <= volumeDomain[1] && (
                    <>
                      <line
                        className="designwlguide"
                        x1={scale.x(hydro.vol * tonsPerVolume)}
                        y1={scale.top}
                        x2={scale.x(hydro.vol * tonsPerVolume)}
                        y2={scale.bottom}
                      />
                      <text
                        className="designwllabel"
                        x={
                          scale.x(hydro.vol * tonsPerVolume) +
                          (hydro.vol > (volumeDomain[0] + volumeDomain[1]) / 2
                            ? -6
                            : 6)
                        }
                        y={scale.top + 16}
                        textAnchor={
                          hydro.vol > (volumeDomain[0] + volumeDomain[1]) / 2
                            ? "end"
                            : "start"
                        }
                      >
                        Design waterline · {fmt(hydro.vol * tonsPerVolume)} t
                      </text>
                    </>
                  )}
                <line
                  className="selectionguide"
                  x1={scale.x(selected.vol * tonsPerVolume)}
                  y1={scale.top}
                  x2={scale.x(selected.vol * tonsPerVolume)}
                  y2={scale.bottom}
                />
                <circle
                  className={
                    displayedPass ? "condition safe" : "condition unsafe"
                  }
                  cx={scale.x(selected.vol * tonsPerVolume)}
                  cy={scale.y(selected.kg)}
                  r={6}
                />
              </>
            );
          }}
        </ChartFrame>
        {(criterion || isMaximum) && (
          <div className="bandlegend">
            {(criterion?.bands ?? MAX_GZ_BANDS).map((band) => (
              <span
                key={band.key}
                className={`bandkey ${band.key}`}
                title={`${band.name} · ${band.range} ${criterion ? "m·rad" : "m"} — ${band.note}`}
              >
                {band.name}
                <small>
                  {band.range} {criterion ? "m·rad" : "m"}
                </small>
              </span>
            ))}
            {isMaximum && (
              <span className="hatchkey">Cross-hatched: peak before 25°</span>
            )}
          </div>
        )}
        <div className="conditionreadout">
          <span>
            Δ <strong>{fmt(selected.vol * tonsPerVolume)} t</strong>
          </span>
          <span>
            KG{" "}
            <strong>
              {fmt(selected.kg)} {unit}
            </strong>
          </span>
          <span>
            KMt{" "}
            <strong>
              {fmt(bound)} {unit}
            </strong>
          </span>
          <span>
            GMt{" "}
            <strong>
              {fmt(bound - selected.kg)} {unit}
            </strong>
          </span>
          {isMaximum ? (
            <>
              <span>
                GZmax{" "}
                <strong className={`bandvalue ${selectedMaximumBand.key}`}>
                  {Number.isFinite(maximumMetres)
                    ? `${maximumMetres.toFixed(3)} m`
                    : "n/a"}
                </strong>
              </span>
              <span>
                Peak{" "}
                <strong>
                  {Number.isFinite(selectedMaximum.heel)
                    ? `${Math.round(selectedMaximum.heel * DEG)}°`
                    : "n/a"}
                </strong>
                {selectedMaximum.deckDown && (
                  <span className="areanote"> — after sheer immersion</span>
                )}
              </span>
            </>
          ) : (
            <span>
              A<sub>{readout.deg}</sub>{" "}
              <strong
                className={selectedBand ? `bandvalue ${selectedBand.key}` : ""}
              >
                {Number.isFinite(selectedArea)
                  ? `${selectedArea.toFixed(3)} m·rad`
                  : "n/a"}
              </strong>
              {selectedBand && (
                <span className="areanote" title={selectedBand.name}>
                  {" "}
                  — {selectedBand.note}
                </span>
              )}
            </span>
          )}
        </div>
      </section>

      <section className="card stabilitycard gzcard">
        <div className="cap">
          GZ curve
          <span className="val">
            Δ {fmt(selected.vol * tonsPerVolume)} t · VCG {fmt(selected.kg)}{" "}
            {unit}
          </span>
        </div>
        <ChartFrame
          xDomain={[0, 90]}
          yDomain={gzDomain}
          xTickStep={15}
          xLabel="Heel (degrees)"
          yLabel={`GZ (${unit})`}
          formatX={(v) => `${Math.round(v)}°`}
          formatY={fmt}
          ariaLabel={`GZ curve for displacement ${fmt(selected.vol * tonsPerVolume)} tonnes and VCG ${fmt(selected.kg)}`}
        >
          {(scale) => {
            // The area the other chart shades, drawn where it is actually measured — so it appears only when
            // that chart is shading by it, and out to whichever heel that criterion uses. Under initial
            // stability the whole curve is the subject and a filled corner would single out an angle nothing
            // there is about.
            const heel = criterion?.deg ?? 0;
            const upTo = gz.filter((p) => p.heel * DEG <= heel + 1e-9),
              last = upTo[upTo.length - 1],
              next = gz[upTo.length];
            // close the fill on the chord where the criterion's heel falls between two table angles
            const edge =
              next && last
                ? [
                    {
                      x: heel,
                      y:
                        last.gz +
                        ((heel - last.heel * DEG) /
                          (next.heel * DEG - last.heel * DEG)) *
                          (next.gz - last.gz),
                    },
                  ]
                : [];
            const under = [
              ...upTo.map((p) => ({ x: p.heel * DEG, y: p.gz })),
              ...edge,
            ];
            // Only positive GZ is counted, so only positive GZ is shaded — the fill has to BE the region the
            // number reports, or the picture argues with it. Runs are cut at the crossing between plotted
            // points; past the vanishing angle nothing is drawn at all.
            const lobes: { x: number; y: number }[][] = [];
            let lobe: { x: number; y: number }[] = [];
            const close = () => {
              if (lobe.length >= 2) lobes.push(lobe);
              lobe = [];
            };
            for (let i = 0; i < under.length; i++) {
              const p = under[i],
                q = under[i + 1];
              if (p.y >= 0) lobe.push(p);
              if (!q || !Number.isFinite(p.y) || !Number.isFinite(q.y)) {
                close();
                continue;
              }
              if (p.y >= 0 !== q.y >= 0) {
                const t = p.y / (p.y - q.y);
                lobe.push({ x: p.x + t * (q.x - p.x), y: 0 });
                if (p.y >= 0) close();
              }
            }
            close();
            const label = `A${sub(heel)}`;
            return (
              <>
                {criterion && (
                  <>
                    {lobes.map((points, i) => (
                      <path
                        key={i}
                        className={`gzarea ${selectedBand?.key ?? ""}`}
                        d={`${linePath(points, scale)} L${scale.x(points[points.length - 1].x)},${scale.y(0)} L${scale.x(points[0].x)},${scale.y(0)} Z`}
                      />
                    ))}
                    <line
                      className="areaedge"
                      x1={scale.x(heel)}
                      y1={scale.top}
                      x2={scale.x(heel)}
                      y2={scale.bottom}
                    />
                    <text
                      className="areaedgelabel"
                      x={scale.x(heel) + 5}
                      y={scale.top + 14}
                    >
                      {Number.isFinite(selectedArea)
                        ? `${label} ${fmtArea(selectedArea)} m·rad`
                        : `${label} n/a`}
                    </text>
                  </>
                )}
                {Number.isFinite(selectedSheerGz) && (
                  <line
                    className="sheerangle"
                    x1={scale.x(selectedSheerDeg)}
                    y1={scale.top}
                    x2={scale.x(selectedSheerDeg)}
                    y2={scale.bottom}
                  />
                )}
                <line
                  className="zeroline"
                  x1={scale.left}
                  y1={scale.y(0)}
                  x2={scale.right}
                  y2={scale.y(0)}
                />
                <path
                  className="gzline"
                  d={linePath(
                    gz.map((p) => ({ x: p.heel * DEG, y: p.gz })),
                    scale,
                  )}
                />
                {gz
                  .filter((p) => p.deckDown)
                  .map((p) => (
                    <circle
                      className="deckdownpoint"
                      key={p.heel}
                      cx={scale.x(p.heel * DEG)}
                      cy={scale.y(p.gz)}
                      r={3}
                    />
                  ))}
                {Number.isFinite(selectedSheerGz) && (
                  <circle
                    className="sheerpoint"
                    cx={scale.x(selectedSheerDeg)}
                    cy={scale.y(selectedSheerGz)}
                    r={5}
                  >
                    <title>{`Sheer immersion ${selectedSheerDeg.toFixed(1)}° · GZ ${(selectedSheerGz * metres).toFixed(3)} m`}</title>
                  </circle>
                )}
                {isMaximum && Number.isFinite(selectedMaximum.gz) && (
                  <>
                    <line
                      className="maximumguide"
                      x1={scale.x(selectedMaximum.heel * DEG)}
                      y1={scale.y(0)}
                      x2={scale.x(selectedMaximum.heel * DEG)}
                      y2={scale.y(selectedMaximum.gz)}
                    />
                    <circle
                      className={`maximumpoint ${selectedMaximum.deckDown ? "deckdown" : ""}`}
                      cx={scale.x(selectedMaximum.heel * DEG)}
                      cy={scale.y(selectedMaximum.gz)}
                      r={6}
                    >
                      <title>{`Maximum GZ ${maximumMetres.toFixed(3)} m at ${Math.round(selectedMaximum.heel * DEG)}°${selectedMaximum.deckDown ? ", after sheer immersion" : ""}`}</title>
                    </circle>
                    <text
                      className="maximumlabel"
                      x={scale.x(selectedMaximum.heel * DEG) + 8}
                      y={scale.y(selectedMaximum.gz) - 8}
                    >
                      {`max ${maximumMetres.toFixed(3)} m · ${Math.round(selectedMaximum.heel * DEG)}°`}
                    </text>
                  </>
                )}
              </>
            );
          }}
        </ChartFrame>
        <div className="sheerimmersionreadout">
          <span>
            Sheer immersion{" "}
            <strong>
              {Number.isFinite(selectedSheerDeg)
                ? `${selectedSheerDeg.toFixed(1)}°`
                : "> 90°"}
            </strong>
          </span>
          {Number.isFinite(selectedSheerGz) && (
            <span>
              GZ at immersion{" "}
              <strong>{(selectedSheerGz * metres).toFixed(3)} m</strong>
            </span>
          )}
        </div>
        {gz.some((p) => p.deckDown) && (
          <div className="decknote">
            Orange points use the watertight sheer cap after deck-edge
            immersion.
          </div>
        )}
      </section>
    </div>
  );
}
