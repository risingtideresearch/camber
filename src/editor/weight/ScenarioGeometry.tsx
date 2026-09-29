import { useMemo, useState } from "react";
import type { Vec2 } from "../../core/math";
import type { HullSampling } from "../../core/mesh";
import type { Model } from "../../core/model";
import type { Item } from "../../core/sheet/book";
import type { BookResults } from "../../core/sheet/evaluate";
import { hullOutlines } from "../../core/sheet/points";
import {
  comparisonPoints,
  comparisonCentreOfGravity,
  type ComparisonPoint,
} from "./pointPlots";
import { sig } from "./weightFormat";

interface World {
  readonly name: string;
  readonly items: readonly Item[];
  readonly results: BookResults;
  readonly pending: boolean;
}

/** Read-only overlays: both scenarios are fitted together, with different shapes as well as colours. */
export function ScenarioGeometry({
  current,
  other,
  fieldKey,
  summary = false,
  contextual = false,
  model,
  sampling,
}: {
  readonly current: World;
  readonly other: World;
  readonly fieldKey: string | null;
  readonly summary?: boolean;
  readonly contextual?: boolean;
  readonly model: Model;
  readonly sampling: HullSampling | null;
}) {
  const [open, setOpen] = useState(!contextual);
  const outlines = useMemo(
    () => (sampling ? hullOutlines(model, sampling) : null),
    [model, sampling],
  );
  const worlds = [current, other] as const;
  const points = worlds.map((world) =>
    world.pending
      ? []
      : summary
        ? comparisonCentreOfGravity(world.results)
        : comparisonPoints(world.items, world.results, fieldKey),
  );
  const hasFields = worlds.some((world) =>
    world.items.some((item) =>
      Object.entries(item.fields).some(
        ([key, field]) =>
          field.k === "point" && (!fieldKey || fieldKey === key),
      ),
    ),
  );
  if (!summary && !hasFields) return null;
  return (
    <details
      className="wscenario-geometry"
      aria-label="Scenario geometry comparison"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {summary
          ? "Centre of gravity"
          : contextual
            ? "Show item geometry"
            : "Point positions"}
      </summary>
      <div className="wscenario-geometry-legend">
        <span className="wscenario-geometry-current">
          ● {current.name} <small>(current)</small>
        </span>
        <span className="wscenario-geometry-other">◇ {other.name}</span>
      </div>
      {(["profile", "end"] as const).map((plane) => (
        <Projection
          key={plane}
          plane={plane}
          points={points}
          names={[current.name, other.name]}
          hull={
            plane === "profile" && outlines
              ? [
                  ...outlines.profile.upper,
                  ...[...outlines.profile.lower].reverse(),
                ]
              : []
          }
        />
      ))}
      {worlds.map(
        (world, index) =>
          !points[index].length && (
            <p className="whint" key={index}>
              {world.name}:{" "}
              {world.pending
                ? "updating geometry…"
                : summary
                  ? "LCG and VCG are needed to draw the centre of gravity."
                  : "no complete, valid points in this selection."}
            </p>
          ),
      )}
      {summary && (
        <p className="whint">
          Reported LCG / VCG, shown on the centreline (y = 0).
        </p>
      )}
      <p className="whint">
        Read-only, nominal positions in metres. Incomplete or invalid points are
        omitted.
      </p>
    </details>
  );
}

function Projection({
  plane,
  points,
  names,
  hull,
}: {
  readonly plane: "profile" | "end";
  readonly points: readonly (readonly ComparisonPoint[])[];
  readonly names: readonly string[];
  readonly hull: readonly Vec2[];
}) {
  const axis = plane === "profile" ? 0 : 1;
  const horizontal = plane === "profile" ? "x" : "y";
  const coordinates: Vec2[] = [
    ...hull,
    [0, 0],
    ...points.flatMap((group) =>
      group.map((point) => [point.position[axis], point.position[2]] as Vec2),
    ),
  ];
  let x0 = 0,
    x1 = 0,
    z0 = 0,
    z1 = 0;
  for (const [x, z] of coordinates) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  const scale = Math.min(
    296 / Math.max(x1 - x0, 0.1),
    126 / Math.max(z1 - z0, 0.1),
  );
  const project = ([x, z]: Vec2): Vec2 => [
    180 + (x - (x0 + x1) / 2) * scale,
    88 - (z - (z0 + z1) / 2) * scale,
  ];
  const path = (values: readonly Vec2[]) =>
    values.map((p) => project(p).join(",")).join(" ");
  const title =
    plane === "profile" ? "Profile (x / z)" : "End projection (y / z)";
  return (
    <figure>
      <figcaption>{title}</figcaption>
      <svg
        viewBox="0 0 360 180"
        role="img"
        aria-label={`${title}: ${names[0]} circles, ${names[1]} diamonds`}
      >
        {/* The end view often has only centreline points (y = 0). Keep
            its horizontal axis visible even when the data has no width. */}
        <line
          className={
            plane === "end"
              ? "wscenario-geometry-axis"
              : "wscenario-geometry-datum"
          }
          x1={plane === "end" ? 32 : project([x0, 0])[0]}
          y1={project([x0, 0])[1]}
          x2={plane === "end" ? 328 : project([x1, 0])[0]}
          y2={project([x1, 0])[1]}
        />
        {plane === "end" && (
          <text x="328" y={project([0, 0])[1] - 6} textAnchor="end">
            y →
          </text>
        )}
        <line
          className="wscenario-geometry-datum"
          x1={project([0, z0])[0]}
          y1={project([0, z0])[1]}
          x2={project([0, z1])[0]}
          y2={project([0, z1])[1]}
        />
        {hull.length > 0 && (
          <polygon className="wscenario-geometry-hull" points={path(hull)} />
        )}
        {points.map((group, index) =>
          group.map((point) => {
            const [x, y] = project([point.position[axis], point.position[2]]);
            const label = `${names[index]} · ${point.label}: x ${sig(point.position[0])}, y ${sig(point.position[1])}, z ${sig(point.position[2])} m`;
            return (
              <g
                key={`${index}:${point.key}`}
                className={
                  index === 0
                    ? "wscenario-geometry-current"
                    : "wscenario-geometry-other"
                }
                tabIndex={0}
                aria-label={label}
              >
                <title>{label}</title>
                {index === 0 ? (
                  <circle cx={x} cy={y} r={4} fill="currentColor" />
                ) : (
                  <path
                    d={`M ${x} ${y - 7} l 7 7 l -7 7 l -7 -7 Z`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  />
                )}
              </g>
            );
          }),
        )}
        <text x="12" y="16">
          z ↑
        </text>
        <text x="12" y="172">
          {horizontal}: {sig(x0)} … {sig(x1)} m
        </text>
        <text x="348" y="172" textAnchor="end">
          z: {sig(z0)} … {sig(z1)} m
        </text>
      </svg>
    </figure>
  );
}
