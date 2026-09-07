// Camber-only silhouette and section queries, extracted without changing sampling or frame semantics.
import { unitScale } from "./lengthUnits";
import type { Vec2, Vec3 } from "./math";
import { sweptSection, type HullSampling } from "./mesh";
import type { Model } from "./model";
import { heightSpan, stationGeometry } from "./sweep";
import {
  toSheet,
  type PointFrame,
  type HullOutlines,
  type SectionAt,
  type SectionOutline,
} from "../analysis/geometry";
const SECTION_R = 6;

// ---------- the vertical slice ----------

/**
 * The hull cut by the plane x = `xSheet`, in sheet (y, z).
 *
 * This is the cut a POINT is judged against, and the reason it exists beside the station: a point's x puts it
 * exactly in this plane, where the station its x looks up misses it by up to 300 mm and the station THROUGH
 * it is a plane whose skin an interior point is never on. Here the question "is this inside the outline" is
 * the question "is this inside the boat", with nothing lost in the asking.
 *
 * Built by walking the sampling's ROWS rather than its columns. A column is a station and has almost no
 * extent in x; a row is a longitudinal curve and crosses the plane exactly once, so one crossing per row is
 * one point of the section, and the rows the trims removed simply do not contribute. That keeps the outline
 * trimmed without this having to know what the trims were — and the hull's two EDGES are rows of the same
 * kind, which is what makes the slice reach the sheer at the top and close on the centreline at the keel.
 *
 * A drawing, at pointer resolution: the crossing is linear between neighbouring columns. `slices.ts` remains
 * the only thing that measures.
 */
