// Point-placement previews consume generic physical queries on STL. Compatibility
// Camber drawings retain their authored frame/station traces, without a fake Model.
import type { Vec2 } from "../core/math";
import {
  available,
  type HullAnalysis,
  type OutlineQuery,
  type QueryOptions,
  type QueryResult,
} from "./api";
import type { PointViewOutlines, SectionOutline } from "./geometry";
import { hullPoint } from "./sections";
import {
  fromWeight,
  toWeight,
  weightMapping,
  weightPlane,
} from "./weightGeometry";

export async function pointViewOutlines(
  hull: HullAnalysis,
  options?: QueryOptions,
): Promise<QueryResult<PointViewOutlines>> {
  if (hull.context.weightFrame === "camber-deck-x-world-z")
    return hull.outlines(options);
  const mapping = await weightMapping(hull, options);
  if (mapping.status === "unavailable")
    return { contextId: hull.context.id, result: mapping };
  // Upright Cartesian STL mapping is a rigid rotation plus datum translation.
  const m = mapping.value;
  const result = await hull.project(
    {
      view: {
        origin: fromWeight(m, [0, 0, 0]),
        u: [...m.rows[0]],
        v: [...m.rows[2]],
      },
    },
    options,
  );
  if (result.result.status === "unavailable")
    return { contextId: hull.context.id, result: result.result };
  const p = result.result.value,
    b = p.bounds;
  return {
    contextId: hull.context.id,
    result: available({
      frame: {
        xSpan: b ? [b.min[0], b.max[0]] : [0, 1],
        zSpan: b ? [b.min[1], b.max[1]] : [0, 1],
        ySpan: b ? [-b.max[2], -b.min[2]] : [-1, 1],
      },
      profile: { upper: [], lower: [], coverage: p.coverage },
    }),
  };
}
export async function pointSectionOutline(
  hull: HullAnalysis,
  query: OutlineQuery,
  options?: QueryOptions,
): Promise<QueryResult<SectionOutline | null>> {
  if (
    hull.context.weightFrame === "camber-deck-x-world-z" ||
    query.kind === "station"
  )
    return hull.sectionOutline(query, options);
  const mapping = await weightMapping(hull, options);
  if (mapping.status === "unavailable")
    return { contextId: hull.context.id, result: mapping };
  const section = await hull.section(
    { plane: weightPlane(mapping.value, "x", query.x), envelope: "buoyancy" },
    options,
  );
  if (section.result.status === "unavailable")
    return { contextId: hull.context.id, result: section.result };
  const s = section.result.value;
  const yz = (p: Vec2): Vec2 => {
    const q = toWeight(mapping.value, hullPoint(s.plane, p));
    return [q[1], q[2]];
  };
  return {
    contextId: hull.context.id,
    result: available(
      s.regions.length || s.openPaths.length
        ? {
            kind: "vertical",
            x: query.x,
            clamped: false,
            starboard: [],
            port: [],
            trace: [],
            loops: s.regions
              .flatMap((r) => [r.outer, ...r.holes])
              .map((l) => l.points.map(yz)),
            openPaths: s.openPaths.map((p) => p.points.map(yz)),
          }
        : null,
    ),
  };
}
