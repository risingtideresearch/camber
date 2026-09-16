import {
  BOUNDARIES,
  validateLimits,
  type BoundaryLeaf,
  type SectionLimits,
} from "./boundaries";
// Geometry behind a slices page. Measurements are reported in the weight book's frame (metres, x from the
// transom and z above the keel), while render points remain in model coordinates so they can be laid directly
// over the hull in the existing 3D scene.

import { unitScale } from "../json";
import type { Vec3 } from "../math";
import type { HullSampling } from "../mesh";
import { sweptSection } from "../mesh";
import type { Model } from "../model";
import { heightSpan, stationGeometry, type StationGeom } from "../sweep";
import type { SliceShape } from "./book";
import {
  closedHullTriangles,
  clipPlaneCut,
  type PlaneCut,
  intersectPlane,
  sectionFromSegments,
  type CutTriangle,
  type CutSegment,
} from "./planeCuts";
import {
  GEOMETRY_LEAVES,
  geometryValue,
  lineMeasure,
  measureAt,
  sumMeasure,
  type SectionMeasures,
} from "./sectionMeasures";

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
  readonly measures: SectionMeasures;
  readonly geometryDerivative: Readonly<Record<string, number>>;
  readonly boundaryDerivatives?: Readonly<
    Partial<Record<BoundaryLeaf, Readonly<Record<string, number>>>>
  >;
  readonly contours: readonly (readonly Vec3[])[];
  readonly sheetContours: readonly (readonly Vec3[])[];
  /** Explicit skin-only segments: never infer these by closing an outline. */
  readonly sheetSkinSegments: readonly (readonly [Vec3, Vec3])[];
  readonly warning?: string;
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

export type RawSliceMeasurement = Omit<
  SliceMeasurement,
  "derivative" | "geometryDerivative" | "boundaryDerivatives"
>;

/** Bounded per-hull cache: boundary sensitivities and edits revisit the same
 * planes. The expensive triangle intersection is independent of all limits. */
function cachedIntersections(triangles: readonly CutTriangle[]) {
  const cache = new Map<string, PlaneCut>();
  return (
    normal: Vec3,
    offset: number,
    toSheet: (p: Vec3) => Vec3,
    scale: number,
  ) => {
    const key = `${normal.join(",")}:${offset}`;
    let cut = cache.get(key);
    if (!cut) {
      cut = intersectPlane(triangles, normal, offset, toSheet, scale);
      if (cache.size >= 512) cache.delete(cache.keys().next().value!);
      cache.set(key, cut);
    }
    return cut;
  };
}

export interface SliceSensitivities {
  /** Defaults to true; exact authored positions need no finite differences. */
  readonly position?: boolean;
  /** Omitted means all limits; an empty list means no uncertain boundaries. */
  readonly boundaries?: readonly BoundaryLeaf[];
}

