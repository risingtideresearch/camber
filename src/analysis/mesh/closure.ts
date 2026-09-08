import { V, type Vec2 } from "../../core/math";
import { polygonMoments, type BoundarySource } from "../sections";
import { METRE_SETUP, prepareMesh, type PreparedMesh } from "./prepare";
import { buildTree, visit, type Face } from "./spatial";

/** Preview only: triangulate ONE simple boundary that projects to a hull-xy polygon.
 * Heights stay at boundary vertices, yielding a piecewise-planar non-planar deck.
 * This is NOT a planar fan and not asserted equivalent to Camber's swept sheer cap. */
export function proposeDeckClosure(mesh: PreparedMesh): {
  triangles: Face[];
  method: string;
} {
  if (mesh.boundary.length !== 1)
    throw new Error("Deck closure needs exactly one boundary loop");
  const loop = mesh.boundary[0],
    points = loop.map((i) => mesh.vertices[i].slice(0, 2) as Vec2),
    tolerance = mesh.report.tolerance;
  if (loop.length > 2000)
    throw new Error(
      "Deck closure prototype supports at most 2000 boundary vertices",
    );
  const signed = polygonMoments(points).area;
  if (Math.abs(signed) <= tolerance ** 2)
    throw new Error("Deck boundary must enclose a hull-xy region");
  // Reject crossings/touches in the projection; it must be a single-valued deck height surface.
  const cross = (a: Vec2, b: Vec2, c: Vec2) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const a = points[i],
        b = points[(i + 1) % points.length],
        c = points[j],
        d = points[(j + 1) % points.length];
      if (
        Math.max(a[0], b[0]) + tolerance < Math.min(c[0], d[0]) ||
        Math.max(c[0], d[0]) + tolerance < Math.min(a[0], b[0]) ||
        Math.max(a[1], b[1]) + tolerance < Math.min(c[1], d[1]) ||
        Math.max(c[1], d[1]) + tolerance < Math.min(a[1], b[1])
      )
        continue;
      if (
        cross(a, b, c) * cross(a, b, d) <= 0 &&
        cross(c, d, a) * cross(c, d, b) <= 0
      )
        throw new Error("Deck boundary projection crosses or touches itself");
    }
  // For a symmetric, x-monotone sheer, pair its shores instead of choosing an
  // asymmetric ear diagonal across many height stations. Each transverse strip
  // is planar (equal x/z on the two shores), even when the whole sheer is not.
  const shore = loop
    .filter((i) => mesh.vertices[i][1] >= -tolerance)
    .sort((a, b) => mesh.vertices[a][0] - mesh.vertices[b][0]);
  const mirror = (i: number) =>
    loop.find(
      (j) =>
        Math.hypot(
          mesh.vertices[i][0] - mesh.vertices[j][0],
          mesh.vertices[i][1] + mesh.vertices[j][1],
          mesh.vertices[i][2] - mesh.vertices[j][2],
        ) <= tolerance,
    );
  const opposite = shore.map(mirror);
  if (
    opposite.every((i) => i !== undefined) &&
    shore.every(
      (id, k) =>
        k === 0 ||
        mesh.vertices[id][0] > mesh.vertices[shore[k - 1]][0] + tolerance,
    )
  ) {
    const key = (a: number, b: number) =>
        [a, b].sort((a, b) => a - b).join("/"),
      expected = new Set<string>();
    const add = (a: number, b: number) => {
      if (a !== b) expected.add(key(a, b));
    };
    for (let i = 0; i + 1 < shore.length; i++) {
      add(shore[i], shore[i + 1]);
      add(opposite[i]!, opposite[i + 1]!);
    }
    add(shore[0], opposite[0]!);
    add(shore[shore.length - 1], opposite[opposite.length - 1]!);
    if (
      expected.size === loop.length &&
      loop.every((a, i) => expected.has(key(a, loop[(i + 1) % loop.length])))
    ) {
      const triangles: Face[] = [];
      for (let i = 0; i + 1 < shore.length; i++)
        for (const f of [
          [shore[i], opposite[i]!, opposite[i + 1]!],
          [shore[i], opposite[i + 1]!, shore[i + 1]],
        ] as Face[])
          if (new Set(f).size === 3) triangles.push(f);
      return {
        triangles,
        method: "symmetric transverse ruled strips; piecewise-planar heights",
      };
    }
  }
  const remaining = points.map((_, i) => i);
  if (signed < 0) remaining.reverse();
  const triangles: Face[] = [];
  while (remaining.length > 3) {
    let found = false;
    for (let k = 0; k < remaining.length; k++) {
      const a = remaining[(k + remaining.length - 1) % remaining.length],
        b = remaining[k],
        c = remaining[(k + 1) % remaining.length];
      if (cross(points[a], points[b], points[c]) <= tolerance ** 2) continue;
      if (
        remaining.some(
          (i) =>
            i !== a &&
            i !== b &&
            i !== c &&
            cross(points[a], points[b], points[i]) >= -(tolerance ** 2) &&
            cross(points[b], points[c], points[i]) >= -(tolerance ** 2) &&
            cross(points[c], points[a], points[i]) >= -(tolerance ** 2),
        )
      )
        continue;
      triangles.push([loop[a], loop[b], loop[c]]);
      remaining.splice(k, 1);
      found = true;
      break;
    }
    if (!found)
      throw new Error(
        "Deck projection cannot be triangulated without degeneracy",
      );
  }
  triangles.push(remaining.map((i) => loop[i]) as Face);
  return {
    triangles,
    method: "boundary-vertex xy ear triangulation; piecewise-planar heights",
  };
}

