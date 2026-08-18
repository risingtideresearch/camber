import { useMemo, useState } from "react";
import { unitScale } from "../core/json";
import {
  gzAreaTerms,
  gzCurve,
  limitingKgAt,
  vcgForGzArea,
  GZ_AREA_HEEL,
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
const AREA_HEEL = GZ_AREA_HEEL * DEG; // the heel the shaded area runs out to, in degrees for this chart
const fmt = (value: number): string =>
  Math.abs(value) >= 1000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : value.toLocaleString(undefined, { maximumSignificantDigits: 4 });

// ---------- how the displacement / KG plane is shaded ----------

type Coloring = "gmt" | "gz30";

interface AreaBand {
  readonly key: string;
  readonly min: number; // the band's lower bound in m·rad (−∞ for the failing one)
  readonly label: string;
  readonly note: string;
}

// IMO A.749 asks for at least 0.055 m·rad under GZ out to 30°. What is above that line is MARGIN, not a
// score — a very large area for a given size usually comes with a stiff, snappy roll — so the top band is
// marked out rather than made the greenest one.
const GZ30_BANDS: readonly AreaBand[] = [
  {
    key: "fail",
    min: -Infinity,
    label: "< 0.055",
    note: "fails the standard IMO criterion",
  },
  {
    key: "slim",
    min: 0.055,
    label: "0.055 – 0.065",
    note: "compliant, but with relatively little margin",
  },
  {
    key: "margin",
    min: 0.065,
    label: "0.065 – 0.09",
    note: "appreciable margin above the minimum",
  },
  {
    key: "ample",
    min: 0.09,
    label: "> 0.09",
    note: "a large area for this range, but not automatically better",
  },
];
const PASS_AREA = GZ30_BANDS[1].min; // the pass/fail contour the standard actually draws

const bandFor = (area: number): AreaBand | null =>
  Number.isFinite(area)
    ? GZ30_BANDS.reduce((best, band) => (area >= band.min ? band : best))
    : null;

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

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
  // Metric tonnes of seawater per model-volume unit: 1.025 t/m³.
  const unit = snapshot.state.unit;
  const metres = unitScale(unit, "m");
  const tonsPerVolume = metres ** 3 * 1.025;
  const volumeDomain = useMemo<readonly [number, number]>(() => {
    if (!limit.length) return [0, 1];
    return [limit[0].vol, limit[limit.length - 1].vol];
  }, [limit]);
  const xDomain: readonly [number, number] = [
    volumeDomain[0] * tonsPerVolume,
    volumeDomain[1] * tonsPerVolume,
  ];
  const yMax = useMemo(
    () =>
      Math.max(
        1,
        hydro?.kb ?? 0,
        ...limit.map((point) => Math.max(0, point.kg)),
      ) * 1.18,
    [hydro, limit],
  );
  // The area under GZ is linear in KG, so ONE integration per displacement places every contour on this
  // chart exactly — see `gzAreaTerms`. The whole field costs a handful of table lookups per column.
  const areaField = useMemo<readonly { x: number; terms: GzAreaTerms }[]>(
    () =>
      curves
        ? limit.map((point) => ({
            x: point.vol * tonsPerVolume,
            terms: gzAreaTerms(curves, point.vol),
          }))
        : [],
    [curves, limit, tonsPerVolume],
  );

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
  const gzMin = Math.min(0, ...gz.map((p) => p.gz)),
    gzMax = Math.max(0, ...gz.map((p) => p.gz)),
    gzPad = Math.max((gzMax - gzMin) * 0.1, yMax * 0.01),
    gzDomain: readonly [number, number] = [gzMin - gzPad, gzMax + gzPad];

  // the selected condition's own area, converted out of model units into the m·rad the criteria are stated in
  const selectedTerms = gzAreaTerms(curves, selected.vol);
  const selectedArea =
    (selectedTerms.kn - selected.kg * selectedTerms.vcg) * metres;
  const selectedBand = bandFor(selectedArea);
  // KG at a stated area, per column of the chart — the inverse is closed form, so these are contours, not
  // searches. Areas are given in m·rad and converted back into the model's own units to land on the axis.
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
                <option value="gz30">GZ area to 30°</option>
              </select>
            </label>
            <span className={`tag ${safe ? "issafe" : "isunsafe"}`}>
              {safe ? "SAFE" : "UNSAFE"}
            </span>
          </span>
        </div>
        <p className="stabilityhint">
          {coloring === "gmt"
            ? "Green is where the transverse metacenter M is above G (GMt > 0)."
            : "Shaded by the area under GZ out to 30°, which the IMO criterion puts at 0.055 m·rad or more."}{" "}
          Click anywhere to inspect that displacement and KG.
        </p>
        <ChartFrame
          xDomain={xDomain}
          yDomain={[0, yMax]}
          xLabel="Displacement Δ (t, seawater)"
          yLabel={`KG / VCG (${unit})`}
          formatX={fmt}
          formatY={fmt}
          ariaLabel={
            coloring === "gmt"
              ? "Limiting KG by displacement; green below the curve is safe and red above it is unsafe"
              : "Limiting KG by displacement, shaded by the area under the GZ curve out to 30 degrees"
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
            const passLine = runsOf(
              areaField.map((column) => ({
                x: column.x,
                y: kgAtArea(column.terms, PASS_AREA),
              })),
              (p) => Number.isFinite(p.y) && p.y >= 0 && p.y <= yMax,
            );
            return (
              <>
                {coloring === "gmt" ? (
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
                ) : (
                  <>
                    {GZ30_BANDS.map((band, i) => (
                      <path
                        key={band.key}
                        className={`gzband ${band.key}`}
                        d={bandPath(
                          areaField.map((column) => ({
                            x: column.x,
                            lo: clamp(
                              kgAtArea(
                                column.terms,
                                GZ30_BANDS[i + 1]?.min ?? Infinity,
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
                        <title>{`${band.label} m·rad — ${band.note}`}</title>
                      </path>
                    ))}
                    {passLine.map((run, i) => (
                      <path
                        key={i}
                        className="passcontour"
                        d={linePath(run, scale)}
                      />
                    ))}
                  </>
                )}
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
                  className={safe ? "condition safe" : "condition unsafe"}
                  cx={scale.x(selected.vol * tonsPerVolume)}
                  cy={scale.y(selected.kg)}
                  r={6}
                />
              </>
            );
          }}
        </ChartFrame>
        {coloring === "gz30" && (
          <div className="bandlegend">
            {GZ30_BANDS.map((band) => (
              <span
                key={band.key}
                className={`bandkey ${band.key}`}
                title={`${band.label} m·rad — ${band.note}`}
              >
                {band.label}
              </span>
            ))}
            <span className="bandunit">m·rad</span>
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
          <span>
            A<sub>30</sub>{" "}
            <strong className={selectedBand ? `area ${selectedBand.key}` : ""}>
              {Number.isFinite(selectedArea)
                ? `${selectedArea.toFixed(3)} m·rad`
                : "n/a"}
            </strong>
            {selectedBand && (
              <span className="areanote"> — {selectedBand.note}</span>
            )}
          </span>
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
          xLabel="Heel (degrees)"
          yLabel={`GZ (${unit})`}
          formatX={(v) => `${Math.round(v)}°`}
          formatY={fmt}
          ariaLabel={`GZ curve for displacement ${fmt(selected.vol * tonsPerVolume)} tonnes and VCG ${fmt(selected.kg)}`}
        >
          {(scale) => {
            // The area the other chart shades, drawn where it is actually measured — so it appears only when
            // that chart is shading by it. Under initial stability the whole curve is the subject and a
            // filled 0–30° corner would single out an angle nothing there is about.
            const upTo = gz.filter((p) => p.heel * DEG <= AREA_HEEL + 1e-9),
              next = gz[upTo.length];
            const edge =
              next && upTo.length
                ? [
                    {
                      x: AREA_HEEL,
                      y:
                        upTo[upTo.length - 1].gz +
                        ((AREA_HEEL - upTo[upTo.length - 1].heel * DEG) /
                          (next.heel * DEG -
                            upTo[upTo.length - 1].heel * DEG)) *
                          (next.gz - upTo[upTo.length - 1].gz),
                    },
                  ]
                : [];
            const under = [
              ...upTo.map((p) => ({ x: p.heel * DEG, y: p.gz })),
              ...edge,
            ];
            return (
              <>
                {coloring === "gz30" && (
                  <>
                    {under.length >= 2 && (
                      <path
                        className={`gzarea ${selectedBand?.key ?? ""}`}
                        d={`${linePath(under, scale)} L${scale.x(under[under.length - 1].x)},${scale.y(0)} L${scale.x(under[0].x)},${scale.y(0)} Z`}
                      />
                    )}
                    <line
                      className="areaedge"
                      x1={scale.x(AREA_HEEL)}
                      y1={scale.top}
                      x2={scale.x(AREA_HEEL)}
                      y2={scale.bottom}
                    />
                    <text
                      className="areaedgelabel"
                      x={scale.x(AREA_HEEL) + 5}
                      y={scale.top + 14}
                    >
                      {Number.isFinite(selectedArea)
                        ? `A₃₀ ${selectedArea.toFixed(3)} m·rad`
                        : "A₃₀ n/a"}
                    </text>
                  </>
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
              </>
            );
          }}
        </ChartFrame>
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
