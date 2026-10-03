// ============================================================================================
//  reparam.ts — a scale-free, ratio-based coordinate system for a hull: θ ∈ ℝᴹ ↔ HullState
// ============================================================================================
//
// The authored numbers (`HullState`) are the right coordinates for AUTHORING and BLENDING: every one is a
// concrete position, and a convex combination of valid hulls is a valid hull. They are poor coordinates for
// SAMPLING: drawn independently, they almost never make a boat, because the things that make a hull a boat
// are RELATIONS between slots, not values of slots —
//
//   • the section's keel reach against the plan's half-breadth (does the bottom close on the centerline?),
//   • the waterline against the sheer depth and the keel depth (does it float, with the deck dry?),
//   • the transom's top against the sheer at the stern, its foot against the aft section's depth,
//   • neighbouring control points against each other (is the curve fair, or lumpy?).
//
// Independent draws land on those relations only by coincidence. This module is a CHANGE OF VARIABLES that
// turns each relation into a coordinate of its own, so that independent draws respect them by construction:
//
//   SIZE, THEN RATIOS. One length sets the scale; everything else is a dimensionless ratio of something
//   decoded before it — length/beam, beam/depth, sheer depth as a fraction of hull depth, the waterline as a
//   fraction of the way from the lowest sheer down to the emergent keel, the transom's foot as a fraction
//   of the aft depth. A prior on these lives where a designer's intuition lives, and scale decouples from
//   shape.
//
//   CLOSURE IS A COORDINATE. Each station's keel reach is stored as ρ = n_keel / R*, where R* is the largest
//   centerline distance the plan presents to a station plane over the stretch of hull that station governs
//   (halfway to each neighbouring station). ρ > 1 means the section reaches the centerline wherever that
//   stretch is widest; "does it close" becomes one interpretable number per station, centred past 1,
//   instead of a coincidence between a plan point and a section point.
//
//   SHAPE IN THE UNIT BOX. A section is its keel reach and depth plus a SHAPE: where along the depth its
//   points sit (stick-breaking fractions of the depth) and how far inboard each panel runs (a fraction of
//   the reach per panel, the last one implied). Strict descent is automatic — the fractions are
//   non-negative. The inboard-run backbone grows panel by panel from near-vertical topsides to a flat run,
//   and one tilt coordinate on it is the turn of the bilge: zero tilt is a straight V, a steep tilt a box
//   section with a hard turn.
//
//   RESIDUALS IN A SMOOTH BASIS. Per-point detail (the plan's interior half-breadths, the trim's depths, the
//   spacing of control points, the panel runs) is carried as coefficients of cosine modes over the index,
//   with the scale of mode k falling geometrically. Mode 0 moves the whole curve, mode 1 tilts it, and the
//   wiggles sit in coordinates the prior keeps small — so a unit draw is a fair curve, not a lumpy one. It is
//   an orthonormal change of basis, so nothing is lost: any vector of residuals is some set of coefficients.
//
//   RATIOS THROUGH asinh, NOT log. A half-breadth, a sheer depth or a panel run is "a ratio of its backbone"
//   — log-like when it is positive and ordinary — but the saved designs also put it at ZERO (a double-ender's
//   stern, a sheer that meets the deck, a level panel) or NEGATIVE (tumblehome, an inverted bow). Those are
//   a log's −∞. The residual is therefore asinh(v / v̄) − asinh(1): exponential-like above, linear through
//   zero, and onto the whole line.
//
//   BOUNDARIES THAT ARE TYPICAL ARE REACHABLE. A knuckle is usually exactly 0 (smooth) or exactly 1 (a hard
//   chine), and a sigmoid reaches neither. Knuckles, the keel crease and the depth fractions use a CENSORED
//   logistic — a logistic stretched past both ends of [0,1] and clamped — so both ends carry probability
//   mass and a draw can be a true chine, a truly smooth point, or a level panel. (This is the one place the
//   map is many-to-one: `encode` picks the pre-image a half unit past the boundary.)
//
// `decode` is a triangular (autoregressive) map — each coordinate enters through a monotone transform
// relative to what was decoded before it — so it is onto the whole valid region: every readable hull is
// some θ, and `encode` finds it. The two are ONE traversal (`walk`) run in two modes, so the layout of θ
// cannot drift between them.
//
// What this is NOT: a new document format. θ is a view of the same hull, for samplers and optimizers; the
// authored numbers remain what is stored and blended. Convex blending is in the authored space; a straight
// line in θ is a different (log/ratio) path between the same two hulls.
//
// Exactness. `encode ∘ decode` is the identity. `decode ∘ encode` reproduces a hull to float precision
// wherever the hull is in the open domain, and rounds the following onto it: a knuckle or a depth fraction
// on its boundary is exact (censoring); a waterline above the lowest sheer or below the keel is pulled just
// inside that interval; a first station not at u = 0 or last not at u = 1 is moved there (the loft clamps
// beyond its outer stations, so the sweep changes only by the knot positions).
//
// The prior's centres and spreads were read off the designs saved in the app's library (see
// `tools/compare-hull-samplers.ts`), not off the default hull alone.