/** Confirmation belongs to the import host; a proposal alone never grants a buoyancy envelope. */
export function closeDeck(
  mesh: PreparedMesh,
  confirmation: { accepted: true; closureId: string },
): PreparedMesh {
  if (confirmation.accepted !== true || !confirmation.closureId)
    throw new Error("Explicit deck closure confirmation is required");
  const proposal = proposeDeckClosure(mesh),
    faces = [...mesh.faces, ...proposal.triangles];
  // A projected opening is not automatically a DECK opening. The supported cap
  // must contain the physical vertices beneath its xy footprint. Cap/skin
  // intersections are separately checked by complete envelope validation below.
  const capTree = buildTree(mesh.vertices, proposal.triangles);
  const boundary = new Set(mesh.boundary.flat());
  mesh.vertices.forEach((p, id) => {
    if (boundary.has(id)) return;
    let covered = false;
    visit(
      capTree,
      (box) =>
        p[0] >= box.min[0] - mesh.report.tolerance &&
        p[0] <= box.max[0] + mesh.report.tolerance &&
        p[1] >= box.min[1] - mesh.report.tolerance &&
        p[1] <= box.max[1] + mesh.report.tolerance,
      (i) => {
        const [a, b, c] = proposal.triangles[i].map((j) => mesh.vertices[j]);
        const denominator =
          (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        const u =
          ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) /
          denominator;
        const v =
          ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) /
          denominator;
        const eps =
          mesh.report.tolerance /
          Math.max(
            Math.hypot(b[0] - a[0], b[1] - a[1]),
            Math.hypot(c[0] - a[0], c[1] - a[1]),
          );
        if (u < -eps || v < -eps || 1 - u - v < -eps || !Number.isFinite(u + v))
          return;
        covered = true;
        if (
          p[2] >
          u * a[2] + v * b[2] + (1 - u - v) * c[2] + mesh.report.tolerance
        )
          throw new Error("The opening is not a supported top/deck boundary");
      },
    );
    if (!covered)
      throw new Error(
        "Deck closure prototype does not support skin outside the boundary's xy footprint",
      );
  });
  const sources: BoundarySource[] = [
    ...mesh.sources,
    ...proposal.triangles.map(() => ({
      kind: "synthetic" as const,
      closure: confirmation.closureId,
    })),
  ];
  const closed = prepareMesh(
    faces.flatMap((f) => f.flatMap((i) => mesh.vertices[i])),
    METRE_SETUP,
    { tolerance: mesh.report.tolerance, sources },
  );
  // Revalidation above checks winding, topology and intersections with the physical skin.
  closed.report.diagnostics.push(
    `Confirmed synthetic deck: ${proposal.method}`,
  );
  return closed;
}

/** A closed cap's reference is the physical/synthetic seam, not every high vertex. */
export function deckReference(mesh: PreparedMesh) {
  const ids = new Set<number>();
  mesh.faces.forEach((f, i) => {
    if (mesh.sources[i].kind === "synthetic") f.forEach((v) => ids.add(v));
  });
  return [...ids].map((i) => V.scale(mesh.vertices[i], 1));
}
