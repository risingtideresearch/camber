import { useMemo, useState } from "react";
import { unitScale } from "../core/json";
import {
  gzAreaTerms,
  gzCurve,
  limitingKgAt,
  vcgForGzArea,
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

type Coloring = "gmt" | "gz30" | "gz40";

interface AreaBand {
  readonly key: string;
  readonly min: number; // the band's lower bound in m·rad (−∞ for the non-compliant one)
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

const bandFor = (criterion: AreaCriterion, area: number): AreaBand | null =>
  Number.isFinite(area)
    ? criterion.bands.reduce((best, band) => (area >= band.min ? band : best))
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
  // The criterion being shaded by, or null under the initial-stability reading. The readout keeps an area on
  // screen either way, falling back to the standard's first one, so switching the shading never blanks it.
  const criterion = AREA_CRITERIA.find((c) => c.key === coloring) ?? null;
  const readout = criterion ?? AREA_CRITERIA[0];
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
      curves && criterion
        ? limit.map((point) => ({
            x: point.vol * tonsPerVolume,
            terms: gzAreaTerms(curves, point.vol, criterion.upTo),
          }))
        : [],
    [curves, criterion, limit, tonsPerVolume],
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
  const selectedTerms = gzAreaTerms(curves, selected.vol, readout.upTo);
  const selectedArea =
    (selectedTerms.kn - selected.kg * selectedTerms.vcg) * metres;
  const selectedBand = bandFor(readout, selectedArea);
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
                {AREA_CRITERIA.map((c) => (
                  <option key={c.key} value={c.key}>
                    GZ area to {c.deg}°
                  </option>
                ))}
              </select>
            </label>
            <span className={`tag ${safe ? "issafe" : "isunsafe"}`}>
              {safe ? "SAFE" : "UNSAFE"}
            </span>
          </span>
        </div>
        <p className="stabilityhint">
          {criterion
            ? `Shaded by the area under GZ out to ${criterion.deg}°, which the IMO criterion puts at ${fmtArea(passArea(criterion))} m·rad or more.`
            : "Green is where the transverse metacenter M is above G (GMt > 0)."}{" "}
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
            criterion
              ? `Limiting KG by displacement, shaded by the area under the GZ curve out to ${criterion.deg} degrees`
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
            const passLine = runsOf(
              areaField.map((column) => ({
                x: column.x,
                y: criterion
                  ? kgAtArea(column.terms, passArea(criterion))
                  : NaN,
              })),
              (p) => Number.isFinite(p.y) && p.y >= 0 && p.y <= yMax,
            );
            return (
              <>
                {!criterion ? (
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
        {criterion && (
          <div className="bandlegend">
            {criterion.bands.map((band) => (
              <span
                key={band.key}
                className={`bandkey ${band.key}`}
                title={`${band.name} · ${band.range} m·rad — ${band.note}`}
              >
                {band.name}
                <small>{band.range}</small>
              </span>
            ))}
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
            A<sub>{readout.deg}</sub>{" "}
            <strong className={selectedBand ? `area ${selectedBand.key}` : ""}>
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
            const label = `A${sub(heel)}`;
            return (
              <>
                {criterion && (
                  <>
                    {under.length >= 2 && (
                      <path
                        className={`gzarea ${selectedBand?.key ?? ""}`}
                        d={`${linePath(under, scale)} L${scale.x(under[under.length - 1].x)},${scale.y(0)} L${scale.x(under[0].x)},${scale.y(0)} Z`}
                      />
                    )}
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
