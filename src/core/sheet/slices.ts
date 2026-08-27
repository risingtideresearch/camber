// Geometry behind a slices page. Measurements are reported in the weight book's frame (metres, x from the
// transom and z above the keel), while render points remain in model coordinates so they can be laid directly
// over the hull in the existing 3D scene.

import { unitScale } from "../json";
import type { Vec3 } from "../math";
import type { HullSampling } from "../mesh";
import { sweptSection } from "../mesh";
import type { Model } from "../model";
import { cut, heightSpan, stationGeometry, type StationGeom } from "../sweep";
import type { SliceShape } from "./book";

export const SLICE_VALUE_FIELDS = [
  "area",
  "closedPerimeter",
  "openPerimeter",
  "x",
  "y",
  "z",
] as const;
export type SliceValueField = (typeof SLICE_VALUE_FIELDS)[number];

export interface SliceMeasurement {
  readonly area: number;
  /** The complete boundary of the cut, including the straight segments that close it. */
  readonly closedPerimeter: number;
  /** The intersection with the hull skin, without deck or other closing segments. */
  readonly openPerimeter: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Local derivative of each reported value with respect to `pos`, used for first-order uncertainty. */
  readonly derivative: Readonly<Record<SliceValueField, number>>;
  readonly curve: readonly Vec3[];
  readonly centroid: Vec3;
}

export type SliceMeasurements = ReadonlyMap<string, SliceMeasurement>;
export const sliceMeasurementKey = (sheetId: string, rowId: string): string =>
  `${sheetId} ${rowId}`;

const distance = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const openLength = (points: readonly Vec3[]): number => {
  let out = 0;
  for (let i = 1; i < points.length; i++)
    out += distance(points[i - 1], points[i]);
  return out;
};

const closedLength = (points: readonly Vec3[]): number =>
  openLength(points) +
  (points.length > 1 ? distance(points[points.length - 1], points[0]) : 0);

/** Area and centroid of a polygon in local (a,z) coordinates. */
function polygon2(points: readonly [number, number][]): {
  area: number;
  a: number;
  z: number;
} | null {
  let twice = 0,
    ca = 0,
    cz = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      q = points[(i + 1) % points.length],
      cross = p[0] * q[1] - q[0] * p[1];
    twice += cross;
    ca += (p[0] + q[0]) * cross;
    cz += (p[1] + q[1]) * cross;
  }
  if (Math.abs(twice) < 1e-12) return null;
  return {
    area: Math.abs(twice) / 2,
    a: ca / (3 * twice),
    z: cz / (3 * twice),
  };
}

type RawSliceMeasurement = Omit<SliceMeasurement, "derivative">;

