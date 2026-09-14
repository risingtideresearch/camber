// Physical cut construction and finite-difference uncertainty belong to the weight
// feature, not the triangle backend. All physical queries remain section(plane).
import { V, type Vec3 } from "../core/math";
import {
  available,
  unavailable,
  type AnalysisContext,
  type Available,
  type HullAnalysis,
  type QueryOptions,
  type SliceQuery,
} from "./api";
import { SLICE_VALUE_FIELDS, type SliceMeasurement } from "./geometry";
import {
  hullPoint,
  planeNormal,
  type PlaneFrame,
  type SectionResult,
} from "./sections";

const add = (a: Vec3, b: Vec3): Vec3 => a.map((x, i) => x + b[i]) as Vec3;
export type WeightMapping = NonNullable<AnalysisContext["hullToWeight"]>;
export const toWeight = (m: WeightMapping, p: Vec3): Vec3 =>
  m.rows.map((r, i) => V.dot(r, p) + m.offset[i]) as Vec3;
const inverse = (m: WeightMapping, p: Vec3, point: boolean): Vec3 => {
  const [a, b, c] = m.rows,
    det = V.dot(a, V.cross(b, c));
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10)
    throw new Error("Singular hull-to-weight frame");
  const q = point ? V.sub(p, m.offset) : p;
  return V.scale(
    add(
      add(V.scale(V.cross(b, c), q[0]), V.scale(V.cross(c, a), q[1])),
      V.scale(V.cross(a, b), q[2]),
    ),
    1 / det,
  );
};
export const fromWeight = (m: WeightMapping, p: Vec3) => inverse(m, p, true);

export async function weightMapping(
  hull: HullAnalysis,
  options?: QueryOptions,
): Promise<Available<WeightMapping>> {
  if (hull.context.hullToWeight) return available(hull.context.hullToWeight);
  const result = (await hull.outlines(options)).result;
  if (result.status === "unavailable") return result;
  const f = result.value.frame;
  // Body-plane queries are SI even though legacy outline mappings use model units.
  return available({
    rows: [
      [1, 0, 0],
      [0, 1, 0],
      [f.sinRake, 0, f.cosRake],
    ],
    offset: [-f.x0 * f.s, 0, -f.keelZ * f.s],
  });
}
export type PlaneMotion =
  | { kind: "translation"; reference: PlaneFrame; direction: Vec3 } // metres along a UNIT direction
  | { kind: "rotation"; reference: PlaneFrame; pivot: Vec3; axis: Vec3 }; // radians about a UNIT axis
const unit = (v: Vec3) => {
  if (
    v.length !== 3 ||
    !v.every(Number.isFinite) ||
    Math.abs(V.dot(v, v) - 1) > 1e-10
  )
    throw new Error("Motion needs a finite unit direction/axis");
};
export function planeAt(motion: PlaneMotion, parameter: number): PlaneFrame {
  planeNormal(motion.reference);
  if (!Number.isFinite(parameter))
    throw new Error("Finite motion parameter required");
  if (motion.kind === "translation") {
    unit(motion.direction);
    return {
      ...motion.reference,
      origin: add(
        motion.reference.origin,
        V.scale(motion.direction, parameter),
      ),
    };
  }
  unit(motion.axis);
  if (!motion.pivot.every(Number.isFinite))
    throw new Error("Finite pivot required");
  const c = Math.cos(parameter),
    s = Math.sin(parameter),
    n = motion.axis;
  const rotate = (p: Vec3) =>
    add(
      add(V.scale(p, c), V.scale(V.cross(n, p), s)),
      V.scale(n, V.dot(n, p) * (1 - c)),
    );
  return {
    origin: add(
      motion.pivot,
      rotate(V.sub(motion.reference.origin, motion.pivot)),
    ),
    u: rotate(motion.reference.u),
    v: rotate(motion.reference.v),
  };
}
/** Body-frame line and explicit up direction (hull-up or fixed-trim gravity-up).
 * Neither vertical convention is inferred from a view or an affine normal. */
