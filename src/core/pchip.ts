// ---------- monotone cubic Hermite (PCHIP) — interpolates without overshoot (used for the stations) ----------

// We implement two flavors of Piecewise Cubic Hermite Interpolating Polynomial
// (PCHIP), both of them providing monotone cubic interpolation.
//
// 1. "Fritsch–Carlson" is the classic monotone cubic interpolation approach:
//
//     https://en.wikipedia.org/wiki/Monotone_cubic_interpolation
//
//     The output is a series of per-knot slopes, whose hermite evaluation gives
//     a function y(x) which is C¹ as a function of x.
//
//     However, the Fritsch–Carlson algorithm itself is a function from its knot
//     values [..., [xi, yi], ...] to the slopes [..., mi, ...], and this
//     function is only C⁰ due to the hard branch switches, e.g.:
//
//       if (a * b <= 0) m[i] = 0   (=> in the domain where a * b <= 0, the
//                                      algorithm's gradient is null as a
//                                      function of the input knots)
//
//       else { ... }               (=> in the domain where a * b > 0, the
//                                      algorithm's gradient is non-null)
//
//    This means that if you generate a curve C(u) by first blending together
//    multiple sets of knots, then evaluating at a fixed x the Fritsch–Carlson
//    interpolation of the blended knots [..., [xi(u), yi(u)], ...] , the
//    resulting curve C(u) will only be C⁰. This is what would happen to
//    longitudinal lines (and therefore also the sheer line) of our hull model
//    with blended stations.
//
// 2. "C2-Fritsch–Carlson" is a new variant which is C² as a function of its
//    knot values. This is achieved by adding a smooth quintic ramp to ease out
//    the "else cases" into m[i] = 0, and still preserving the monotonicity
//    guarantee.
//
type PchipVariant = "Fritsch-Carlson" | "C2-Fritsch-Carlson";
const PCHIP_VARIANT: PchipVariant = "C2-Fritsch-Carlson";

/**
 * An ease-in function from 0 to 1 with:
 *
 * y(0) = 0, y'(0) = 0, y''(0) = 0
 * y(1) = 1, y'(1) = 1, y''(1) = 0
 */
export function c2EaseIn(q: number): number {
  return q * q * q * (6 + q * (3 * q - 8));
}

/**
 * An ease-in ease-out function from 0 to 1 with:
 *
 * y(0) = 0, y'(0) = 0, y''(0) = 0
 * y(1) = 1, y'(1) = 0, y''(1) = 0
 */
export function c2EaseInOut(q: number): number {
  return q * q * q * (10 + q * (6 * q - 15));
}

// Fraction of the secant RATIO over which an interior slope is faded to zero (see pchipSlopes): once the
// smaller adjacent secant drops under MID_EASE× the larger, the harmonic mean is scaled by a C² fade so
// it reaches the zeroed opposite-sign branch with matching value, slope and curvature. Must stay < 1 (the
// fade's clamp then also hides the min/max switch at equal secants inside the identity region).
const MID_EASE = 0.25;

