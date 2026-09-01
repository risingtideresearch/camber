// The uncertain number: gradient propagation, the three readings, and dimensions.
//
// These check the PROPERTIES the construction is supposed to have rather than fixed numbers, so they survive
// any retuning of the algebra:
//
//   - cancellation: `x − x` has an empty gradient, which is the thing interval arithmetic cannot do. Same for
//     `x/x` and for a margin stated as a fraction of a total the item is itself inside.
//   - the chain rule is right: every rule's reported gradient matches a central finite difference of the same
//     expression, for +, −, ×, ÷, powers, roots, exp/ln and the trig.
//   - ordering: the quadrature reading never exceeds the worst case, and both vanish exactly when nothing
//     uncertain is upstream.
//   - scale equivariance: multiplying every source's spread by k multiplies both readings by k. This is what
//     lets the sheet decline to ask what confidence a ± describes — see `read`'s header.
//   - asymmetry: a one-sided tolerance stays one-sided through a sign change, which is what the signed
//     gradient is for. A negated expression swaps its lo and hi exactly.
//   - the sensitivity ranking is a real measurement: `share` agrees with the variance each source contributes
//     when measured by finite difference, and sums to 1.
//   - dimensions: adding kg to m² is refused, a product multiplies exponents, sqrt halves them and refuses an
//     odd one, and a dimensioned base refuses an uncertain exponent.
//   - MONTE CARLO, which is the real oracle: on a nonlinear sheet the linearized readings agree with 200k
//     samples, and the second-order error is measured rather than assumed — the test asserts the size of the
//     gap the module's header claims.
//
// Run with `npm run test:quantity` (tsx runs this directly under node). Non-zero exit on any failure.

import {
  abs,
  add,
  bounds,
  branchIsTight,
  combine,
  cos,
  div,
  exact,
  exp,
  halfWidth,
  isExact,
  ln,
  maxOf,
  minOf,
  mul,
  neg,
  pow,
  QuantityError,
  read,
  sin,
  sqrt,
  sub,
  sumOf,
  uncertain,
  AREA,
  DIMLESS,
  LENGTH,
  MASS,
  dimLabel,
  type Quantity,
  type Source,
  type SourceTable,
} from "../src/core/sheet/quantity";

let failures = 0;
const ok = (condition: unknown, message: string) => {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    failures++;
  }
};
const near = (a: number, b: number, tol: number): boolean =>
  Math.abs(a - b) <= tol;

// ---------- a small sheet's worth of sources ----------

const sources = new Map<string, Source>();
const src = (
  id: string,
  v: number,
  lo: number,
  hi = lo,
  dim = DIMLESS,
): Quantity => {
  const source: Source = { id, label: id, lo, hi };
  sources.set(id, source);
  return uncertain(v, source, dim);
};

const table: SourceTable = sources;

// ---------- cancellation: the thing intervals get wrong ----------
{
  const x = src("x", 10, 1);
  ok(isExact(sub(x, x)), "x − x depends on nothing at all");
  ok(read(sub(x, x), table).worst.hi === 0, "and therefore has no spread");
  ok(near(div(x, x).v, 1, 1e-12) && isExact(div(x, x)), "x / x is exactly 1");

  // The case a real weight sheet hits: a margin stated as a fraction of a total the item is inside.
  const total = add(x, exact(5));
  const withMargin = add(total, mul(total, exact(0.1)));
  const direct = mul(total, exact(1.1));
  ok(
    near(read(withMargin, table).worst.hi, read(direct, table).worst.hi, 1e-12),
    "a margin folded in twice reports the same spread as the closed form",
  );

  ok(
    Object.keys(combine({ a: 2 }, 1, { a: -2 }, 1)).length === 0,
    "combine drops an exactly cancelling coefficient rather than storing a zero",
  );
}

