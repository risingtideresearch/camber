import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Vec2 } from "../../core/math";
import type { HullSampling } from "../../core/mesh";
import type { Model } from "../../core/model";
import {
  readTolerance,
  sectionOutline,
  verticalSection,
  withNominal,
  withoutHandle,
  withTolerance,
  type HullOutlines,
  type Placement,
  type SectionKind,
  type SectionOutline,
} from "../../core/sheet/points";
import "./PointViews.css";

// ---------- placing a point in two projections ----------
//
// Two views of one point, and neither is a step in a pipeline: the profile is the hull's silhouette in
// (x, z), the section is the hull's own cut at that point's x in (y, z), and z is the coordinate they share.
// Drag in either and the other re-cuts — the section follows the x it is being given, and the profile shows
// where the section is being taken. Both drags use both of their degrees of freedom, and neither view has to
// exist before the other, which is what makes them a pair rather than a sequence.
//
// Everything is drawn in the SHEET's frame (metres from the transom, off the centreline, above the keel),
// because that is the frame the cells are authored in — the mapping to model coordinates lives in
// `points.ts` and nothing here needs to know the hull is drawn deck-flat.
//
// ---------- what may be dragged ----------
//
// A coordinate is a formula, and the ones worth having usually cannot be dragged: `HULL.LWL * 0.4` is a
// statement, and replacing it with wherever the pointer landed would delete that statement silently. So each
// axis carries its own `placement`, which `readPlacement` returns only for a plain number — a locked axis
// draws its point where it computes to and refuses to move, and a drag that would have moved it just moves
// the axes that are free. Nothing about this is a mode the user sets: it is read off the cell.

export type Axis = "x" | "y" | "z";

/** One coordinate of one point, as the panel resolved it. */
export interface PointAxis {
  /** Sheet-frame metres. NaN where the cell errored, which is drawn as unplaced rather than at zero. */
  readonly value: number;
  /** How to rewrite the cell, or null where it is an expression and may only be shown. */
  readonly placement: Placement | null;
  /** Metres per unit of the row's own unit — a drag writes the number the row is authored in, not metres. */
  readonly factor: number;
  readonly empty: boolean;
}

export interface PlottedPoint {
  /** `${itemId} ${fieldKey}` — one opaque handle, so a drag can name the cell it lands in. */
  readonly id: string;
  readonly itemId: string;
  readonly fieldKey: string;
  readonly name: string;
  readonly axes: Readonly<Record<Axis, PointAxis>>;
  /** The uncertainty region around the nominal, in each view's plane. See `points.ts`. */
  readonly xz: readonly Vec2[];
  readonly yz: readonly Vec2[];
}

/**
 * One cut field, as it appears in the projections.
 *
 * A HORIZONTAL cut is a plane of constant world height, and the sheet's z is a world height, so it really is
 * a level line in both views: `axis` says so and `at` says where.
 *
 * A STATION is not the vertical line it looks like it ought to be. It is cut normal to the plan heading, an
 * authored plan curves, and the two halves are mirrored — so it leans, and closes as a shallow V. `trace` is
 * its own measured outline projected into the profile, and `band` is that swept over the range its position
 * could fall in. Both are empty where there is no measurement to draw from, and the straight line at `at` is
 * then all there is to say. See `plotCuts`.
 */
export interface PlottedCut {
  /** `${itemId} ${fieldKey}`, the same handle a point carries, so one `activeId` serves both. */
  readonly id: string;
  readonly itemId: string;
  readonly fieldKey: string;
  readonly name: string;
  readonly axis: "x" | "z";
  /** Sheet-frame metres. NaN where the cell errored or is empty, which is drawn nowhere. */
  readonly at: number;
  /** How far the position could fall below and above the nominal, both non-negative, in sheet metres. */
  readonly lo: number;
  readonly hi: number;
  /** The cut's own outline in the profile's (x, z), sheet-frame metres. Empty where it is a level line. */
  readonly trace: readonly Vec2[];
  /** `trace` swept over the position's spread. Empty where the position is exact, or there is no trace. */
  readonly band: readonly Vec2[];
  readonly empty: boolean;
}

/**
 * Somewhere a drag can land exactly, and what to write when it does.
 *
 * A position that IS another row's position should say so rather than repeat its number: dropping a tank on
 * the flat a slice measures writes `Slices.tank flat.z`, and the point then follows that slice when the hull
 * changes. The centreline is the same idea with a shorter formula.
 */