import { planCurve } from "./bspline";
import { loa, stationKnuckle, type HullState } from "./hull";
import { clamp } from "./math";

// ---------- one-dimensional transforms ----------
// Each maps a θ-coordinate z ∈ ℝ onto a slot's domain, with z = 0 at the slot's centre, and back.
export interface Codec1 {
  decode: (z: number) => number;
  encode: (v: number) => number;
}

const sigmoid = (u: number): number => 1 / (1 + Math.exp(-u));
const logit = (p: number): number => Math.log(p / (1 - p));
const ASINH1 = Math.asinh(1);

/** A positive quantity: v = center·e^{scale·z}. A value at or below 0 encodes as the floor of the ray. */
export const positive = (center: number, scale: number): Codec1 => ({
  decode: (z) => center * Math.exp(scale * z),
  encode: (v) => Math.log(Math.max(v, center * 1e-9) / center) / scale,
});

/** A free quantity: v = center + scale·z. */
export const affine = (center: number, scale: number): Codec1 => ({
  decode: (z) => center + scale * z,
  encode: (v) => (v - center) / scale,
});

/**
 * A ratio to a reference that is usually positive but may pass through zero: v = ref·sinh(scale·z + asinh 1).
 * Exponential-like for positive v (a log ratio), linear through 0, and onto ℝ — a log that reaches zero and
 * the far side of it.
 */
export const ratio = (ref: number, scale: number): Codec1 => ({
  decode: (z) => ref * Math.sinh(scale * z + ASINH1),
  encode: (v) => (Math.asinh(v / ref) - ASINH1) / scale,
});

/** A bounded quantity on (lo, hi): v = lo + (hi − lo)·σ(scale·z + logit c), where c is the centre's fraction. */
export const bounded = (
  lo: number,
  hi: number,
  centerFraction: number,
  scale: number,
): Codec1 => {
  const l0 = logit(centerFraction);
  return {
    decode: (z) => lo + (hi - lo) * sigmoid(scale * z + l0),
    encode: (v) =>
      (logit(clamp((v - lo) / (hi - lo), 1e-3, 1 - 1e-3)) - l0) / scale,
  };
};

/**
 * A quantity on the CLOSED interval [0,1] whose ends are typical values: a logistic stretched to
 * (−cens, 1 + cens) and clamped, taking `at` when z = 0. Many-to-one at the ends; the pre-image `encode`
 * returns for 0 / 1 sits half a unit past where the clamp begins, so a decoded end point re-encodes to the
 * same θ. The larger `cens`, the more probability the ends carry.
 */
