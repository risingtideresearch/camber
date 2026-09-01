// ---------- an uncertain, dimensioned number ----------
//
// Every value in a weight sheet carries three things: what it is, how wrong it might be, and what it is
// measured in. The middle one is the interesting one, and it is carried as a GRADIENT — ∂v/∂xᵢ for each
// uncertain input the value depends on — rather than as an interval.
//
// Two reasons, and the second is the one that earns it:
//
//   • Intervals get repeated variables wrong. `x − x` comes out non-zero under interval arithmetic, and a
//     weight estimate does that constantly (a margin stated as a fraction of a total the item is itself in).
//     A gradient cancels exactly, because the coefficients add — see `combine`.
//
//   • Intervals cannot say WHICH guess is driving the spread. A gradient can: the contribution of each
//     source is |∂f/∂xᵢ|·rᵢ, so one evaluation ranks the inputs by how much of the uncertainty each one
//     owns. That is the reading that tells a designer which number to go and improve, and it is worth more
//     than the bound itself.
//
// One evaluation then yields three readings (see `read`): the worst case, the root-sum-square likely case,
// and the ranking. Nothing is evaluated twice to get them.
//
// ---------- what this is NOT ----------
//
// The propagation is FIRST ORDER. It is exact for +, − and scaling, and a linearization everywhere else: a
// product of two ±10% inputs reads as ±20% where the true interval is +21%/−19%. At estimating tolerances
// the difference is far below the honesty of the inputs, but it means `worst` is not a rigorous bound and
// must not be presented as one. `test/quantity.ts` pins the size of that error against Monte Carlo.
//
// It also assumes the sources are INDEPENDENT wherever it takes a root-sum-square. Real estimating bias is
// correlated — someone systematically optimistic is wrong the same way everywhere — which is exactly why
// both readings are reported rather than one: the truth sits between them and no arithmetic settles where.

// ---------- dimensions ----------
// Mass and length exponents, which is everything a weight sheet needs: kg is (1, 0), m² is (0, 2), a density
// in kg/m² is (1, −2), and a form coefficient is (0, 0). A third exponent (cost, say) would be one more field
// and three more lines below.

export interface Dim {
  readonly m: number;
  readonly l: number;
}

export const DIMLESS: Dim = { m: 0, l: 0 };
export const MASS: Dim = { m: 1, l: 0 };
export const LENGTH: Dim = { m: 0, l: 1 };
export const AREA: Dim = { m: 0, l: 2 };
export const VOLUME: Dim = { m: 0, l: 3 };

export const sameDim = (a: Dim, b: Dim): boolean => a.m === b.m && a.l === b.l;
export const addDim = (a: Dim, b: Dim): Dim => ({
  m: a.m + b.m,
  l: a.l + b.l,
});
export const subDim = (a: Dim, b: Dim): Dim => ({
  m: a.m - b.m,
  l: a.l - b.l,
});
export const scaleDim = (a: Dim, k: number): Dim => ({
  m: a.m * k,
  l: a.l * k,
});
export const isDimless = (a: Dim): boolean => a.m === 0 && a.l === 0;

/** A dimension as a person reads it: `kg·m⁻²`, or `—` for a pure number. */
export function dimLabel(dim: Dim): string {
  if (isDimless(dim)) return "—";
  const part = (symbol: string, exp: number): string =>
    exp === 0 ? "" : exp === 1 ? symbol : `${symbol}^${exp}`;
  return [part("kg", dim.m), part("m", dim.l)].filter(Boolean).join("·");
}

// ---------- sources ----------

/**
 * One uncertain input, as the sheet declares it.
 *
 * `lo` and `hi` are how far BELOW and ABOVE the nominal the input may fall, both non-negative. Two numbers
 * rather than a ±, because a real tolerance is often one-sided — the lightship is known and the gear piled on
 * top of it is not — and because the stability panel's own tolerance is already shaped that way.
 *
 * Nothing here says what confidence the numbers describe, and nothing needs to: see `read`.
 */
export interface Source {
  readonly id: string;
  /** What the sensitivity list calls it. The row it was typed in, which is why rows have names. */
  readonly label: string;
  /**
   * An OPAQUE handle on the cell the `±` was typed in, for a reader that wants to go there rather than
   * only read the name. A plain string because nothing at this layer knows what a cell is: the evaluator puts
   * its own `cellKey` in, and is the only thing that takes it back out again.
   */
  readonly at?: string;
  readonly lo: number;
  readonly hi: number;
}

export type SourceTable = ReadonlyMap<string, Source>;

// ---------- the value ----------

/** Signed ∂v/∂xᵢ per source. A coefficient that reaches exactly zero is DROPPED, never stored as 0. */
export type Gradient = Readonly<Record<string, number>>;

