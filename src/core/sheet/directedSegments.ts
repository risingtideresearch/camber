// Complete directed boundaries, without welded nodes or section adjacency.
import type { Vec3 } from "../math";
import type { CutSegment } from "./planeCuts";

interface Incidence {
  incoming: number;
  outgoing: number;
}
const invalid = () =>
  new Error(
    "Directed cut boundary is open, branched, or inconsistently oriented",
  );
function incidence(segments: readonly CutSegment[]) {
  const counts = new Map<Vec3, Incidence>();
  const node = (p: Vec3) => {
    let count = counts.get(p);
    if (!count) {
      count = { incoming: 0, outgoing: 0 };
      counts.set(p, count);
    }
    return count;
  };
  for (const {
    points: [a, b],
  } of segments) {
    node(a).outgoing++;
    node(b).incoming++;
  }
  return counts;
}
function validateCounts(counts: Map<Vec3, Incidence>): void {
  for (const count of counts.values())
    if (count.incoming !== 1 || count.outgoing !== 1) throw invalid();
}
/** Count in AND out, not just net flow: a balanced branch is still invalid. */
export function validateDirectedSegments(
  segments: readonly CutSegment[],
): void {
  validateCounts(incidence(segments));
}

/** Complete boundary in, complete boundary out. Input must already pass
 * validateDirectedSegments (once on collection, then after every effective clip).
 * Never mutate the input, its
 * segments or their points: an untrimmed list may be retained by a plane cache.
 * Endpoints share identity, so no coordinate welding is needed. eps is already
 * in the affine clipping coordinate's units. coordinate must be pure/affine.
 */
export function clipDirectedSegments(
  segments: readonly CutSegment[],
  coordinate: (p: Vec3) => number,
  limit: number,
  eps: number,
): readonly CutSegment[] {
  const distances = new Map<Vec3, number>();
  let outside = false;
  for (const { points } of segments)
    for (const p of points) {
      if (distances.has(p)) continue;
      const d = coordinate(p) - limit;
      distances.set(p, Math.abs(d) <= eps ? 0 : d);
      if (d > eps) outside = true;
    }
  // Knowing the entire input makes skin ownership explicit: no-op limits keep
  // on-line skin; effective limits reconstruct trim-line edges as non-skin.
  if (!outside) return segments;
  const kept: CutSegment[] = [];
  for (const segment of segments) {
    let [a, b] = segment.points;
    const da = distances.get(a)!,
      db = distances.get(b)!;
    if (da >= 0 && db >= 0) continue;
    if (da > 0 || db > 0) {
      const t = da / (da - db),
        hit = a.map((x, i) => x + t * (b[i] - x)) as Vec3;
      if (da > 0) a = hit;
      else b = hit;
      kept.push({ points: [a, b], skin: segment.skin });
    } else kept.push(segment);
  }
  const counts = incidence(kept),
    ends: Vec3[] = [];
  for (const [point, count] of counts) {
    if (count.incoming === 1 && count.outgoing === 1) continue;
    if (count.incoming + count.outgoing !== 1) throw invalid();
    if (Math.abs(coordinate(point) - limit) > 2 * eps)
      throw new Error("Directed cut is open away from its clipping boundary");
    ends.push(point);
  }
  if (ends.length % 2)
    throw new Error("Directed clipping has an unmatched endpoint");
  if (ends.length) {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const p of ends)
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], p[i]);
        hi[i] = Math.max(hi[i], p[i]);
      }
    const spans = hi.map((x, i) => x - lo[i]),
      axis = spans.indexOf(Math.max(...spans));
    ends.sort((a, b) => a[axis] - b[axis]);
    for (let i = 0; i < ends.length; i += 2) {
      let a = ends[i],
        b = ends[i + 1];
      if (counts.get(a)!.outgoing === 1) [a, b] = [b, a];
      const ca = counts.get(a)!,
        cb = counts.get(b)!;
      if (
        ca.incoming !== 1 ||
        ca.outgoing !== 0 ||
        cb.incoming !== 0 ||
        cb.outgoing !== 1
      )
        throw new Error(
          "Directed clipping endpoints disagree about material side",
        );
      kept.push({ points: [a, b], skin: false });
      ca.outgoing++;
      cb.incoming++;
    }
  }
  validateCounts(counts);
  return kept;
}

/** Only drawing builds a successor map. This does not classify holes or measure. */
export function directedContours(segments: readonly CutSegment[]): Vec3[][] {
  const next = new Map(segments.map(({ points: [a, b] }) => [a, b])),
    contours: Vec3[][] = [];
  while (next.size) {
    const start = next.keys().next().value!,
      contour: Vec3[] = [];
    let point = start;
    do {
      contour.push(point);
      const target = next.get(point);
      if (target === undefined)
        throw new Error("Directed contour does not close");
      next.delete(point);
      point = target;
    } while (point !== start);
    contours.push(contour);
  }
  return contours;
}

/** Detach public drawing output from the cached source AND the immutable mesh,
 * while preserving endpoint sharing within a returned result. */
export function copyDirectedSegments(
  segments: readonly CutSegment[],
): CutSegment[] {
  const copies = new Map<Vec3, Vec3>();
  const copy = (p: Vec3) => {
    let q = copies.get(p);
    if (!q) {
      q = [...p];
      copies.set(p, q);
    }
    return q;
  };
  return segments.map(({ points: [a, b], skin }) => ({
    points: [copy(a), copy(b)],
    skin,
  }));
}
