// ---------- what makes a sampled hull a boat: a scorecard read off the swept geometry ----------
//
// Shared by the sampler comparison (`compare-hull-samplers.ts`) and the reparameterization test. Everything
// here is a yes/no read of the hull as the app draws it, so a sampler is judged on the same geometry a user
// would see. The thresholds are deliberately loose: they are set so that the designs people actually saved
// pass them (see the comparison's "real designs" row), and a sampler is scored on how often it lands inside
// that envelope — not on matching any particular boat.

import { hydrostatics } from "../src/core/hydro";
import { type HullState } from "../src/core/hull";
import { computeHullSampling, type HullSampling } from "../src/core/mesh";
import { loa, type Model } from "../src/core/model";
import { assemble } from "../src/core/runtime";
import { hullViolations } from "../src/core/invariants";

export interface Scorecard {
  /** The hull passes the document invariants (it can be opened at all). */
  valid: boolean;
  /** `hydrostatics` returns a result: something is under the waterline. */
  floats: boolean;
  /** The deck edge is above the waterline everywhere. */
  dry: boolean;
  /** Every wetted section reaches the centerline or the transom — no open bottom under water. */
  closed: boolean;
  /** The fraction of columns with hull that end on the centerline or the transom. */
  closure: number;
  /** Principal ratios inside the envelope real designs occupy. */
  proportioned: boolean;
  /** The keel / rocker line has at most two inflections (a keel bump is one pair). */
  rockerFair: boolean;
  /** Each sampled section changes turning direction at most twice (flare, bilge, hollow garboard). */
  sectionsFair: boolean;
  /** All of the above. */
  boat: boolean;
  lb: number;
  bt: number;
  cb: number;
  cp: number;
  lcb: number;
}

const inRange = (v: number, lo: number, hi: number): boolean =>
  isFinite(v) && v >= lo && v <= hi;

// sign changes of a sequence, ignoring entries below `eps` in magnitude
function signChanges(seq: number[], eps: number): number {
  let last = 0,
    n = 0;
  for (const v of seq) {
    if (Math.abs(v) < eps) continue;
    const s = v > 0 ? 1 : -1;
    if (last && s !== last) n++;
    last = s;
  }
  return n;
}

// the keel line's inflections: second differences of z against x, on the centerline curve resampled to ~24
// points so the test is about the line's shape and not the mesh's resolution
function rockerInflections(s: HullSampling, L: number): number {
  const pts = s.hullCenterline.map((h) => h.pos).filter((p) => isFinite(p[2]));
  if (pts.length < 6) return 0;
  // keep the part that is a graph z(x): walk from the aft end while x increases (the stem climbs back)
  const run: [number, number][] = [];
  for (const p of pts) {
    if (run.length && p[0] <= run[run.length - 1][0]) break;
    run.push([p[0], p[2]]);
  }
  if (run.length < 6) return 0;
  const N = 24,
    xs = run.map((p) => p[0]),
    x0 = xs[0],
    x1 = xs[xs.length - 1];
  const zAt = (x: number): number => {
    let i = 1;
    while (i < run.length - 1 && run[i][0] < x) i++;
    const [xa, za] = run[i - 1],
      [xb, zb] = run[i];
    return za + ((zb - za) * (x - xa)) / (xb - xa || 1);
  };
  const z = Array.from({ length: N + 1 }, (_, i) =>
    zAt(x0 + ((x1 - x0) * i) / N),
  );
  const d2: number[] = [];
  for (let i = 1; i < N; i++) d2.push(z[i + 1] - 2 * z[i] + z[i - 1]);
  // skip the ends, where the transom foot and the forefoot turn hard by construction
  return signChanges(d2.slice(2, -4), 2e-4 * L);
}