export interface Quantity {
  /** The stated nominal — what the user believes, not the midpoint of a range. */
  readonly v: number;
  readonly d: Gradient;
  readonly dim: Dim;
}

export const EMPTY_GRADIENT: Gradient = Object.freeze({});

/**
 * ka·a + kb·b over two sparse gradients.
 *
 * Every rule below is one call to this, which is the whole engine. The `delete` matters: a coefficient that
 * cancels exactly must LEAVE the gradient rather than sit in it as a zero, or `x − x` would keep claiming to
 * depend on x and would be reported with a spread it does not have.
 */
export function combine(
  a: Gradient,
  ka: number,
  b: Gradient,
  kb: number,
): Gradient {
  const out: Record<string, number> = {};
  for (const k in a) {
    const c = ka * a[k];
    if (c !== 0) out[k] = c;
  }
  for (const k in b) {
    const c = (out[k] ?? 0) + kb * b[k];
    if (c !== 0) out[k] = c;
    else delete out[k];
  }
  return out;
}

const scaleGradient = (a: Gradient, k: number): Gradient =>
  combine(a, k, EMPTY_GRADIENT, 0);

// ---------- constructors ----------

/**
 * A dimensionless value read as a quantity of `dim`, `factor` base units to the one it was written in.
 *
 * The gradient scales with the value, which is what keeps `2 ± 0.1` in a row of metres uncertain by 0.1 m
 * rather than by 0.1 of nothing — the source keeps the reach as WRITTEN, and the coefficient carries the
 * conversion.
 */
export const stampUnit = (q: Quantity, factor: number, dim: Dim): Quantity => ({
  v: q.v * factor,
  d: combine(q.d, factor, EMPTY_GRADIENT, 0),
  dim,
});

/** A number known exactly: a literal the user typed without a ±, or a measurement off the hull. */
export const exact = (v: number, dim: Dim = DIMLESS): Quantity => ({
  v,
  d: EMPTY_GRADIENT,
  dim,
});

/**
 * A new INDEPENDENT uncertain input. The only door uncertainty comes through: every `±` literal in a sheet
 * makes one of these, and everything downstream inherits its gradient rather than inventing more.
 */
export const uncertain = (
  v: number,
  source: Source,
  dim: Dim = DIMLESS,
): Quantity => ({ v, d: { [source.id]: 1 }, dim });

/** Whether anything at all could move this value. */
export const isExact = (q: Quantity): boolean => Object.keys(q.d).length === 0;

// ---------- errors ----------
// A formula that cannot be evaluated is a per-row message, never a throw: half-written lines are a normal
// state for a sheet to be in, and one bad row must not take the others down with it.

export class QuantityError extends Error {}

const fail = (message: string): never => {
  throw new QuantityError(message);
};

const requireSameDim = (a: Quantity, b: Quantity, what: string): Dim => {
  if (sameDim(a.dim, b.dim)) return a.dim;
  // One side being a PLAIN NUMBER is the common case and has an obvious fix, so it gets said: a row that
  // declares a unit reads the plain numbers in its outermost sum in that unit (see `formula.ts`), so
  // `HULL.LCB + 2` works the moment the row says `m`. Saying only "the units do not match" would leave the
  // reader looking for a mistake in the formula, where the fix is in the column beside it.
  const bare = isDimless(a.dim) || isDimless(b.dim);
  const said = `cannot ${what} ${dimLabel(a.dim)} and ${dimLabel(b.dim)} — the units do not match`;
  return fail(
    bare
      ? `${said}. Give this row a unit and the plain number will be read in it`
      : said,
  );
};

// ---------- the algebra ----------
// Each binary rule is `combine(a.d, ∂f/∂a, b.d, ∂f/∂b)`. Nothing else is going on.

export const add = (a: Quantity, b: Quantity): Quantity => ({
  v: a.v + b.v,
  d: combine(a.d, 1, b.d, 1),
  dim: requireSameDim(a, b, "add"),
});

export const sub = (a: Quantity, b: Quantity): Quantity => ({
  v: a.v - b.v,
  d: combine(a.d, 1, b.d, -1),
  dim: requireSameDim(a, b, "subtract"),
});

export const mul = (a: Quantity, b: Quantity): Quantity => ({
  v: a.v * b.v,
  d: combine(a.d, b.v, b.d, a.v),
  dim: addDim(a.dim, b.dim),
});

export const div = (a: Quantity, b: Quantity): Quantity => {
  // A divisor whose range straddles zero has no linearization worth reporting — the result's spread is
  // unbounded — so it is refused rather than returned as a very large number.
  if (b.v === 0) fail("division by zero");
  return {
    v: a.v / b.v,
    d: combine(a.d, 1 / b.v, b.d, -a.v / (b.v * b.v)),
    dim: subDim(a.dim, b.dim),
  };
};