export interface SnapTarget {
  readonly axis: Axis;
  /** Sheet-frame metres. */
  readonly at: number;
  /** What the cell becomes — a reference, not the number it currently works out to. */
  readonly formula: string;
  readonly label: string;
  /**
   * The `PlottedCut` this target is, where it is one.
   *
   * A view that already draws that cut names it instead of ruling a second line through it: the plane is on
   * screen either way, and a straight red rule through a leaning station would be drawing it wrong twice.
   */
  readonly cut?: string;
}

/** A cell's new text, per axis. Only the axes a gesture actually moved appear. */
export type Move = Partial<Record<Axis, string>>;

// ---------- fitting content into a box ----------

interface Plane {
  /** The horizontal axis of this view. */
  readonly across: Axis;
  /** The vertical axis, which is always z: both views share it, and that is the point. */
  readonly up: "z";
}

const PROFILE: Plane = { across: "x", up: "z" };
const SECTION: Plane = { across: "y", up: "z" };

interface Fit {
  readonly k: number;
  /** Content (across, up) → screen px. `up` is negated here, so nothing else has to remember to. */
  readonly px: (a: number, b: number) => [number, number];
  /** Screen px → content (across, up). */
  readonly at: (px: number, py: number) => [number, number];
}

const PAD = 16;

function fitTo(w: number, h: number, lo: Vec2, hi: Vec2): Fit {
  const cw = Math.max(hi[0] - lo[0], 1e-6);
  const ch = Math.max(hi[1] - lo[1], 1e-6);
  const k = Math.max(1e-9, Math.min((w - 2 * PAD) / cw, (h - 2 * PAD) / ch));
  const ox = (w - k * cw) / 2 - k * lo[0];
  // Screen y grows downward and z grows up, so the vertical axis is negated once, here.
  const oy = (h - k * ch) / 2 + k * hi[1];
  return {
    k,
    px: (a, b) => [ox + k * a, oy - k * b],
    at: (px, py) => [(px - ox) / k, (oy - py) / k],
  };
}

const path = (pts: readonly Vec2[], fit: Fit, close = false): string =>
  pts.length
    ? pts
        .map((p, i) => {
          const [px, py] = fit.px(p[0], p[1]);
          return `${i ? "L" : "M"}${px.toFixed(2)} ${py.toFixed(2)}`;
        })
        .join("") + (close ? "Z" : "")
    : "";