export const censored = (at: number, scale: number, cens: number): Codec1 => {
  const w = 1 + 2 * cens,
    center = logit((at + cens) / w),
    lo = logit(cens / w),
    hi = -lo;
  return {
    decode: (z) => clamp(w * sigmoid(scale * z + center) - cens, 0, 1),
    encode: (k) => {
      if (k <= 0) return (lo - center) / scale - 0.5;
      if (k >= 1) return (hi - center) / scale + 0.5;
      return (logit((k + cens) / w) - center) / scale;
    },
  };
};

// ---------- vector transforms ----------
// The orthonormal DCT-II modes on m points: φ_k[i] = c_k·cos(π(i+½)k/m). Mode 0 is the constant vector, so
// modes 1..m−1 span the zero-sum subspace — exactly the gauge-fixed logits of a simplex.
function dctBasis(m: number): number[][] {
  const out: number[][] = [];
  for (let k = 0; k < m; k++) {
    const c = Math.sqrt((k === 0 ? 1 : 2) / m),
      row: number[] = [];
    for (let i = 0; i < m; i++)
      row.push(c * Math.cos((Math.PI * (i + 0.5) * k) / m));
    out.push(row);
  }
  return out;
}

export interface CodecN {
  dim: number;
  decode: (z: number[]) => number[];
  encode: (v: number[]) => number[];
}

/**
 * m values as m cosine-mode coefficients: v_i = Σ_k z_k·σ_k·φ_k[i], σ_k = scale·decay^k. A change of basis
 * — every v is some z — with a prior that keeps the wiggles small.
 */
export function smooth(m: number, scale: number, decay = 0.6): CodecN {
  const phi = dctBasis(m),
    sig = Array.from({ length: m }, (_, k) => scale * Math.pow(decay, k));
  return {
    dim: m,
    decode: (z) =>
      Array.from({ length: m }, (_, i) =>
        z.reduce((a, zk, k) => a + zk * sig[k] * phi[k][i], 0),
      ),
    encode: (v) =>
      phi.map((row, k) => row.reduce((a, p, i) => a + p * v[i], 0) / sig[k]),
  };
}

/**
 * m positive parts summing to 1, as m−1 coefficients of the zero-sum cosine modes of their log-ratios around
 * a centre composition. Softmax is over-parameterized by a shift; dropping mode 0 fixes that gauge.
 */
export function simplex(center: number[], scale: number, decay = 0.6): CodecN {
  const m = center.length,
    phi = dctBasis(m).slice(1),
    sig = Array.from({ length: m - 1 }, (_, k) => scale * Math.pow(decay, k));
  const centered = (p: number[]): number[] => {
    const l = p.map((x) => Math.log(Math.max(x, 1e-12))),
      mean = l.reduce((a, x) => a + x, 0) / m;
    return l.map((x) => x - mean);
  };
  const l0 = centered(center);
  return {
    dim: m - 1,
    decode: (z) => {
      const l = l0.map(
        (b, i) => b + z.reduce((a, zk, k) => a + zk * sig[k] * phi[k][i], 0),
      );
      const e = l.map((x) => Math.exp(x)),
        s = e.reduce((a, x) => a + x, 0);
      return e.map((x) => x / s);
    },
    encode: (p) => {
      const r = centered(p).map((x, i) => x - l0[i]);
      return phi.map(
        (row, k) => row.reduce((a, q, i) => a + q * r[i], 0) / sig[k],
      );
    },
  };
}

/**
 * m non-negative parts summing to 1 by STICK-BREAKING, each break a censored logistic: part i takes a
 * fraction of what is left, and that fraction may be exactly 0 (a zero-length part) or exactly 1 (every
 * later part empty). This is the simplex a flat-bottomed section needs — two points at one depth — which
 * the log-ratio form above can only approach.
 */