export function verticalPlaneThroughLine(
  a: Vec3,
  b: Vec3,
  up: Vec3,
): PlaneFrame {
  unit(up);
  const d = V.sub(b, a),
    len = Math.hypot(...d);
  if (len < 1e-10)
    throw new Error("A vertical plane needs two distinct line points");
  const u = V.scale(d, 1 / len),
    perpendicular = V.sub(up, V.scale(u, V.dot(up, u))),
    h = Math.hypot(...perpendicular);
  if (h < 1e-10)
    throw new Error(
      "A line parallel to up does not define a unique vertical plane",
    );
  const plane = { origin: a, u, v: V.scale(perpendicular, 1 / h) };
  planeNormal(plane);
  return plane;
}
/** A sheet x or z level, resolved in physical body coordinates. The mapping can
 * be Camber's non-orthogonal hybrid; normals are NEVER mapped as points. */
export function weightPlane(
  mapping: WeightMapping,
  axis: "x" | "z",
  position: number,
): PlaneFrame {
  const p: Vec3 = axis === "x" ? [position, 0, 0] : [0, 0, position];
  const n = V.norm(mapping.rows[axis === "x" ? 0 : 2]);
  const u = V.norm(
    inverse(mapping, axis === "x" ? [0, 1, 0] : [1, 0, 0], false),
  );
  const plane = { origin: fromWeight(mapping, p), u, v: V.cross(n, u) };
  planeNormal(plane);
  return plane;
}
const topology = (s: SectionResult) =>
  JSON.stringify([
    s.regions.map((r) => r.holes.length).sort(),
    s.openPaths.length,
    Object.keys(s.measurements.perimeterBySurface).sort(),
    s.measurements.syntheticPerimeter > s.accuracy.tolerance,
  ]);
function nominal(
  s: SectionResult,
  mapping: WeightMapping,
  skin: readonly string[] | undefined,
): Available<SliceMeasurement> {
  const m = s.measurements;
  if (m.area.status !== "available") return m.area;
  if (m.closedPerimeter.status !== "available") return m.closedPerimeter;
  if (m.centroid.status !== "available") return m.centroid;
  const centroid = toWeight(mapping, hullPoint(s.plane, m.centroid.value));
  const loops = s.regions
    .flatMap((r) => [r.outer, ...r.holes])
    .map((l) => l.points.map((p) => toWeight(mapping, hullPoint(s.plane, p))));
  return available({
    area: m.area.value,
    closedPerimeter: m.closedPerimeter.value,
    openPerimeter: skin
      ? skin.reduce((n, name) => n + (m.perimeterBySurface[name] ?? 0), 0)
      : NaN,
    x: centroid[0],
    y: centroid[1],
    z: centroid[2],
    centroid,
    // The legacy single curve cannot represent holes/disconnected regions.
    curve: loops.length === 1 ? loops[0] : [],
    loops,
    derivative: {
      area: NaN,
      closedPerimeter: NaN,
      openPerimeter: NaN,
      x: NaN,
      y: NaN,
      z: NaN,
    },
    unavailable: skin
      ? undefined
      : {
          openPerimeter:
            "Confirm a physical shell scope to measure skin-only perimeter",
        },
    diagnostics: s.diagnostics,
  });
}
/** Central difference along the declared motion, with one-sided consistency and
 * topology checks. Nominal values survive a non-differentiable neighbourhood;
 * only uncertainty-dependent formulas become unavailable. Numerical error is
 * not inserted into the book's authored uncertainty. */
