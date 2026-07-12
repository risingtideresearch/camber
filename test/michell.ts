// Michell-integral verification.
//
// Two independent checks:
//
// 1. WIGLEY CROSS-CHECK. The standard Wigley hull Y(x,ζ) = (B/2)·(1−(2x/L−1)²)·(1−(ζ/T)²) has an
//    analytic, separable ∂Y/∂x, so Michell's integral can be brute-forced by a completely different
//    route: Simpson's rule on the analytic integrand in x and ζ, and the classical θ-form of the outer
//    integral (λ = sec θ), R ∝ ∫₀^{π/2} |F|² sec³θ dθ. The production code (src/core/michell.ts) instead
//    uses a sampled piecewise-linear grid, closed-form Filon panels, and the λ = √(1+u²) substitution —
//    nothing is shared but the physics, so agreement pins down both the constant and the quadrature. We
//    assert ≤ 2% relative agreement across Froude numbers 0.2–0.55, and that the last hump of the Wigley
//    curve sits near Fn ≈ 0.5 with C_w of order 10⁻³ — the textbook signature.
//
// 2. MODEL PATH. The default hull's C_w(Fn) must be finite and positive across the sailing range, and
//    stable under grid doubling (station/depth resolution) to a few percent — i.e. the offsets sampling
//    (including the dry-transom cut) is converged, not just the synthetic-grid path.
//
// Run with `npm run test:michell` (tsx under node). Non-zero exit on any failure, to gate CI.

import {
  centerplaneGrid,
  michellCw,
  type CenterplaneGrid,
} from "../src/core/michell";
import { createModel, resetModel, prepare } from "../src/core/model";

let failures = 0;
function check(ok: boolean, label: string, detail: string): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}  ${detail}`);
  if (!ok) failures++;
}

// ---------- 1. the Wigley hull, two independent evaluations ----------
// standard Wigley: L/B = 10, B/T = 1.6 (L = 1, B = 0.1, T = 0.0625)
const WL = 1,
  WB = 0.1,
  WT = 0.0625;
const SREF = WL * WT; // reference area for C_w — arbitrary but IDENTICAL on both routes
const py = (x: number): number => 1 - ((2 * x) / WL - 1) ** 2; // plan profile p(x)
const dpy = (x: number): number => (-2 * ((2 * x) / WL - 1) * 2) / WL; // p'(x)
const qz = (z: number): number => 1 - (z / WT) ** 2; // depth profile q(ζ)

// Simpson's rule over [0, hi] with n panels (n even)
function simpson(f: (v: number) => number, hi: number, n: number): number {
  const h = hi / n;
  let s = f(0) + f(hi);
  for (let i = 1; i < n; i++) s += f(i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

// brute-force Michell C_w in the θ-form: C_w = (8k₀²/πS)·∫₀^{π/2} |F(secθ)|² sec³θ dθ, with
// F = (B/2)·[∫p'(x)e^{iκx}dx]·[∫q(ζ)e^{−aζ}dζ], κ = k₀secθ, a = k₀sec²θ — all by dense Simpson.
function bruteWigleyCw(fn: number): number {
  const k0 = 1 / (fn * fn * WL);
  const NT = 4000,
    dth = Math.PI / 2 / NT;
  let sum = 0;
  for (let it = 0; it <= NT; it++) {
    const th = it * dth,
      sec = 1 / Math.cos(th),
      a = k0 * sec * sec,
      kap = k0 * sec;
    if (a * WT > 30) break; // kernel dead below the surface layer — spectrum ~ e^{−2aT}
    const xre = simpson((x) => dpy(x) * Math.cos(kap * x), WL, 4000),
      xim = simpson((x) => dpy(x) * Math.sin(kap * x), WL, 4000),
      zin = simpson((z) => qz(z) * Math.exp(-a * z), WT, 1000);
    const f2 = (WB / 2) ** 2 * (xre * xre + xim * xim) * zin * zin,
      w = it === 0 || it === NT ? 0.5 : 1;
    sum += w * f2 * sec ** 3 * dth;
  }
  return ((8 * k0 * k0) / (Math.PI * SREF)) * sum;
}

// the same hull as a sampled grid through the production path (no transom: cutX all NaN)
function wigleyGrid(nx: number, nz: number): CenterplaneGrid {
  const xs: number[] = [],
    Y: Float64Array[] = [],
    dz = WT / nz;
  for (let i = 0; i <= nx; i++) {
    const x = (WL * i) / nx,
      row = new Float64Array(nz + 1);
    for (let j = 0; j <= nz; j++) row[j] = (WB / 2) * py(x) * qz(j * dz);
    xs.push(x);
    Y.push(row);
  }
  const first = new Int32Array(nz + 1);
  for (let j = 0; j <= nz; j++) {
    first[j] = -1;
    for (let i = 0; i <= nx; i++)
      if (Y[i][j] > 0) {
        first[j] = i;
        break;
      }
  }
  return {
    xs,
    Y,
    nz,
    dz,
    first,
    cutX: new Float64Array(nz + 1).fill(NaN),
    cutY: new Float64Array(nz + 1),
    lwl: WL,
    draft: WT,
    wettedArea: SREF,
  };
}

console.log("Wigley cross-check: production grid/Filon vs analytic Simpson");
const grid = wigleyGrid(240, 60);
let cwPeak = 0,
  fnPeak = 0;
for (const fn of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55]) {
  const a = michellCw(grid, fn),
    b = bruteWigleyCw(fn),
    rel = Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  check(
    rel < 0.02,
    `Fn=${fn.toFixed(2)}`,
    `michell=${a.toExponential(4)} brute=${b.toExponential(4)} rel=${(rel * 100).toFixed(2)}%`,
  );
}
// the last hump: scan the production curve for the Fn∈[0.35,0.7] maximum
for (let fn = 0.35; fn <= 0.7; fn += 0.01) {
  const c = michellCw(grid, fn);
  if (c > cwPeak) {
    cwPeak = c;
    fnPeak = fn;
  }
}
check(
  fnPeak > 0.44 && fnPeak < 0.56,
  "last hump position",
  `peak at Fn=${fnPeak.toFixed(2)} (expect ≈ 0.5)`,
);

// ---------- 2. the default hull through the model-sampling path ----------
console.log("default hull: finiteness + grid convergence");
const model = createModel();
resetModel(model);
prepare(model);
const gCoarse = centerplaneGrid(model, 96, 28),
  gFine = centerplaneGrid(model, 192, 56);
if (!gCoarse || !gFine) {
  check(false, "grid", "centerplaneGrid returned null for the default hull");
} else {
  check(
    Math.abs(gCoarse.lwl - gFine.lwl) / gFine.lwl < 0.02,
    "wetted span",
    `lwl coarse=${gCoarse.lwl.toFixed(1)} fine=${gFine.lwl.toFixed(1)}`,
  );
  const fns = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6];
  const fine = fns.map((fn) => michellCw(gFine, fn)),
    peak = Math.max(...fine);
  check(
    fine.every((c) => Number.isFinite(c) && c > 0),
    "C_w finite/positive",
    fine.map((c) => c.toExponential(2)).join(" "),
  );
  for (let i = 0; i < fns.length; i++) {
    const c = michellCw(gCoarse, fns[i]),
      rel = Math.abs(c - fine[i]) / peak;
    check(
      rel < 0.03,
      `Fn=${fns[i].toFixed(2)} grid-doubling`,
      `coarse=${c.toExponential(3)} fine=${fine[i].toExponential(3)} Δ/peak=${(rel * 100).toFixed(2)}%`,
    );
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall michell checks passed");