export function stick(center: number[], scale: number, cens: number): CodecN {
  const m = center.length,
    codecs: Codec1[] = [];
  let rest = 1;
  for (let i = 0; i < m - 1; i++) {
    codecs.push(censored(clamp(center[i] / rest, 1e-6, 1 - 1e-6), scale, cens));
    rest -= center[i];
  }
  return {
    dim: m - 1,
    decode: (z) => {
      const out: number[] = [];
      let left = 1;
      for (let i = 0; i < m - 1; i++) {
        const p = codecs[i].decode(z[i]) * left;
        out.push(p);
        left -= p;
      }
      out.push(Math.max(left, 0));
      return out;
    },
    encode: (p) => {
      const out: number[] = [];
      let left = 1;
      for (let i = 0; i < m - 1; i++) {
        out.push(left > 1e-12 ? codecs[i].encode(p[i] / left) : 0);
        left -= p[i];
      }
      return out;
    },
  };
}

// ---------- the traversal, in two modes ----------
// `walk` visits every slot of a hull in a fixed order. Decoding, each visit consumes θ-coordinates and returns
// the decoded value; encoding, each visit is handed the hull's actual value, emits its coordinates, and
// returns that same value — so the downstream arithmetic (ratios of what came before) is identical in both
// modes, and the layout of θ is defined once.
interface IO {
  slot: (c: Codec1, current: number, label: string) => number;
  vec: (c: CodecN, current: number[], label: string) => number[];
}

function decoder(theta: readonly number[], labels?: string[]): IO {
  let i = 0;
  const take = (label: string): number => {
    labels?.push(label);
    return theta[i++] ?? 0; // past the end of θ a coordinate reads 0: its centre value
  };
  return {
    slot: (c, _cur, label) => c.decode(take(label)),
    vec: (c, _cur, label) =>
      c.decode(Array.from({ length: c.dim }, (_, k) => take(`${label}[${k}]`))),
  };
}

function encoder(out: number[]): IO {
  return {
    slot: (c, cur) => {
      out.push(c.encode(cur));
      return cur;
    },
    vec: (c, cur) => {
      out.push(...c.encode(cur));
      return cur;
    },
  };
}

// ---------- backbones: the canonical boat the prior is centred on, as shape functions of t ∈ [0,1] ----------
// Shapes, not sizes: every length is a ratio. The sheer dips amidships, the plan is fullest a little aft of
// amidships and fines to the bow, the section turns from steep topsides to a flat run.

// the plan's control polygon, as a fraction of the half-breadth at its middle control point
const planShape = (t: number): number =>
  t <= 0.5
    ? 0.92 + 0.08 * (t / 0.5)
    : Math.max(1 - 1.09 * Math.pow(2 * t - 1, 1.9), 0.02);
// the sheer trim's depth below the deck, as a fraction of its depth at the reference control point: lowest
// at the stern, rising steadily to the bow (the saved designs' median: 1.2 at the stern, 0.7 two-thirds of
// the way forward, 0.15 at the bow)
const trimShape = (t: number): number => 1.2 - 1.05 * Math.pow(t, 1.8);
// a section's depth fractions: the panels get shorter toward the keel
function depthParts(m: number): number[] {
  const raw = Array.from(
    { length: m },
    (_, i) => 1 - (m > 1 ? (0.6 * i) / (m - 1) : 0),
  );
  const s = raw.reduce((a, x) => a + x, 0);
  return raw.map((x) => x / s);
}
// a section's inboard run per panel as a fraction of the reach, for the FREE panels (all but the last): the
// backbone slope dñ/dd̃ rises from near-vertical topsides toward a flat run, times each panel's depth share
function runParts(m: number): number[] {
  const parts = depthParts(m);
  const raw = parts.map(
    (p, i) => p * Math.exp(-1.2 + (m > 2 ? (2.4 * i) / (m - 2) : 0)),
  );
  const s = raw.reduce((a, x) => a + x, 0);
  return raw.map((x) => x / s).slice(0, m - 1);
}
// which section point is the turn of the bilge (where a chine would be)
const bilgeIndex = (S: number): number =>
  clamp(Math.round((S - 1) * 0.55), 1, Math.max(1, S - 2));