// a section's changes of turning direction: cross products of successive segments of the half-section
// (|y|, z), with short segments skipped
function sectionTurns(s: HullSampling, u: number, L: number): number {
  let best = -1,
    bd = Infinity;
  s.columns.forEach((c, i) => {
    if (!c.pts.length) return;
    const d = Math.abs(s.uParams[c.i] - u);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  if (best < 0) return 0;
  const pts = s.columns[best].pts.map((h) => [Math.abs(h.pos[1]), h.pos[2]]);
  const segs: [number, number][] = [];
  const minLen = 0.004 * L;
  let a = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i],
      d: [number, number] = [b[0] - a[0], b[1] - a[1]];
    if (Math.hypot(d[0], d[1]) < minLen) continue;
    segs.push(d);
    a = b;
  }
  // the turning angle at each vertex, in degrees; turns under 2° are straight
  const turns: number[] = [];
  for (let i = 1; i < segs.length; i++) {
    const [ax, ay] = segs[i - 1],
      [bx, by] = segs[i];
    turns.push(
      (Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI,
    );
  }
  return signChanges(turns, 2);
}

/** A scored hull, with the geometry the score was read from (absent where it could not be built). */
export interface Analysis {
  card: Scorecard;
  model?: Model;
  sampling?: HullSampling;
}

/** Score one hull. `ns` columns along the hull, `r` girth sub-steps per section segment. */
export const score = (hull: HullState, ns = 64, r = 4): Scorecard =>
  analyze(hull, ns, r).card;

/** Score one hull and keep its sampling, for drawing it. */
export function analyze(hull: HullState, ns = 64, r = 4): Analysis {
  const nan = {
    lb: NaN,
    bt: NaN,
    cb: NaN,
    cp: NaN,
    lcb: NaN,
  };
  const fail: Scorecard = {
    valid: false,
    floats: false,
    dry: false,
    closed: false,
    closure: 0,
    proportioned: false,
    rockerFair: false,
    sectionsFair: false,
    boat: false,
    ...nan,
  };
  if (hullViolations(hull, "document").length) return { card: fail };
  const model = assemble(hull),
    L = loa(model);
  let s: HullSampling;
  try {
    s = computeHullSampling(model, ns, r);
  } catch {
    return { card: { ...fail, valid: true }, model };
  }
  const cols = s.columns.filter((c) => c.pts.length > 0);
  const ended = cols.filter((c) => c.keel || c.transom).length;
  const closure = cols.length ? ended / cols.length : 0;
  const wl = -hull.waterline;
  // a column whose bottom is under the waterline and ends on neither the centerline nor the transom is an
  // open bottom that would flood
  const openWet = cols.some(
    (c) => !c.keel && !c.transom && c.pts[c.pts.length - 1].pos[2] < wl,
  );
  const h = hydrostatics(model, s, 0);
  if (!h)
    return {
      card: { ...fail, valid: true, closed: !openWet, closure },
      model,
      sampling: s,
    };
  const lb = L / (h.bwl || NaN),
    bt = h.bwl / (h.draft || NaN),
    lcb = (h.lcb - h.xAft) / (h.lwl || NaN);
  const proportioned =
    inRange(lb, 1.6, 14) &&
    inRange(bt, 1.2, 14) &&
    inRange(h.cb, 0.15, 0.8) &&
    inRange(h.cp, 0.4, 0.95) &&
    inRange(lcb, 0.3, 0.7);
  const rockerFair = rockerInflections(s, L) <= 2;
  const sectionsFair = [0.15, 0.3, 0.5, 0.7, 0.85].every(
    (u) => sectionTurns(s, u, L) <= 2,
  );
  const card: Scorecard = {
    valid: true,
    floats: true,
    dry: h.validWaterplane,
    closed: !openWet,
    closure,
    proportioned,
    rockerFair,
    sectionsFair,
    boat: false,
    lb,
    bt,
    cb: h.cb,
    cp: h.cp,
    lcb,
  };
  card.boat =
    card.dry &&
    card.closed &&
    card.proportioned &&
    card.rockerFair &&
    card.sectionsFair;
  return { card, model, sampling: s };
}

/** Column-wise pass rates over a batch of scorecards, as fractions. */
export function summarize(cards: Scorecard[]): Record<string, number> {
  const keys = [
    "valid",
    "floats",
    "dry",
    "closed",
    "proportioned",
    "rockerFair",
    "sectionsFair",
    "boat",
  ] as const;
  const out: Record<string, number> = {};
  for (const k of keys)
    out[k] = cards.filter((c) => c[k]).length / (cards.length || 1);
  out.closure = cards.reduce((a, c) => a + c.closure, 0) / (cards.length || 1);
  // how DIFFERENT the draws are from each other — a sampler that only ever returns the base hull would pass
  // everything, so the pass rates are only comparable between samplers of similar spread
  const sd = (xs: number[]): number => {
    const v = xs.filter((x) => isFinite(x));
    if (v.length < 2) return 0;
    const m = v.reduce((a, x) => a + x, 0) / v.length;
    return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
  };
  out.spreadLB = sd(cards.map((c) => Math.log(c.lb)));
  out.spreadBT = sd(cards.map((c) => Math.log(c.bt)));
  out.spreadCb = sd(cards.map((c) => c.cb));
  return out;
}