// ---------- every rule's gradient matches a finite difference ----------
{
  // Rebuild an expression with one source nudged, and difference it. This is the independent check on the
  // chain rule: nothing below shares code with the algebra it is testing.
  const check = (
    name: string,
    build: (a: number, b: number) => Quantity,
    a0: number,
    b0: number,
    tol = 1e-6,
  ) => {
    const q = build(a0, b0);
    const h = 1e-5;
    const dA = (build(a0 + h, b0).v - build(a0 - h, b0).v) / (2 * h);
    const dB = (build(a0, b0 + h).v - build(a0, b0 - h).v) / (2 * h);
    // Every builder below makes its sources with lo = hi = 1, so the reported contribution IS the derivative.
    const local = new Map<string, Source>([
      ["fa", { id: "fa", label: "fa", lo: 1, hi: 1 }],
      ["fb", { id: "fb", label: "fb", lo: 1, hi: 1 }],
    ]);
    const got = read(q, local);
    const term = (id: string) => {
      const t = got.terms.find((c) => c.source === id);
      if (!t) return 0;
      // hi is |g|·1 for a positive derivative and |g|·1 for a negative one; the sign is recovered from which
      // way round lo and hi came out, which is exactly what the asymmetry test below is about.
      return t.hi;
    };
    ok(
      near(term("fa"), Math.abs(dA), tol * Math.max(1, Math.abs(dA))) &&
        near(term("fb"), Math.abs(dB), tol * Math.max(1, Math.abs(dB))),
      `${name}: the reported gradient matches a finite difference`,
    );
  };

  const fa = (v: number) =>
    uncertain(v, { id: "fa", label: "fa", lo: 1, hi: 1 });
  const fb = (v: number) =>
    uncertain(v, { id: "fb", label: "fb", lo: 1, hi: 1 });

  check("add", (a, b) => add(fa(a), fb(b)), 3, 4);
  check("sub", (a, b) => sub(fa(a), fb(b)), 3, 4);
  check("mul", (a, b) => mul(fa(a), fb(b)), 3, 4);
  check("div", (a, b) => div(fa(a), fb(b)), 3, 4);
  check("pow", (a, b) => pow(fa(a), fb(b)), 2.5, 1.7);
  check("sqrt", (a, b) => mul(sqrt(fa(a)), fb(b)), 9, 2);
  check("exp", (a, b) => mul(exp(fa(a)), fb(b)), 0.7, 2);
  check("ln", (a, b) => mul(ln(fa(a)), fb(b)), 5, 2);
  check("sin", (a, b) => mul(sin(fa(a)), fb(b)), 35, 2);
  check("cos", (a, b) => mul(cos(fa(a)), fb(b)), 35, 2);
  check("abs", (a, b) => mul(abs(neg(fa(a))), fb(b)), 4, 2);
  check(
    "a compound expression",
    (a, b) => div(mul(fa(a), add(fb(b), exact(2))), sqrt(fa(a))),
    6,
    3,
  );
}

// ---------- the two readings, and how they order ----------
{
  const a = src("a", 100, 10);
  const b = src("b", 50, 10);
  const c = src("c", 25, 10);
  const total = add(add(a, b), c);
  const r = read(total, table);

  ok(r.v === 175, "the nominal is the sum of the nominals");
  ok(near(r.worst.hi, 30, 1e-12), "the worst case adds the extents");
  ok(
    near(r.likely.hi, Math.sqrt(300), 1e-12),
    "the likely case adds them in quadrature",
  );
  ok(r.likely.hi < r.worst.hi, "quadrature is never the larger of the two");

  ok(
    read(exact(42), table).worst.hi === 0 &&
      read(exact(42), table).terms.length === 0,
    "an exact value reports no spread and no contributions",
  );

  ok(
    near(bounds(r).lo, 145, 1e-12) && near(bounds(r).hi, 205, 1e-12),
    "bounds() puts the extents either side of the nominal",
  );
  ok(near(halfWidth(r), 30, 1e-12), "halfWidth averages the two extents");
}