/**
 * The largest centerline distance the plan presents to a station plane over u ∈ [u0, u1]: y / T_x at its
 * maximum there (T_x floored so a plan turning across the hull does not blow it up).
 */
export function planReach(
  plan: readonly { x: number; y: number }[],
  u0 = 0,
  u1 = 1,
): number {
  const c = planCurve(plan.map((p) => [p.x, p.y]));
  let r = 0;
  const N = 80;
  for (let i = 0; i <= N; i++) {
    const u = u0 + ((u1 - u0) * i) / N,
      [, y] = c.at(u),
      [dx, dy] = c.d(u),
      tx = Math.abs(dx) / (Math.hypot(dx, dy) || 1);
    r = Math.max(r, y / Math.max(tx, 0.5));
  }
  return r || 1;
}

// ---------- the codec ----------
export interface HullCodec {
  /** The number of coordinates. */
  readonly dim: number;
  /** A name per coordinate, in θ order. */
  readonly labels: readonly string[];
  /** The hull at θ. Any finite θ decodes to a hull that passes the document invariants. */
  decode: (theta: readonly number[]) => HullState;
  /** The θ of a hull with the base's control-point counts. */
  encode: (hull: HullState) => number[];
}

/**
 * Build the coordinate system for hulls shaped like `base`: the same control-point counts (plan, trim,
 * stations, points per station), the same unit, and sizes stated relative to the base's length. θ = 0 is
 * the canonical boat at that length.
 */
