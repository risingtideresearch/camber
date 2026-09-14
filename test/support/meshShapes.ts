import type { Vec3 } from "../../src/core/math";
/** Analytic cuboid, optionally with a missing top and a deliberately nonplanar top edge. */
export function boxSoup(
  length = 4,
  beam = 2,
  depth = 2,
  open = false,
  nonplanar = false,
): number[] {
  const p: Vec3[] = [
    [0, -beam / 2, 0],
    [length, -beam / 2, 0],
    [length, beam / 2, 0],
    [0, beam / 2, 0],
    [0, -beam / 2, depth],
    [length, -beam / 2, depth],
    [length, beam / 2, depth],
    [0, beam / 2, depth],
  ];
  if (nonplanar) p[6][2] += depth * 0.2;
  const quads = [
    [0, 3, 2, 1],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
    ...(!open ? [[4, 5, 6, 7]] : []),
  ];
  return quads.flatMap(([a, b, c, d]) =>
    [a, b, c, a, c, d].flatMap((i) => p[i]),
  );
}
/** Increase triangle count without changing a planar box's geometry. */
export function subdivide(soup: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < soup.length; i += 9) {
    const [a, b, c] = [0, 3, 6].map(
      (j) => soup.slice(i + j, i + j + 3) as Vec3,
    );
    const mix = (a: Vec3, b: Vec3) => a.map((v, j) => (v + b[j]) / 2) as Vec3;
    const ab = mix(a, b),
      bc = mix(b, c),
      ca = mix(c, a);
    out.push(...[a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca].flat());
  }
  return out;
}

/** A small triangular opening in the bottom of a box, with an optional open sheer. */
export function boxWithSmallOpening(open = false, fraction = 0.002): number[] {
  const soup = boxSoup(4, 2, 2, open);
  const p = [0, 3, 6].map((i) => soup.slice(i, i + 3));
  const center = p[0].map((_, i) => (p[0][i] + p[1][i] + p[2][i]) / 3);
  const q = p.map((a) =>
    a.map((v, i) => center[i] + (v - center[i]) * fraction),
  );
  return [
    ...soup.slice(9),
    ...p.flatMap((a, i) =>
      [a, p[(i + 1) % 3], q[(i + 1) % 3], a, q[(i + 1) % 3], q[i]].flat(),
    ),
  ];
}