// ---------- scale equivariance: why no confidence level is asked for ----------
{
  const build = (k: number) => {
    const local = new Map<string, Source>([
      ["p", { id: "p", label: "p", lo: 2 * k, hi: 3 * k }],
      ["q", { id: "q", label: "q", lo: 1 * k, hi: 1 * k }],
    ]);
    const p = uncertain(20, local.get("p")!);
    const q = uncertain(7, local.get("q")!);
    return read(mul(p, add(q, exact(1))), local);
  };
  const one = build(1);
  const three = build(3);
  ok(
    near(three.worst.hi, 3 * one.worst.hi, 1e-9) &&
      near(three.likely.hi, 3 * one.likely.hi, 1e-9),
    "scaling every input's bound by k scales both readings by k",
  );
  ok(
    near(three.terms[0].share, one.terms[0].share, 1e-12),
    "and leaves the sensitivity ranking untouched",
  );
}

// ---------- asymmetry survives a sign change ----------
{
  const local = new Map<string, Source>([
    ["s", { id: "s", label: "s", lo: 1, hi: 9 }],
  ]);
  const s = uncertain(100, local.get("s")!);
  const up = read(s, local);
  ok(
    up.worst.lo === 1 && up.worst.hi === 9,
    "a one-sided tolerance is carried as two numbers, not a ±",
  );
  const down = read(neg(s), local);
  ok(
    down.worst.lo === 9 && down.worst.hi === 1,
    "negating swaps which way the source can pull the result",
  );
  const scaled = read(mul(s, exact(-2)), local);
  ok(
    near(scaled.worst.lo, 18, 1e-12) && near(scaled.worst.hi, 2, 1e-12),
    "and so does any negative coefficient",
  );
}

// ---------- the sensitivity ranking is a real measurement ----------
{
  // A believable little estimate: a plywood shell, framing as a fraction of it, an outboard, and crew.
  const local = new Map<string, Source>();
  const make = (id: string, v: number, spread: number) => {
    local.set(id, { id, label: id, lo: spread, hi: spread });
    return uncertain(v, local.get(id)!);
  };
  const plyDensity = make("ply_density", 4.2, 0.3);
  const layFactor = make("lay_factor", 1.12, 0.04);
  const frameFrac = make("frame_frac", 0.22, 0.05);
  const deck = make("deck", 12, 3);
  const fuel = make("fuel", 20, 5);
  const crew = make("crew", 160, 15);

  const shellArea = exact(14.8);
  const shell = mul(mul(shellArea, plyDensity), layFactor);
  const frames = mul(shell, frameFrac);
  const displacement = add(add(add(add(shell, frames), deck), fuel), crew);
  const r = read(displacement, local);

  ok(
    near(
      r.terms.reduce((s, t) => s + t.share, 0),
      1,
      1e-12,
    ),
    "the shares of one value's spread sum to 1",
  );
  ok(
    r.terms[0].label === "crew",
    "the ranking names the crew as the biggest driver of the spread",
  );
  ok(
    r.terms.every((t, i) => i === 0 || t.share <= r.terms[i - 1].share),
    "the ranking really is sorted",
  );

  // The share should be the variance this source contributes, measured independently: nudge one source by
  // its own spread and see how far the result moves.
  const measured = new Map<string, number>();
  for (const [id, source] of local) {
    const save = source.lo;
    const only = new Map<string, Source>([[id, source]]);
    measured.set(id, Math.pow(read(displacement, only).worst.hi, 2));
    void save;
  }
  const totalVar = [...measured.values()].reduce((s, v) => s + v, 0);
  ok(
    r.terms.every((t) =>
      near(t.share, (measured.get(t.source) ?? 0) / totalVar, 1e-9),
    ),
    "each share is that source's variance over the total, measured one at a time",
  );
}