function measureSliceAt(
  model: Model,
  sampling: HullSampling,
  geom: StationGeom,
  shape: SliceShape,
  positionMetres: number,
): RawSliceMeasurement | null {
  if (!isFinite(positionMetres)) return null;
  const s = unitScale(model.unit, "m");

  if (shape === "plane") {
    const worldZ = geom.keelZ + positionMetres / s;
    const result = cut(geom, 0, worldZ, true);
    // Once the horizontal cut crosses a submerged deck edge, `wp` no longer describes the section of the
    // closed solid. Refuse that misleading geometry rather than drawing an authoritative-looking wrong cut.
    if (!result.wp || result.deckDown || result.waterline.length < 3)
      return null;
    const cr = geom.cosRake,
      sr = geom.sinRake,
      modelX = result.wp.cx * cr + worldZ * sr,
      modelZ = (worldZ - modelX * sr) / cr;
    const centroid: Vec3 = [modelX, result.wp.cy, modelZ];
    return {
      area: result.wp.area * s * s,
      closedPerimeter: closedLength(result.waterline) * s,
      openPerimeter:
        (openLength(result.waterlineSkin[0]) +
          openLength(result.waterlineSkin[1])) *
        s,
      x: (modelX - model.plan.at(0)[0]) * s,
      y: result.wp.cy * s,
      z: positionMetres,
      curve: result.waterline,
      centroid,
    };
  }

  // A station is authored by x, but the sweep is parameterised by u. It is normal to the plan heading at
  // that u, exactly like every sampled station used by the hull integration.
  const x0 = model.plan.at(0)[0],
    x1 = model.plan.at(1)[0],
    modelX = x0 + positionMetres / s;
  if (modelX < x0 || modelX > x1) return null;
  const u = model.plan.uAtX(modelX);
  const section = sweptSection(model, u, sampling.R, true);
  if (section.empty || section.pts.length < 2) return null;
  const [px, py] = model.plan.at(u),
    [dx, dy] = model.plan.d(u),
    speed = Math.hypot(dx, dy) || 1,
    nx = dy / speed,
    ny = -dx / speed,
    aOf = (p: Vec3): number => (p[0] - px) * nx + (p[1] - py) * ny,
    aC = Math.abs(ny) > 1e-12 ? -py / ny : 0;

  // One half's closed area follows the skin, closes horizontally across the deck to the centreline, then
  // follows the centreline down to the lower skin end. The physical full section is two mirrored halves; on
  // a curved plan those halves are not literally coplanar, which is why the integral is doubled here rather
  // than shoelaced across a fictitious common plane.
  const local: [number, number][] = section.pts.map((p) => [aOf(p), p[2]]);
  local.push([aC, section.pts[section.pts.length - 1][2]]);
  local.push([aC, section.pts[0][2]]);
  const half = polygon2(local);
  if (!half) return null;

  const starboard = section.pts;
  const port = section.pts
    .slice()
    .reverse()
    .map((p): Vec3 => [p[0], -p[1], p[2]]);
  const curve = [...starboard, ...port];
  const cx = px + half.a * nx,
    centroid: Vec3 = [cx, 0, half.z],
    worldCentroidZ = cx * geom.sinRake + half.z * geom.cosRake;

  return {
    area: 2 * half.area * s * s,
    closedPerimeter: closedLength(curve) * s,
    // Only the two hull-skin runs belong to the open perimeter. `curve` also joins their lower ends so the
    // overlay and area have a closed boundary; that join may be a transom cut rather than a zero-length keel.
    openPerimeter: 2 * openLength(section.pts) * s,
    x: (cx - x0) * s,
    // Every authored hull is port/starboard symmetric; retaining y in the public point-shaped result keeps
    // the centroid frame explicit and leaves room for asymmetric geometry without changing formulas.
    y: 0,
    z: (worldCentroidZ - geom.keelZ) * s,
    curve,
    centroid,
  };
}

/** Build the position-dependent measurer once for a model/sampling pair. */
export function createSliceMeasurer(
  model: Model,
  sampling: HullSampling,
): (shape: SliceShape, positionMetres: number) => SliceMeasurement | null {
  const geom = stationGeometry(model, sampling);
  if (!geom) return () => null;
  const s = unitScale(model.unit, "m");
  const longitudinalSpan = (model.plan.at(1)[0] - model.plan.at(0)[0]) * s;
  const [zLo, zHi] = heightSpan(geom, 0);
  const verticalSpan = (zHi - zLo) * s;

  return (shape, positionMetres) => {
    const value = measureSliceAt(model, sampling, geom, shape, positionMetres);
    if (!value) return null;
    // The finite-difference scale follows the axis the cut moves on: hull length for stations, hull height
    // for horizontal planes. They often happen to be similar enough numerically, but are unrelated geometry.
    const span = shape === "station" ? longitudinalSpan : verticalSpan;
    const h = Math.max(1e-5, span * 1e-4);
    const below = measureSliceAt(
      model,
      sampling,
      geom,
      shape,
      positionMetres - h,
    );
    const above = measureSliceAt(
      model,
      sampling,
      geom,
      shape,
      positionMetres + h,
    );
    const derivative = Object.fromEntries(
      SLICE_VALUE_FIELDS.map((field) => {
        if (below && above)
          return [field, (above[field] - below[field]) / (2 * h)];
        if (above) return [field, (above[field] - value[field]) / h];
        if (below) return [field, (value[field] - below[field]) / h];
        return [field, 0];
      }),
    ) as Record<SliceValueField, number>;
    return { ...value, derivative };
  };
}

/** Convenience for callers measuring one cut. Bulk callers should reuse `createSliceMeasurer`. */
export function measureSlice(
  model: Model,
  sampling: HullSampling,
  shape: SliceShape,
  positionMetres: number,
): SliceMeasurement | null {
  return createSliceMeasurer(model, sampling)(shape, positionMetres);
}
