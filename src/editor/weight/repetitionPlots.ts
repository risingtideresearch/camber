import type { Vec3 } from "../../core/math";
import type { RawSliceMeasurement } from "../../core/sheet/slices";

export type RepetitionView = "area" | "openLength" | "closedLength";
export type Projection = (point: Vec3) => readonly [number, number];

const DEFAULT_PREVIEW_SECTIONS = 7;

/** Presentation sampling is deliberately separate from repetition integration.
 * These sections illustrate the extent; they do not represent actual members or
 * control numerical accuracy.
 */
export function repetitionPreviewPositions(
  start: number,
  end: number,
  count = DEFAULT_PREVIEW_SECTIONS,
): readonly number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return [];
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("Preview section count must be a positive safe integer");
  return Array.from(
    { length: count },
    (_, i) => start + ((i + 0.5) * (end - start)) / count,
  );
}

/** One SVG subpath per contour preserves holes with even-odd fill. Open length
 * uses tagged skin segments, including disjoint runs, without closing them. */
export function samplePath(
  sample: RawSliceMeasurement,
  view: RepetitionView,
  at: Projection,
): string {
  if (view === "openLength")
    return sample.sheetSkinSegments
      .map(([a, b]) => `M${at(a).join(",")}L${at(b).join(",")}`)
      .join(" ");
  return sample.sheetContours
    .filter((c) => c.length)
    .map((c) => `M${c.map((p) => at(p).join(",")).join("L")}Z`)
    .join(" ");
}

/** Hit-test against projected contour segments, not centroid x alone: horizontal
 * samples separate in z and longitudinal samples may overlap in profile. Ties
 * retain the currently selected sample rather than flickering between overlaps. */
export function nearestSample(
  samples: readonly RawSliceMeasurement[],
  point: readonly [number, number],
  at: Projection,
  preferred: number,
): number | null {
  let best: number | null = null,
    distance = Infinity;
  samples.forEach((sample, index) =>
    sample.sheetContours.forEach((contour) =>
      contour.forEach((a, i) => {
        const b = contour[(i + 1) % contour.length],
          p = at(a),
          q = at(b);
        const dx = q[0] - p[0],
          dy = q[1] - p[1],
          length = dx * dx + dy * dy;
        const t = length
          ? Math.max(
              0,
              Math.min(
                1,
                ((point[0] - p[0]) * dx + (point[1] - p[1]) * dy) / length,
              ),
            )
          : 0;
        const d =
          (point[0] - p[0] - t * dx) ** 2 + (point[1] - p[1] - t * dy) ** 2;
        if (
          d < distance - 1e-6 ||
          (Math.abs(d - distance) <= 1e-6 && index === preferred)
        ) {
          distance = d;
          best = index;
        }
      }),
    ),
  );
  return best;
}