export const neg = (a: Quantity): Quantity => ({
  v: -a.v,
  d: scaleGradient(a.d, -1),
  dim: a.dim,
});

/**
 * The chain rule for a one-argument function: supply f(a) and f′(a).
 *
 * Exported because it is also the door a NUMERICALLY differentiated builtin comes through. When a geometry
 * function eventually depends on an uncertain displacement — "float the hull to the estimated mass, then
 * measure its wetted area" — its derivative comes off a finite difference on the flotation solve, and
 * nothing here needs to know that.
 */
export const lift = (
  v: number,
  dim: Dim,
  a: Quantity,
  dfda: number,
): Quantity => ({ v, dim, d: scaleGradient(a.d, dfda) });

/** Raise to a power. The two cases differ in what the exponent is allowed to be — see below. */
export function pow(a: Quantity, n: Quantity): Quantity {
  if (!isDimless(n.dim))
    fail(`an exponent must be a plain number, not ${dimLabel(n.dim)}`);

  if (!isDimless(a.dim)) {
    // A DIMENSIONED base raised to an uncertain power has no dimension at all — m^(2±0.1) is not a unit — so
    // the exponent has to be exact, and it has to be one the dimension can actually be raised to.
    if (!isExact(n))
      fail(
        `${dimLabel(a.dim)} cannot be raised to an uncertain power — the result would have no units`,
      );
    if (a.v < 0 && !Number.isInteger(n.v))
      fail("a negative number has no real fractional power");
    const v = Math.pow(a.v, n.v);
    const dfda = n.v * Math.pow(a.v, n.v - 1);
    return { v, dim: scaleDim(a.dim, n.v), d: scaleGradient(a.d, dfda) };
  }

  // A dimensionless base takes anything, including an uncertain exponent.
  if (a.v < 0 && !Number.isInteger(n.v))
    fail("a negative number has no real fractional power");
  const v = Math.pow(a.v, n.v);
  const dfda = a.v === 0 ? 0 : n.v * Math.pow(a.v, n.v - 1);
  const dfdn = a.v > 0 ? v * Math.log(a.v) : 0;
  return { v, dim: DIMLESS, d: combine(a.d, dfda, n.d, dfdn) };
}

export function sqrt(a: Quantity): Quantity {
  if (a.v < 0) fail("the square root of a negative number");
  if (a.dim.m % 2 !== 0 || a.dim.l % 2 !== 0)
    fail(`${dimLabel(a.dim)} has no square root as a unit`);
  const v = Math.sqrt(a.v);
  return lift(v, scaleDim(a.dim, 0.5), a, v === 0 ? 0 : 0.5 / v);
}

export const abs = (a: Quantity): Quantity =>
  a.v >= 0 ? a : lift(-a.v, a.dim, a, -1);

const dimlessOnly = (a: Quantity, name: string): void => {
  if (!isDimless(a.dim))
    fail(`${name} needs a plain number, not ${dimLabel(a.dim)}`);
};

export function exp(a: Quantity): Quantity {
  dimlessOnly(a, "exp");
  const v = Math.exp(a.v);
  return lift(v, DIMLESS, a, v);
}

export function ln(a: Quantity): Quantity {
  dimlessOnly(a, "ln");
  if (a.v <= 0) fail("the logarithm of a non-positive number");
  return lift(Math.log(a.v), DIMLESS, a, 1 / a.v);
}

export function log10(a: Quantity): Quantity {
  dimlessOnly(a, "log10");
  if (a.v <= 0) fail("the logarithm of a non-positive number");
  return lift(Math.log10(a.v), DIMLESS, a, 1 / (a.v * Math.LN10));
}

// The trig takes DEGREES, because every angle a designer types into this sheet is in degrees and a sheet that
// silently wanted radians would be a trap. The chain rule carries the conversion.
const DEG = Math.PI / 180;

export function sin(a: Quantity): Quantity {
  dimlessOnly(a, "sin");
  return lift(Math.sin(a.v * DEG), DIMLESS, a, Math.cos(a.v * DEG) * DEG);
}

export function cos(a: Quantity): Quantity {
  dimlessOnly(a, "cos");
  return lift(Math.cos(a.v * DEG), DIMLESS, a, -Math.sin(a.v * DEG) * DEG);
}

export function tan(a: Quantity): Quantity {
  dimlessOnly(a, "tan");
  const c = Math.cos(a.v * DEG);
  if (Math.abs(c) < 1e-12) fail("the tangent of a right angle");
  return lift(Math.tan(a.v * DEG), DIMLESS, a, DEG / (c * c));
}

