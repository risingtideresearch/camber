// ---------- geometry and authoring for a points page ----------
//
// A point row is three formulas (`book.ts`), and this module is what stands between them and a pointer: the
// hull outlines the editor draws a point against, the rule that decides whether a coordinate may be dragged
// at all, and the shape a point's uncertainty actually has on screen.
//
// ---------- the frame ----------
//
// Everything here speaks the SHEET's frame — x from the transom, y from the centreline, z above the keel
// baseline, all in metres — because that is the frame the cells are written in. The hull is authored
// deck-flat with rake applied as a rotation, so z is a WORLD height (`x·sinRake + z·cosRake`, as `sweep.ts`
// computes `zBWorld`) while x stays in the deck frame. That hybrid is not this module's invention: it is the
// frame `hullMetrics.ts` reports `shellLcg` and `shellVcg` in and `slices.ts` measures cuts in, and a point
// has to land in the same one or a moment arm written against `HULL.SHELL_VCG` would be measured twice.
//
// ---------- two views, and why they are these two ----------
//
// The editor draws a point in the profile (x, z) and in the section at its own x (y, z). Neither view is the
// hull cut by the plane the point sits in, and only one of them could be:
//
//   • The profile is a SILHOUETTE — the hull's own outline in side view. The intersection of a hull with the
//     centreline plane is the keel and stem, a curve rather than a region, so there is nothing to position a
//     point inside. The silhouette is the envelope of the sampled columns, and it is context, not a bound.
//
//   • The section IS a cut, and it is the one that answers "is this inside the boat" — at the point's own x,
//     which is the only station where that question means anything.
//
// The pairing that suggests itself instead — profile to pick z, then the horizontal cut at that z to pick x
// and y — has three problems this one does not. It spends a two-degree-of-freedom drag on one number; it
// makes z choosable before x when the z a hull HAS depends on x; and the horizontal cut stops existing the
// moment it crosses a deck edge (`slices.ts` refuses it, correctly), which is exactly where a rig, a crew
// weight or an outboard on a bracket lives. A station section is defined the length of the hull, and a point
// outside the skin simply draws outside the outline.
//
// ---------- outlines are drawings, not measurements ----------
//
// The curves below are redrawn while a point is dragged, so they are sampled at a resolution chosen for a
// pointer rather than for an integral. Nothing here reports an area, a perimeter or a centroid: a number a
// sheet can refer to comes from a slice row (`slices.ts`), which is measured once at a nominal position and
// cached.

import { unitScale } from "../json";
import type { Vec2, Vec3 } from "../math";
import type { HullSampling } from "../mesh";
import { sweptSection } from "../mesh";
import type { Model } from "../model";
import { heightSpan, stationGeometry } from "../sweep";
import type { Gradient, Quantity, SourceTable } from "./quantity";

// A pointer redraws the section every frame, so it is sampled for a line rather than for an integral. Slice
// rows own measurement; this is the drawing a point is placed against.
const SECTION_R = 6;

// ---------- the frame ----------

/** Model coordinates ↔ the sheet's frame, for one hull. */
export interface PointFrame {
  /** Metres per model unit. */
  readonly s: number;
  /** The model x the plan starts at — the transom, which is the sheet's x origin. */
  readonly x0: number;
  readonly x1: number;
  readonly keelZ: number;
  readonly cosRake: number;
  readonly sinRake: number;
  /** The hull's own extent in the sheet's frame, which is what the views fit themselves to. */
  readonly xSpan: readonly [number, number];
  readonly ySpan: readonly [number, number];
  readonly zSpan: readonly [number, number];
  /**
   * The sweep parameters a trimmed section actually exists at.
   *
   * Not [0, 1]: the plan starts at the transom CONTROL POINT, and the transom plane trims the surface some
   * way forward of it — so the aft few percent of the plan has no hull on it, and the stem is a point rather
   * than a section. A cut asked for outside this range is answered with the nearest one inside it.
   */
  readonly uSpan: readonly [number, number];
}

/** A model point, in the sheet's frame. */
export function toSheet(frame: PointFrame, p: Vec3): Vec3 {
  return [
    (p[0] - frame.x0) * frame.s,
    p[1] * frame.s,
    (p[0] * frame.sinRake + p[2] * frame.cosRake - frame.keelZ) * frame.s,
  ];
}

