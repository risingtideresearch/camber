import { useMemo, useRef, useState, type ReactNode } from "react";
import { NumberInput } from "polymorph-ui";
import { unitScale } from "../core/json";
import {
  gzAreaOf,
  gzAreaTerms,
  gzAtHeel,
  gzCurve,
  gzEnvelope,
  limitingKgAt,
  maximumGz,
  sheerImmersionAngle,
  vcgForGzArea,
  vcgForMaximumGz,
  vcgForMaximumGzHeel,
  GZ_AREA_HEEL_30,
  GZ_AREA_HEEL_40,
  type GzAreaTerms,
  type GzBound,
  type LimitingKgPoint,
} from "../core/stability";
import { Button } from "../components/Button";
import { ButtonGroup } from "../components/ButtonGroup";
import { Dropdown } from "../components/Dropdown";
import { useDocumentSnapshot } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { useStabilityAnalysis } from "./useStabilityAnalysis";
import {
  ChartFrame,
  PLOT_LEFT_INSET,
  type ChartScale,
  type PlotGrab,
} from "./ChartFrame";
import "./StabilityPanel.css";

interface Condition {
  vol: number;
  kg: number;
}

/**
 * How far ONE of the condition's two quantities is allowed to be wrong.
 *
 * Held in DISPLAYED units — tonnes for the displacement, model units for the VCG — because these are the
 * numbers the user types and the numbers a dragged handle lands on.
 *
 * The two extents are separate rather than a ± because a tolerance is often one-sided: the lightship is known
 * and the gear on top of it is not. `linked` is what makes the common symmetrical case one number to keep in
 * mind rather than two to keep equal — while it holds, an edit to either extent, typed or dragged, moves
 * both. It is a statement about the tolerance and not a mode of the panel: the two extents are always what is
 * stored, and always what is shown.
 *
 * `on` is per quantity, so a known displacement can be paired with an uncertain VCG, which is the case that a
 * single switch over the pair could not express.
 */
interface AxisTolerance {
  readonly on: boolean;
  readonly linked: boolean;
  readonly lo: number;
  readonly hi: number;
}

/** The condition's tolerance on both of its axes: x is the displacement, y the VCG. */
interface Spread {
  readonly x: AxisTolerance;
  readonly y: AxisTolerance;
}

/** What an axis contributes to the rectangle — nothing at all while its tolerance is switched off. */
const extentOf = (axis: AxisTolerance): { lo: number; hi: number } =>
  axis.on ? { lo: axis.lo, hi: axis.hi } : { lo: 0, hi: 0 };

/**
 * The reference marks drawn over the shading — everything on the plane that is not the criterion itself.
 *
 * They are ONE object rather than a state each because that is how they are presented: a single Overlays
 * control whose panel has a row per mark. The next reference to arrive is a row in that panel, not another
 * bar above the chart, which is what the panel had been growing one of per feature.
 */
interface Overlays {
  readonly sheerReference: boolean;
  /** The heel the sheer immersion angle is compared against, in degrees. */
  readonly sheerReferenceDeg: number;
  readonly designWaterline: boolean;
  readonly lowestSheer: boolean;
}

const DEFAULT_OVERLAYS: Overlays = {
  sheerReference: true,
  sheerReferenceDeg: 30,
  designWaterline: true,
  lowestSheer: true,
};

/** How finely the displacement interval is scanned for the readings' extremes over the rectangle. */
const REGION_SAMPLES = 24;

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

type Coloring = "imo" | "gmt" | "gzmax" | "gz30" | "gz40";

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
const IMO = {
  area30: 0.055, // m·rad, area under GZ out to 30°
  area40: 0.09, // m·rad, out to 40°
  area3040: 0.03, // m·rad, between 30° and 40°
  gzAt30: 0.2, // m, righting lever at 30° of heel or beyond
  peakDeg: 25, // degrees, the heel maximum GZ must occur at or beyond
  gm: 0.15, // m, initial metacentric height
} as const;

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
    bands: bandsAt([IMO.area30, 0.07, 0.12, 0.2]),
  },
  {
    key: "gz40",
    deg: 40,
    upTo: GZ_AREA_HEEL_40,
    bands: bandsAt([IMO.area40, 0.115, 0.2, 0.33]),
  },
];
/** The pass/fail contour the standard actually draws — the first band's floor. */
const passArea = (criterion: AreaCriterion): number => criterion.bands[1].min;

/**
 * What the plane can be shaded by, in the order the segmented bar offers them. The IMO view comes first
 * because it is the question a design is actually asked — the four below it are the same plane opened up one
 * reading at a time, for when the answer is no and the next thing to know is by how much and on what.
 */
const SHADINGS: readonly {
  readonly key: Coloring;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    key: "imo",
    label: "IMO criteria",
    hint: "Every general intact-stability criterion at once — compliant below the limiting KG curve, non-compliant above it",
  },
  {
    key: "gmt",
    label: "Initial stability",
    hint: "Where the transverse metacenter M stands above G — GMt > 0",
  },
  {
    key: "gzmax",
    label: "Maximum GZ",
    hint: "The largest righting lever the condition reaches, against the 0.20 m criterion",
  },
  ...AREA_CRITERIA.map((criterion) => ({
    key: criterion.key,
    label: `Area to ${criterion.deg}°`,
    hint: `The area under the GZ curve out to ${criterion.deg}°, against the IMO criterion of ${fmtArea(passArea(criterion))} m·rad`,
  })),
];