/**
 * `min` and `max` propagate the SELECTED branch's gradient.
 *
 * That is a subgradient: correct almost everywhere, and wrong exactly at a tie. A row whose branch could flip
 * inside its own uncertainty range has a spread that means less than it looks like, which is why `branchIsTight`
 * exists — the panel warns on such a row rather than reporting a confident-looking number.
 */
export function minOf(items: readonly Quantity[]): Quantity {
  if (!items.length) fail("min needs at least one value");
  return items.reduce((best, q) => {
    requireSameDim(best, q, "compare");
    return q.v < best.v ? q : best;
  });
}

export function maxOf(items: readonly Quantity[]): Quantity {
  if (!items.length) fail("max needs at least one value");
  return items.reduce((best, q) => {
    requireSameDim(best, q, "compare");
    return q.v > best.v ? q : best;
  });
}

export function sumOf(items: readonly Quantity[], dim: Dim): Quantity {
  return items.reduce<Quantity>((acc, q) => add(acc, q), exact(0, dim));
}

/**
 * Whether two candidate branches are close enough together, relative to their own spreads, that choosing
 * between them by nominal value alone is not meaningful. The panel shows a warning where this holds.
 */
export function branchIsTight(
  a: Quantity,
  b: Quantity,
  sources: SourceTable,
): boolean {
  const gap = Math.abs(a.v - b.v);
  const spread = halfWidth(read(a, sources)) + halfWidth(read(b, sources));
  return spread > 0 && gap < spread;
}

// ---------- reading it back ----------

export interface Contribution {
  readonly source: string;
  readonly label: string;
  /** The source's `at`, carried through so a ranking can be navigated and not merely read. */
  readonly at?: string;
  /** How far this source alone can pull the result down, and up. Both non-negative. */
  readonly lo: number;
  readonly hi: number;
  /** Fraction of the total variance — for a linear model, exactly the first-order Sobol index. */
  readonly share: number;
}

export interface Reading {
  readonly v: number;
  readonly dim: Dim;
  /** Everything wrong at once, in the same direction. A bound, but a LINEARIZED one — see the header. */
  readonly worst: { lo: number; hi: number };
  /** Independent errors, in quadrature. The number to actually quote. */
  readonly likely: { lo: number; hi: number };
  /** Largest share first. Empty when nothing can move the value. */
  readonly terms: readonly Contribution[];
}

/**
 * Turn a value and the sheet's source table into the three readings.
 *
 * ---------- why no confidence level is asked for ----------
 *
 * The obvious objection to the quadrature figure is "±10% at what confidence — one sigma, two?" It never has
 * to be answered. Root-sum-square is scale-equivariant: if every input's stated bound is the same multiple k
 * of its standard deviation, the RSS of the bounds is k times the RSS of the sigmas — which is the combined
 * bound at the very confidence the user was already thinking in. All that is required is that the sheet is
 * consistent with itself, which is a far easier thing to ask than a calibrated σ.
 */
export function read(q: Quantity, sources: SourceTable): Reading {
  let worstLo = 0,
    worstHi = 0,
    sqLo = 0,
    sqHi = 0,
    variance = 0;
  const raw: { c: Omit<Contribution, "share">; halfWidth: number }[] = [];

  for (const id in q.d) {
    const g = q.d[id];
    const source = sources.get(id);
    if (!source) continue; // a source the table has forgotten contributes nothing rather than NaN
    // The source ranges over [−lo, +hi]. A positive derivative carries those the same way round; a negative
    // one swaps them, which is the whole reason the gradient keeps its sign.
    const lo = g > 0 ? g * source.lo : -g * source.hi;
    const hi = g > 0 ? g * source.hi : -g * source.lo;
    worstLo += lo;
    worstHi += hi;
    sqLo += lo * lo;
    sqHi += hi * hi;
    const half = (lo + hi) / 2;
    variance += half * half;
    raw.push({
      c: { source: id, label: source.label, at: source.at, lo, hi },
      halfWidth: half,
    });
  }

  const terms = raw
    .map(({ c, halfWidth: half }) => ({
      ...c,
      share: variance > 0 ? (half * half) / variance : 0,
    }))
    .sort((a, b) => b.share - a.share);

  return {
    v: q.v,
    dim: q.dim,
    worst: { lo: worstLo, hi: worstHi },
    likely: { lo: Math.sqrt(sqLo), hi: Math.sqrt(sqHi) },
    terms,
  };
}

/** The symmetric ± a reading is usually shown as: the mean of its two worst-case extents. */
export const halfWidth = (reading: Reading): number =>
  (reading.worst.lo + reading.worst.hi) / 2;

/** The reading's extremes as absolute values, which is what a tolerance rectangle wants. */
export const bounds = (
  reading: Reading,
  which: "worst" | "likely" = "worst",
): { lo: number; hi: number } => ({
  lo: reading.v - reading[which].lo,
  hi: reading.v + reading[which].hi,
});