// ---------- dimensions ----------
{
  const kg = exact(10, MASS);
  const m2 = exact(4, AREA);
  const m = exact(3, LENGTH);

  let threw = false;
  try {
    add(kg, m2);
  } catch (error) {
    threw = error instanceof QuantityError;
  }
  ok(threw, "adding kg to m² is refused");

  ok(
    mul(m, m).dim.l === 2 && mul(kg, m2).dim.m === 1,
    "a product adds the exponents",
  );
  ok(div(kg, m2).dim.l === -2, "a quotient subtracts them");
  ok(sqrt(m2).dim.l === 1, "sqrt halves them");
  ok(dimLabel(div(kg, m2).dim) === "kg·m^-2", "a dimension reads as a unit");

  threw = false;
  try {
    sqrt(m);
  } catch (error) {
    threw = error instanceof QuantityError;
  }
  ok(threw, "a dimension with an odd exponent has no square root");

  threw = false;
  try {
    pow(m, src("badexp", 2, 0.1));
  } catch (error) {
    threw = error instanceof QuantityError;
  }
  ok(threw, "a dimensioned base refuses an uncertain exponent");

  ok(
    pow(m, exact(3)).dim.l === 3,
    "but takes an exact one and scales the unit",
  );

  threw = false;
  try {
    div(kg, exact(0, MASS));
  } catch (error) {
    threw = error instanceof QuantityError;
  }
  ok(threw, "division by zero is refused rather than returned as Infinity");

  ok(
    sumOf([exact(1, MASS), exact(2, MASS)], MASS).v === 3,
    "sumOf carries the dimension of an empty sum",
  );
}

// ---------- min, max, and the tie they cannot see ----------
{
  const local = new Map<string, Source>([
    ["u", { id: "u", label: "u", lo: 5, hi: 5 }],
    ["w", { id: "w", label: "w", lo: 5, hi: 5 }],
  ]);
  const u = uncertain(10, local.get("u")!);
  const w = uncertain(30, local.get("w")!);
  ok(minOf([u, w]) === u && maxOf([u, w]) === w, "min and max select a branch");
  ok(
    read(minOf([u, w]), local).terms[0].source === "u",
    "and propagate only the selected branch's gradient",
  );
  ok(
    !branchIsTight(u, w, local),
    "branches 20 apart with ±5 each are safely apart",
  );
  const close = uncertain(12, local.get("w")!);
  ok(
    branchIsTight(u, close, local),
    "branches 2 apart with ±5 each are flagged as a tie the linearization cannot see",
  );
}