export async function measurePlaneFamily(
  hull: HullAnalysis,
  at: (t: number) => PlaneFrame,
  parameter: number,
  mapping: WeightMapping,
  skin: readonly string[] | undefined,
  step = 1e-4,
  options?: QueryOptions,
): Promise<Available<SliceMeasurement>> {
  if (!Number.isFinite(parameter) || !Number.isFinite(step) || step <= 0)
    return unavailable("Finite position and positive derivative step required");
  const sections = await Promise.all(
    [parameter, parameter - step, parameter + step].map((t) =>
      hull
        .section({ plane: at(t), envelope: "buoyancy" }, options)
        .then((r) => r.result),
    ),
  );
  const [center, below, above] = sections;
  if (center.status === "unavailable") return center;
  const value = nominal(center.value, mapping, skin);
  if (value.status === "unavailable") return value;
  const lo =
    below.status === "available" ? nominal(below.value, mapping, skin) : below;
  const hi =
    above.status === "available" ? nominal(above.value, mapping, skin) : above;
  let problem: string | undefined;
  if (
    below.status !== "available" ||
    above.status !== "available" ||
    lo.status !== "available" ||
    hi.status !== "available"
  )
    problem =
      "Cut derivative unavailable: a neighbouring section is empty or unsupported";
  else if (
    topology(center.value) !== topology(below.value) ||
    topology(center.value) !== topology(above.value)
  )
    problem =
      "Cut derivative unavailable at a boundary topology/surface transition";
  else if (center.value.diagnostics.some((d) => d.startsWith("On-edge")))
    problem = "Cut derivative unavailable at an on-edge boundary limit";
  const derivative = { ...value.value.derivative };
  if (!problem && lo.status === "available" && hi.status === "available")
    for (const name of SLICE_VALUE_FIELDS) {
      if (value.value.unavailable?.[name]) continue;
      const left = (value.value[name] - lo.value[name]) / step,
        right = (hi.value[name] - value.value[name]) / step;
      if (
        !Number.isFinite(left + right) ||
        Math.abs(left - right) >
          1e-3 * Math.max(1, Math.abs(left), Math.abs(right))
      ) {
        problem =
          "Cut derivative is ill-conditioned: one-sided slopes disagree";
        break;
      }
      derivative[name] = (left + right) / 2;
    }
  return available({
    ...value.value,
    derivative,
    derivativeUnavailable: problem,
    diagnostics: [
      ...center.value.diagnostics,
      ...(problem ? [problem] : []),
      `Central differences along authored motion, step ${step}; no verified error bound`,
    ],
  });
}

export async function measureWeightCuts(
  hull: HullAnalysis,
  queries: readonly SliceQuery[],
  options?: QueryOptions,
) {
  const answers: Available<SliceMeasurement>[] = new Array(queries.length);
  const legacy: { query: SliceQuery; index: number }[] = [];
  const physical: { query: SliceQuery; index: number }[] = [];
  queries.forEach((query, index) => {
    if (
      query.shape === "station" ||
      (query.shape === "plane" &&
        hull.context.weightFrame === "camber-deck-x-world-z")
    )
      legacy.push({ query, index });
    else physical.push({ query, index });
  });
  if (legacy.length) {
    const result = hull.capabilities.authoredStations
      ? (
          await hull.slices(
            legacy.map((q) => q.query),
            options,
          )
        ).result
      : unavailable(
          "STL has no authored Camber stations; explicitly choose a transverse cut instead",
        );
    legacy.forEach(
      (q, i) =>
        (answers[q.index] =
          result.status === "available" ? result.value[i] : result),
    );
  }
  if (physical.length) {
    // Scope validation is local: an absent surface must not become a zero skin
    // perimeter. Fixed measurements are cached independently of moving cuts.
    const metrics =
      hull.context.weightFrame === "upright-cartesian" &&
      hull.context.shellScope
        ? (await hull.measurements(options)).result
        : null;
    const scopeValid =
      !metrics ||
      (metrics.status === "available" &&
        Number.isFinite(metrics.value.shellArea));
    const mapping = await weightMapping(hull, options);
    const skin =
      hull.context.weightFrame === "camber-deck-x-world-z"
        ? ["skin"]
        : scopeValid
          ? hull.context.shellScope?.surfaces
          : undefined;
    await Promise.all(
      physical.map(async ({ query, index }) => {
        answers[index] =
          mapping.status === "unavailable"
            ? mapping
            : await measurePlaneFamily(
                hull,
                (t) =>
                  weightPlane(
                    mapping.value,
                    query.shape === "plane" ? "z" : "x",
                    t,
                  ),
                query.position,
                mapping.value,
                skin,
                1e-4,
                options,
              );
      }),
    );
  }
  return { contextId: hull.context.id, result: available(answers) };
}