export function pchipSlopes(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const h = Array(n - 1);
  const d = Array(n - 1);
  const m = Array(n);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  if (n === 1) return [0];
  if (n === 2) return [d[0], d[0]];
  for (let i = 1; i < n - 1; i++) {
    const a = d[i - 1];
    const b = d[i];
    if (a * b <= 0) {
      // Case 1: opposite-sign secants. The slope must be zero to avoid
      // overshoot.
      m[i] = 0;
    } else {
      // Case 2: same-sign secants. We compute the slope as a weighted harmonic
      // mean of the two secants, which is guaranteed to be monotone-safe.
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      let mi = (w1 + w2) / (w1 / a + w2 / b); // weighted harmonic mean (Fritsch–Carlson)
      if (PCHIP_VARIANT === "C2-Fritsch-Carlson") {
        // The weighted harmonic mean converges to 0 as either secant converges
        // to 0, but it arrives with a nonzero slope while the opposite-sign
        // branch (Case 1) sits at exactly 0, so as is there would be a C¹
        // discontinuity when a*b crosses the sign boundary. We make it C² by
        // applying an easing function to smoothly transition between the two
        // branches:
        // - For balanced secants (r >= MID_EASE), we leave `mi` as is
        // - For unbalanced secants, we ease `mi` down to 0 as the smaller
        //   secant approaches 0, with C² contact at r = 0 and r = MID_EASE
        //
        // If both secants approach 0 together with their ratio not approaching
        // zero, then there is still a C² discontinuity. This one is unavoidable
        // given our desiderata (zero slope if any of the secants is zero, and
        // secant slope if both secants are equal), and is unlikely to happen by
        // chance while blending knots.
        const r =
          Math.min(Math.abs(a), Math.abs(b)) /
          Math.max(Math.abs(a), Math.abs(b));
        if (r < MID_EASE) {
          const q = r / MID_EASE;
          mi *= c2EaseInOut(q);
        }
      }
      m[i] = mi;
    }
  }
  m[0] = pchipEnd(h[0], h[1], d[0], d[1]);
  m[n - 1] = pchipEnd(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

// Natural cubic spline tangents (second derivative = 0 at both ends): C² across all knots, unlike the
// C¹ PCHIP above. Returns the first-derivative at each knot so the same `hermiteEval` reproduces the
// curve. Not shape-preserving — it can overshoot — so it is only used in spaces where overshoot is
// harmless (the logit pre-image of the weight simplex) or where curvature continuity is wanted over the
// monotonicity guarantee (the optional C² station fairing).
export function naturalCubicSlopes(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  if (n === 1) return [0];
  const h = Array(n - 1),
    d = Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  if (n === 2) return [d[0], d[0]]; // two points → straight line
  // solve the tridiagonal system for the second derivatives M (M[0] = M[n-1] = 0, the natural BC)
  const M = Array(n).fill(0),
    b = Array(n).fill(0),
    r = Array(n).fill(0);
  for (let i = 1; i <= n - 2; i++) {
    b[i] = (h[i - 1] + h[i]) / 3;
    r[i] = d[i] - d[i - 1];
  }
  for (let i = 2; i <= n - 2; i++) {
    const w = h[i - 1] / 6 / b[i - 1];
    b[i] -= w * (h[i - 1] / 6);
    r[i] -= w * r[i - 1];
  }
  for (let i = n - 2; i >= 1; i--) M[i] = (r[i] - (h[i] / 6) * M[i + 1]) / b[i];
  // first derivatives at the knots, recovered from the second derivatives
  const m = Array(n);
  for (let i = 0; i < n - 1; i++)
    m[i] = d[i] - (h[i] * (2 * M[i] + M[i + 1])) / 6;
  m[n - 1] = d[n - 2] + (h[n - 2] * (2 * M[n - 1] + M[n - 2])) / 6;
  return m;
}

// Fraction of the monotone-safe box eased at each bound by pchipEnd (must stay
// ≤ 1/3: the zones must not overlap, and the untouched middle must cover
// everything reachable with same-sign secants, m/d0 < 2).
const END_EASE = 0.25;

// The three-point end slope, saturated into the monotone-safe box [0, 3·d0]
// (sign-mirrored for d0 < 0). The original Fritsch–Carlson does this as a hard
// clamp: zero the slope on a sign mismatch with the first secant, cut it at
// 3·d0. The C2 variant keeps the same box (identity in the middle, exactly 0 /
// 3·d0 outside it) but apply a C² ease across the END_EASE-wide zone inside
// each bound.
function pchipEnd(h0: number, h1: number, d0: number, d1: number): number {
  const m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1),
    s = 3 * d0;
  if (s === 0) return 0;
  const t = m / s; // position in the monotone-safe box, normalized to [0, 1]
  if (t <= 0) return 0;
  if (t >= 1) return s;
  if (PCHIP_VARIANT === "C2-Fritsch-Carlson") {
    if (t < END_EASE) return s * END_EASE * c2EaseIn(t / END_EASE);
    if (t > 1 - END_EASE)
      return s * (1 - END_EASE * c2EaseIn((1 - t) / END_EASE));
  }
  return m;
}

// per-point left/right tangents for a "knuckled" monotone curve. k[i] ∈ [0,1] blends the smooth PCHIP
// tangent toward the one-sided secants: k=0 → C¹ smooth (plain PCHIP); k=1 → the point's two sides take
// their own secants, so an isolated k=1 is a knuckle and two adjacent k=1 points bound a straight segment.
// End points have a single side — the first only a right secant, the last only a left — so an end-point
// knuckle bends just the one segment that touches it; e.g. k=1 on the last (keel) point pulls the final
// segment's arrival tangent onto the chord, so a hard chine can run straight into the keel. Both blend
// ends (the PCHIP slope and the secant) are sign-consistent and within the Fritsch–Carlson monotonicity
// box, so blending toward the secant only tightens monotonicity — every k stays monotone-safe, the swept
// section never curls back on itself. k=0 leaves the smooth PCHIP slope untouched (so the default and any
// interior point behave exactly as before).
export function knuckleSlopes(
  xs: number[],
  ys: number[],
  ks: number[],
): { L: number[]; R: number[] } {
  const n = xs.length,
    m = pchipSlopes(xs, ys),
    L = m.slice(),
    R = m.slice();
  for (let i = 0; i < n; i++) {
    const k = Math.min(Math.max(ks[i] ?? 0, 0), 1);
    if (k === 0) continue;
    if (i > 0)
      L[i] = m[i] + ((ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]) - m[i]) * k; // toward left secant
    if (i < n - 1)
      R[i] = m[i] + ((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - m[i]) * k; // toward right secant
  }
  return { L, R };
}

// Hermite eval with independent left/right tangents per point: segment [i,i+1] uses the RIGHT tangent at i
// and the LEFT tangent at i+1, so a per-point tangent jump shows up as a knuckle.
export function hermiteEvalLR(
  xs: number[],
  ys: number[],
  L: number[],
  R: number[],
  tt: number,
): number {
  let i = 0;
  while (i < xs.length - 2 && tt > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i],
    t = (tt - xs[i]) / h,
    t2 = t * t,
    t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1,
    h10 = t3 - 2 * t2 + t,
    h01 = -2 * t3 + 3 * t2,
    h11 = t3 - t2;
  return h00 * ys[i] + h10 * h * R[i] + h01 * ys[i + 1] + h11 * h * L[i + 1];
}

export function hermiteEval(
  xs: number[],
  ys: number[],
  m: number[],
  tt: number,
): number {
  let i = 0;
  while (i < xs.length - 2 && tt > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i],
    t = (tt - xs[i]) / h,
    t2 = t * t,
    t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1,
    h10 = t3 - 2 * t2 + t,
    h01 = -2 * t3 + 3 * t2,
    h11 = t3 - t2;
  return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
}