export function createHullCodec(base: HullState): HullCodec {
  const P = base.sheerPlan.length,
    Q = base.sheerTrim.length,
    K = base.stations.length,
    S = base.stations[0].points.length,
    Lref = loa(base) || 1,
    unit = base.unit;
  const midPlan = Math.floor((P - 1) / 2), // the control point the beam is read at
    refTrim = Math.floor((Q - 1) / 2); // the control point the sheer depth is read at
  const tPlan = (i: number): number => i / (P - 1),
    tTrim = (i: number): number => i / (Q - 1);
  const DEG = Math.PI / 180;
  const uniform = (m: number): number[] => new Array(m).fill(1 / m);

  const walk = (io: IO, h: HullState): HullState => {
    // ---- size and the principal ratios ----
    const L = io.slot(positive(Lref, 0.15), loa(h), "L");
    const yMidH = h.sheerPlan[midPlan].y;
    const LB = io.slot(positive(3.5, 0.4), L / (2 * yMidH), "L/B");
    const yMid = L / (2 * LB),
      B = 2 * yMid;
    const aftPts = h.stations[0].points,
      Dh = aftPts[0].z - aftPts[aftPts.length - 1].z; // the aft station's depth, deck point to keel point
    const BD = io.slot(positive(1.8, 0.3), B / Dh, "B/D");
    const D = B / BD;
    const tau = io.slot(
      positive(0.23, 0.35),
      -h.sheerTrim[refTrim].z / D,
      "sheer/D",
    );
    const dRef = tau * D;
    const deckTrim = io.slot(affine(0, 0.5 * DEG), h.deckTrim, "deckTrim");

    // ---- the sheer plan ----
    const x0 = io.slot(affine(0, 0.02 * L), h.sheerPlan[0].x, "plan.x0");
    const gaps = io.vec(
      simplex(uniform(P - 1), 0.5),
      h.sheerPlan.slice(1).map((p, i) => (p.x - h.sheerPlan[i].x) / loa(h)),
      "plan.dx",
    );
    const planX: number[] = [x0];
    for (let i = 1; i < P; i++) planX.push(planX[i - 1] + gaps[i - 1] * L);
    // the ends are free: a transom stern is at ~0.6 of the beam, a double-ender's at 0; a bow is at 0, an
    // inverted bow's plan crosses the centerline. The interior points are ratios to the middle one.
    const yStern =
      yMid *
      io.slot(affine(0.6, 0.35), h.sheerPlan[0].y / yMidH, "plan.yStern");
    const yIdx: number[] = [];
    for (let i = 1; i < P - 1; i++) if (i !== midPlan) yIdx.push(i);
    const yBack = yIdx.map(
      (i) => planShape(tPlan(i)) / planShape(tPlan(midPlan)),
    );
    const yRes = io.vec(
      smooth(yIdx.length, 0.3),
      yIdx.map((i, k) => ratio(yBack[k], 1).encode(h.sheerPlan[i].y / yMidH)),
      "plan.y",
    );
    const yBow = io.slot(
      affine(0, 0.03 * B),
      h.sheerPlan[P - 1].y,
      "plan.yBow",
    );
    const planY = new Array<number>(P).fill(yMid);
    planY[0] = yStern;
    yIdx.forEach(
      (i, k) => (planY[i] = yMid * ratio(yBack[k], 1).decode(yRes[k])),
    );
    planY[P - 1] = yBow;
    const sheerPlan = planX.map((x, i) => ({ x, y: planY[i] }));

    // ---- the sheer trim ----
    const hTrimLen = h.sheerTrim[Q - 1].x - h.sheerTrim[0].x;
    const tx0 = io.slot(affine(0, 0.02 * L), h.sheerTrim[0].x, "trim.x0");
    const tLen = L * io.slot(positive(1, 0.05), hTrimLen / loa(h), "trim.len");
    const tGaps = io.vec(
      simplex(uniform(Q - 1), 0.3),
      h.sheerTrim.slice(1).map((p, i) => (p.x - h.sheerTrim[i].x) / hTrimLen),
      "trim.dx",
    );
    const trimX: number[] = [tx0];
    for (let i = 1; i < Q; i++) trimX.push(trimX[i - 1] + tGaps[i - 1] * tLen);
    const dIdx: number[] = [];
    for (let i = 0; i < Q; i++) if (i !== refTrim) dIdx.push(i);
    const dBack = dIdx.map(
      (i) => trimShape(tTrim(i)) / trimShape(tTrim(refTrim)),
    );
    const dRefH = -h.sheerTrim[refTrim].z;
    const dRes = io.vec(
      smooth(dIdx.length, 0.35),
      dIdx.map((i, k) => ratio(dBack[k], 1).encode(-h.sheerTrim[i].z / dRefH)),
      "trim.depth",
    );
    const trimD = new Array<number>(Q).fill(dRef);
    dIdx.forEach(
      (i, k) => (trimD[i] = dRef * ratio(dBack[k], 1).decode(dRes[k])),
    );
    const sheerTrim = trimX.map((x, i) => ({
      x,
      z: -trimD[i],
      k: io.slot(censored(0, 1, 0.25), h.sheerTrim[i].k, `trim.k${i}`),
    }));

    // ---- the transom: its top against the sheer at the stern, its foot against the aft depth ----
    const [hTop, hBot] = h.transom;
    const xt = io.slot(affine(0.01 * L, 0.015 * L), hTop.x, "transom.x");
    // the top sits a little above the sheer at the stern (often at the deck), the foot well below the hull
    const dTop =
      trimD[0] +
      D *
        io.slot(
          affine(-0.17, 0.25),
          (-hTop.z + h.sheerTrim[0].z) / Dh,
          "transom.top",
        );
    const dd =
      D * io.slot(positive(1.25, 0.4), (hTop.z - hBot.z) / Dh, "transom.drop");
    const rake = io.slot(
      affine(-0.15, 0.2),
      (hBot.x - hTop.x) / (hBot.z - hTop.z || 1),
      "transom.rake",
    );
    const zTop = -dTop,
      zBot = zTop - dd;
    const transom = [
      { x: xt, z: zTop },
      { x: xt + rake * (zBot - zTop), z: zBot },
    ];

    // ---- the stations ----
    let us: number[];
    if (K === 1)
      us = [io.slot(bounded(0, 1, 0.5, 1.5), h.stations[0].u, "station.u")];
    else {
      const hu = h.stations.map((s) => s.u),
        hSpan = hu[K - 1] - hu[0] || 1;
      const uGaps = io.vec(
        simplex(uniform(K - 1), 0.45),
        hu.slice(1).map((u, j) => (u - hu[j]) / hSpan),
        "station.du",
      );
      us = [0];
      for (let j = 1; j < K; j++) us.push(us[j - 1] + uGaps[j - 1]);
      us[K - 1] = 1;
    }
    // the stretch of hull each station governs: halfway to its neighbours, the whole hull for one station
    const zone = (j: number): [number, number] => [
      j === 0 ? 0 : (us[j - 1] + us[j]) / 2,
      j === K - 1 ? 1 : (us[j] + us[j + 1]) / 2,
    ];
    const parts0 = depthParts(S - 1),
      runs0 = runParts(S - 1),
      bilge = bilgeIndex(S);
    const stations = h.stations.map((hs, j) => {
      const hp = hs.points,
        hDepth = hp[0].z - hp[S - 1].z,
        hReach = hp[S - 1].n - hp[0].n || 1e-9 * loa(h);
      const Dj =
        j === 0
          ? D
          : D *
            Math.exp(
              io.slot(
                affine((0.2 * j) / (K - 1), 0.2),
                Math.log(hDepth / Dh),
                `st${j}.depth`,
              ),
            );
      const [za, zb] = zone(j);
      // ρ through `ratio`, not `positive`: a double-ender's end station is a point on the centerline, so its
      // keel reach can be zero or even outboard
      const nKeel =
        planReach(sheerPlan, za, zb) *
        io.slot(
          ratio(1.18, 0.045),
          hp[S - 1].n / planReach(h.sheerPlan, za, zb),
          `st${j}.reach`,
        );
      const n0 = io.slot(affine(0, 0.01 * B), hp[0].n, `st${j}.n0`);
      const z0 = io.slot(affine(0, 0.01 * D), hp[0].z, `st${j}.z0`);
      const reach = nKeel - n0;
      // each panel's share of the depth, by stick-breaking (a level panel is a share of exactly 0)
      const parts = io.vec(
        stick(parts0, 0.6, 0.08),
        hp.slice(1).map((p, i) => clamp((hp[i].z - p.z) / hDepth, 0, 1)),
        `st${j}.dz`,
      );
      // each free panel's inboard run as a fraction of the reach, a ratio to its backbone; the last panel
      // runs to the keel point
      const runRes = io.vec(
        smooth(S - 2, 0.5),
        hp
          .slice(1, S - 1)
          .map((p, i) => ratio(runs0[i], 1).encode((p.n - hp[i].n) / hReach)),
        `st${j}.run`,
      );
      const points: { n: number; z: number; k: number }[] = [
        { n: n0, z: z0, k: 1 },
      ];
      let dn = 0,
        dz = 0;
      for (let i = 1; i < S; i++) {
        dz += parts[i - 1];
        dn = i < S - 1 ? dn + ratio(runs0[i - 1], 1).decode(runRes[i - 1]) : 1;
        const k =
          i < S - 1
            ? io.slot(
                censored(i === bilge ? 0.25 : 0.1, 1.2, 1),
                hp[i].k,
                `st${j}.k${i}`,
              )
            : 1;
        points.push({
          n: n0 + dn * reach,
          z: z0 - dz * Dj,
          k: stationKnuckle(S, i, k),
        });
      }
      const keelK = io.slot(censored(0, 1, 1), hs.keelK, `st${j}.keelK`);
      return { u: us[j], keelK, points };
    });

    // ---- the waterline: a fraction of the way from the lowest sheer down to the emergent keel ----
    // Stated last, against the shape, so that any draw floats with its deck dry. The keel it is measured
    // against is where a station's polyline crosses the centerline — the depth the sweep actually reaches —
    // not the keel point, which lies past the centerline by the reach margin ρ and can sit well below the
    // hull.
    // the lowest point of the sheer in WORLD height, with the deck trim applied — the waterline must sit
    // below it for the deck to stay dry
    const cT = Math.cos(deckTrim),
      sT = Math.sin(deckTrim);
    const sheerMax = Math.max(...trimD.map((d, i) => d * cT - trimX[i] * sT));
    const pc = planCurve(sheerPlan.map((p) => [p.x, p.y]));
    let keelDepth = 0;
    for (const st of stations) {
      const [, y] = pc.at(st.u),
        [dx, dy] = pc.d(st.u),
        tx = Math.abs(dx) / (Math.hypot(dx, dy) || 1),
        nC = y / Math.max(tx, 0.05);
      const pts = st.points;
      let z = pts[S - 1].z; // an open section: the keel point itself
      for (let i = 1; i < S; i++)
        if (pts[i].n >= nC) {
          const f = (nC - pts[i - 1].n) / (pts[i].n - pts[i - 1].n || 1);
          z = pts[i - 1].z + clamp(f, 0, 1) * (pts[i].z - pts[i - 1].z);
          break;
        }
      keelDepth = Math.max(keelDepth, -z);
    }
    const wlLo = sheerMax,
      wlHi = Math.max(keelDepth, 1.5 * sheerMax);
    const waterline = io.slot(
      bounded(wlLo, wlHi, 0.65, 1.2),
      h.waterline,
      "waterline",
    );

    return {
      name: "",
      unit,
      sheerPlan,
      sheerTrim,
      transom,
      stations,
      waterline,
      deckTrim,
    };
  };

  const labels: string[] = [];
  walk(decoder([], labels), base);
  return {
    dim: labels.length,
    labels,
    decode: (theta) => walk(decoder(theta), base),
    encode: (hull) => {
      if (
        hull.sheerPlan.length !== P ||
        hull.sheerTrim.length !== Q ||
        hull.stations.length !== K ||
        hull.stations.some((s) => s.points.length !== S)
      )
        throw new Error(
          "encode: the hull's control-point counts differ from the codec's base",
        );
      const out: number[] = [];
      walk(encoder(out), hull);
      return out;
    },
  };
}