/** The element's size, kept current — the views draw in screen pixels, so they have to know it. */
function useSize(
  ref: React.RefObject<HTMLDivElement | null>,
): [number, number] {
  const [size, setSize] = useState<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize(([w, h]) =>
        Math.abs(w - box.width) < 0.5 && Math.abs(h - box.height) < 0.5
          ? [w, h]
          : [box.width, box.height],
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

// ---------- the pair ----------

export function PointViews({
  model,
  sampling,
  outlines,
  points,
  cuts,
  snaps,
  activeId,
  reading,
  onFocus,
  onMove,
}: {
  readonly model: Model;
  /** The same sweep the outlines came from — a vertical slice is read off its rows. */
  readonly sampling: HullSampling;
  readonly outlines: HullOutlines;
  readonly points: readonly PlottedPoint[];
  readonly cuts: readonly PlottedCut[];
  readonly snaps: readonly SnapTarget[];
  readonly activeId: string | null;
  readonly reading: "worst" | "likely";
  readonly onFocus: (id: string) => void;
  readonly onMove: (id: string, move: Move) => void;
}) {
  const active = points.find((point) => point.id === activeId) ?? null;
  const activeCut = cuts.find((cut) => cut.id === activeId) ?? null;

  // Which station to cut: whatever is selected says where to look, and says it in its own terms.
  //
  // A POINT asks for the plane THROUGH it. Asking for the plane at its x would be a different station —
  // stations are normal to the plan heading, and the plan is the sheer running a metre off the centreline,
  // so the plane at a point's x misses the point itself by up to 300 mm near the ends. The section is the
  // one thing here that answers "is this inside the boat", and it can only answer it about a plane the point
  // is actually in.
  //
  // A STATION CUT asks for the plane AT its `pos`, because that is what `pos` means and what `slices.ts`
  // measured it as — so the preview is the same cut the schedule reports, not a near neighbour of it.
  //
  // Midships when nothing is selected.
  const askX =
    active && isFinite(active.axes.x.value)
      ? active.axes.x.value
      : activeCut && activeCut.axis === "x" && isFinite(activeCut.at)
        ? activeCut.at
        : (outlines.frame.xSpan[0] + outlines.frame.xSpan[1]) / 2;
  // A selected STATION CUT is previewed as the station it is — the shape whose area the inspector is
  // reporting has to be the shape on screen. Everything else is previewed as a VERTICAL slice, because the
  // pane's question is whether a point is inside the boat and only the plane x = const contains the point to
  // ask it of. Carried as a boolean rather than as the cut, so the memo below is keyed on primitives.
  const asStation = !active && !!activeCut && activeCut.axis === "x";

  // One cut, taken where the selection is. Memoized on what was asked for, so a drag re-cuts once per
  // position rather than once per render — and a formula edit elsewhere re-cuts not at all.
  const section = useMemo(
    () =>
      asStation
        ? sectionOutline(model, outlines.frame, { k: "at", x: askX })
        : verticalSection(sampling, outlines.frame, askX),
    [model, sampling, outlines.frame, askX, asStation],
  );

  return (
    <div className="pviews">
      <PointPlot
        plane={PROFILE}
        label="Profile"
        hint="The hull in side view. Its silhouette, not a cut — context for x and z, never a boundary."
        outlines={outlines}
        section={null}
        cutKind={section?.kind ?? null}
        cutAt={section?.x ?? null}
        cutTrace={section?.trace ?? null}
        points={points}
        cuts={cuts}
        snaps={snaps}
        activeId={activeId}
        reading={reading}
        onFocus={onFocus}
        onMove={onMove}
      />
      <PointPlot
        plane={SECTION}
        label={
          !section
            ? "Section"
            : section.kind === "station"
              ? // The station's OWN x, which is the `pos` that names this cut.
                `Station x = ${section.x.toFixed(2)} m${section.clamped ? " (clamped to the hull)" : ""}`
              : `Vertical slice at x = ${section.x.toFixed(2)} m`
        }
        hint={
          section?.kind === "station"
            ? "The hull's own station — normal to the plan, and the cut whose area the schedule reports."
            : "The hull cut straight across at this x, looking forward. A point outside the outline is outside the boat."
        }
        outlines={outlines}
        section={section}
        cutKind={null}
        cutAt={null}
        cutTrace={null}
        points={points}
        cuts={cuts}
        snaps={snaps}
        activeId={activeId}
        reading={reading}
        onFocus={onFocus}
        onMove={onMove}
      />
    </div>
  );
}

// ---------- one view ----------

interface DragState {
  readonly id: string;
  /** Pointer offset from the marker at grab time, in content units — so the point does not jump. */
  readonly grab: Vec2;
  /** Which axes this gesture is allowed to write. A locked coordinate is simply absent. */
  readonly axes: readonly Axis[];
  /** A tolerance handle rather than the point itself. */
  readonly tolerance: Axis | null;
  /**
   * The cells as they stood when the gesture STARTED, and what every frame of it is computed against.
   *
   * A drag writes to the document on every move, so reading the cell back each frame would feed the drag
   * its own output. That is not merely redundant, it is wrong: one frame passing within snapping distance of
   * a slice writes `Slices.frame 4.pos`, and the next frame reads THAT as the cell's base and appends an
   * offset to it — so brushing past a slice on the way somewhere else leaves the reference behind, welded
   * into the coordinate for the rest of the gesture. Held from the start, a frame near the slice writes the
   * reference and a frame away from it writes a plain number again, because both are computed from the same
   * text that was there before the pointer went down.
   */
  readonly from: Readonly<Partial<Record<Axis, PointAxis>>>;
}

const SNAP_PX = 7;

function PointPlot({
  plane,
  label,
  hint,
  outlines,
  section,
  cutKind,
  cutAt,
  cutTrace,
  points,
  cuts,
  snaps,
  activeId,
  reading,
  onFocus,
  onMove,
}: {
  readonly plane: Plane;
  readonly label: string;
  readonly hint: string;
  readonly outlines: HullOutlines;
  readonly section: SectionOutline | null;
  /** Which kind of cut is being previewed, or null in the pane that IS the preview. */
  readonly cutKind: SectionKind | null;
  /** Its x — the rule a vertical slice is drawn as. */
  readonly cutAt: number | null;
  /** Its own outline seen from the side, which a station needs and a vertical slice does not. */
  readonly cutTrace: readonly Vec2[] | null;
  readonly points: readonly PlottedPoint[];
  readonly cuts: readonly PlottedCut[];
  readonly snaps: readonly SnapTarget[];
  readonly activeId: string | null;
  readonly reading: "worst" | "likely";
  readonly onFocus: (id: string) => void;
  readonly onMove: (id: string, move: Move) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, h] = useSize(box);
  const [drag, setDrag] = useState<DragState | null>(null);
  const profile = plane.across === "x";

  const regionOf = (point: PlottedPoint): readonly Vec2[] =>
    profile ? point.xz : point.yz;
  const coords = (point: PlottedPoint): Vec2 => [
    point.axes[plane.across].value,
    point.axes[plane.up].value,
  ];
  const plotted = (point: PlottedPoint): boolean => {
    const [a, b] = coords(point);
    return isFinite(a) && isFinite(b);
  };

  // The view fits the hull AND everything drawn against it: a mast head or a crew weight on the rail sits
  // outside the outline, and a view that cropped it would hide the very thing being placed.
  let lo: Vec2 = [Infinity, Infinity];
  let hi: Vec2 = [-Infinity, -Infinity];
  const grow = (a: number, b: number) => {
    if (!isFinite(a) || !isFinite(b)) return;
    lo = [Math.min(lo[0], a), Math.min(lo[1], b)];
    hi = [Math.max(hi[0], a), Math.max(hi[1], b)];
  };
  if (profile) {
    for (const [x, z] of outlines.profile.upper) grow(x, z);
    for (const [x, z] of outlines.profile.lower) grow(x, z);
  } else if (section) {
    for (const [y, z] of section.starboard) grow(y, z);
    for (const [y, z] of section.port) grow(y, z);
  } else {
    grow(outlines.frame.ySpan[0], outlines.frame.zSpan[0]);
    grow(outlines.frame.ySpan[1], outlines.frame.zSpan[1]);
  }
  for (const point of points) {
    if (!plotted(point)) continue;
    const [a, b] = coords(point);
    grow(a, b);
    for (const [da, db] of regionOf(point)) grow(a + da, b + db);
  }
  if (!isFinite(lo[0])) {
    lo = [0, 0];
    hi = [1, 1];
  }

  const fit = fitTo(w, h, lo, hi);
  const hullLength = Math.max(
    1e-6,
    outlines.frame.xSpan[1] - outlines.frame.xSpan[0],
  );
  const axisSnaps = snaps.filter(
    (snap) => snap.axis === plane.across || snap.axis === plane.up,
  );
  // Which cuts this view actually has on screen. A cut belonging to an item the view is not scoped to is not
  // among them, and its snap is still worth ruling a line for.
  const shownCuts = new Set(
    cuts
      .filter(
        (cut) =>
          (profile && cut.trace.length > 1) ||
          cut.axis === plane.across ||
          cut.axis === plane.up,
      )
      .map((cut) => cut.id),
  );

  /**
   * The pointer, in content units.
   *
   * Measured against the event's own root `<svg>` rather than against a ref, so a handler works wherever it
   * is attached — the surface, a point, a tolerance handle — and nothing here reaches for a ref at all.
   */
  const pointerAt = (event: React.PointerEvent): Vec2 => {
    const target = event.currentTarget as SVGElement;
    const root = target.ownerSVGElement ?? (target as SVGSVGElement);
    const rect = root.getBoundingClientRect();
    return fit.at(event.clientX - rect.left, event.clientY - rect.top);
  };

  /**
   * Write one axis: the nearest thing the drag can land exactly on, otherwise the number.
   *
   * The rounding follows the SCREEN — one pixel, converted into the cell's own unit — so a drag writes as
   * much precision as the gesture actually carried and not the seventeen digits a float would offer.
   */
  const textFor = (
    axis: Axis,
    placement: Placement,
    factor: number,
    metres: number,
  ): string => {
    const step = 1 / (fit.k * factor);
    const onScreen = (at: number) => Math.abs(at - metres) * fit.k < SNAP_PX;

    // A cell with a base of its own snaps to ITS OWN base and nothing else. A reference snap replaces the
    // whole cell, which is right for a bare number and wrong here — writing `Slices.frame 4.pos` over
    // `HULL.LCB + 2` would delete the LCB, and writing the offset that lands on the slice today would look
    // like a snap while following nothing. Landing on the base writes the base, which says what it means.
    if (!placement.bare) {
      const base = withoutHandle(placement);
      const at = placement.handle
        ? (placement.value - placement.handle.contributes) * factor
        : placement.value * factor;
      if (base !== null && onScreen(at)) return base;
      return withNominal(placement, metres / factor, step);
    }

    const near = axisSnaps
      .filter((snap) => snap.axis === axis)
      .find((snap) => onScreen(snap.at));
    if (near) return near.formula;
    return withNominal(placement, metres / factor, step);
  };

  const move = (state: DragState, event: React.PointerEvent) => {
    const point = points.find((p) => p.id === state.id);
    if (!point) return;
    const [pa, pb] = pointerAt(event);
    const wanted: Record<Axis, number> = {
      x: point.axes.x.value,
      y: point.axes.y.value,
      z: point.axes.z.value,
    };
    wanted[plane.across] = pa - state.grab[0];
    wanted[plane.up] = pb - state.grab[1];

    const out: Move = {};
    if (state.tolerance) {
      const axis = state.tolerance;
      const cell = state.from[axis];
      if (!cell?.placement) return;
      // The nominal does not move while a tolerance is dragged, so the reach is measured from where the
      // point stood when the handle was taken.
      const reach = Math.abs(wanted[axis] - cell.placement.value * cell.factor);
      const written = withTolerance(
        cell.placement,
        reach / cell.factor,
        1 / (fit.k * cell.factor),
      );
      if (written !== null) out[axis] = written;
    } else {
      for (const axis of state.axes) {
        const cell = state.from[axis];
        if (!cell?.placement) continue;
        out[axis] = textFor(axis, cell.placement, cell.factor, wanted[axis]);
      }
    }
    if (Object.keys(out).length) onMove(state.id, out);
  };

  const start = (
    point: PlottedPoint,
    event: React.PointerEvent,
    tolerance: Axis | null,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    onFocus(point.id);
    const axes = [plane.across, plane.up].filter(
      (axis) => point.axes[axis].placement !== null,
    );
    if (!axes.length) return; // both coordinates are expressions: shown, never moved
    const [pa, pb] = pointerAt(event);
    const [a, b] = coords(point);
    (event.target as Element).setPointerCapture(event.pointerId);
    setDrag({
      id: point.id,
      grab: tolerance ? [0, 0] : [pa - a, pb - b],
      axes,
      tolerance:
        tolerance && point.axes[tolerance].placement ? tolerance : null,
      // Every axis the gesture might write, as it reads now. See `DragState.from`.
      from: Object.fromEntries(
        ([plane.across, plane.up] as Axis[]).map((axis) => [
          axis,
          point.axes[axis],
        ]),
      ),
    });
  };

  return (
    <div className="pview" ref={box}>
      <div className="pviewcap" title={hint}>
        {label}
      </div>
      <svg
        className="pviewsvg"
        width={w}
        height={h}
        onPointerMove={(event) => drag && move(drag, event)}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      >
        {/* The datum lines the frame is stated against: the keel baseline z = 0, and the centreline y = 0. */}
        <line
          className="pdatum"
          x1={0}
          x2={w}
          y1={fit.px(0, 0)[1]}
          y2={fit.px(0, 0)[1]}
        />
        {!profile && (
          <line
            className="pdatum"
            x1={fit.px(0, 0)[0]}
            x2={fit.px(0, 0)[0]}
            y1={0}
            y2={h}
          />
        )}

        {profile ? (
          <>
            {/* One closed outline rather than two curves: the silhouette joins at the stem and across the
                transom, and drawn open it reads as two unrelated lines instead of as a boat. */}
            <path
              className="phull"
              d={path(
                [
                  ...outlines.profile.upper,
                  ...[...outlines.profile.lower].reverse(),
                ],
                fit,
                true,
              )}
            />
            {/* The cut shown beside this, seen from the side.
                A VERTICAL slice is a rule, drawn the full height: the plane is x = const, so a point at that
                x is on it wherever it sits, and the plane really does go on past the hull.
                A STATION is a curve, because its plane is normal to the plan heading and its x runs with the
                athwartships offset — a vertical line there would mark a plane the hull was never cut on. */}
            {cutKind === "vertical" && cutAt !== null && (
              <line
                className="pcut"
                x1={fit.px(cutAt, 0)[0]}
                x2={fit.px(cutAt, 0)[0]}
                y1={0}
                y2={h}
              />
            )}
            {cutKind === "station" && cutTrace && cutTrace.length > 1 && (
              <path className="pcut" d={path(cutTrace, fit)} />
            )}
          </>
        ) : section ? (
          <>
            <path className="phull" d={path(section.starboard, fit)} />
            <path className="phull" d={path(section.port, fit)} />
          </>
        ) : (
          <text className="pnone" x={w / 2} y={h / 2}>
            no section here
          </text>
        )}

        {/* Where a drag would land exactly. Drawn only while one is in progress: they are an aid to a
            gesture, and a static view cluttered with them says nothing. */}
        {drag &&
          axisSnaps.map((snap, i) => {
            const along = snap.axis === plane.up;
            const [sx, sy] = fit.px(snap.at, snap.at);
            // A cut this view is already drawing keeps its own line and gets only its name: ruling a second
            // line over the first says nothing, and for a station it would say it straight over a curve.
            const drawn = !!snap.cut && shownCuts.has(snap.cut);
            return (
              <g key={i}>
                {!drawn && (
                  <line
                    className="psnap"
                    x1={along ? 0 : sx}
                    x2={along ? w : sx}
                    y1={along ? sy : 0}
                    y2={along ? sy : h}
                  />
                )}
                {/* Named, because what a snap WRITES is a reference and not the number under the pointer —
                    the label is the only thing that says which. */}
                <text
                  className="psnaplabel"
                  x={along ? w - 5 : sx + 4}
                  y={along ? sy - 4 : 12}
                  textAnchor={along ? "end" : "start"}
                >
                  {snap.label}
                </text>
              </g>
            );
          })}

        {/* The cuts, under the points: a plane seen edge-on is a line, and a point sitting ON one is the
            thing being read off the drawing — so the line must never cover the marker. A cut this view has
            no line for is simply absent: a station has no edge in a section, being the plane you are looking
            along, and the caption above already says which one that is. */}
        {cuts.map((cut) => {
          const on = cut.id === activeId;
          const press = (event: { stopPropagation: () => void }) => {
            event.stopPropagation();
            onFocus(cut.id);
          };

          // A station, drawn as the leaning lens it is. Only in the profile: in a section it is the plane
          // being looked along, and the caption above already says which one that is.
          if (profile && cut.trace.length) {
            const top = cut.trace.reduce((a, b) => (a[1] > b[1] ? a : b));
            const [tx, ty] = fit.px(top[0], top[1]);
            return (
              <g
                key={cut.id}
                className={`pcutline${on ? " on" : ""}`}
                onPointerDown={press}
              >
                {cut.band.length > 2 && (
                  <path className="pcutband" d={path(cut.band, fit, true)} />
                )}
                {/* Open, not closed. The trace runs sheer to keel and stops there — closing it would stroke
                    a straight line back up to the sheer across the middle of the section, which is not a
                    piece of hull. Only the swept band above is a region. */}
                <path className="pcutedge" d={path(cut.trace, fit)} />
                {/* The grab target: the same curve under a fat invisible stroke, because a leaning line a
                    pixel or two wide is not something a pointer can hit. */}
                <path className="pcuthit" d={path(cut.trace, fit)} />
                <text className="pcutlabel" x={tx + 4} y={ty - 4}>
                  {cut.name}
                </text>
              </g>
            );
          }

          // A level line: a horizontal cut in either view, and a station the hull has not been cut at, where
          // the position is the only thing there is to say.
          if (cut.axis !== plane.across && cut.axis !== plane.up) return null;
          if (!isFinite(cut.at)) return null;
          const along = cut.axis === plane.up;
          const line = (v: number): [number, number] =>
            along ? fit.px(0, v) : fit.px(v, 0);
          const [nx, ny] = line(cut.at);
          const [lx, ly] = line(cut.at - cut.lo);
          const [hx, hy] = line(cut.at + cut.hi);
          return (
            <g
              key={cut.id}
              className={`pcutline${on ? " on" : ""}${cut.trace.length ? "" : " flat"}`}
              onPointerDown={press}
            >
              {/* Where the position could actually be. A cut known to ±5 cm is a band, and a bare line would
                  claim a precision the cell does not have. */}
              {cut.lo + cut.hi > 0 && (
                <rect
                  className="pcutband"
                  x={along ? 0 : Math.min(lx, hx)}
                  y={along ? Math.min(ly, hy) : 0}
                  width={along ? w : Math.max(1, Math.abs(hx - lx))}
                  height={along ? Math.max(1, Math.abs(hy - ly)) : h}
                />
              )}
              <line
                className="pcutedge"
                x1={along ? 0 : nx}
                x2={along ? w : nx}
                y1={along ? ny : 0}
                y2={along ? ny : h}
              />
              <line
                className="pcuthit"
                x1={along ? 0 : nx}
                x2={along ? w : nx}
                y1={along ? ny : 0}
                y2={along ? ny : h}
              />
              <text
                className="pcutlabel"
                x={along ? 5 : nx + 4}
                y={along ? ny - 4 : h - 5}
              >
                {cut.name}
              </text>
            </g>
          );
        })}

        {points.map((point) => {
          if (!plotted(point)) return null;
          const [a, b] = coords(point);
          const [cx, cy] = fit.px(a, b);
          const on = point.id === activeId;
          // A section is one station, and a point at another one is not in it. Drawn at full strength it
          // would read as sitting inside this outline, which is a claim about a different part of the boat —
          // so it fades with how far along the hull it actually is. The profile shows every point equally,
          // because a silhouette really does contain all of them.
          const away =
            profile || !section
              ? 0
              : Math.abs(point.axes.x.value - section.x) / hullLength;
          const faded = Math.max(0.12, Math.min(1, 1 - away * 6));
          const region = regionOf(point);
          const ghost = point.axes[plane.across].empty || point.axes.z.empty;
          const acrossFree = point.axes[plane.across].placement !== null;
          const upFree = point.axes.z.placement !== null;
          // The cursor says which motion this projection can actually write. A point with y locked but z
          // free, for example, is a vertical handle in the section rather than a two-dimensional grab.
          const motion =
            acrossFree && upFree
              ? " free-both"
              : acrossFree
                ? " free-across"
                : upFree
                  ? " free-up"
                  : " locked";
          return (
            <g
              key={point.id}
              className={`ppoint${on ? " on" : ""}${ghost ? " ghost" : ""}${motion}`}
              style={faded < 1 ? { opacity: faded } : undefined}
              onPointerDown={(event) => start(point, event, null)}
            >
              {region.length > 1 && (
                <path
                  className={`pspread p-${reading}`}
                  d={path(
                    region.map(([da, db]): Vec2 => [a + da, b + db]),
                    fit,
                    region.length > 2,
                  )}
                />
              )}
              {/* The grab target, which is deliberately larger than the mark and always filled: a marker
                  drawn as a ring (`fill: none`, an unplaced point) is hit-testable only ON the ring, and a
                  3.5px dot is a small thing to ask anyone to hit. */}
              <circle className="phit" cx={cx} cy={cy} r={10} />
              <circle className="pdot" cx={cx} cy={cy} r={on ? 5 : 3.5} />
              {point.name && (
                <text className="plabel" x={cx + 8} y={cy - 7}>
                  {point.name}
                </text>
              )}
            </g>
          );
        })}

        {/* The tolerance handles, on the active point only: one per axis this view shows, sitting at the
            edge of its own reach. Dragging one states how well the position is known, which is a different
            claim from where it is — so it is a different handle. */}
        {points
          .filter((point) => point.id === activeId && plotted(point))
          .flatMap((point) =>
            [plane.across, plane.up].map((axis) => {
              const cell = point.axes[axis];
              const handle = cell.placement?.handle;
              const tol = handle ? readTolerance(handle.tail) : null;
              // A handle sits on the EDGE of the region, so a coordinate with no ± has no edge to grab —
              // and a zero-width handle would sit exactly on the marker and swallow every attempt to move
              // the point. The first ± is typed; dragging is how it is then refined.
              if (!tol) return null;
              const [a, b] = coords(point);
              const reach = tol * cell.factor;
              const at: Vec2 = axis === "z" ? [a, b + reach] : [a + reach, b];
              const [hx, hy] = fit.px(at[0], at[1]);
              return (
                <rect
                  key={axis}
                  className={`phandle ${axis === "z" ? "vertical" : "horizontal"}`}
                  x={hx - 3.5}
                  y={hy - 3.5}
                  width={7}
                  height={7}
                  onPointerDown={(event) => start(point, event, axis)}
                >
                  <title>{`How well ${axis} is known — drag to state a ±`}</title>
                </rect>
              );
            }),
          )}
      </svg>
    </div>
  );
}
