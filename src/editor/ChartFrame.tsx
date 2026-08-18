import type { MouseEvent, ReactNode } from "react";

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

interface ChartFrameProps {
  readonly xDomain: readonly [number, number];
  readonly yDomain: readonly [number, number];
  readonly xLabel: string;
  readonly yLabel: string;
  readonly formatX?: (value: number) => string;
  readonly formatY?: (value: number) => string;
  readonly onPlotClick?: (x: number, y: number) => void;
  readonly ariaLabel: string;
  readonly children: (scale: ChartScale) => ReactNode;
}

const W = 800,
  H = 410,
  LEFT = 76,
  RIGHT = 22,
  TOP = 20,
  BOTTOM = 58,
  TICKS = 5;

export function ChartFrame({
  xDomain,
  yDomain,
  xLabel,
  yLabel,
  formatX = (v) => v.toPrecision(3),
  formatY = (v) => v.toPrecision(3),
  onPlotClick,
  ariaLabel,
  children,
}: ChartFrameProps) {
  const left = LEFT,
    right = W - RIGHT,
    top = TOP,
    bottom = H - BOTTOM,
    xSpan = xDomain[1] - xDomain[0] || 1,
    ySpan = yDomain[1] - yDomain[0] || 1;
  const scale: ChartScale = {
    x: (v) => left + ((v - xDomain[0]) / xSpan) * (right - left),
    y: (v) => bottom - ((v - yDomain[0]) / ySpan) * (bottom - top),
    left,
    right,
    top,
    bottom,
  };
  const click = (event: MouseEvent<SVGSVGElement>) => {
    if (!onPlotClick) return;
    const svg = event.currentTarget,
      matrix = svg.getScreenCTM();
    if (!matrix) return;
    // Convert through the SVG's own screen transform rather than scaling its bounding rectangle. The latter
    // includes the letterboxed space introduced when the viewBox and the responsive element have different
    // aspect ratios, which made the selected point drift vertically or horizontally away from the pointer.
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse()),
      px = local.x,
      py = local.y;
    if (px < left || px > right || py < top || py > bottom) return;
    onPlotClick(
      xDomain[0] + ((px - left) / (right - left)) * xSpan,
      yDomain[0] + ((bottom - py) / (bottom - top)) * ySpan,
    );
  };

  return (
    <svg
      className={onPlotClick ? "stabilitychart clickable" : "stabilitychart"}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={ariaLabel}
      onClick={click}
    >
      {Array.from({ length: TICKS + 1 }, (_, i) => {
        const f = i / TICKS,
          px = left + f * (right - left),
          py = bottom - f * (bottom - top),
          xv = xDomain[0] + f * xSpan,
          yv = yDomain[0] + f * ySpan;
        return (
          <g key={i}>
            <line className="chartgrid" x1={px} y1={top} x2={px} y2={bottom} />
            <line className="chartgrid" x1={left} y1={py} x2={right} y2={py} />
            <text
              className="charttick"
              x={px}
              y={bottom + 22}
              textAnchor="middle"
            >
              {formatX(xv)}
            </text>
            <text
              className="charttick"
              x={left - 12}
              y={py + 4}
              textAnchor="end"
            >
              {formatY(yv)}
            </text>
          </g>
        );
      })}
      {children(scale)}
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
        y={H - 10}
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
    </svg>
  );
}
