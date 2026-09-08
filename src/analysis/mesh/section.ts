import { V, type Vec2, type Vec3 } from "../../core/math";
import { available, unavailable, type Available } from "../api";
import {
  containsPoint,
  planeNormal,
  planePoint,
  polygonMoments,
  type BoundarySource,
  type SectionLoop,
  type SectionPath,
  type SectionRequest,
  type SectionResult,
} from "../sections";
import type { PreparedMesh } from "./prepare";
import { visit } from "./spatial";

/** Intersect the actual triangles. On-edge cuts use the negative-halfspace boundary limit.
 * Coplanar faces and branched/touching contours are explicitly unavailable, never spliced. */
export function meshSection(
  mesh: PreparedMesh,
  request: SectionRequest,
): Available<SectionResult> {
  if (request.envelope !== "buoyancy") return unavailable("Unknown envelope");
  const { plane } = request,
    normal = planeNormal(plane),
    tolerance = request.tolerance ?? mesh.report.tolerance;
  if (
    !Number.isFinite(tolerance) ||
    tolerance < mesh.report.tolerance ||
    tolerance > mesh.report.tolerance * 100
  )
    throw new Error(
      "Section tolerance must be between the mesh tolerance and 100 times it",
    );
  type Node = { key: string; p: Vec3 };
  type Segment = { a: Node; b: Node; source: BoundarySource };
  const segments = new Map<string, Segment>();
  let coplanar = false,
    onEdge = false;
  const distances = new Map<number, number>();
  const distance = (id: number) => {
    let d = distances.get(id);
    if (d === undefined) {
      d = V.dot(V.sub(mesh.vertices[id], plane.origin), normal);
      if (Math.abs(d) <= tolerance) d = 0;
      distances.set(id, d);
    }
    return d;
  };
  visit(
    mesh.tree,
    (box) => {
      let lo = 0,
        hi = 0;
      for (let i = 0; i < 3; i++) {
        const a = (box.min[i] - plane.origin[i]) * normal[i],
          b = (box.max[i] - plane.origin[i]) * normal[i];
        lo += Math.min(a, b);
        hi += Math.max(a, b);
      }
      return lo <= tolerance && hi >= -tolerance;
    },
    (id) => {
      const face = mesh.faces[id],
        d = face.map(distance);
      if (d.every((v) => v === 0)) {
        coplanar = true;
        return;
      }
      if (d.every((v) => v >= 0) || d.every((v) => v < 0)) return;
      const points: Node[] = [];
      face.forEach((a, j) => {
        const b = face[(j + 1) % 3],
          da = d[j],
          db = d[(j + 1) % 3];
        if (da === 0) points.push({ key: `v${a}`, p: mesh.vertices[a] });
        if (da * db < 0) {
          const lo = Math.min(a, b),
            hi = Math.max(a, b),
            dl = distance(lo),
            dh = distance(hi);
          points.push({
            key: `e${lo}/${hi}`,
            p: V.lerp(mesh.vertices[lo], mesh.vertices[hi], dl / (dl - dh)),
          });
        }
      });
      if (
        points.length !== 2 ||
        Math.hypot(...V.sub(points[0].p, points[1].p)) <= tolerance
      )
        return;
      if (d.filter((v) => v === 0).length === 2) onEdge = true;
      const fn = V.cross(
        V.sub(mesh.vertices[face[1]], mesh.vertices[face[0]]),
        V.sub(mesh.vertices[face[2]], mesh.vertices[face[0]]),
      );
      let [a, b] = points;
      if (V.dot(V.sub(b.p, a.p), V.cross(normal, fn)) < 0) [a, b] = [b, a];
      const key = [a.key, b.key].sort().join(":");
      if (segments.has(key))
        segments.delete(key); // two submerged faces sharing a tangent edge cancel
      else segments.set(key, { a, b, source: mesh.sources[id] });
    },
  );
  if (coplanar)
    return unavailable(
      "Coplanar face: move or rotate the section beyond the reported tolerance",
    );
  const outgoing = new Map<string, Segment>(),
    incoming = new Map<string, Segment>();
  for (const s of segments.values()) {
    if (outgoing.has(s.a.key) || incoming.has(s.b.key))
      return unavailable(
        "Branched or touching section contours at this tolerance",
      );
    outgoing.set(s.a.key, s);
    incoming.set(s.b.key, s);
  }
  const loops: SectionLoop[] = [],
    openPaths: SectionPath[] = [];
  const consume = (start: Segment) => {
    const points: Vec2[] = [],
      edges: BoundarySource[] = [];
    let s: Segment | undefined = start;
    let closed = false;
    while (s) {
      points.push(planePoint(plane, s.a.p));
      edges.push(s.source);
      outgoing.delete(s.a.key);
      if (s.b.key === start.a.key) {
        closed = true;
        break;
      }
      const next = outgoing.get(s.b.key);
      if (!next) points.push(planePoint(plane, s.b.p));
      s = next;
    }
    if (closed) loops.push({ points, edges });
    else openPaths.push({ points, edges });
  };
  for (const s of segments.values())
    if (!incoming.has(s.a.key) && outgoing.has(s.a.key)) consume(s);
  while (outgoing.size) consume(outgoing.values().next().value!);
  const anchor: Vec2 = loops[0]?.points[0] ?? [0, 0];
  const shifted = (l: SectionLoop) =>
    l.points.map((p) => [p[0] - anchor[0], p[1] - anchor[1]] as Vec2);
  const entries = loops.map((loop) => ({
    loop,
    m: polygonMoments(shifted(loop)),
  }));
  if (entries.some((e) => Math.abs(e.m.area) <= tolerance ** 2))
    return unavailable("Degenerate section region at this tolerance");
  const regions = entries
    .filter((e) => e.m.area > 0)
    .map((e) => ({ outer: e.loop, holes: [] as SectionLoop[] }));
  for (const hole of entries.filter((e) => e.m.area < 0)) {
    const parent = regions
      .filter((r) => containsPoint(r.outer.points, hole.loop.points[0]))
      .sort(
        (a, b) =>
          polygonMoments(shifted(a.outer)).area -
          polygonMoments(shifted(b.outer)).area,
      )[0];
    if (!parent)
      return unavailable("Section hole has no enclosing outer boundary");
    parent.holes.push(hole.loop);
  }
  let area = 0,
    mx = 0,
    my = 0,
    xx = 0,
    yy = 0,
    xy = 0,
    perimeter = 0,
    syntheticPerimeter = 0;
  const perimeterBySurface: Record<string, number> = Object.create(null);
  for (const { m } of entries) {
    area += m.area;
    mx += m.x;
    my += m.y;
    xx += m.xx;
    yy += m.yy;
    xy += m.xy;
  }
  for (const path of [...loops, ...openPaths])
    path.edges.forEach((source, i) => {
      const a = path.points[i],
        b = path.points[(i + 1) % path.points.length],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      perimeter += length;
      if (source.kind === "physical")
        perimeterBySurface[source.surface] =
          (perimeterBySurface[source.surface] ?? 0) + length;
      else syntheticPerimeter += length;
    });
  const centroid: Vec2 = area > 0 ? [mx / area, my / area] : [0, 0],
    reason = "Open intersection: no invented closure or enclosed measurements";
  return available({
    plane,
    regions,
    openPaths,
    measurements: {
      area: openPaths.length ? unavailable(reason) : available(area),
      centroid: openPaths.length
        ? unavailable(reason)
        : area > 0
          ? available([centroid[0] + anchor[0], centroid[1] + anchor[1]])
          : unavailable("Empty section has no centroid"),
      closedPerimeter: openPaths.length
        ? unavailable(reason)
        : available(perimeter),
      perimeterBySurface,
      syntheticPerimeter,
      moments: openPaths.length
        ? unavailable(reason)
        : available({
            uu: yy - area * centroid[1] ** 2,
            vv: xx - area * centroid[0] ** 2,
            uv: xy - area * centroid[0] * centroid[1],
          }),
    },
    diagnostics: [
      ...mesh.report.diagnostics,
      ...(onEdge
        ? ["On-edge intersection uses the negative-halfspace boundary limit"]
        : []),
    ],
    accuracy: {
      method: "triangle-intersection",
      tolerance,
      triangles: mesh.faces.length,
      errorBound: null,
    },
  });
}
