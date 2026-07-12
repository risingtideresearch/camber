// ---------- scalar + 3D vector helpers ----------

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export const clamp = (x: number, a: number, b: number): number =>
  Math.max(a, Math.min(b, x));

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

export const V = {
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
};

// mirror a starboard half-section row (sheer → keel, the keel point last, y = 0) across the centerline:
// starboard sheer→keel, then port keel→sheer as the y-mirror, dropping the duplicate keel point — so the
// keel is one interior column rather than a mirrored seam.
export function mirrorRow(row: Vec3[]): Vec3[] {
  const full = row.slice();
  for (let j = row.length - 2; j >= 0; j--)
    full.push([row[j][0], -row[j][1], row[j][2]]);
  return full;
}