/** A sheet-frame point, back in model coordinates — what the 3D overlay draws with. */
export function toModel(frame: PointFrame, p: Vec3): Vec3 {
  const mx = p[0] / frame.s + frame.x0;
  const worldZ = p[2] / frame.s + frame.keelZ;
  return [mx, p[1] / frame.s, (worldZ - mx * frame.sinRake) / frame.cosRake];
}

// ---------- the outlines ----------

/** The hull in side view: its upper and lower envelopes, in sheet (x, z). */
export interface ProfileOutline {
  /** Aft to forward along the top of the silhouette — the sheer, in side view. */
  readonly upper: readonly Vec2[];
  /** Aft to forward along the bottom — the keel and stem. */
  readonly lower: readonly Vec2[];
}

/** One station, in sheet (y, z). Both halves, because a point may sit on either side. */
export interface SectionOutline {
  /** The x the cut was actually taken at, which is the requested one clamped into the hull. */
  readonly x: number;
  /** True when the requested x fell outside the hull and the cut was clamped to reach it. */
  readonly clamped: boolean;
  readonly starboard: readonly Vec2[];
  readonly port: readonly Vec2[];
}

export interface HullOutlines {
  readonly frame: PointFrame;
  readonly profile: ProfileOutline;
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
 * The hull's section at a sheet-frame x, in sheet (y, z).
 *
 * The cut is normal to the plan's heading, exactly as a slice row's station is — the same `sweptSection`
 * every hull integral is built on — so the outline a point is judged against is the one the hull is measured
 * with. An x outside the hull is CLAMPED to the nearest end rather than refused: the point is still drawn,
 * against the nearest real section, and the caller is told the section is not the one it asked for.
 */
export function sectionOutline(
  model: Model,
  frame: PointFrame,
  xSheet: number,
): SectionOutline | null {
  const [uLo, uHi] = frame.uSpan;
  const wanted = model.plan.uAtX(xSheet / frame.s + frame.x0);
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

  const starboard = section.pts.map((p): Vec2 => {
    const [, y, z] = toSheet(frame, p);
    return [y, z];
  });
  return {
    x: (model.plan.at(u)[0] - frame.x0) * frame.s,
    clamped,
    starboard,
    port: starboard.map(([y, z]): Vec2 => [-y, z]),
  };
}

// ---------- what a coordinate may be dragged to ----------
//
// A point's coordinates are formulas, and most of what makes them worth having cannot simply be replaced:
// `HULL.LCB` says something a number does not, and overwriting it with wherever the pointer landed would
// throw that away silently. So a drag does not replace a cell — it moves ONE literal inside it, and which
// literal that is comes off the parse rather than out of a mode the user sets.
//
// The literal is a term of the outermost sum, because moving a point is adding a distance to it:
//
//   2.1                  the whole cell is the literal — the simple case, and still the common one
//   HULL.LCB + 2         the `2` moves; the reference is not touched, and the point follows the LCB
//   HULL.LOA * 0.4       nothing moves. `0.4` is a proportion, and a nudge must not restate a design ratio
//
// Where the cell has no literal to move, a drag ADDS one: dragging `HULL.LCB` writes `HULL.LCB + 0.3`, so a
// coordinate authored as a pure reference can still be nudged off it without being retyped. That only works
// in a row whose declared unit gives the new number a dimension (see `formula.ts`), which is why the caller
// passes that in — appending a plain number to a length would trade a working cell for an error.
//
// Two or more literals in the sum is a refusal rather than a guess. `HULL.LCB + 2 + 3` has no single number
// the gesture is about, and picking one would be arbitrary; the fix is to tidy it to `+ 5`, which is a thing
// the person who wrote it should do.
//
// The `± …` on the literal rides along untouched. A tolerance says how well the position is known, and
// moving the position does not make it better or worse known — only a drag on the tolerance handle itself
// changes it.

import { topLevelTerms, termLiteral, type Node } from "./formula";

/** The literal a move rewrites, and the span it occupies. */
export interface Handle {
  /**
   * What this term CONTRIBUTES to the cell, in the cell's own unit — the literal with its sign already
   * applied. `HULL.LCB - 2` contributes −2, so moving the point aft by 0.3 leaves −2.3 to write, and the
   * writer turns that back into an operator and a magnitude.
   */
  readonly contributes: number;
  /** The `± …` after the number, verbatim. Empty where there is none. */
  readonly tail: string;
  /** The source range a rewrite replaces: the operator before the number included, so its sign can flip. */
  readonly from: number;
  readonly to: number;
  /** Nothing precedes it — it is the first term, and is written as a bare number rather than `+ n`. */
  readonly leading: boolean;
}

export interface Placement {
  /** The cell as written. A move splices into this rather than replacing it. */
  readonly source: string;
  /** What the whole cell works out to, in its own unit. A move is stated against this, not against a term. */
  readonly value: number;
  /** The literal a move rewrites, or null where the cell has none and a move appends one. */
  readonly handle: Handle | null;
  /** The cell IS its literal and nothing else. Only then may a snap replace the whole thing. */
  readonly bare: boolean;
}

// The number at the start of a literal's span. Its `±` and amount, if any, are whatever follows.
const NUMBER = /^\s*[+-]?\s*(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

/**
 * Read a coordinate as something a drag can move, or null where nothing in it may be.
 *
 * An EMPTY cell is a placement at zero with no handle: a point that has not been placed yet is the ordinary
 * state of a row you just added, and dragging is how you place it.
 *
 * `value` is what the cell currently works out to, in its own unit — the drag is stated against that, since
 * what the pointer says is "the whole coordinate should be here", not "this literal should be that".
 * `canAppend` says whether the row's unit would give a newly written number a dimension.
 */
export function readPlacement(
  source: string,
  tree: Node | null,
  value: number,
  canAppend: boolean,
): Placement | null {
  if (!source.trim()) return { source, value: 0, handle: null, bare: true };
  if (!tree || !isFinite(value)) return null; // a cell that will not parse or will not evaluate

  const terms = topLevelTerms(tree);
  const literals = terms.flatMap((term) => {
    const literal = termLiteral(term);
    return literal ? [{ term, literal }] : [];
  });
  if (literals.length > 1) return null; // no single number the gesture is about
  if (!literals.length)
    return canAppend ? { source, value, handle: null, bare: false } : null;

  const { term, literal } = literals[0];
  const leading = term.opAt < 0;
  const span = source.slice(literal.at, literal.node.end);
  const number = NUMBER.exec(span);
  if (!number) return null; // the span is not shaped as this module believes — leave the cell alone
  return {
    source,
    value,
    bare: terms.length === 1 && leading,
    handle: {
      contributes: literal.sign * literal.node.v,
      tail: span.slice(number[0].length).trim(),
      from: leading ? literal.at : term.opAt,
      to: literal.node.end,
      leading,
    },
  };
}

/**
 * How many decimals a move of `step` can honestly claim.
 *
 * A drag resolves one screen pixel, and `step` is that pixel in the cell's own unit. Without this a drag
 * writes `3.2000000000000455`, which is a worse thing to read a month later than the pixel of precision it
 * is pretending to.
 */
const decimalsFor = (step: number): number =>
  Math.min(6, Math.max(0, Math.ceil(-Math.log10(Math.max(step, 1e-9)))));

const trim = (value: number, step: number): string => {
  const text = value.toFixed(decimalsFor(step));
  const tidy = text.includes(".") ? text.replace(/\.?0+$/, "") : text;
  return tidy === "" || tidy === "-" ? "0" : tidy;
};

/** `n`, or `n ± tol`, as a cell would spell it. */
const spell = (value: number, tail: string, step: number): string =>
  tail ? `${trim(value, step)} ${tail}` : trim(value, step);

/** Splice a term's replacement in, keeping the spacing readable however the rest was typed. */
const splice = (placement: Placement, handle: Handle, text: string): string =>
  handle.leading
    ? placement.source.slice(0, handle.from) +
      text +
      placement.source.slice(handle.to)
    : `${placement.source.slice(0, handle.from).trimEnd()} ${text}${placement.source.slice(handle.to)}`;

/**
 * A coordinate's text after a move to `target`, in the cell's own unit.
 *
 * The move is a TRANSLATION — the literal takes the difference — which is why nothing here evaluates a
 * derivative or divides by one. `HULL.LCB + 2` dragged 0.3 forward becomes `HULL.LCB + 2.3`, exactly, and
 * every other character of the cell is the character that was there before.
 */
export function withNominal(
  placement: Placement,
  target: number,
  step: number,
): string {
  const delta = target - placement.value;
  if (!placement.handle) {
    // Nothing to move, so the move writes the offset it needs. On an empty cell that is the position itself.
    if (!placement.source.trim()) return trim(target, step);
    const base = placement.source.trim();
    return delta < 0
      ? `${base} - ${trim(-delta, step)}`
      : `${base} + ${trim(delta, step)}`;
  }
  const handle = placement.handle;
  const next = handle.contributes + delta;
  return splice(
    placement,
    handle,
    handle.leading
      ? spell(next, handle.tail, step)
      : `${next < 0 ? "-" : "+"} ${spell(Math.abs(next), handle.tail, step)}`,
  );
}

/**
 * The cell with its literal taken out entirely — what a point dragged back onto its own base becomes.
 *
 * `HULL.LCB + 2` becomes `HULL.LCB`, which says "exactly at the LCB" where `+ 0` only says the arithmetic
 * works out that way. Null where there is nothing to remove, or where removing it would leave an expression
 * starting with an operator.
 */
export function withoutHandle(placement: Placement): string | null {
  const handle = placement.handle;
  if (!handle || handle.leading || placement.bare) return null;
  return (
    placement.source.slice(0, handle.from).trimEnd() +
    placement.source.slice(handle.to)
  );
}

// A tolerance a handle may be dragged: written out as a plain distance, or not written at all. `± 5%` and
// `± [0.2, 0.5]` are deliberately excluded — both say something a single handle cannot, and rewriting either
// into a symmetric absolute would be answering a question the user did not ask.
const PLAIN_TOLERANCE = /^(?:±|\+-)\s*(\d+(?:\.\d*)?|\.\d+)$/;

/**
 * The `±` a tolerance handle stands at, or null where the tail is not one a handle can express.
 *
 * An empty tail is zero rather than null: the coordinate can carry a tolerance, it just has none yet.
 */
export function readTolerance(tail: string): number | null {
  if (!tail.trim()) return 0;
  const match = PLAIN_TOLERANCE.exec(tail.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return isFinite(value) ? value : null;
}

/** A coordinate's text after a tolerance handle moved: the literal as it stood, a new `±`. */
export function withTolerance(
  placement: Placement,
  tolerance: number,
  step: number,
): string | null {
  const handle = placement.handle;
  if (!handle) return null;
  // A handle dragged back onto the point is a tolerance of nothing, which is written as no tolerance at all
  // rather than as `± 0` — an exact number and a number known to within zero are the same claim, and only
  // one of them reads like one.
  const reach = Math.abs(tolerance);
  const tail = reach < step ? "" : `± ${trim(reach, step)}`;
  return splice(
    placement,
    handle,
    handle.leading
      ? spell(handle.contributes, tail, step)
      : `${handle.contributes < 0 ? "-" : "+"} ${spell(Math.abs(handle.contributes), tail, step)}`,
  );
}

// ---------- the shape of an uncertainty, in two dimensions ----------
//
// A point with a ± on each coordinate is not a dot and not, in general, a box either. Two coordinates that
// lean on the SAME uncertain input move together: a tank whose x and z are both measured off one frame
// station is uncertain along a line, not over a rectangle. `quantity.ts` carries a gradient precisely so
// that this is knowable, and the two `Reading` figures alone cannot express it — they report each source's
// reach as two non-negative distances, which discards the sign that says which way the pair leans.
//
// So both regions below are built from the gradients:
//
//   • WORST is a zonotope — the exact first-order image of the box each source ranges over. One segment per
//     source, summed. Independent sources give back the axis-aligned rectangle; a shared one tilts it.
//   • LIKELY is the one-sigma ellipse of the same generators taken as independent, which is the same
//     quadrature the panel quotes: its extent along each axis is exactly that coordinate's `likely` figure.
//
// Both are drawn AROUND the nominal, in the quantities' own units, and both are linearizations — the same
// first-order honesty the rest of the uncertainty algebra is written in.

const generators = (
  a: Gradient,
  b: Gradient,
  sources: SourceTable,
): { g: Vec2; lo: number; hi: number }[] => {
  const out: { g: Vec2; lo: number; hi: number }[] = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const source = sources.get(id);
    if (!source) continue; // a source the table has forgotten contributes nothing, as `read` has it
    const g: Vec2 = [a[id] ?? 0, b[id] ?? 0];
    if (g[0] === 0 && g[1] === 0) continue;
    if (source.lo === 0 && source.hi === 0) continue;
    out.push({ g, lo: source.lo, hi: source.hi });
  }
  return out;
};

/**
 * The worst-case region: a convex polygon around the nominal, in (a, b).
 *
 * Empty where nothing can move the pair, and two points where everything moves it the same way — a point
 * uncertain along a line is a real answer and the caller draws it as one.
 */
export function worstRegion(
  a: Quantity,
  b: Quantity,
  sources: SourceTable,
): Vec2[] {
  const gens = generators(a.d, b.d, sources);
  if (!gens.length) return [];

  // Each source contributes the segment from −lo·g to +hi·g. Split it into a centre and a half-vector, so
  // the sum is one translation plus a Minkowski sum of segments symmetric about the origin — which is a
  // zonotope, and a zonotope's boundary is its half-vectors walked in angle order.
  let cx = 0;
  let cy = 0;
  const halves: Vec2[] = [];
  for (const { g, lo, hi } of gens) {
    cx += ((hi - lo) / 2) * g[0];
    cy += ((hi - lo) / 2) * g[1];
    const h: Vec2 = [((hi + lo) / 2) * g[0], ((hi + lo) / 2) * g[1]];
    // Flipped into the upper half-plane, so the walk below sweeps a half-turn and mirrors it.
    halves.push(h[1] < 0 || (h[1] === 0 && h[0] < 0) ? [-h[0], -h[1]] : h);
  }
  halves.sort((p, q) => Math.atan2(p[1], p[0]) - Math.atan2(q[1], q[0]));

  let x = cx;
  let y = cy;
  for (const h of halves) {
    x -= h[0];
    y -= h[1];
  }
  const out: Vec2[] = [[x, y]];
  for (const h of halves) {
    x += 2 * h[0];
    y += 2 * h[1];
    out.push([x, y]);
  }
  for (const h of halves.slice(0, -1)) {
    x -= 2 * h[0];
    y -= 2 * h[1];
    out.push([x, y]);
  }
  return out;
}

/**
 * The likely region: the one-sigma ellipse, as a polygon of `steps` points.
 *
 * An asymmetric tolerance is taken at its mean half-width, which is what `read` already does when it ranks
 * one source against another. The ellipse is the quadrature figure the panel quotes, drawn: its half-extent
 * along each axis is that coordinate's own `likely` spread.
 */
export function likelyRegion(
  a: Quantity,
  b: Quantity,
  sources: SourceTable,
  steps = 48,
): Vec2[] {
  const gens = generators(a.d, b.d, sources);
  if (!gens.length) return [];

  // The covariance of the pair, treating every source as an independent one-sigma of its mean half-width.
  let saa = 0;
  let sab = 0;
  let sbb = 0;
  for (const { g, lo, hi } of gens) {
    const sigma = (lo + hi) / 2;
    saa += sigma * sigma * g[0] * g[0];
    sab += sigma * sigma * g[0] * g[1];
    sbb += sigma * sigma * g[1] * g[1];
  }

  // Its eigen-decomposition, in closed form: the axes of the ellipse and how far it reaches along each.
  const trace = saa + sbb;
  const gap = Math.hypot(saa - sbb, 2 * sab);
  const l1 = (trace + gap) / 2;
  const l2 = Math.max(0, (trace - gap) / 2);
  // The major axis. Degenerate where the covariance is already diagonal, and (1, 0) is right there.
  const vx = sab !== 0 ? sab : 1;
  const vy = sab !== 0 ? l1 - saa : 0;
  const norm = Math.hypot(vx, vy) || 1;
  const ex = vx / norm;
  const ey = vy / norm;
  const r1 = Math.sqrt(Math.max(0, l1));
  const r2 = Math.sqrt(l2);

  const out: Vec2[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const c = r1 * Math.cos(t);
    const s = r2 * Math.sin(t);
    out.push([c * ex - s * ey, c * ey + s * ex]);
  }
  return out;
}

/** The region for whichever reading the panel is showing. */
export const spreadRegion = (
  a: Quantity,
  b: Quantity,
  sources: SourceTable,
  which: "worst" | "likely",
): Vec2[] =>
  which === "worst" ? worstRegion(a, b, sources) : likelyRegion(a, b, sources);