// ---------- sampling ----------
/** A standard normal from a uniform source, by Box–Muller. */
export function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12),
    v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Variants of a design: its own θ plus a small step in every coordinate, with three things held. The length
 * and the deck trim stay (a variant is the same boat explored, not a different size or a different floating
 * attitude), and no station's keel reach drops below
 * the design's own — a design that only just closes would otherwise be opened by half the draws, and
 * "variants of this boat" should not include ones whose bottom falls out. Decode the result with the same
 * codec that produced `theta0`.
 */
export function sampleAround(
  codec: HullCodec,
  theta0: readonly number[],
  rng: () => number,
  temperature = 0.5,
): number[] {
  const th = sampleTheta(codec.dim, rng, temperature, theta0);
  codec.labels.forEach((label, k) => {
    // the length and the deck trim are not shape: one is the boat's size, the other how it floats
    if (label === "L" || label === "deckTrim") th[k] = theta0[k];
    else if (label.endsWith(".reach")) th[k] = Math.max(th[k], theta0[k]);
  });
  return th;
}

/**
 * θ ~ N(mean, (temperature·sd)²) coordinate-wise. With no mean / sd this is the canonical prior around the
 * codec's own centres: `temperature` 0 is the canonical boat, 1 the intended spread, larger ranges further.
 */
export function sampleTheta(
  dim: number,
  rng: () => number,
  temperature = 1,
  mean?: readonly number[],
  sd?: readonly number[],
): number[] {
  return Array.from(
    { length: dim },
    (_, i) => (mean?.[i] ?? 0) + temperature * (sd?.[i] ?? 1) * gaussian(rng),
  );
}
