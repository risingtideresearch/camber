import type { ChartScale } from "./ChartFrame";

/** Missing/nonfinite readings break a drawing; a path must never bridge them. */
export function linePath(
  points: readonly { x: number; y: number | null }[],
  scale: ChartScale,
): string {
  let drawing = false;
  return points
    .map((p) => {
      if (p.y === null || !Number.isFinite(p.y) || !Number.isFinite(p.x)) {
        drawing = false;
        return "";
      }
      const cmd = drawing ? "L" : "M";
      drawing = true;
      return `${cmd}${scale.x(p.x)},${scale.y(p.y)}`;
    })
    .join(" ");
}
/** A single ribbon per contiguous usable run avoids seams between adjacent cells. */
export function bandPath(
  points: readonly { x: number; lo: number | null; hi: number | null }[],
  scale: ChartScale,
): string {
  const runs: (typeof points)[] = [],
    current: { x: number; lo: number | null; hi: number | null }[] = [];
  for (const p of points) {
    if (
      !Number.isFinite(p.x) ||
      p.lo === null ||
      p.hi === null ||
      !Number.isFinite(p.lo) ||
      !Number.isFinite(p.hi)
    ) {
      if (current.length > 1) runs.push(current.splice(0));
      else current.length = 0;
    } else current.push(p);
  }
  if (current.length > 1) runs.push(current);
  return runs
    .map(
      (run) =>
        `${linePath(
          run.map((p) => ({ x: p.x, y: p.hi })),
          scale,
        )} ${run
          .slice()
          .reverse()
          .map((p) => `L${scale.x(p.x)},${scale.y(p.lo!)}`)
          .join(" ")} Z`,
    )
    .join(" ");
}