function measureSliceAt(
  model: Model,
  sampling: HullSampling,
  geom: StationGeom,
  shape: SliceShape,
  positionMetres: number,
  intersect: ReturnType<typeof cachedIntersections>,
  limits: SectionLimits = {},
): RawSliceMeasurement | null {
  if (!isFinite(positionMetres)) return null;
  validateLimits(limits);
  const s = unitScale(model.unit, "m");

  const toSheet = (p: Vec3): Vec3 => [
    (p[0] - model.plan.at(0)[0]) * s,
    p[1] * s,
    (p[0] * geom.sinRake + p[2] * geom.cosRake - geom.keelZ) * s,
  ];
  const toBoundary = (p: Vec3): Vec3 => [
    (p[0] - (p[2] * geom.sinRake) / geom.cosRake - model.plan.at(0)[0]) * s,
    p[1] * s,
    toSheet(p)[2],
  ];
  if (shape !== "station") {
    // Transverse planes are world-vertical. pos locates their intersection with
    // the deck-flat z=0 axis, measured from the book's x origin.
    const normal: Vec3 =
      shape === "plane"
        ? [geom.sinRake, 0, geom.cosRake]
        : shape === "transverse"
          ? [geom.cosRake, 0, -geom.sinRake]
          : [0, 1, 0];
    const offset =
      shape === "plane"
        ? geom.keelZ + positionMetres / s
        : shape === "transverse"
          ? (model.plan.at(0)[0] + positionMetres / s) * geom.cosRake
          : positionMetres / s;
    const result = clipPlaneCut(
      intersect(normal, offset, toSheet, s),
      normal,
      offset,
      toSheet,
      s,
      limits,
      toBoundary,
    );
    const m = result.measures;
    const cg = m.area.amount
      ? (m.area.moment.map((v) => v / m.area.amount) as Vec3)
      : ([0, 0, 0] as Vec3);
    const mx = cg[0] / s + model.plan.at(0)[0];
    const centroid: Vec3 = [
      mx,
      cg[1] / s,
      (cg[2] / s + geom.keelZ - mx * geom.sinRake) / geom.cosRake,
    ];
    return {
      measures: m,
      contours: result.contours,
      sheetContours: result.contours.map((c) => c.map(toSheet)),
      sheetSkinSegments: result.skinSegments.map(([a, b]) => [
        toSheet(a),
        toSheet(b),
      ]),
      area: m.area.amount,
      openPerimeter: m.openLength.amount,
      closedPerimeter: m.closedLength.amount,
      x: cg[0],
      y: cg[1],
      z: cg[2],
      centroid,
      curve: result.contours[0] ?? [],
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

  const segments = (points: readonly Vec3[]): [Vec3, Vec3][] =>
    points.slice(1).map((p, i) => [points[i], p]);
  const halfCurve: Vec3[] = [
    ...starboard,
    [px + aC * nx, 0, starboard[starboard.length - 1][2]],
    [px + aC * nx, 0, starboard[0][2]],
  ];
  const changesSection = BOUNDARIES.some((b) => {
    const value = limits[b.leaf];
    return (
      value !== undefined &&
      [...halfCurve, ...halfCurve.map((p): Vec3 => [p[0], -p[1], p[2]])].some(
        (p) => (toBoundary(p)[b.axis] - value) * b.sign > 1e-10,
      )
    );
  });
  if (changesSection) {
    const halves = [false, true].map((reflect) => {
      const points = halfCurve.map((p): Vec3 =>
        reflect ? [p[0], -p[1], p[2]] : p,
      );
      const normal: Vec3 = [ny, reflect ? nx : -nx, 0];
      return sectionFromSegments(
        points.map((p, i) => ({
          points: [p, points[(i + 1) % points.length]] as [Vec3, Vec3],
          skin: i < starboard.length - 1,
        })),
        normal,
        ny * px - nx * py,
        toSheet,
        s,
        limits,
        toBoundary,
      );
    });
    // The halves are separate planes. Sum their areas, then remove their shared
    // centreline seam before measuring the physical boundary of their union.
    const joined = new Map<string, CutSegment>();
    for (const segment of halves.flatMap((h) => h.segments)) {
      const onSeam = segment.points.every((p) => Math.abs(p[1] * s) < 1e-8);
      const key = segment.points
        .map((p) => p.map((v) => Math.round((v * s) / 1e-8)).join(","))
        .sort()
        .join(";");
      if (onSeam && joined.has(key)) joined.delete(key);
      else joined.set(key, segment);
    }
    // Area from this joined outline is deliberately unused: it need not be planar.
    const fullCut = sectionFromSegments(
      [...joined.values()],
      [1, 0, 0],
      modelX,
      toSheet,
      s,
    );
    const area = sumMeasure(halves[0].measures.area, halves[1].measures.area);
    const measures = { ...fullCut.measures, area };
    const cg = area.amount
      ? (area.moment.map((v) => v / area.amount) as Vec3)
      : ([0, 0, 0] as Vec3);
    const mx = cg[0] / s + x0;
    const centroid: Vec3 = [
      mx,
      cg[1] / s,
      (cg[2] / s + geom.keelZ - mx * geom.sinRake) / geom.cosRake,
    ];
    return {
      measures,
      contours: fullCut.contours,
      sheetContours: fullCut.contours.map((c) => c.map(toSheet)),
      sheetSkinSegments: fullCut.skinSegments.map(([a, b]) => [
        toSheet(a),
        toSheet(b),
      ]),
      area: area.amount,
      openPerimeter: measures.openLength.amount,
      closedPerimeter: measures.closedLength.amount,
      x: cg[0],
      y: cg[1],
      z: cg[2],
      centroid,
      curve: fullCut.contours[0] ?? [],
    };
  }
  const measures: SectionMeasures = {
    area: measureAt(2 * half.area * s * s, toSheet(centroid)),
    openLength: lineMeasure(
      [...segments(starboard), ...segments(port)],
      toSheet,
      s,
    ),
    closedLength: lineMeasure(
      [...segments(curve), [curve[curve.length - 1], curve[0]]],
      toSheet,
      s,
    ),
  };
  return {
    measures,
    contours: [curve],
    sheetContours: [curve.map(toSheet)],
    sheetSkinSegments: [...segments(starboard), ...segments(port)].map(
      ([a, b]) => [toSheet(a), toSheet(b)],
    ),
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
): (
  shape: SliceShape,
  positionMetres: number,
  limits?: SectionLimits,
  sensitivities?: SliceSensitivities,
) => SliceMeasurement | null {
  const geom = stationGeometry(model, sampling);
  if (!geom) return () => null;
  const triangles = closedHullTriangles(sampling);
  const intersect = cachedIntersections(triangles);
  const s = unitScale(model.unit, "m");
  const longitudinalSpan = (model.plan.at(1)[0] - model.plan.at(0)[0]) * s;
  const [zLo, zHi] = heightSpan(geom, 0);
  const verticalSpan = (zHi - zLo) * s;
  let lateralSpan = 0;
  for (const triangle of triangles)
    for (const p of triangle.points)
      lateralSpan = Math.max(lateralSpan, 2 * Math.abs(p[1]) * s);

  const safeAt = (
    shape: SliceShape,
    pos: number,
    limits: SectionLimits = {},
  ) => {
    try {
      return measureSliceAt(
        model,
        sampling,
        geom,
        shape,
        pos,
        intersect,
        limits,
      );
    } catch {
      return null;
    }
  };
  return (shape, positionMetres, limits = {}, sensitivities = {}) => {
    const value = safeAt(shape, positionMetres, limits);
    if (!value) return null;
    // The finite-difference scale follows the axis the cut moves on: hull length for stations, hull height
    // for horizontal planes. They often happen to be similar enough numerically, but are unrelated geometry.
    const span =
      shape === "station" || shape === "transverse"
        ? longitudinalSpan
        : shape === "longitudinal"
          ? lateralSpan
          : verticalSpan;
    const h = Math.max(1e-5, span * 1e-4);
    const below =
      sensitivities.position === false
        ? null
        : safeAt(shape, positionMetres - h, limits);
    const above =
      sensitivities.position === false
        ? null
        : safeAt(shape, positionMetres + h, limits);
    const derivative = Object.fromEntries(
      SLICE_VALUE_FIELDS.map((field) => {
        if (below && above)
          return [field, (above[field] - below[field]) / (2 * h)];
        if (above) return [field, (above[field] - value[field]) / h];
        if (below) return [field, (value[field] - below[field]) / h];
        return [field, 0];
      }),
    ) as Record<SliceValueField, number>;
    const geometryDerivative: Record<string, number> = {};
    for (const leaf of GEOMETRY_LEAVES) {
      try {
        const lo = below
          ? geometryValue(below.measures, leaf)
          : geometryValue(value.measures, leaf);
        const hi = above
          ? geometryValue(above.measures, leaf)
          : geometryValue(value.measures, leaf);
        geometryDerivative[leaf] = (hi - lo) / (below && above ? 2 * h : h);
      } catch {
        geometryDerivative[leaf] = NaN;
      }
    }
    const boundaryDerivatives: Partial<
      Record<BoundaryLeaf, Record<string, number>>
    > = {};
    for (const boundary of BOUNDARIES) {
      const value = limits[boundary.leaf];
      if (
        value === undefined ||
        (sensitivities.boundaries !== undefined &&
          !sensitivities.boundaries.includes(boundary.leaf))
      )
        continue;
      const dh = Math.max(
        1e-5,
        [longitudinalSpan, lateralSpan, verticalSpan][boundary.axis] * 1e-4,
      );
      const lo = safeAt(shape, positionMetres, {
        ...limits,
        [boundary.leaf]: value - dh,
      });
      const hi = safeAt(shape, positionMetres, {
        ...limits,
        [boundary.leaf]: value + dh,
      });
      boundaryDerivatives[boundary.leaf] = Object.fromEntries(
        GEOMETRY_LEAVES.map((leaf) => {
          try {
            return [
              leaf,
              lo && hi
                ? (geometryValue(hi.measures, leaf) -
                    geometryValue(lo.measures, leaf)) /
                  (2 * dh)
                : NaN,
            ];
          } catch {
            return [leaf, NaN];
          }
        }),
      );
    }
    return {
      ...value,
      boundaryDerivatives,
      derivative,
      geometryDerivative,
      warning:
        sensitivities.position !== false && (!below || !above)
          ? "Cut uncertainty uses a one-sided local slope at a geometry boundary"
          : undefined,
    };
  };
}

/** Convenience for callers measuring one cut. Bulk callers should reuse `createSliceMeasurer`. */
export function measureSlice(
  model: Model,
  sampling: HullSampling,
  shape: SliceShape,
  positionMetres: number,
  limits: SectionLimits = {},
): SliceMeasurement | null {
  return createSliceMeasurer(model, sampling)(shape, positionMetres, limits);
}

/** Raw measurements for integration: preserve geometry errors, distinguish empty sections. */
export function createSectionMeasurer(model: Model, sampling: HullSampling) {
  const geom = stationGeometry(model, sampling);
  const triangles = closedHullTriangles(sampling);
  const intersect = cachedIntersections(triangles);
  return (
    shape: SliceShape,
    position: number,
    limits: SectionLimits = {},
  ): RawSliceMeasurement => {
    if (!geom) throw new Error("Hull geometry is unavailable");
    const value = measureSliceAt(
      model,
      sampling,
      geom,
      shape,
      position,
      intersect,
      limits,
    );
    if (!value)
      throw new Error(
        "No valid sweep station at this position; use a planar orientation or move the bounds inside the hull",
      );
    return value;
  };
}
