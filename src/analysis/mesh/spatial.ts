import { V, type Vec3 } from "../../core/math";
export type Face = [number, number, number];
export interface Bounds {
  min: Vec3;
  max: Vec3;
}
export interface Tree extends Bounds {
  faces?: number[];
  left?: Tree;
  right?: Tree;
}
export function bounds(points: readonly Vec3[]): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let j = 0; j < 3; j++) {
      min[j] = Math.min(min[j], p[j]);
      max[j] = Math.max(max[j], p[j]);
    }
  return { min, max };
}
export function buildTree(
  vertices: readonly Vec3[],
  faces: readonly Face[],
): Tree {
  const boxes = faces.map((f) => bounds(f.map((i) => vertices[i])));
  const build = (ids: number[]): Tree => {
    const box = bounds(ids.flatMap((i) => [boxes[i].min, boxes[i].max]));
    if (ids.length <= 12) return { ...box, faces: ids };
    const span = V.sub(box.max, box.min),
      axis = span.indexOf(Math.max(...span));
    ids.sort(
      (a, b) =>
        boxes[a].min[axis] +
        boxes[a].max[axis] -
        (boxes[b].min[axis] + boxes[b].max[axis]),
    );
    const mid = Math.floor(ids.length / 2);
    return {
      ...box,
      left: build(ids.slice(0, mid)),
      right: build(ids.slice(mid)),
    };
  };
  return build(faces.map((_, i) => i));
}
export function visit(
  tree: Tree,
  accepts: (box: Bounds) => boolean,
  face: (id: number) => void,
) {
  if (!accepts(tree)) return;
  if (tree.faces) tree.faces.forEach(face);
  else {
    visit(tree.left!, accepts, face);
    visit(tree.right!, accepts, face);
  }
}
export function overlaps(a: Bounds, b: Bounds, t: number): boolean {
  return a.min.every((v, i) => v <= b.max[i] + t && a.max[i] >= b.min[i] - t);
}
/** Triangle SAT, including coplanar separating axes. Contacts within tolerance are ambiguous. */
export function trianglesMeet(
  a: Vec3[],
  b: Vec3[],
  tolerance: number,
): boolean {
  const edges = (p: Vec3[]) => p.map((v, i) => V.sub(p[(i + 1) % 3], v));
  const ea = edges(a),
    eb = edges(b),
    na = V.cross(ea[0], ea[1]),
    nb = V.cross(eb[0], eb[1]);
  const axes = [
    na,
    nb,
    ...ea.flatMap((x) => eb.map((y) => V.cross(x, y))),
    ...ea.map((e) => V.cross(e, na)),
    ...eb.map((e) => V.cross(e, nb)),
  ];
  for (const axis of axes) {
    const len = Math.hypot(...axis);
    if (len < 1e-30) continue;
    const n = V.scale(axis, 1 / len),
      aa = a.map((p) => V.dot(p, n)),
      bb = b.map((p) => V.dot(p, n));
    if (
      Math.max(...aa) < Math.min(...bb) - tolerance ||
      Math.max(...bb) < Math.min(...aa) - tolerance
    )
      return false;
  }
  return true;
}