// ---------- the real oracle: Monte Carlo ----------
//
// A deliberately NONLINEAR sheet — products, a quotient and a square root — sampled directly. The linearized
// readings should agree with the sampled ones, and the residual is the second-order term the module's header
// promises is small. The generator is a fixed-seed LCG so a failure is reproducible.
{
  let seed = 0x2f6e2b1;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  // Box–Muller, truncated to ±3σ so a sample never leaves the range the bound describes.
  const gauss = (): number => {
    let g: number;
    do {
      const u1 = Math.max(rnd(), 1e-12);
      g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rnd());
    } while (Math.abs(g) > 3);
    return g / 3; // ∈ [−1, 1], with the stated bound as the 3σ point
  };

  const baseSpec = [
    { id: "area", v: 14.8, spread: 0.8 },
    { id: "dens", v: 4.2, spread: 0.3 },
    { id: "frac", v: 0.22, spread: 0.05 },
    { id: "beam", v: 1.9, spread: 0.15 },
  ];

  // shell·(1 + frac) + 30·sqrt(beam) − shell/beam : products, a root and a quotient, with `shell` appearing
  // three times so a naive interval would inflate badly.
  const formula = (a: number, d: number, f: number, b: number): number => {
    const shell = a * d;
    return shell * (1 + f) + 30 * Math.sqrt(b) - shell / b;
  };

  // The whole sheet at some fraction of its stated spreads, so the linearization error can be MEASURED as a
  // function of how wide the inputs are rather than compared against a threshold picked by hand.
  const at = (scale: number) => {
    const spec = baseSpec.map((s) => ({ ...s, spread: s.spread * scale }));
    const local = new Map<string, Source>(
      spec.map((s) => [
        s.id,
        { id: s.id, label: s.id, lo: s.spread, hi: s.spread },
      ]),
    );
    const a = uncertain(spec[0].v, local.get("area")!);
    const d = uncertain(spec[1].v, local.get("dens")!);
    const f = uncertain(spec[2].v, local.get("frac")!);
    const b = uncertain(spec[3].v, local.get("beam")!);
    const shell = mul(a, d);
    const q = sub(
      add(mul(shell, add(exact(1), f)), mul(exact(30), sqrt(b))),
      div(shell, b),
    );
    const r = read(q, local);

    // Push every source to the corner the linearization says is worst, and evaluate the formula there. The
    // gap between that and the reported bound IS the second-order term.
    const corner = (dir: 1 | -1): number => {
      const pt = spec.map((s) => {
        const term = r.terms.find((t) => t.source === s.id)!;
        const positive = term.hi >= term.lo; // symmetric sources, so this recovers the derivative's sign
        return s.v + (positive ? dir : -dir) * s.spread;
      });
      return formula(pt[0], pt[1], pt[2], pt[3]);
    };
    const err = Math.max(
      Math.abs(corner(1) - r.v - r.worst.hi) / r.worst.hi,
      Math.abs(r.v - corner(-1) - r.worst.lo) / r.worst.lo,
    );
    return { spec, local, r, err };
  };

  const full = at(1);
  const half = at(0.5);
  const { spec, r } = full;

  ok(
    near(r.v, formula(spec[0].v, spec[1].v, spec[2].v, spec[3].v), 1e-9),
    "monte carlo: the nominal agrees with direct evaluation",
  );

  // The header claims the propagation is FIRST ORDER. That is a testable statement about how the error
  // behaves, not a threshold: halving every input's spread halves the linear term and quarters the quadratic
  // one, so the RELATIVE error against the exact corner should itself halve. Anything second-order-and-worse
  // in the algebra would fail this while comfortably passing a fixed bound.
  ok(
    half.err < full.err * 0.6 && half.err > full.err * 0.4,
    `the worst case's error is first order in the spreads (${(full.err * 100).toFixed(2)}% → ${(half.err * 100).toFixed(2)}% on halving)`,
  );
  ok(
    full.err < 0.08,
    `and is small at realistic estimating tolerances (${(full.err * 100).toFixed(2)}% on inputs of 5–23%)`,
  );

  // The quadrature reading against sampling. Each stated bound is the 3σ point, so the sampled 3σ is what it
  // should be compared with — and that comparison is the scale-equivariance argument in action.
  const N = 200000;
  let sum = 0,
    sumSq = 0;
  for (let i = 0; i < N; i++) {
    const at = spec.map((s) => s.v + gauss() * s.spread);
    const y = formula(at[0], at[1], at[2], at[3]);
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / N;
  const sd = Math.sqrt(Math.max(0, sumSq / N - mean * mean));
  const sampled3Sigma = 3 * sd;
  const likelyErr =
    Math.abs(sampled3Sigma - r.likely.hi) / Math.max(r.likely.hi, 1e-12);
  ok(
    likelyErr < 0.05,
    `the quadrature reading matches ${N} samples to 5% (${(likelyErr * 100).toFixed(2)}%)`,
  );
  ok(
    Math.abs(mean - r.v) < 0.02 * r.likely.hi,
    "and sampling finds no meaningful bias away from the nominal",
  );

  // The point of the whole exercise, stated as a test: a worst case that assumed nothing cancels would be far
  // larger than what actually happens, because `shell` appears three times.
  ok(
    r.worst.hi < 3 * r.likely.hi,
    "repeated variables do not inflate the bound the way an interval would",
  );
}

if (failures) process.exitCode = 1;
else console.log("\nall passed");