export function verticalSection(
  sampling: HullSampling,
  frame: PointFrame,
  xSheet: number,
): SectionOutline | null {
  // Every longitudinal curve of the trimmed hull, each as the columns it survives in.
  //
  // The interior ones are the sheet's own rows. The other two are the EDGES: a column's first point is where
  // the sheer trim cut it and its last is where the centreline or the transom did, and those land on
  // fractional rows — 5.18 and 36.93 on the stock hull's twentieth column — so neither is a row and both are
  // curves all the same. Leaving them out is what truncated the slice below the sheer and left it hanging
  // short of the centreline, where the two halves are supposed to meet.
  const runs = new Map<number, { i: number; pos: Vec3 }[]>();
  const SHEER = -1;
  const KEEL = Infinity;
  const push = (k: number, i: number, pos: Vec3): void => {
    const run = runs.get(k);
    if (run) run.push({ i, pos });
    else runs.set(k, [{ i, pos }]);
  };
  for (const column of sampling.columns) {
    if (!column.pts.length) continue;
    push(SHEER, column.i, column.pts[0].pos);
    push(KEEL, column.i, column.pts[column.pts.length - 1].pos);
    for (const sample of column.pts)
      if (Number.isInteger(sample.vSheetIndex))
        push(sample.vSheetIndex, column.i, sample.pos);
  }

  /**
   * Where one curve crosses the plane, in the sheet's frame.
   *
   * Only between ADJACENT columns: a row the trims interrupt would otherwise be bridged across the gap, and
   * the crossing invented there is on no part of the hull. One crossing is taken, because x runs
   * monotonically along a hull's length.
   */
  const cross = (run: { i: number; pos: Vec3 }[]): Vec3 | null => {
    for (let n = 1; n < run.length; n++) {
      if (run[n].i !== run[n - 1].i + 1) continue;
      const a = toSheet(frame, run[n - 1].pos);
      const b = toSheet(frame, run[n].pos);
      const da = a[0] - xSheet;
      const db = b[0] - xSheet;
      if (da !== 0 && da < 0 === db < 0) continue;
      const t = da === 0 ? 0 : da / (da - db);
      return [xSheet, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    return null;
  };

  // Sheer first, then down the rows, then the keel — the order a section is drawn in, and the order that
  // makes the last point the one the mirrored half meets.
  const order = [...runs.keys()].sort((a, b) => a - b);
  const starboard: Vec2[] = [];
  const trace: Vec2[] = [];
  for (const k of order) {
    const at = cross(runs.get(k)!);
    if (!at) continue;
    starboard.push([at[1], at[2]]);
    trace.push([at[0], at[2]]);
  }

  // Fewer than two crossings is a plane that misses the hull, or grazes its very end. Nothing to draw, and
  // saying so beats a one-point outline that reads as a section with no beam.
  if (starboard.length < 2) return null;
  return {
    kind: "vertical",
    x: xSheet,
    clamped: false,
    starboard,
    port: starboard.map(([y, z]): Vec2 => [-y, z]),
    trace,
  };
}

/**
 * The frame and the side-view silhouette, from a hull already swept.
 *
 * Null for a hull `stationGeometry` cannot make sense of, which is the same condition `hullMetrics` returns
 * null on: no frame, so nothing to draw a point in.
 */
export function hullOutlines(
  model: Model,
  sampling: HullSampling,
): HullOutlines | null {
  const geom = stationGeometry(model, sampling);
  if (!geom) return null;
  const s = unitScale(model.unit, "m");
  const x0 = model.plan.at(0)[0];
  const x1 = model.plan.at(1)[0];
  const [zLo, zHi] = heightSpan(geom, 0);

  const base: Omit<PointFrame, "xSpan" | "ySpan" | "zSpan" | "uSpan"> = {
    s,
    x0,
    x1,
    keelZ: geom.keelZ,
    cosRake: geom.cosRake,
    sinRake: geom.sinRake,
  };
  // `heightSpan` brackets the hull's own heights, and the keel datum is its floor — so the sheet z of the
  // lowest point on the hull is 0 by construction, whatever the rake.
  const frame: PointFrame = {
    ...base,
    xSpan: [0, (x1 - x0) * s],
    ySpan: [0, 0],
    zSpan: [(zLo - geom.keelZ) * s, (zHi - geom.keelZ) * s],
    uSpan: [0, 1],
  };

  // The silhouette is the per-column envelope: the highest and lowest the hull reaches at each station,
  // taken at the x of whichever point reaches it. On a curved plan a column spans a little x of its own; the
  // smear is far below the width of the line it is drawn with.
  const upper: Vec2[] = [];
  const lower: Vec2[] = [];
  let beam = 0;
  let uLo = 1;
  let uHi = 0;
  for (const column of sampling.columns) {
    if (column.pts.length < 2) continue;
    const u = sampling.uParams[column.i];
    uLo = Math.min(uLo, u);
    uHi = Math.max(uHi, u);
    let top: Vec2 | null = null;
    let bottom: Vec2 | null = null;
    for (const sample of column.pts) {
      const [x, y, z] = toSheet(frame, sample.pos);
      beam = Math.max(beam, Math.abs(y));
      if (!top || z > top[1]) top = [x, z];
      if (!bottom || z < bottom[1]) bottom = [x, z];
    }
    if (top) upper.push(top);
    if (bottom) lower.push(bottom);
  }

  if (uLo > uHi) return null; // no trimmed column anywhere: nothing to place a point against
  return {
    frame: { ...frame, ySpan: [-beam, beam], uSpan: [uLo, uHi] },
    profile: { upper, lower },
  };
}

/**
 * The hull's section at a place, in sheet (y, z).
 *
 * The cut is normal to the plan's heading, exactly as a slice row's station is — the same `sweptSection`
 * every hull integral is built on — so the outline a point is judged against is the one the hull is measured
 * with. An x outside the hull is CLAMPED to the nearest end rather than refused: the point is still drawn,
 * against the nearest real section, and the caller is told the section is not the one it asked for.
 */
export function sectionOutline(
  model: Model,
  frame: PointFrame,
  where: SectionAt,
): SectionOutline | null {
  const [uLo, uHi] = frame.uSpan;
  // `uAtPoint` is the foot of the perpendicular from the place onto the plan, which is exactly the u whose
  // station plane contains it: the plane is normal to the heading, and the foot is where the offset from the
  // curve has no component along it.
  const wanted =
    where.k === "at"
      ? model.plan.uAtX(where.x / frame.s + frame.x0)
      : model.plan.uAtPoint([where.x / frame.s + frame.x0, where.y / frame.s]);
  const u0 = Math.min(uHi, Math.max(uLo, wanted));
  let clamped = Math.abs(u0 - wanted) > 1e-9;

  // The ends need a little more give than the trimmed span alone. The stem is a point rather than a section,
  // and the aftmost column can sit a hair outside what `sweptSection` will trim at, so a cut asked for at the
  // very end steps inward until one exists. A point forward of the last real station is still drawn — against
  // the nearest section there is, and told it is not the one it asked for. Refusing would blank the view
  // exactly where a bow locker or an anchor is being placed.
  let section = null;
  let u = u0;
  for (let tries = 0; tries < 16; tries++) {
    const candidate = sweptSection(model, u, SECTION_R, true);
    if (!candidate.empty && candidate.pts.length >= 2) {
      section = candidate;
      break;
    }
    clamped = true;
    u =
      u0 + (u0 < (uLo + uHi) / 2 ? 1 : -1) * (uHi - uLo) * 0.004 * (tries + 1);
  }
  if (!section) return null;

  const sheet = section.pts.map((p) => toSheet(frame, p));
  const starboard = sheet.map(([, y, z]): Vec2 => [y, z]);
  return {
    kind: "station",
    x: (model.plan.at(u)[0] - frame.x0) * frame.s,
    clamped,
    starboard,
    port: starboard.map(([y, z]): Vec2 => [-y, z]),
    trace: sheet.map(([x, , z]): Vec2 => [x, z]),
  };
}
