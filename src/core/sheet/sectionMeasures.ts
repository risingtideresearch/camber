// Geometry-only measures. Moments are in the book's (hybrid deck-x / world-z) frame;
// lengths and areas are physical, measured in an orthonormal plane before conversion.
import type { Vec3 } from "../math";

export interface Measure {
  readonly amount: number;
  readonly moment: Vec3;
}
export interface SectionMeasures {
  readonly area: Measure;
  readonly openLength: Measure;
  readonly closedLength: Measure;
}
export const MEASURE_NAMES = ["area", "openLength", "closedLength"] as const;
export const CG_NAMES = ["areaCg", "openLengthCg", "closedLengthCg"] as const;
export const GEOMETRY_LEAVES = [
  "area",
  "openLength",
  "closedLength",
  ...CG_NAMES.flatMap((name) =>
    ["x", "y", "z"].map((axis) => `${name}.${axis}`),
  ),
];
export const zeroMeasure = (): Measure => ({ amount: 0, moment: [0, 0, 0] });
export const zeroMeasures = (): SectionMeasures => ({
  area: zeroMeasure(),
  openLength: zeroMeasure(),
  closedLength: zeroMeasure(),
});
export function sumMeasure(a: Measure, b: Measure): Measure {
  return {
    amount: a.amount + b.amount,
    moment: a.moment.map((v, i) => v + b.moment[i]) as Vec3,
  };
}
export function scaleMeasure(a: Measure, factor: number): Measure {
  return {
    amount: a.amount * factor,
    moment: a.moment.map((v) => v * factor) as Vec3,
  };
}
export function measureAt(amount: number, centroid: Vec3): Measure {
  return { amount, moment: centroid.map((v) => v * amount) as Vec3 };
}
export function geometryValue(measures: SectionMeasures, leaf: string): number {
  if ((MEASURE_NAMES as readonly string[]).includes(leaf))
    return measures[leaf as keyof SectionMeasures].amount;
  const [name, axis] = leaf.split(".");
  const index = ["x", "y", "z"].indexOf(axis);
  const measure = measures[name?.replace(/Cg$/, "") as keyof SectionMeasures];
  if (!name?.endsWith("Cg") || !measure || index < 0)
    throw new Error(`Unknown geometry value ${leaf}`);
  if (measure.amount === 0)
    throw new Error(`${name} is undefined because its measure is zero`);
  return measure.moment[index] / measure.amount;
}

/** Length and its first moment for explicitly selected line segments. */
export function lineMeasure(
  segments: readonly (readonly [Vec3, Vec3])[],
  toSheet: (p: Vec3) => Vec3,
  scale: number,
): Measure {
  return segments.reduce((total, [a, b]) => {
    const length = Math.hypot(...a.map((v, i) => v - b[i])) * scale;
    const midpoint = a.map((v, i) => (v + b[i]) / 2) as Vec3;
    return sumMeasure(total, measureAt(length, toSheet(midpoint)));
  }, zeroMeasure());
}