const MAX_GZ_MIN = IMO.gzAt30; // metres, at a heel of at least 30°
const MAX_GZ_MIN_HEEL = 30 / DEG;
const MAX_GZ_MIN_PEAK_HEEL = IMO.peakDeg / DEG;
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
    min: MAX_GZ_MIN,
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
interface ImoCheck {
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
interface ImoVerdict {
  readonly pass: boolean;
  /** The rectangle has the threshold running through it: some of it complies and some does not. */
  readonly straddles: boolean;
}

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

// ---------- the uncertainty bars ----------

const HANDLE_CAP = 7, // half-length of the visible end cap
  HANDLE_GRAB = 9; // half-extent of the invisible target around it, across the bar
/**
 * What a typed or dragged field stores. polymorph-ui renders the value it is given with `toString`, so an
 * unrounded drag would put a dozen digits in a box 60px wide; rounding on the way IN keeps the number in the
 * state and the number on screen the same one, which is what stops the field fighting its own value.
 */
const snap = (value: number): number =>
  Number.isFinite(value) ? Number(value.toPrecision(4)) : 0;

/**
 * One end of one bar, draggable along its own axis.
 *
 * `ChartFrame` owns pointer events on the SVG, so the press has to be stopped from reaching it — otherwise
 * dragging a handle pans the chart — and the release has to suppress the click the frame would otherwise
 * turn into a brand new condition, moving the point out from under the bar being adjusted. Both are what
 * `PlotGrab` exists for.
 */
function SpreadHandle({
  px,
  py,
  axis,
  label,
  grab,
  onMove,
}: {
  readonly px: number;
  readonly py: number;
  readonly axis: "x" | "y";
  readonly label: string;
  readonly grab: PlotGrab;
  readonly onMove: (at: { x: number; y: number }) => void;
}) {
  const dragging = useRef(false);
  const halfWidth = axis === "x" ? HANDLE_GRAB : HANDLE_CAP + 4,
    halfHeight = axis === "x" ? HANDLE_CAP + 4 : HANDLE_GRAB;
  return (
    <g
      className={`spreadhandle ${axis}`}
      onPointerDown={(event) => {
        if (grab.panActive || event.button !== 0) return;
        event.stopPropagation();
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        // The frame reads its hover off this same move, and a ghost curve chasing the handle being dragged
        // is noise: while a handle has the pointer, it is not a question about somewhere else on the plane.
        event.stopPropagation();
        const at = grab.locate(event.clientX, event.clientY);
        if (at) onMove(at);
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        grab.suppressClick();
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <line
        className="spreadcap"
        x1={axis === "x" ? px : px - HANDLE_CAP}
        y1={axis === "x" ? py - HANDLE_CAP : py}
        x2={axis === "x" ? px : px + HANDLE_CAP}
        y2={axis === "x" ? py + HANDLE_CAP : py}
      />
      <rect
        className="spreadgrab"
        x={px - halfWidth}
        y={py - halfHeight}
        width={halfWidth * 2}
        height={halfHeight * 2}
      />
      <title>{label}</title>
    </g>
  );
}

/**
 * A mark that gives up an explanation on hover or focus, and takes no room until it is asked.
 *
 * CSS-only, and anchored to the bar it sits in rather than to itself: the card scrolls its own overflow, so a
 * bubble hung off a mark near the right-hand end would be clipped by it or would open a scrollbar. Held to
 * the bar's width, it can only ever grow downwards over the chart.
 */
function InfoHint({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <span className="infohint">
      <button type="button" className="infomark" aria-label={label}>
        i
      </button>
      <span className="infobubble" role="tooltip">
        {children}
      </span>
    </span>
  );
}

/**
 * The readings, in one of two sizes.
 *
 * CLOSED they are a wrapping row of the few that are always worth a glance. OPEN they become a grid of the
 * lot, one tile apiece with room for the name, the number and its spread — and the chart above gives up the
 * height, because a card whose numbers are being read does not need as much of a picture.
 */
function Readings({
  readings,
  open,
  onToggle,
}: {
  readonly readings: readonly Reading[];
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className={open ? "gzreadout isopen" : "gzreadout"}>
      {readings
        .filter((reading) => open || reading.always)
        .map((reading) => (
          <span key={reading.id} title={reading.title}>
            <span className="rname">{reading.name}</span>{" "}
            <strong>{reading.value}</strong>
            {reading.range}
            {reading.note}
          </span>
        ))}
      {/* Last in the row, where it reads as the end of what is on show — "…and more", rather than a control
          in the caption asking to be connected to something eight inches below it. */}
      <Button
        variant="ghost"
        className="readmore"
        aria-expanded={open}
        title={
          open
            ? "Show only the key readings, and give the height back to the curve"
            : "Show every reading, at the curve's expense"
        }
        onClick={onToggle}
      >
        {open ? "Less ▴" : "More ▾"}
      </Button>
    </div>
  );
}

/** The ± beside a quantity: whether it has a tolerance at all. Its extents are kept while it is off. */
function ToleranceToggle({
  on,
  what,
  onChange,
}: {
  readonly on: boolean;
  readonly what: string;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <Button
      className="rangetoggle"
      active={on}
      title={
        on
          ? `Every reading spans this tolerance — click to read ${what} as one exact value`
          : `Give ${what} a tolerance, and read every value across it`
      }
      onClick={() => onChange(!on)}
    >
      ±
    </Button>
  );
}

/**
 * A condition's tolerance on one axis: both extents on the quantity's own line, with the tie that links them.
 *
 * BOTH are always on show. A control that collapsed to one box while the two agreed had to be read before it
 * could be trusted — the same field meant "both sides" or "the low side" depending on a number somewhere
 * else — and it regrouped under the pointer as a drag happened to pass through symmetry. Two fields and a
 * link say the same thing with nothing to infer.
 *
 * The signs ride inside their boxes here, which is the one place polymorph-ui's leading label reads correctly:
 * "− 0.60" is the quantity, where "° 30" was a unit stranded in front of its number.
 *
 * `max` is not a limit so much as a scale: polymorph-ui's drag covers min…max in 200px, and without it a
 * field for a 0.6 t tolerance would move a whole tonne per pixel.
 */
function ToleranceCells({
  idBase,
  axis,
  max,
  onExtent,
  onLink,
}: {
  readonly idBase: string;
  readonly axis: AxisTolerance;
  readonly max: number;
  readonly onExtent: (side: "lo" | "hi", value: number) => void;
  readonly onLink: (linked: boolean) => void;
}) {
  return (
    <>
      <NumberInput
        idBase={`${idBase}-lo`}
        label="−"
        value={axis.lo}
        min={0}
        max={max}
        onChange={(value) => onExtent("lo", value)}
      />
      {/* Drawn as the tie between the two boxes it governs — unbroken while they move together, and a line
          with a gap in it while each is its own. A mark rather than a word because it has to say WHICH two
          fields it joins, which a word sitting beside them could not. */}
      <button
        type="button"
        className={`tollink${axis.linked ? " islinked" : ""}`}
        aria-pressed={axis.linked}
        title={
          axis.linked
            ? "The two extents move together — click to give each its own"
            : "Each extent is its own — click to move them together, at the wider of the two"
        }
        aria-label={axis.linked ? "Unlink the extents" : "Link the extents"}
        onClick={() => onLink(!axis.linked)}
      />
      <NumberInput
        idBase={`${idBase}-hi`}
        label="+"
        value={axis.hi}
        min={0}
        max={max}
        onChange={(value) => onExtent("hi", value)}
      />
    </>
  );
}

/**
 * One reading of the selected condition.
 *
 * `always` marks the handful worth having on screen at all times; the rest are there when the section is
 * opened out. None of them depends on what the plane is shaded by — a design either satisfies the criteria or it
 * does not, and which one is being pictured at the moment has no bearing on that.
 */
interface Reading {
  readonly id: string;
  readonly name: ReactNode;
  readonly value: string;
  readonly range: ReactNode;
  readonly note?: ReactNode;
  readonly title?: string;
  readonly always: boolean;
}

/** The spread of a reading across the rectangle, shown under the reading itself. */
const rangeNote = (
  range: { lo: number; hi: number } | null,
  format: (value: number) => string,
): ReactNode =>
  range && range.hi - range.lo > 0 ? (
    <small className="spreadrange">
      {format(range.lo)} – {format(range.hi)}
    </small>
  ) : null;

/**
 * The Overlays menu: which reference marks are drawn. It uses the shared dropdown in its MENU form and its
 * row primitives, so it reads as the same control as Curvature and Mesh resolution rather than as a third way
 * of doing this — but with no toggle on the button, because there is no feature here to switch on. The marks
 * are a list of independent choices, and a master switch over them would be one this panel invented.
 *
 * A mark's PARAMETER sits in the row under the mark it belongs to — the reference angle means nothing without
 * the hatching it defines, and keeping the two together is what stops a "settings" section accumulating at
 * the bottom of the panel. Dimmed rather than hidden while its mark is off: the value stays readable, and the
 * panel does not resize under the pointer as rows are ticked.
 */
function OverlayControls({
  value,
  onChange,
}: {
  readonly value: Overlays;
  readonly onChange: (next: Overlays) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof Overlays>(key: K, next: Overlays[K]): void =>
    onChange({ ...value, [key]: next });
  return (
    <Dropdown
      label="Overlays"
      open={open}
      onOpenChange={setOpen}
      title="Which reference marks are drawn over the shading"
      menuLabel="Overlays"
      align="right"
    >
      <div className="dd-section">
        <div className="dd-group">References</div>
        <label className="dd-row dd-check">
          <input
            type="checkbox"
            checked={value.sheerReference}
            onChange={(e) => set("sheerReference", e.target.checked)}
          />
          <span className="dd-name">Sheer immersion</span>
        </label>
        <div
          className={`dd-row dd-sub${value.sheerReference ? "" : " isoff"}`}
          title="Hatch the displacements whose sheer immerses before this heel"
        >
          <span className="dd-name">Immerses before</span>
          <NumberInput
            label=""
            value={value.sheerReferenceDeg}
            // The field is dragged as well as typed, and a heel is read in whole degrees either way.
            onChange={(deg) => set("sheerReferenceDeg", Math.round(deg))}
            min={5}
            max={90}
          />
          <span className="dd-unit">°</span>
        </div>
        <label className="dd-row dd-check">
          <input
            type="checkbox"
            checked={value.designWaterline}
            onChange={(e) => set("designWaterline", e.target.checked)}
          />
          <span className="dd-name">Design waterline</span>
        </label>
        <label className="dd-row dd-check">
          <input
            type="checkbox"
            checked={value.lowestSheer}
            onChange={(e) => set("lowestSheer", e.target.checked)}
          />
          <span className="dd-name">Lowest sheer-immersing KG</span>
        </label>
      </div>
    </Dropdown>
  );
}

export function StabilityPanel() {
  const snapshot = useDocumentSnapshot();
  const { perf } = useEditorUi();
  const { analysis, error } = useStabilityAnalysis(snapshot, perf);
  const curves = analysis?.curves ?? null,
    limit = analysis?.limit ?? EMPTY_LIMIT,
    hydro = analysis?.hydro ?? null,
    lowestSheerKg = analysis?.lowestSheerKg ?? NaN;
  const [condition, setCondition] = useState<Condition | null>(null);
  // null until a tolerance is touched; `defaultSpread` stands in until then, so the first ± draws a rectangle
  // immediately without seeding state from a viewport the analysis had not produced yet.
  const [spread, setSpread] = useState<Spread | null>(null);
  // Where the pointer is over the plane, if anywhere. Clicking pins a condition; merely pointing at one is
  // enough to see its curve, so the plane can be read continuously without committing to a selection.
  const [hover, setHover] = useState<Condition | null>(null);
  // The plane opens on the whole standard at once, because that is the question a design is asked. The
  // single-reading shadings are what it is opened up into once the answer is no.
  const [coloring, setColoring] = useState<Coloring>("imo");
  const [overlays, setOverlays] = useState<Overlays>(DEFAULT_OVERLAYS);
  // Whether the readings are opened out to all of them. It costs the GZ chart height, which is the trade the
  // button offers: the curve is the subject until the numbers are what is being read.
  const [numbersOpen, setNumbersOpen] = useState(false);
  // Named for what each layer below asks. The reference angle keeps its own name because the hatch and its
  // tooltip are stated in it.
  const showSheerReference = overlays.sheerReference,
    showDesignWaterline = overlays.designWaterline,
    showLowestSheer = overlays.lowestSheer,
    sheerReferenceDeg = overlays.sheerReferenceDeg;
  // The area criterion being shaded by, or null for the initial-stability and maximum-GZ readings. The area
  // readout falls back to the standard's first one, so switching away from area shading never blanks it.
  const criterion = AREA_CRITERIA.find((c) => c.key === coloring) ?? null;
  const isImo = coloring === "imo";
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
  // Off, linked, and — for when they are switched on — visible without swamping the chart: a twentieth of the
  // design framing each way.
  const defaultSpread = useMemo<Spread>(() => {
    const x = snap((designXDomain[1] - designXDomain[0]) / 20),
      y = snap(designYMax / 20);
    return {
      x: { on: false, linked: true, lo: x, hi: x },
      y: { on: false, linked: true, lo: y, hi: y },
    };
  }, [designXDomain, designYMax]);
  const tolerance = spread ?? defaultSpread;
  const editAxis = (axis: "x" | "y", patch: Partial<AxisTolerance>): void =>
    setSpread((s) => {
      const base = s ?? defaultSpread;
      return { ...base, [axis]: { ...base[axis], ...patch } };
    });
  // Every edit to an extent, typed or dragged, comes through here — so `linked` means the same thing to the
  // fields and to the chart's handles: one number, moving both sides of the rectangle at once.
  const setExtent = (
    axis: "x" | "y",
    side: "lo" | "hi",
    value: number,
  ): void => {
    const next = snap(Math.max(0, value));
    editAxis(
      axis,
      tolerance[axis].linked ? { lo: next, hi: next } : { [side]: next },
    );
  };
  // Relinking takes the WIDER extent: it should never quietly narrow the rectangle the readings are over.
  const setLinked = (axis: "x" | "y", linked: boolean): void =>
    editAxis(
      axis,
      linked
        ? (() => {
            const both = Math.max(tolerance[axis].lo, tolerance[axis].hi);
            return { linked, lo: both, hi: both };
          })()
        : { linked },
    );
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
  // KG at a stated area, per column and per band boundary. Clipping GZ at zero costs the closed-form
  // inverse, so each of these is a bisection down its column — see `vcgForGzArea` — which makes them by
  // some way the most expensive thing on the panel. They depend on the hull and the criterion and on
  // nothing the viewport or the pointer is doing, so they are held here rather than solved again inside
  // the render prop: panning, zooming and dragging a bar end then redraw the same numbers through a new
  // scale. Areas arrive in m·rad and are converted back into the model's own units to land on the axis.
  const areaBandRibbons = useMemo(
    () =>
      criterion
        ? criterion.bands.map((band, i) =>
            areaField.map((column) => ({
              x: column.x,
              lo: clamp(
                vcgForGzArea(
                  column.terms,
                  (criterion.bands[i + 1]?.min ?? Infinity) / metres,
                ),
                0,
                yMax,
              ),
              hi: clamp(vcgForGzArea(column.terms, band.min / metres), 0, yMax),
            })),
          )
        : [],
    [areaField, criterion, metres, yMax],
  );
  const areaPassKg = useMemo(
    () =>
      criterion
        ? areaField.map((column) => ({
            x: column.x,
            y: vcgForGzArea(column.terms, passArea(criterion) / metres),
          }))
        : [],
    [areaField, criterion, metres],
  );
  // The standard's six criteria, bound to this hull. Readings come out of the core in model units and are
  // stated here in the units the criteria are written in — metres and metre-radians — so the thresholds can
  // be the literal numbers of the text.
  const imoChecks = useMemo<readonly ImoCheck[]>(() => {
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
  }, [curves, limit, metres]);
  // The limiting KG curve itself: per displacement, each criterion's own bound and the least of them. Held
  // here for the same reason the area ribbons are — six bisections a column is the most expensive thing the
  // panel does, and none of it depends on the viewport or the pointer.
  const imoColumns = useMemo(
    () =>
      imoChecks.length
        ? limit.map((point) => {
            const bounds = imoChecks.map((check) =>
              clamp(check.bound(point.vol), 0, yMax),
            );
            return {
              x: point.vol * tonsPerVolume,
              vol: point.vol,
              bounds,
              limit: Math.min(...bounds),
            };
          })
        : [],
    [imoChecks, limit, tonsPerVolume, yMax],
  );
  // The IMO envelope runs far below KMt — the large-angle criteria bite well under the metacentre — so
  // opening this view on the initial-stability framing would press the complying region into a sliver along
  // the foot of the chart. It gets its own initial framing, off its own curve over the same displacement
  // window, with room above the envelope for the marks that sit there.
  const imoDesignYMax = useMemo(() => {
    const local = imoColumns
      .filter(
        (column) =>
          column.x >= designXDomain[0] && column.x <= designXDomain[1],
      )
      .map((column) => column.limit)
      .filter(Number.isFinite);
    return local.length
      ? clamp(Math.max(...local) * 1.35, yMax / 1000, yMax)
      : designYMax;
  }, [designXDomain, designYMax, imoColumns, yMax]);
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
    maximumPass =
      selectedBeyond30.gz * metres >= MAX_GZ_MIN &&
      selectedMaximum.heel >= MAX_GZ_MIN_PEAK_HEEL,
    selectedSheerHeel = sheerImmersionAngle(curves, selected.vol),
    selectedSheerDeg = selectedSheerHeel * DEG,
    selectedSheerGz = gzAtHeel(
      curves,
      selected.vol,
      selected.kg,
      selectedSheerHeel,
    );
  // ---------- the rectangle, and every reading taken across it ----------
  //
  // Clamped to what the analysis can actually answer for, rather than passed through as typed: a tolerance
  // overhanging the end of the table should narrow the rectangle, not blank the whole band.
  const dispExtent = extentOf(tolerance.x),
    vcgExtent = extentOf(tolerance.y);
  const region =
    tolerance.x.on || tolerance.y.on
      ? {
          vol: [
            clamp(
              selected.vol - dispExtent.lo / tonsPerVolume,
              volumeDomain[0],
              volumeDomain[1],
            ),
            clamp(
              selected.vol + dispExtent.hi / tonsPerVolume,
              volumeDomain[0],
              volumeDomain[1],
            ),
          ] as readonly [number, number],
          kg: [
            Math.max(0, selected.kg - vcgExtent.lo),
            Math.min(yMax, selected.kg + vcgExtent.hi),
          ] as readonly [number, number],
        }
      : null;
  const regionVols = region
    ? Array.from(
        { length: REGION_SAMPLES + 1 },
        (_, i) =>
          region.vol[0] +
          ((region.vol[1] - region.vol[0]) * i) / REGION_SAMPLES,
      )
    : [];
  // Every reading here is non-increasing in VCG — see `gzEnvelope` — so the extremes over the rectangle lie
  // on its two VCG edges and only displacement has to be scanned. Both edges are evaluated rather than
  // assuming which one carries which end, so a reading that ever stopped being monotone would widen the
  // range rather than quietly report the wrong side of it. A sample the table cannot answer for gives up the
  // whole range: a spread over part of the rectangle is not a spread over the rectangle.
  const rangeOf = (
    read: (vol: number, kg: number) => number,
  ): { lo: number; hi: number } | null => {
    if (!region) return null;
    let lo = Infinity,
      hi = -Infinity;
    for (const vol of regionVols)
      for (const kg of region.kg) {
        const value = read(vol, kg);
        if (!Number.isFinite(value)) return null;
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    return { lo, hi };
  };
  const kmtRange = rangeOf((vol) => limitingKgAt(limit, vol)),
    gmtRange = rangeOf((vol, kg) => limitingKgAt(limit, vol) - kg),
    maximumRange = rangeOf((vol, kg) => maximumGz(curves, vol, kg).gz * metres),
    peakRange = rangeOf((vol, kg) => maximumGz(curves, vol, kg).heel * DEG),
    beyond30Range = rangeOf(
      (vol, kg) => maximumGz(curves, vol, kg, MAX_GZ_MIN_HEEL).gz * metres,
    ),
    sheerRange = rangeOf((vol) => sheerImmersionAngle(curves, vol) * DEG);
  // EVERY area criterion, read for the selected condition and spread over the rectangle — not just the one
  // the plane happens to be shaded by. Which criterion is being looked at is a question about the picture;
  // which ones a design has to satisfy is not, and these are the numbers that answer the second.
  //
  // The area is the one reading whose per-displacement setup is worth holding on to, so it does not go
  // through `rangeOf`: one `gzAreaTerms` per column serves both VCG edges.
  const areaReadings = AREA_CRITERIA.map((c) => {
    const value =
      gzAreaOf(gzAreaTerms(curves, selected.vol, c.upTo), selected.kg) * metres;
    const range = region
      ? (() => {
          let lo = Infinity,
            hi = -Infinity;
          for (const vol of regionVols) {
            const terms = gzAreaTerms(curves, vol, c.upTo);
            for (const kg of region.kg) {
              const at = gzAreaOf(terms, kg) * metres;
              if (!Number.isFinite(at)) return null;
              lo = Math.min(lo, at);
              hi = Math.max(hi, at);
            }
          }
          return { lo, hi };
        })()
      : null;
    return { criterion: c, value, band: bandFor(c, value), range };
  });
  // EVERY criterion of the standard against the condition, and against the whole rectangle where there is
  // one. A criterion whose threshold falls inside its own range is neither a pass nor a failure — the box
  // has been drawn across the line, and saying either would be answering for the centre point alone.
  const imoVerdicts: readonly ImoVerdict[] = imoChecks.map((check) => {
    const value = check.read(selected.vol, selected.kg),
      range = rangeOf(check.read);
    return {
      pass: Number.isFinite(value) && value >= check.min,
      straddles:
        range !== null && range.lo < check.min && range.hi >= check.min,
    };
  });
  // Compliance is the conjunction: one criterion short is non-compliant however much margin the rest have.
  const imoPass = imoVerdicts.length > 0 && imoVerdicts.every((v) => v.pass),
    imoStraddles = imoVerdicts.some((v) => v.straddles);
  // What the marker on the plane says, in the terms the plane is currently drawn in.
  const displayedPass = isImo ? imoPass : isMaximum ? maximumPass : safe;
  // The one the plane is shaded by, which is the only place the shading still reaches into the numbers: it
  // decides which contour the rectangle can straddle, and which area the GZ curve fills out to.
  const activeArea =
    areaReadings.find((a) => a.criterion === readout) ?? areaReadings[0];
  const areaRange = activeArea.range;
  const envelope: readonly GzBound[] = region
    ? gzEnvelope(curves, region.vol, region.kg)
    : [];
  // What the rectangle does to the verdict. A tag that still said SAFE with the criterion's own contour
  // running through the box would be answering for the centre point only — which is the reading the box was
  // added to replace.
  const criterionRange = isInitial
      ? gmtRange
      : isMaximum
        ? beyond30Range
        : areaRange,
    criterionFloor = isInitial ? 0 : isMaximum ? MAX_GZ_MIN : passArea(readout),
    // Under the IMO view it is ANY of the six the box may be drawn across, not one nominated reading.
    straddles = isImo
      ? imoStraddles
      : criterionRange !== null &&
        criterionRange.lo < criterionFloor &&
        criterionRange.hi >= criterionFloor;
  // The band is drawn in the colour of its WORST corner, so a tolerance reaching down into a lower band says
  // so in the fill and not only in the numbers.
  const worstBandKey = !region
    ? null
    : isImo
      ? imoVerdicts.some((v) => !v.pass || v.straddles)
        ? "fail"
        : "comfortable"
      : isMaximum
        ? maximumRange
          ? MAX_GZ_BANDS.reduce((best, band) =>
              maximumRange.lo >= band.min ? band : best,
            ).key
          : null
        : criterion
          ? (bandFor(criterion, areaRange?.lo ?? NaN)?.key ?? null)
          : gmtRange && gmtRange.lo <= 0
            ? "fail"
            : null;

  // The hovered condition's own curve, drawn faintly against the pinned one. It deliberately does NOT enter
  // the framing below: the axis belongs to the condition that was chosen, and GZ swings widely enough across
  // the plane — at VCG 0 it is KN itself — that letting a passing pointer into the scale would leave the
  // pinned curve growing and shrinking under the reading being taken from it. A ghost that runs out of the
  // chart is clipped at the plot edge instead, which says plainly that it is off the scale being read.
  const ghost = hover
    ? gzCurve(curves, hover.vol, hover.kg).filter((p) => Number.isFinite(p.gz))
    : [];
  const bandLo = envelope.map((b) => b.lo).filter(Number.isFinite),
    bandHi = envelope.map((b) => b.hi).filter(Number.isFinite);
  const gzMin = Math.min(0, ...gz.map((p) => p.gz), ...bandLo),
    gzMax = Math.max(0, ...gz.map((p) => p.gz), ...bandHi),
    gzPad = Math.max((gzMax - gzMin) * 0.1, yMax * 0.01),
    gzDomain: readonly [number, number] = [gzMin - gzPad, gzMax + gzPad];

  const readings: readonly Reading[] = [
    {
      id: "kmt",
      name: "KMt",
      value: `${fmt(bound)} ${unit}`,
      range: rangeNote(kmtRange, fmt),
      title:
        "Transverse metacentre above the keel — the hull's own geometry, whatever it is loaded to",
      always: false,
    },
    {
      id: "gmt",
      name: "GMt",
      value: `${fmt(bound - selected.kg)} ${unit}`,
      range: rangeNote(gmtRange, fmt),
      title:
        "Metacentric height, KMt − KG. The IMO criterion puts it at 0.15 m or more",
      always: true,
    },
    {
      id: "gzmax",
      name: "GZmax",
      value: Number.isFinite(maximumMetres)
        ? `${maximumMetres.toFixed(3)} m`
        : "n/a",
      range: rangeNote(maximumRange, (v) => v.toFixed(3)),
      title: "The largest righting lever the condition reaches, at any heel",
      always: true,
    },
    {
      id: "peak",
      name: "Peak",
      value: Number.isFinite(selectedMaximum.heel)
        ? `${Math.round(selectedMaximum.heel * DEG)}°`
        : "n/a",
      range: rangeNote(peakRange, (v) => `${Math.round(v)}°`),
      note: selectedMaximum.deckDown ? (
        <span className="areanote"> — after sheer immersion</span>
      ) : undefined,
      title:
        "The heel GZmax occurs at. The IMO criterion puts it at 25° or more",
      always: false,
    },
    {
      id: "beyond30",
      name: "GZ ≥ 30°",
      value: Number.isFinite(selectedBeyond30.gz)
        ? `${(selectedBeyond30.gz * metres).toFixed(3)} m`
        : "n/a",
      range: rangeNote(beyond30Range, (v) => v.toFixed(3)),
      title:
        "The largest righting lever at or beyond 30° of heel. The IMO criterion puts it at 0.20 m or more",
      always: false,
    },
    ...areaReadings.map(({ criterion: c, value, range }) => ({
      id: `area${c.deg}`,
      name: (
        <>
          A<sub>{c.deg}</sub>
        </>
      ),
      value: Number.isFinite(value) ? `${value.toFixed(3)} m·rad` : "n/a",
      range: rangeNote(range, (v) => v.toFixed(3)),
      title: `The area under the GZ curve out to ${c.deg}°. The IMO criterion puts it at ${fmtArea(passArea(c))} m·rad or more`,
      always: true,
    })),
    {
      id: "sheer",
      name: "Sheer immersion",
      value: Number.isFinite(selectedSheerDeg)
        ? `${selectedSheerDeg.toFixed(1)}°`
        : "> 90°",
      range: rangeNote(sheerRange, (v) => `${v.toFixed(1)}°`),
      title: "The heel at which the sheer line first touches the water",
      always: true,
    },
    {
      id: "sheergz",
      name: "GZ at immersion",
      value: Number.isFinite(selectedSheerGz)
        ? `${(selectedSheerGz * metres).toFixed(3)} m`
        : "n/a",
      range: null,
      title:
        "The righting lever the condition has at the moment the sheer immerses",
      always: false,
    },
  ];

  return (
    <div className="stabilitypanel">
      <section className="card stabilitycard">
        <div className="cap">
          <span className="capname">Limiting KG</span>
          <span className="capctls">
            <OverlayControls value={overlays} onChange={setOverlays} />
          </span>
        </div>
        {/* What the plane is shaded by. A segmented bar rather than the select it was, because this is not a
            setting of the chart but the question the whole card answers: it decides the shading, the legend,
            the wording of the verdict, and which reading is taken beside the curve in the next card. A select
            says "minor option" and hides its own alternatives; a bar shows the four readings as the four
            readings. The explanation that used to sit under it in a paragraph of its own is behind the mark
            at the end — it is read once and then never again, which is not worth a permanent row. */}
        <div className="shadebar">
          <ButtonGroup className="shadepick" aria-label="Shade the plane by">
            {SHADINGS.map((shading) => (
              <Button
                key={shading.key}
                active={coloring === shading.key}
                title={shading.hint}
                aria-pressed={coloring === shading.key}
                onClick={() => setColoring(shading.key)}
              >
                {shading.label}
              </Button>
            ))}
          </ButtonGroup>
          <InfoHint label="What this shading means">
            {isImo
              ? "Green is where every general intact-stability criterion of IMO A.749 is met at once. The heavy curve is the limiting KG each displacement allows — the least of the six ceilings, drawn thin behind it — and it is labelled with the criterion that sets it. The 40° criteria are read at 40° flat: downflooding openings are not modelled, so the sheer-immersion overlay is a warning here and not a criterion."
              : criterion
                ? `Shaded by the area under GZ out to ${criterion.deg}°, which the IMO criterion puts at ${fmtArea(passArea(criterion))} m·rad or more.`
                : isMaximum
                  ? "Shaded by maximum GZ. The dashed contour requires GZ ≥ 0.20 m at or beyond 30°; cross-hatching marks a qualifying lever whose peak occurs before 25°."
                  : "Green is where the transverse metacenter M is above G (GMt > 0)."}{" "}
            Point anywhere to see that condition’s curve, and click to pin it.
          </InfoHint>
        </div>
        <ChartFrame
          xDomain={xDomain}
          yDomain={[0, yMax]}
          initialXDomain={designXDomain}
          initialYDomain={[0, isImo ? imoDesignYMax : designYMax]}
          initialViewLabel="Design"
          panZoom
          xLabel="Displacement Δ (t, seawater)"
          yLabel={`KG / VCG (${unit})`}
          formatX={fmt}
          formatY={fmt}
          ariaLabel={
            isImo
              ? "Limiting KG by displacement against every general intact-stability criterion of IMO A.749; green below the curve is compliant and red above it is not"
              : criterion
                ? `Limiting KG by displacement, shaded by the area under the GZ curve out to ${criterion.deg} degrees`
                : isMaximum
                  ? "Displacement and VCG conditions shaded by maximum righting lever, with the 0.20 metre criterion and early peak warning"
                  : "Limiting KG by displacement; green below the curve is safe and red above it is unsafe"
          }
          onPlotClick={(tons, kg) =>
            setCondition({ vol: tons / tonsPerVolume, kg })
          }
          onPlotHover={(at) =>
            setHover(at ? { vol: at.x / tonsPerVolume, kg: at.y } : null)
          }
        >
          {(scale, grab) => {
            const points = limit.map((p) => ({
              x: p.vol * tonsPerVolume,
              y: p.kg,
            }));
            const safeArea = `${linePath(points, scale)} L${scale.x(xDomain[1])},${scale.bottom} L${scale.x(xDomain[0])},${scale.bottom} Z`;
            const areaPassLine = runsOf(
              areaPassKg,
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
            // The limiting KG curve and the criterion that owns each stretch of it. Runs are grouped by
            // which bound is least, so the label appears once per stretch rather than once per column.
            const imoRuns = runsOf(imoColumns, (c) => Number.isFinite(c.limit));
            const imoGovernors = imoRuns.flatMap((run) => {
              const stretches: { columns: typeof run; check: ImoCheck }[] = [];
              for (const column of run) {
                const at = column.bounds.indexOf(column.limit),
                  check = imoChecks[at < 0 ? 0 : at],
                  last = stretches[stretches.length - 1];
                if (last && last.check === check) last.columns.push(column);
                else stretches.push({ columns: [column], check });
              }
              return stretches;
            });
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
                {isImo ? (
                  <>
                    {/* Two states and no ramp: the standard does not grade, it admits or refuses. The
                        margin a design has over each criterion is the OTHER four shadings — this one is
                        the answer, and giving it a gradient would suggest the answer came by degrees. */}
                    <rect
                      className="unsafearea"
                      x={scale.left}
                      y={scale.top}
                      width={scale.right - scale.left}
                      height={scale.bottom - scale.top}
                    />
                    {imoRuns.map((run, i) => (
                      <path
                        key={i}
                        className="safearea"
                        d={`${linePath(
                          run.map((c) => ({ x: c.x, y: c.limit })),
                          scale,
                        )} L${scale.x(run[run.length - 1].x)},${scale.bottom} L${scale.x(run[0].x)},${scale.bottom} Z`}
                      >
                        <title>
                          Every general intact-stability criterion is met below
                          this curve.
                        </title>
                      </path>
                    ))}
                    {/* Each criterion's own bound, so the envelope can be read as the six curves it is the
                        floor of: how close the others run to the one that governs is the margin a change
                        has to work with, and it is invisible in the envelope alone. */}
                    {imoChecks.map((check, ci) =>
                      runsOf(
                        imoColumns.map((column) => ({
                          x: column.x,
                          y: column.bounds[ci],
                        })),
                        (point) => Number.isFinite(point.y),
                      ).map((run, i) => (
                        <path
                          key={`${check.key}-${i}`}
                          className="criterioncontour"
                          d={linePath(run, scale)}
                        >
                          <title>{`${check.title} — the KG this puts a ceiling on`}</title>
                        </path>
                      )),
                    )}
                    {imoRuns.map((run, i) => (
                      <path
                        key={i}
                        className="limitline"
                        d={linePath(
                          run.map((c) => ({ x: c.x, y: c.limit })),
                          scale,
                        )}
                      />
                    ))}
                    {/* Which criterion the envelope is made of here. It changes along the curve, and it is
                        the one a design has to answer, so it is written on the stretch it governs rather
                        than left to be worked out from six overlapping lines. */}
                    {imoGovernors.map(({ columns, check }, i) => {
                      const at = columns[Math.floor(columns.length / 2)],
                        px = scale.x(at.x),
                        py = scale.y(at.limit);
                      return columns.length < 3 ? null : (
                        <text
                          key={i}
                          className="governorlabel"
                          x={px}
                          y={py - 7}
                          textAnchor="middle"
                        >
                          {`${check.label} ${check.rule}`}
                        </text>
                      );
                    })}
                  </>
                ) : isInitial ? (
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
                        d={bandPath(areaBandRibbons[i] ?? [], scale)}
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
                {showLowestSheer &&
                  lowestSheerKg >= 0 &&
                  lowestSheerKg <= yMax && (
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
                {showDesignWaterline &&
                  hydro &&
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
                {!region && (
                  <line
                    className="selectionguide"
                    x1={scale.x(selected.vol * tonsPerVolume)}
                    y1={scale.top}
                    x2={scale.x(selected.vol * tonsPerVolume)}
                    y2={scale.bottom}
                  />
                )}
                {region &&
                  (() => {
                    // The bars are the handles; the rectangle is the region they span.
                    const x0 = scale.x(region.vol[0] * tonsPerVolume),
                      x1 = scale.x(region.vol[1] * tonsPerVolume),
                      y0 = scale.y(region.kg[0]),
                      y1 = scale.y(region.kg[1]),
                      cx = scale.x(selected.vol * tonsPerVolume),
                      cy = scale.y(selected.kg),
                      tons = selected.vol * tonsPerVolume;
                    return (
                      <>
                        {/* The rectangle is drawn only when BOTH quantities have a tolerance — the bars
                            would otherwise put no ink in the corners, which is where the readings' extremes
                            are found and where the box crossing a contour becomes visible. With one of them
                            exact there are no corners: the region IS the bar. */}
                        {tolerance.x.on && tolerance.y.on && (
                          <rect
                            className={`regionbox${straddles ? " straddles" : ""}`}
                            x={Math.min(x0, x1)}
                            y={Math.min(y0, y1)}
                            width={Math.abs(x1 - x0)}
                            height={Math.abs(y1 - y0)}
                          >
                            {straddles && (
                              <title>
                                The criterion&rsquo;s own contour runs through
                                the range — some of it complies and some of it
                                does not.
                              </title>
                            )}
                          </rect>
                        )}
                        {tolerance.x.on && (
                          <>
                            <line
                              className="spreadbar"
                              x1={x0}
                              y1={cy}
                              x2={x1}
                              y2={cy}
                            />
                            <SpreadHandle
                              px={x0}
                              py={cy}
                              axis="x"
                              label="Displacement tolerance below the condition"
                              grab={grab}
                              onMove={(at) => setExtent("x", "lo", tons - at.x)}
                            />
                            <SpreadHandle
                              px={x1}
                              py={cy}
                              axis="x"
                              label="Displacement tolerance above the condition"
                              grab={grab}
                              onMove={(at) => setExtent("x", "hi", at.x - tons)}
                            />
                          </>
                        )}
                        {tolerance.y.on && (
                          <>
                            <line
                              className="spreadbar"
                              x1={cx}
                              y1={y0}
                              x2={cx}
                              y2={y1}
                            />
                            <SpreadHandle
                              px={cx}
                              py={y0}
                              axis="y"
                              label="VCG tolerance below the condition"
                              grab={grab}
                              onMove={(at) =>
                                setExtent("y", "lo", selected.kg - at.y)
                              }
                            />
                            <SpreadHandle
                              px={cx}
                              py={y1}
                              axis="y"
                              label="VCG tolerance above the condition"
                              grab={grab}
                              onMove={(at) =>
                                setExtent("y", "hi", at.y - selected.kg)
                              }
                            />
                          </>
                        )}
                      </>
                    );
                  })()}
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
        {/* The key to the shading, under the drawing it is the key to. */}
        {(criterion || isMaximum) && (
          <div
            className="bandlegend"
            style={{ paddingLeft: `${PLOT_LEFT_INSET}px` }}
          >
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
        {/* The condition itself, and every reading taken of it. The two that DEFINE it are fields rather than
            figures: a loading condition is a number that came out of a weight estimate, and pointing at it on
            the plane is the coarse way to say it. KMt is not among the readings because it IS the limit curve
            (see limitingKgCurve) — the chart states it at this displacement already, and GMt is the form of
            it that the chart does not. */}
        {/* ---------- the condition bar ---------- */}
        {/* The two quantities that DEFINE the condition, as fields rather than figures: a loading condition
            is a number that came out of a weight estimate, and pointing at it on the plane is the coarse way
            to say it. One number to a line, in a grid of name · field · unit · control, so the units stand in
            a column of their own instead of trailing each value into the next one along. The readings TAKEN
            of the condition are in the GZ card, beside the curve they describe. */}
        <div className="conditionbar">
          <div className="quantity">
            <label className="cname" htmlFor="cond-disp::input">
              Δ
            </label>
            <NumberInput
              idBase="cond-disp"
              label=""
              value={snap(selected.vol * tonsPerVolume)}
              min={xDomain[0]}
              max={xDomain[1]}
              onChange={(tons) =>
                setCondition({ vol: tons / tonsPerVolume, kg: selected.kg })
              }
            />
            <span className="cunit">t</span>
            <ToleranceToggle
              on={tolerance.x.on}
              what="the displacement"
              onChange={(on) => editAxis("x", { on })}
            />
            {tolerance.x.on && (
              <ToleranceCells
                idBase="tol-disp"
                axis={tolerance.x}
                max={xDomain[1] - xDomain[0]}
                onExtent={(side, value) => setExtent("x", side, value)}
                onLink={(linked) => setLinked("x", linked)}
              />
            )}
          </div>
          <div className="quantity">
            <label className="cname" htmlFor="cond-kg::input">
              KG
            </label>
            <NumberInput
              idBase="cond-kg"
              label=""
              value={snap(selected.kg)}
              min={0}
              max={yMax}
              onChange={(kg) => setCondition({ vol: selected.vol, kg })}
            />
            <span className="cunit">{unit}</span>
            <ToleranceToggle
              on={tolerance.y.on}
              what="the VCG"
              onChange={(on) => editAxis("y", { on })}
            />
            {tolerance.y.on && (
              <ToleranceCells
                idBase="tol-kg"
                axis={tolerance.y}
                max={yMax}
                onExtent={(side, value) => setExtent("y", side, value)}
                onLink={(linked) => setLinked("y", linked)}
              />
            )}
          </div>
        </div>
      </section>

      <section
        className={`card stabilitycard gzcard${numbersOpen ? " numbersopen" : ""}`}
      >
        <div className="cap">
          <span className="capname">
            {region ? "GZ curve and range" : "GZ curve"}
          </span>
          {/* The pinned condition, and the one the pointer is over. Only the pinned one is fixed here: the
              ghost gives up width first and is cut with an ellipsis, because a reading being taken should not
              slide off the line as the pointer wanders over somewhere with longer numbers. */}
          <span className="val">
            {hover && (
              <span className="ghostval">
                pointing at Δ {fmt(hover.vol * tonsPerVolume)} t · VCG{" "}
                {fmt(hover.kg)} {unit}
              </span>
            )}
            <span className="pinnedval">
              Δ {fmt(selected.vol * tonsPerVolume)} t · VCG {fmt(selected.kg)}{" "}
              {unit}
            </span>
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
                {envelope.length > 0 && (
                  <path
                    className={`gzenvelope ${worstBandKey ?? ""}`}
                    d={bandPath(
                      envelope.map((bound) => ({
                        x: bound.heel * DEG,
                        lo: bound.lo,
                        hi: bound.hi,
                      })),
                      scale,
                    )}
                  >
                    <title>
                      Every GZ curve in the range lies inside this band. Its
                      edges are pointwise extremes, so neither is the curve of
                      any one condition.
                    </title>
                  </path>
                )}
                {criterion && (
                  <>
                    {lobes.map((points, i) => (
                      <path
                        key={i}
                        className={`gzarea ${activeArea.band?.key ?? ""}`}
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
                      {Number.isFinite(activeArea.value)
                        ? `${label} ${fmtArea(activeArea.value)} m·rad`
                        : `${label} n/a`}
                    </text>
                  </>
                )}
                {region &&
                  sheerRange &&
                  sheerRange.hi - sheerRange.lo > 1e-9 && (
                    <rect
                      className="sheerspread"
                      x={scale.x(sheerRange.lo)}
                      y={scale.top}
                      width={Math.max(
                        0,
                        scale.x(sheerRange.hi) - scale.x(sheerRange.lo),
                      )}
                      height={scale.bottom - scale.top}
                    >
                      <title>{`Sheer immersion ${sheerRange.lo.toFixed(1)}° – ${sheerRange.hi.toFixed(1)}° across the range`}</title>
                    </rect>
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
                {ghost.length > 1 && (
                  <path
                    className="gzghost"
                    d={linePath(
                      ghost.map((p) => ({ x: p.heel * DEG, y: p.gz })),
                      scale,
                    )}
                  />
                )}
                <path
                  className="gzline"
                  d={linePath(
                    gz.map((p) => ({ x: p.heel * DEG, y: p.gz })),
                    scale,
                  )}
                />
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
        {/* Every reading taken of the condition, beside the curve they are readings of — the initial-stability
            one, whichever large-angle criterion is being shaded by, and what the sheer does under it. */}
        <Readings
          readings={readings}
          open={numbersOpen}
          onToggle={() => setNumbersOpen((open) => !open)}
        />
      </section>
    </div>
  );
}
