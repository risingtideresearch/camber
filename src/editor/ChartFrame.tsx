import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "../components/Button";
import { ButtonGroup } from "../components/ButtonGroup";

// A small, dependency-free pair of Cartesian axes. Stability criteria all live in displacement/KG space,
// so they can supply different layers while retaining exactly this frame, scales, pointer mapping and ticks.
export interface ChartScale {
  x: (value: number) => number;
  y: (value: number) => number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * What a layer needs to drag handles of its own: where the pointer is in DATA coordinates, and a way to stop
 * the frame turning the release into a plot click. Deliberately unclamped — a handle being dragged past the
 * axis should keep tracking the pointer, and it is the layer that knows what its own limits are.
 */
export interface PlotGrab {
  readonly locate: (
    clientX: number,
    clientY: number,
  ) => { x: number; y: number } | null;
  readonly suppressClick: () => void;
  /** True while the frame owns the drag for panning, so handles must keep their hands off it. */
  readonly panActive: boolean;
}

interface ChartFrameProps {
  /** The complete domain. Zooming and panning are constrained to it. */
  readonly xDomain: readonly [number, number];
  readonly yDomain: readonly [number, number];
  /** The useful initial framing; defaults to the complete domain. */
  readonly initialXDomain?: readonly [number, number];
  readonly initialYDomain?: readonly [number, number];
  readonly initialViewLabel?: string;
  /** Enable wheel zoom, temporary/sticky panning and the chart navigation toolbar. */
  readonly panZoom?: boolean;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly formatX?: (value: number) => string;
  readonly formatY?: (value: number) => string;
  /** Optional semantic steps, such as 15° heel ticks. Other axes choose a responsive nice step. */
  readonly xTickStep?: number;
  readonly yTickStep?: number;
  readonly onPlotClick?: (x: number, y: number) => void;
  readonly ariaLabel: string;
  readonly children: (scale: ChartScale, grab: PlotGrab) => ReactNode;
}

const BASE_WIDTH = 800,
  BASE_HEIGHT = 410,
  LEFT_MARGIN = 64,
  RIGHT_MARGIN = 22,
  TOP_MARGIN = 20,
  // A navigable chart parks its toolbar in the top margin rather than above the frame, so that band is opened
  // just wide enough to hold it. It costs a third of what a row of its own did.
  NAVIGABLE_TOP_MARGIN = 32,
  BOTTOM_MARGIN = 58;

interface ChartLayout {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

const makeLayout = (
  width = BASE_WIDTH,
  height = BASE_HEIGHT,
  top = TOP_MARGIN,
): ChartLayout => ({
  width,
  height,
  left: LEFT_MARGIN,
  right: width - RIGHT_MARGIN,
  top,
  bottom: height - BOTTOM_MARGIN,
});

type Domain = readonly [number, number];
interface Viewport {
  readonly key: string;
  readonly x: Domain;
  readonly y: Domain;
}
interface Point {
  readonly x: number;
  readonly y: number;
}
interface DragStart extends Point {
  readonly viewport: Viewport;
  moved: boolean;
}

// ---------- domain and scale arithmetic ----------

// The tightest framing zooming may reach, as a fraction of the complete domain. The toolbar reads it too, so
// that its zoom-in button can go dim exactly when it has nothing left to give.
const MIN_SPAN_FRACTION = 1 / 1000;

const constrainDomain = (domain: Domain, full: Domain): Domain => {
  const fullSpan = full[1] - full[0];
  if (!(fullSpan > 0)) return full;
  const span = Math.min(
    fullSpan,
    Math.max(fullSpan * MIN_SPAN_FRACTION, domain[1] - domain[0]),
  );
  let lo = domain[0],
    hi = lo + span;
  if (lo < full[0]) {
    lo = full[0];
    hi = lo + span;
  }
  if (hi > full[1]) {
    hi = full[1];
    lo = hi - span;
  }
  return [lo, hi];
};

// Whether a viewport axis is framed on a given domain, to within a rounding of its own span. Used only to
// light or dim a control: the preset the chart is already showing, and a zoom that would not move.
const framedOn = (domain: Domain, target: Domain) => {
  const tolerance = Math.max(Math.abs(target[1] - target[0]), 1e-12) * 1e-6;
  return (
    Math.abs(domain[0] - target[0]) <= tolerance &&
    Math.abs(domain[1] - target[1]) <= tolerance
  );
};

const zoomDomain = (
  domain: Domain,
  full: Domain,
  anchor: number,
  factor: number,
): Domain =>
  constrainDomain(
    [
      anchor - (anchor - domain[0]) * factor,
      anchor + (domain[1] - anchor) * factor,
    ],
    full,
  );

const scaleValue = (
  value: number,
  domain: Domain,
  rangeStart: number,
  rangeEnd: number,
) =>
  rangeStart +
  ((value - domain[0]) / (domain[1] - domain[0] || 1)) *
    (rangeEnd - rangeStart);

const chartScale = (viewport: Viewport, layout: ChartLayout): ChartScale => {
  const xSpan = viewport.x[1] - viewport.x[0] || 1,
    ySpan = viewport.y[1] - viewport.y[0] || 1;
  return {
    x: (value) =>
      layout.left +
      ((value - viewport.x[0]) / xSpan) * (layout.right - layout.left),
    y: (value) =>
      layout.bottom -
      ((value - viewport.y[0]) / ySpan) * (layout.bottom - layout.top),
    left: layout.left,
    right: layout.right,
    top: layout.top,
    bottom: layout.bottom,
  };
};

const pointInPlot = ({ x, y }: Point, layout: ChartLayout) =>
  x >= layout.left &&
  x <= layout.right &&
  y >= layout.top &&
  y <= layout.bottom;

interface Ticks {
  readonly values: readonly number[];
  readonly step: number;
}

// Pick 1, 2, 2.5 or 5 times a power of ten, then place ticks only on exact multiples inside the viewport.
// The viewport itself stays untouched: a nice scale should label the data, not change what the user framed.
const niceTicks = (
  domain: Domain,
  pixelSpan: number,
  minSpacing: number,
  requestedStep?: number,
): Ticks => {
  const span = domain[1] - domain[0];
  if (!(span > 0)) return { values: [domain[0]], step: 1 };
  const target = Math.max(1, Math.floor(pixelSpan / minSpacing)),
    rawStep = span / target,
    magnitude = 10 ** Math.floor(Math.log10(rawStep)),
    normalized = rawStep / magnitude,
    multiplier =
      [1, 2, 2.5, 5, 10].find((candidate) => candidate >= normalized) ?? 10,
    automaticStep = multiplier * magnitude,
    step =
      requestedStep && Number.isFinite(requestedStep) && requestedStep > 0
        ? requestedStep
        : automaticStep,
    epsilon = step * 1e-9,
    first = Math.ceil((domain[0] - epsilon) / step),
    last = Math.floor((domain[1] + epsilon) / step),
    values: number[] = [];
  for (let index = first; index <= last && values.length < 1000; index++)
    values.push(Number((index * step).toPrecision(12)) || 0);
  return { values, step };
};

const formatNiceTick = (value: number, step: number): string => {
  if (Math.abs(step) < 1e-9 || Math.abs(step) >= 1e12)
    return value.toExponential(2);
  const exponent = Math.floor(Math.log10(Math.abs(step))),
    normalized = step / 10 ** exponent,
    hasFractionalMultiplier =
      Math.abs(normalized - Math.round(normalized)) > 1e-9,
    digits = Math.min(
      12,
      Math.max(0, -exponent + (hasFractionalMultiplier ? 1 : 0)),
    );
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

// Use the SVG element's CSS-pixel dimensions as its viewBox. One SVG unit therefore remains one screen
// pixel as the panel resizes: the plot expands, while labels, markers and strokes keep a stable size.
function useResponsiveLayout(
  svgRef: RefObject<SVGSVGElement | null>,
  topMargin: number,
) {
  const [size, setSize] = useState({
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
  });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const resize = () => {
      const bounds = svg.getBoundingClientRect();
      if (!(bounds.width > 0 && bounds.height > 0)) return;
      setSize((current) =>
        Math.abs(current.width - bounds.width) < 0.5 &&
        Math.abs(current.height - bounds.height) < 0.5
          ? current
          : { width: bounds.width, height: bounds.height },
      );
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [svgRef]);
  return makeLayout(size.width, size.height, topMargin);
}

// ---------- temporary Space-to-pan state ----------

const releaseFocusedButton = () => {
  const focused = document.activeElement;
  if (focused instanceof HTMLButtonElement) focused.blur();
};

function useTemporaryPan(enabled: boolean) {
  const [active, setActive] = useState(false),
    chartHovered = useRef(false),
    spaceHeld = useRef(false);

  // Holding Space is the conventional temporary hand tool in CAD and drawing software. A focused button is
  // safe to override once the pointer is over the plot, but text-entry controls retain the key themselves.
  useEffect(() => {
    if (!enabled) return;
    const textEntry = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      Boolean(target.closest("input, select, textarea, [contenteditable]"));
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || textEntry(event.target)) return;
      // Remember it globally so entering the chart after pressing Space still picks up the hand tool. Once
      // the chart owns Space, release a previously clicked toolbar button so key-up cannot activate it too.
      spaceHeld.current = true;
      if (chartHovered.current) {
        event.preventDefault();
        releaseFocusedButton();
        setActive(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !spaceHeld.current) return;
      if (chartHovered.current) event.preventDefault();
      spaceHeld.current = false;
      setActive(false);
    };
    const blur = () => {
      spaceHeld.current = false;
      setActive(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [enabled]);

  return {
    active,
    enter: () => {
      chartHovered.current = true;
      if (spaceHeld.current) {
        releaseFocusedButton();
        setActive(true);
      }
    },
    leave: () => {
      chartHovered.current = false;
      if (spaceHeld.current) setActive(false);
    },
  };
}

// ---------- viewport state and pointer interactions ----------

interface NavigationOptions {
  readonly xDomain: Domain;
  readonly yDomain: Domain;
  readonly initialX: Domain;
  readonly initialY: Domain;
  readonly layout: ChartLayout;
  readonly svgRef: RefObject<SVGSVGElement | null>;
  readonly enabled: boolean;
  readonly onPlotClick?: (x: number, y: number) => void;
}

function useChartNavigation({
  xDomain,
  yDomain,
  initialX,
  initialY,
  layout,
  svgRef,
  enabled,
  onPlotClick,
}: NavigationOptions) {
  const viewportKey = [...xDomain, ...yDomain, ...initialX, ...initialY].join(
      "|",
    ),
    [storedViewport, setStoredViewport] = useState<Viewport>(() => ({
      key: viewportKey,
      x: initialX,
      y: initialY,
    })),
    [panEnabled, setPanEnabled] = useState(false),
    [isDragging, setIsDragging] = useState(false),
    temporaryPan = useTemporaryPan(enabled),
    panActive = panEnabled || temporaryPan.active,
    viewport =
      storedViewport.key === viewportKey
        ? storedViewport
        : { key: viewportKey, x: initialX, y: initialY },
    scale = chartScale(viewport, layout),
    drag = useRef<DragStart | null>(null),
    suppressClick = useRef(false);

  const localPoint = (clientX: number, clientY: number): Point | null => {
    const svg = svgRef.current,
      matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    // The SVG may be letterboxed, so its screen transform is more accurate than its bounding rectangle.
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const local = point.matrixTransform(matrix.inverse());
    return Number.isFinite(local.x) && Number.isFinite(local.y)
      ? { x: local.x, y: local.y }
      : null;
  };
  // Pixel → data. The click handler and every draggable layer need the same mapping, so it lives once here.
  const dataAt = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const point = localPoint(clientX, clientY);
    return point
      ? {
          x:
            viewport.x[0] +
            ((point.x - layout.left) / (layout.right - layout.left)) *
              (viewport.x[1] - viewport.x[0]),
          y:
            viewport.y[0] +
            ((layout.bottom - point.y) / (layout.bottom - layout.top)) *
              (viewport.y[1] - viewport.y[0]),
        }
      : null;
  };
  const setView = (x: Domain, y: Domain) =>
    setStoredViewport({ key: viewportKey, x, y });
  const zoomAt = (factor: number, px: number, py: number) => {
    const xAnchor =
        viewport.x[0] +
        ((px - layout.left) / (layout.right - layout.left)) *
          (viewport.x[1] - viewport.x[0]),
      yAnchor =
        viewport.y[0] +
        ((layout.bottom - py) / (layout.bottom - layout.top)) *
          (viewport.y[1] - viewport.y[0]);
    setView(
      zoomDomain(viewport.x, xDomain, xAnchor, factor),
      zoomDomain(viewport.y, yDomain, yAnchor, factor),
    );
  };
  // Toolbar zoom is deliberately independent of pointer position. Work directly from the domain midpoint
  // rather than routing it through screen coordinates, which are reserved for wheel zoom.
  const zoomCentered = (factor: number) =>
    setView(
      zoomDomain(
        viewport.x,
        xDomain,
        (viewport.x[0] + viewport.x[1]) / 2,
        factor,
      ),
      zoomDomain(
        viewport.y,
        yDomain,
        (viewport.y[0] + viewport.y[1]) / 2,
        factor,
      ),
    );

  // React's delegated wheel listener may be passive. Install one directly so chart zoom cannot also scroll
  // its containing panel.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: globalThis.WheelEvent) => {
      if (!enabled) return;
      const point = localPoint(event.clientX, event.clientY);
      if (!point || !pointInPlot(point, layout)) return;
      event.preventDefault();
      zoomAt(Math.exp(event.deltaY * 0.0015), point.x, point.y);
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  });

  const pointerDown = (event: PointerEvent<SVGSVGElement>) => {
    // The middle button drags the plot around whatever mode the chart is in: it is the one press that cannot
    // be mistaken for a selection, so it needs neither the toolbar toggle nor a held key.
    const middle = event.button === 1;
    if (!enabled || (!middle && (!panActive || event.button !== 0))) return;
    const point = localPoint(event.clientX, event.clientY);
    if (!point || !pointInPlot(point, layout)) return;
    // Suppresses the browser's own middle-click autoscroll, which would otherwise take the drag over.
    if (middle) event.preventDefault();
    // DOMPoint coordinates are prototype accessors rather than enumerable own properties, so spreading the
    // point drops x/y and poisons the first pan delta with NaN. Copy the coordinates explicitly.
    drag.current = { x: point.x, y: point.y, viewport, moved: false };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = drag.current,
      point = localPoint(event.clientX, event.clientY);
    if (!start || !point) return;
    const dx = point.x - start.x,
      dy = point.y - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 3) return;
    start.moved = true;
    const xSpan = start.viewport.x[1] - start.viewport.x[0],
      ySpan = start.viewport.y[1] - start.viewport.y[0];
    setView(
      constrainDomain(
        [
          start.viewport.x[0] - (dx / (layout.right - layout.left)) * xSpan,
          start.viewport.x[1] - (dx / (layout.right - layout.left)) * xSpan,
        ],
        xDomain,
      ),
      constrainDomain(
        [
          start.viewport.y[0] + (dy / (layout.bottom - layout.top)) * ySpan,
          start.viewport.y[1] + (dy / (layout.bottom - layout.top)) * ySpan,
        ],
        yDomain,
      ),
    );
  };
  const finishPointer = (
    event: PointerEvent<SVGSVGElement>,
    suppressPanClick: boolean,
  ) => {
    // Suppress even a stationary pan press: Space may be released before the browser dispatches its click.
    if (suppressPanClick && drag.current) suppressClick.current = true;
    drag.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const click = (event: MouseEvent<SVGSVGElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (panActive || !onPlotClick) return;
    const point = localPoint(event.clientX, event.clientY);
    if (!point || !pointInPlot(point, layout)) return;
    const at = dataAt(event.clientX, event.clientY);
    if (at) onPlotClick(at.x, at.y);
  };

  const xSpan = viewport.x[1] - viewport.x[0],
    ySpan = viewport.y[1] - viewport.y[0],
    atLimit = (span: number, full: Domain) =>
      span <= (full[1] - full[0]) * MIN_SPAN_FRACTION * (1 + 1e-9);

  return {
    viewport,
    scale,
    grab: {
      locate: dataAt,
      suppressClick: () => {
        suppressClick.current = true;
      },
      panActive,
    } satisfies PlotGrab,
    panEnabled,
    panActive,
    isDragging,
    atInitial: framedOn(viewport.x, initialX) && framedOn(viewport.y, initialY),
    atFull: framedOn(viewport.x, xDomain) && framedOn(viewport.y, yDomain),
    canZoomIn: !(atLimit(xSpan, xDomain) && atLimit(ySpan, yDomain)),
    canZoomOut: !(
      framedOn(viewport.x, xDomain) && framedOn(viewport.y, yDomain)
    ),
    setPanEnabled,
    setView,
    zoom: zoomCentered,
    svgEvents: {
      onClick: click,
      onPointerDown: pointerDown,
      onPointerMove: pointerMove,
      onPointerUp: (event: PointerEvent<SVGSVGElement>) =>
        finishPointer(event, true),
      onPointerCancel: (event: PointerEvent<SVGSVGElement>) =>
        finishPointer(event, false),
      onPointerEnter: temporaryPan.enter,
      onPointerLeave: temporaryPan.leave,
    },
  };
}

// ---------- toolbar and SVG drawing ----------

// Magnifiers, a hand, a frame closing on its subject and one thrown open to the corners: the gestures every
// chart, map and drawing offers, drawn the way they are drawn everywhere else so they need no reading. The two
// framings cannot say "Design" or "Full" in a glyph, so those words stay on as the accessible name and the
// tooltip — what an icon carries here is the shape of the gesture, not the name of the extent.
const ZOOM_IN_PATH =
    "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm2.5-4h-2v2h-1v-2h-2V9h2V7h1v2h2v1z",
  ZOOM_OUT_PATH =
    "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM7 9h5v1H7z",
  INITIAL_VIEW_PATH =
    "M5 15H3v4c0 1.1.9 2 2 2h4v-2H5v-4zM5 5h4V3H5c-1.1 0-2 .9-2 2v4h2V5zm14-2h-4v2h4v4h2V5c0-1.1-.9-2-2-2zm0 16h-4v2h4c1.1 0 2-.9 2-2v-4h-2v4zM12 9c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
  FULL_VIEW_PATH =
    "M15 3l2.3 2.3-2.89 2.87 1.42 1.42L18.7 6.7 21 9V3h-6zM3 9l2.3-2.3 2.87 2.89 1.42-1.42L6.7 5.3 9 3H3v6zm6 12l-2.3-2.3 2.89-2.87-1.42-1.42L5.3 17.3 3 15v6h6zm12-6l-2.3 2.3-2.87-2.89-1.42 1.42 2.89 2.87L15 21h6v-6z",
  PAN_PATH =
    "M23 5.5V20c0 2.2-1.8 4-4 4h-7.3c-1.08 0-2.1-.43-2.85-1.19L1 14.83s1.26-1.23 1.3-1.25c.22-.19.49-.29.79-.29.22 0 .42.06.6.16.04.01 4.31 2.46 4.31 2.46V4c0-.83.67-1.5 1.5-1.5S11 3.17 11 4v7h1V1.5c0-.83.67-1.5 1.5-1.5S15 .67 15 1.5V11h1V2.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5V11h1V5.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5z";

function NavIcon({ d }: { readonly d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

interface ChartToolbarProps {
  /** Distance from the frame's right edge to the plot's, so the toolbar ends where the drawing does. */
  readonly rightInset: number;
  readonly panActive: boolean;
  readonly panEnabled: boolean;
  readonly initialViewLabel: string;
  readonly atInitial: boolean;
  readonly atFull: boolean;
  readonly canZoomIn: boolean;
  readonly canZoomOut: boolean;
  readonly zoom: (factor: number) => void;
  readonly togglePan: () => void;
  readonly showInitial: () => void;
  readonly showFull: () => void;
}

// Three clusters, because the chart offers three separable things: a magnification, a mode, and a framing to
// return to. The joined pairs follow ButtonGroup's rule — zoom is one movement taken in either direction, and
// the two framings are a pick-one, so whichever the chart is currently showing lights up. Pan stays a
// standalone rounded toggle, since it is lit independently of everything beside it.
function ChartToolbar({
  rightInset,
  panActive,
  panEnabled,
  initialViewLabel,
  atInitial,
  atFull,
  canZoomIn,
  canZoomOut,
  zoom,
  togglePan,
  showInitial,
  showFull,
}: ChartToolbarProps) {
  return (
    <div
      className="chartnav"
      role="group"
      aria-label="Chart navigation"
      style={{ right: `${rightInset}px` }}
    >
      <ButtonGroup className="chartzoom">
        <Button
          onClick={() => zoom(1 / 1.35)}
          disabled={!canZoomIn}
          aria-label="Zoom in"
          title="Zoom in — or scroll the wheel over the plot"
        >
          <NavIcon d={ZOOM_IN_PATH} />
        </Button>
        <Button
          onClick={() => zoom(1.35)}
          disabled={!canZoomOut}
          aria-label="Zoom out"
          title="Zoom out — or scroll the wheel over the plot"
        >
          <NavIcon d={ZOOM_OUT_PATH} />
        </Button>
      </ButtonGroup>
      <Button
        className="chartpan"
        active={panActive}
        aria-pressed={panEnabled}
        aria-label="Pan"
        title={
          panEnabled
            ? "Leave pan mode — clicks select a condition again"
            : "Pan mode — drag the plot instead of selecting. Or hold Space, or drag with the middle button."
        }
        onClick={togglePan}
      >
        <NavIcon d={PAN_PATH} />
      </Button>
      <ButtonGroup className="chartviews">
        <Button
          active={atInitial}
          onClick={showInitial}
          aria-label={`${initialViewLabel} view`}
          title={`Frame the ${initialViewLabel.toLowerCase()} view`}
        >
          <NavIcon d={INITIAL_VIEW_PATH} />
        </Button>
        <Button
          active={atFull}
          onClick={showFull}
          aria-label="Full view"
          title="Frame the complete analysis range"
        >
          <NavIcon d={FULL_VIEW_PATH} />
        </Button>
      </ButtonGroup>
    </div>
  );
}

interface ChartDrawingProps {
  readonly viewport: Viewport;
  readonly layout: ChartLayout;
  readonly clipId: string;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly formatX?: (value: number) => string;
  readonly formatY?: (value: number) => string;
  readonly xTickStep?: number;
  readonly yTickStep?: number;
  readonly children: ReactNode;
}

function ChartDrawing({
  viewport,
  layout,
  clipId,
  xLabel,
  yLabel,
  formatX,
  formatY,
  xTickStep,
  yTickStep,
  children,
}: ChartDrawingProps) {
  const { height, left, right, top, bottom } = layout,
    xTicks = niceTicks(viewport.x, right - left, 100, xTickStep),
    yTicks = niceTicks(viewport.y, bottom - top, 55, yTickStep);
  return (
    <>
      <defs>
        <clipPath id={clipId}>
          <rect x={left} y={top} width={right - left} height={bottom - top} />
        </clipPath>
      </defs>
      {xTicks.values.map((value) => {
        const px = scaleValue(value, viewport.x, left, right);
        return (
          <g key={`x-${value}`}>
            <line className="chartgrid" x1={px} y1={top} x2={px} y2={bottom} />
            <text
              className="charttick"
              x={px}
              y={bottom + 22}
              textAnchor="middle"
            >
              {formatX?.(value) ?? formatNiceTick(value, xTicks.step)}
            </text>
          </g>
        );
      })}
      {yTicks.values.map((value) => {
        const py = scaleValue(value, viewport.y, bottom, top);
        return (
          <g key={`y-${value}`}>
            <line className="chartgrid" x1={left} y1={py} x2={right} y2={py} />
            <text
              className="charttick"
              x={left - 8}
              y={py + 4}
              textAnchor="end"
            >
              {formatY?.(value) ?? formatNiceTick(value, yTicks.step)}
            </text>
          </g>
        );
      })}
      <g clipPath={`url(#${clipId})`}>{children}</g>
      <rect
        className="chartborder"
        x={left}
        y={top}
        width={right - left}
        height={bottom - top}
      />
      <text
        className="chartlabel"
        x={(left + right) / 2}
        y={height - 10}
        textAnchor="middle"
      >
        {xLabel}
      </text>
      <text
        className="chartlabel"
        x={15}
        y={(top + bottom) / 2}
        textAnchor="middle"
        transform={`rotate(-90 15 ${(top + bottom) / 2})`}
      >
        {yLabel}
      </text>
    </>
  );
}

// ---------- public frame ----------

export function ChartFrame({
  xDomain,
  yDomain,
  initialXDomain = xDomain,
  initialYDomain = yDomain,
  initialViewLabel = "Reset",
  panZoom = false,
  xLabel,
  yLabel,
  formatX,
  formatY,
  xTickStep,
  yTickStep,
  onPlotClick,
  ariaLabel,
  children,
}: ChartFrameProps) {
  const svgRef = useRef<SVGSVGElement>(null),
    layout = useResponsiveLayout(
      svgRef,
      panZoom ? NAVIGABLE_TOP_MARGIN : TOP_MARGIN,
    ),
    initialX = constrainDomain(initialXDomain, xDomain),
    initialY = constrainDomain(initialYDomain, yDomain),
    {
      viewport,
      scale,
      grab,
      panEnabled,
      panActive,
      isDragging,
      atInitial,
      atFull,
      canZoomIn,
      canZoomOut,
      setPanEnabled,
      setView,
      zoom,
      svgEvents,
    } = useChartNavigation({
      xDomain,
      yDomain,
      initialX,
      initialY,
      layout,
      svgRef,
      enabled: panZoom,
      onPlotClick,
    }),
    clipId = useId().replace(/:/g, "");

  return (
    <div className={panZoom ? "chartframe navigable" : "chartframe"}>
      {panZoom && (
        <ChartToolbar
          rightInset={layout.width - layout.right}
          panActive={panActive}
          panEnabled={panEnabled}
          initialViewLabel={initialViewLabel}
          atInitial={atInitial}
          atFull={atFull}
          canZoomIn={canZoomIn}
          canZoomOut={canZoomOut}
          zoom={zoom}
          togglePan={() => setPanEnabled((enabled) => !enabled)}
          showInitial={() => setView(initialX, initialY)}
          showFull={() => setView(xDomain, yDomain)}
        />
      )}
      <svg
        ref={svgRef}
        className={`stabilitychart${onPlotClick && !panActive ? " clickable" : ""}${panZoom && panActive ? " pannable" : ""}${isDragging ? " dragging" : ""}`}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={ariaLabel}
        {...svgEvents}
      >
        <ChartDrawing
          viewport={viewport}
          layout={layout}
          clipId={clipId}
          xLabel={xLabel}
          yLabel={yLabel}
          formatX={formatX}
          formatY={formatY}
          xTickStep={xTickStep}
          yTickStep={yTickStep}
        >
          {children(scale, grab)}
        </ChartDrawing>
      </svg>
    </div>
  );
}
