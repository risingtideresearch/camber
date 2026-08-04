// Michell's integral: the validation ladder from michell-plan.md §6, plus the convergence diagnostics of §2.4.
//
// Each rung isolates one layer, and they are ordered so that a failure high up cannot be caused by anything
// below it:
//
//   1. Gauss–Legendre, the quadrature everything is built on.
//   2. THE IDENTITY. F = −i·ν·secθ·∬ y·e^K dX dZ against the closed-form Wigley spectrum. camber cannot
//      represent a Wigley hull, so the node cloud is built analytically here — which is the point: it drives
//      the spectrum, resistance and field code with geometry whose answer is known exactly, pinning the
//      integration by parts, the sign, the kernel and the constants independently of any hull sampling.
//   3. THE TRANSOM. A prismatic half-body, where f jumps at both ends and the whole answer is the two
//      concentrated source lines. This is the rung that checks the claim in michell.ts's header — that the
//      transom boundary term and the delta in ∂f/∂X cancel, so neither appears.
//   4. Volume parity: the sampled node cloud against camber's own hydrostatics, with zero exponent.
//   5. R_w against a brute-force reference, and the free-wave energy identity that ties the wave FIELD's
//      normalization to the resistance (plan rung 6 — the one that would otherwise be fitted).
//   6. Kelvin geometry: 19.47° half-angle and 2πU²/g transverse wavelength. Pure geometry, so it tests the
//      field's phase convention independently of any amplitude.
//   7. Field symmetry in Y, and translation invariance under placement (what the fleet view relies on).
//   8. Convergence: every refinement control doubled, reporting the change in R_w and in sampled F(θ).
//
// Run with `npm run test:michell`.

import { createModel, prepare, type Model } from "../src/core/model";
import type { Vec3 } from "../src/core/math";
import { computeHullSampling } from "../src/core/mesh";
import { hydrostatics } from "../src/core/hydro";
import { unitScale } from "../src/core/json";
import {
  gaussLegendre,
  sampleCenterplane,
  sampleForBandwidth,
  sizeFor,
  inUsefulRange,
  DEFAULT_SEC_MAX,
  secMaxFor,
  NODES_PER_CYCLE,
  USEFUL_FROUDE,
  spectrum,
  thetaGrid,
  thetaCutoff,
  waveResistance,
  fleetResistance,
  waveField,
  G,
  type Centerplane,
  type MichellOptions,
} from "../src/core/michell";

let fails = 0;
const ok = (c: boolean, m: string): void => {
  if (!c) {
    console.log("FAIL: " + m);
    fails++;
  } else console.log("  ok: " + m);
};
const info = (m: string): void => console.log("       " + m);
const rel = (a: number, b: number): number =>
  Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

// ---------- 1. Gauss–Legendre ----------
{
  for (const n of [3, 5, 6, 8]) {
    const g = gaussLegendre(n);
    let w = 0,
      m2 = 0;
    for (let i = 0; i < n; i++) {
      w += g.w[i];
      m2 += g.w[i] * g.x[i] * g.x[i];
    }
    ok(Math.abs(w - 2) < 1e-14, `GL(${n}) weights sum to 2`);
    ok(Math.abs(m2 - 2 / 3) < 1e-14, `GL(${n}) integrates x² exactly`);
    // a rule of n nodes is exact to degree 2n−1
    let hi = 0;
    const p = 2 * n - 1;
    for (let i = 0; i < n; i++) hi += g.w[i] * Math.pow(g.x[i], p);
    ok(Math.abs(hi) < 1e-13, `GL(${n}) exact to degree ${p}`);
  }
}

// ---------- 2. the identity, against the closed-form Wigley spectrum ----------
//
// f = (B/2)(1 − (2X/L)²)(1 − (Z/T)²) on [−L/2, L/2] × [−T, 0]. Fore-aft symmetry makes Re F vanish, and
//     Im F = −(4B/L²)·∫X sin(kX)dX·∫(1 − (Z/T)²)e^{κZ}dZ ,  k = ν·secθ, κ = ν·sec²θ.
// (Cross-checked against the analytic expressions in risingtideresearch/michell's validation suite.)
const WIG = { L: 10, B: 1, T: 0.625 };

function wigleyIm(nu: number, lambda: number, w = WIG): number {
  const a = w.L / 2,
    k = nu * lambda,
    kap = nu * lambda * lambda;
  const xi = 2 * (Math.sin(k * a) / (k * k) - (a * Math.cos(k * a)) / k);
  const e = Math.exp(-kap * w.T);
  const zi =
    (1 - e) / kap -
    (2 - e * (kap * kap * w.T * w.T + 2 * kap * w.T + 2)) /
      (kap * kap * kap * w.T * w.T);
  return (-4 * w.B * xi * zi) / (w.L * w.L);
}

// the analytic hull as a node cloud, so it drives exactly the same spectrum/resistance/field code a camber
// hull does: tensor Gauss–Legendre over the rectangle, weight = f·w_X·w_Z. The depth panels are graded toward
// the free surface for the same reason the real sampler grades its section bands — at λ = 20 the kernel
// exp(ν·λ²·Z) lives in a boundary layer a few hundredths of the draft thick.
function wigleyCloud(
  nX = 40,
  nZ = 24,
  panX = 8,
  panZ = 10,
  w = WIG,
): Centerplane {
  const gx = gaussLegendre(nX),
    gz = gaussLegendre(nZ);
  const X: number[] = [],
    Z: number[] = [],
    W: number[] = [];
  // depth edges: widths h, 2h, 4h, … downward from Z = 0
  const zEdge: number[] = [0],
    den = Math.pow(2, panZ) - 1;
  for (let i = 0; i < panZ; i++)
    zEdge.push(zEdge[i] - (w.T * Math.pow(2, i)) / den);
  let vol = 0;
  for (let px = 0; px < panX; px++) {
    const xa = -w.L / 2 + (w.L * px) / panX,
      xb = -w.L / 2 + (w.L * (px + 1)) / panX,
      hx = (xb - xa) / 2,
      mx = (xa + xb) / 2;
    for (let i = 0; i < nX; i++) {
      const x = mx + hx * gx.x[i],
        wx = hx * gx.w[i];
      for (let pz = 0; pz < panZ; pz++) {
        const hz = 0.5 * (zEdge[pz + 1] - zEdge[pz]),
          mz = 0.5 * (zEdge[pz] + zEdge[pz + 1]);
        for (let j = 0; j < nZ; j++) {
          const z = mz + hz * gz.x[j],
            wz = Math.abs(hz) * gz.w[j];
          const f =
            (w.B / 2) *
            (1 - Math.pow((2 * x) / w.L, 2)) *
            (1 - Math.pow(z / w.T, 2));
          X.push(x);
          Z.push(z);
          W.push(f * wx * wz);
          vol += f * wx * wz;
        }
      }
    }
  }
  return {
    X: Float64Array.from(X),
    Z: Float64Array.from(Z),
    W: Float64Array.from(W),
    volumeHalf: vol,
    areaProjected: (2 * w.L * w.T) / 3,
    draft: w.T,
    xAft: -w.L / 2,
    xFwd: w.L / 2,
    beamMax: w.B,
    wettedLength: w.L,
    columns: nX * panX,
    nodes: X.length,
    jacobianFlips: 0,
    sheerSubmerged: 0,
    fanMaxRatio: 0,
    fanSpread: 0,
    footU: null,
  };
}

const wig = wigleyCloud();
{
  // the exact displaced volume of a Wigley hull is 4BLT/9
  ok(
    rel(2 * wig.volumeHalf, (4 * WIG.B * WIG.L * WIG.T) / 9) < 1e-12,
    "Wigley cloud reproduces ∇ = 4BLT/9",
  );

  let worst = 0,
    worstAt = "";
  for (const froude of [0.2, 0.3, 0.45]) {
    const U = froude * Math.sqrt(G * WIG.L),
      nu = G / (U * U);
    for (const lambda of [1.0, 1.05, 1.3, 2.0, 3.7, 8.0, 20.0]) {
      const th = Math.acos(1 / lambda),
        s = spectrum(wig, nu, [th]);
      const want = wigleyIm(nu, lambda);
      const scale = Math.max(Math.abs(want), 1e-12);
      if (Math.abs(s.re[0]) / scale > worst) {
        worst = Math.abs(s.re[0]) / scale;
        worstAt = `Re at Fn=${froude} λ=${lambda}`;
      }
      const r = Math.abs(s.im[0] - want) / scale;
      if (r > worst) {
        worst = r;
        worstAt = `Im at Fn=${froude} λ=${lambda}`;
      }
    }
  }
  ok(
    worst < 1e-9,
    `F(θ) matches the closed-form Wigley spectrum (worst ${worst.toExponential(2)}, ${worstAt})`,
  );
}

// ---------- 3. the transom: a prismatic half-body ----------
//
// f ≡ f_T on [0, L] × [−T, 0], zero outside. ∂f/∂X is zero in the interior and TWO delta lines, at the transom
// and at the bow. So the whole spectrum is the boundary jumps — and the integrated form must reproduce it:
//     F = f_T·(1 − e^{i·ν·secθ·L})·(1 − e^{−ν·sec²θ·T})/(ν·sec²θ).
{
  const L = 8,
    T = 0.5,
    fT = 0.3;
  const gx = gaussLegendre(8),
    gz = gaussLegendre(8),
    panX = 40,
    panZ = 20;
  const X: number[] = [],
    Z: number[] = [],
    W: number[] = [];
  for (let p = 0; p < panX; p++)
    for (let i = 0; i < 8; i++) {
      const xa = (L * p) / panX,
        xb = (L * (p + 1)) / panX,
        h = (xb - xa) / 2;
      const x = (xa + xb) / 2 + h * gx.x[i],
        wx = h * gx.w[i];
      for (let q = 0; q < panZ; q++)
        for (let j = 0; j < 8; j++) {
          const za = -T + (T * q) / panZ,
            zb = -T + (T * (q + 1)) / panZ,
            hz = (zb - za) / 2;
          X.push(x);
          Z.push((za + zb) / 2 + hz * gz.x[j]);
          W.push(fT * wx * hz * gz.w[j]);
        }
    }
  const cp: Centerplane = {
    ...wig,
    X: Float64Array.from(X),
    Z: Float64Array.from(Z),
    W: Float64Array.from(W),
    nodes: X.length,
  };
  let worst = 0;
  for (const nu of [0.5, 1.7, 4.0])
    for (const lambda of [1.0, 1.8, 5.0]) {
      const th = Math.acos(1 / lambda),
        s = spectrum(cp, nu, [th]);
      const a = nu * lambda * lambda,
        b = nu * lambda;
      // f_T·(1 − e^{ibL})·(1 − e^{−aT})/a
      const dz = (1 - Math.exp(-a * T)) / a;
      const wr = fT * (1 - Math.cos(b * L)) * dz,
        wi = fT * -Math.sin(b * L) * dz;
      worst = Math.max(
        worst,
        Math.hypot(s.re[0] - wr, s.im[0] - wi) /
          Math.max(Math.hypot(wr, wi), 1e-12),
      );
    }
  ok(
    worst < 1e-9,
    `prismatic body: the transom and bow source lines fall out of the integrated form (worst ${worst.toExponential(2)})`,
  );
}

// ---------- 4. volume parity, with zero exponent ----------
//
// Run the section and longitudinal quadratures with the kernel switched off and Σ W must be half the
// displaced volume. This is the domain test: it fails on a wrong Jacobian, a wrong half-breadth, a missed
// waterline root, or a bow/transom limit that does not agree with the hull the rest of camber draws.
//
// The reference is NOT hydrostatics(). It is camber's own marched trimmed mesh reduced by the divergence
// theorem — ∮(0, y, 0)·n dA over the immersed starboard half, where the centreplane cap has y = 0 and both
// the waterline and transom caps have n_y = 0, so only the skin contributes. That shares no code and no
// parameterisation with the sampler, which is what makes it a reference. See the note below on why
// hydrostatics() is a third, different number.
const model: Model = createModel();
prepare(model);
const S = unitScale(model.unit, "m"); // metres per model unit
const cp = sampleCenterplane(model, S);
if (!cp) {
  console.log("FAIL: sampleCenterplane returned null for the default hull");
  fails++;
  process.exit(1);
}
{
  const imm = (p: Vec3): number =>
    -model.waterline -
    (p[0] * Math.sin(model.deckRake) + p[2] * Math.cos(model.deckRake));
  const clipToWater = (poly: Vec3[]): Vec3[] => {
    const out: Vec3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[(i + 1) % poly.length],
        ia = imm(a),
        ib = imm(b);
      if (ia >= 0) out.push(a);
      if (ia >= 0 !== ib >= 0) {
        const t = ia / (ia - ib);
        out.push([0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * t) as Vec3);
      }
    }
    return out;
  };
  // ∬ y·n_y dA over a polygon, fanned into triangles: (u × v)_y × the triangle's mean y
  const flux = (poly: Vec3[]): number => {
    let s = 0;
    for (let i = 1; i < poly.length - 1; i++) {
      const a = poly[0],
        b = poly[i],
        c = poly[i + 1];
      const ny =
        0.5 * ((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]));
      s += ny * ((a[1] + b[1] + c[1]) / 3);
    }
    return s;
  };
  const meshVol = (ns: number, R: number): number => {
    const hs = computeHullSampling(model, ns, R);
    let v = 0;
    for (const q of hs.hullQuads) v += flux(clipToWater(q.map((s) => s.pos)));
    for (const t of hs.hullTris) v += flux(clipToWater(t.map((s) => s.pos)));
    return 2 * v * S * S * S;
  };
  const refCoarse = meshVol(480, 24),
    refFine = meshVol(1440, 48);
  const volMichell = 2 * cp.volumeHalf;
  ok(
    rel(refFine, refCoarse) < 2e-3,
    `the mesh volume reference is converged (${refCoarse.toFixed(5)} → ${refFine.toFixed(5)} m³)`,
  );
  const d = rel(volMichell, refFine);
  ok(
    d < 2e-3,
    `∇ from the centreplane node cloud matches the mesh to ${(d * 100).toFixed(3)}% ` +
      `(${volMichell.toFixed(5)} vs ${refFine.toFixed(5)} m³)`,
  );

  // hydrostatics() is a THIRD number, and knowing why matters more than the discrepancy does: it places each
  // station's whole immersed area at that station's plan x and trapezoid-integrates in plan x. camber's
  // station planes FAN, so near the bow a section leans back by a large fraction of its own length — on this
  // hull the keel point of the station at u = 0.95 sits 0.65 m aft of its plan x — and that longitudinal
  // spread is exactly what the trapezoid discards. The gap below is the size of that effect on this hull.
  const h = hydrostatics(model);
  ok(!!h, "hydrostatics available for the default hull");
  const volHydro = h!.vol * S * S * S;
  info(
    `hydrostatics() reports ∇ = ${volHydro.toFixed(5)} m³, ` +
      `${(((volHydro - refFine) / refFine) * 100).toFixed(1)}% above the mesh — the station-plane fan, not a bug here`,
  );
  info(
    `nodes ${cp.nodes} over ${cp.columns} columns · LWL ${cp.wettedLength.toFixed(3)} m · ` +
      `T ${cp.draft.toFixed(3)} m · B ${cp.beamMax.toFixed(3)} m`,
  );
  info(
    `fan max |δX|/L ${(cp.fanMaxRatio * 100).toFixed(2)}% · Jacobian flips ${cp.jacobianFlips} · ` +
      `sheer-submerged columns ${cp.sheerSubmerged} · foot at u ${cp.footU === null ? "—" : cp.footU.toFixed(4)}`,
  );
  ok(
    cp.jacobianFlips === 0,
    "the centreplane projection does not fold (no Jacobian sign flips)",
  );
  ok(
    cp.sheerSubmerged === 0,
    "the sheer stays above the waterline over the wetted length",
  );
  ok(
    cp.footU !== null,
    "the default hull's lower edge leaves the transom for the keel (foot corner found)",
  );
}

// ---------- 5. resistance, and the free-wave energy identity ----------
const RHO = 1025;
{
  // (a) against a brute-force θ reference on the analytic Wigley cloud, where F is exact
  const froude = 0.3,
    U = froude * Math.sqrt(G * WIG.L),
    nu = G / (U * U);
  const wr = waveResistance(wig, { U, rho: RHO });
  // reference: dense uniform Simpson in θ using the closed-form spectrum, same cutoff
  const N = 200000,
    tmax = wr.grid.thetaMax,
    dt = tmax / N;
  const fn = (t: number): number => {
    const sec = 1 / Math.cos(t),
      j = wigleyIm(nu, sec);
    return sec * sec * sec * j * j;
  };
  let s = fn(0) + fn(tmax);
  for (let i = 1; i < N; i++) s += (i % 2 ? 4 : 2) * fn(i * dt);
  const ref = ((4 * RHO * G * G) / (Math.PI * U * U)) * ((s * dt) / 3);
  const d = rel(wr.rw, ref);
  ok(
    d < 1e-6,
    `Wigley R_w matches a 200k-point Simpson reference to ${d.toExponential(2)}`,
  );
  info(
    `Fn ${froude}: R_w = ${wr.rw.toFixed(3)} N, Cw = ${wr.cw.toExponential(3)}, ` +
      `θ nodes ${wr.grid.theta.length}, tail beyond ${((wr.grid.thetaMax * 180) / Math.PI).toFixed(1)}° ≈ ${(wr.tail * 100).toFixed(2)}%`,
  );

  // (b) the energy identity: R_w = ½πρU²∫|A|²cos³θ dθ over (−π/2, π/2), with the SAME A the wave field uses.
  // This is what pins the field's normalization to the resistance instead of fitting it.
  let e = 0;
  for (let i = 0; i < wr.grid.theta.length; i++) {
    const sec = 1 / Math.cos(wr.grid.theta[i]),
      c = 1 / sec;
    const ar = ((-2 * nu) / Math.PI) * sec * sec * sec * wr.re[i],
      ai = ((2 * nu) / Math.PI) * sec * sec * sec * wr.im[i]; // A = −(2ν/π)sec³θ·conj F
    e += (ar * ar + ai * ai) * c * c * c * wr.grid.weight[i];
  }
  e *= 2; // fold the (−π/2, 0) half back in — |A| is even
  const rwEnergy = 0.5 * Math.PI * RHO * U * U * e;
  const de = rel(rwEnergy, wr.rw);
  ok(
    de < 1e-12,
    `the wave field's A(θ) carries exactly R_w of energy flux (rel ${de.toExponential(2)})`,
  );
}

// the camber hull at a working speed, reused by the field rungs below
const CU = 2.0; // m/s ≈ 3.9 kn — a displacement speed for a 4 m waterline
const cw = waveResistance(cp, { U: CU, rho: RHO });
info(
  `default camber hull at ${CU} m/s (${(CU / 0.514444).toFixed(1)} kn): Fn ${cw.froude.toFixed(3)}, ` +
    `R_w = ${cw.rw.toFixed(1)} N, tail ≈ ${(cw.tail * 100).toFixed(2)}%`,
);

// ---------- 6. Kelvin geometry ----------
{
  const U = 3.0,
    nu = G / (U * U),
    L = WIG.L;
  const grid = thetaGrid(nu, L, thetaCutoff(8), 0.25);
  const sp = spectrum(wig, nu, grid.theta);
  const parts = [{ re: sp.re, im: sp.im, at: { dx: 0, dy: 0 } }];

  // (a) transverse wavelength on the track, well astern. 2πU²/g for U = 3 is 5.766 m.
  {
    const nx = 4001,
      x0 = -60,
      dx = 45 / (nx - 1);
    const f = waveField(parts, grid, nu, { x0, dx, nx, y0: 0, dy: 1, ny: 1 });
    const xs: number[] = [];
    for (let i = 1; i < nx; i++) {
      const a = f.z[i - 1],
        b = f.z[i];
      if (a === 0 || Math.sign(a) === Math.sign(b)) continue;
      xs.push(x0 + (i - 1) * dx + (dx * a) / (a - b));
    }
    const want = (2 * Math.PI * U * U) / G;
    const got =
      xs.length >= 8
        ? (2 * (xs[xs.length - 1] - xs[0])) / (xs.length - 1)
        : NaN;
    ok(
      Number.isFinite(got) && rel(got, want) < 0.02,
      `transverse wavelength astern is 2πU²/g (${got.toFixed(3)} vs ${want.toFixed(3)} m, ${xs.length} crossings)`,
    );
    ok(
      f.max > 1e-4,
      `the wake astern is not flat (peak ${f.max.toExponential(2)} m)`,
    );
  }

  // (b) THE DISPERSION RELATION, which is what actually makes the wake a Kelvin wake. Collapse the spectrum
  // to a single angle: the ±θ pair folds into one wave travelling along the track and standing across it, so
  // on the track the wavelength must be 2π/(ν·secθ) and across it the modulation period must be
  // 2π/(ν·sec²θ·sinθ). Both components of k(θ) = ν·sec²θ·(cosθ, sinθ), read off the field itself.
  {
    const period = (z: number[], step: number): number => {
      const cs: number[] = [];
      for (let i = 1; i < z.length; i++)
        if (z[i - 1] !== 0 && Math.sign(z[i - 1]) !== Math.sign(z[i]))
          cs.push((i - 1) * step + (step * z[i - 1]) / (z[i - 1] - z[i]));
      return cs.length >= 6
        ? (2 * (cs[cs.length - 1] - cs[0])) / (cs.length - 1)
        : NaN;
    };
    let worstX = 0,
      worstY = 0;
    for (const th of [0.0, 0.35, 0.7, 1.0]) {
      const one: typeof grid = {
        theta: Float64Array.from([th]),
        weight: Float64Array.from([1]),
        thetaMax: th + 1e-9,
      };
      const s1 = spectrum(wig, nu, one.theta);
      const p1 = [{ re: s1.re, im: s1.im, at: { dx: 0, dy: 0 } }];
      const sec = 1 / Math.cos(th);
      // along the track
      const lamX = (2 * Math.PI) / (nu * sec);
      const nx = 1200,
        sx = lamX / 30;
      const fx = waveField(p1, one, nu, {
        x0: -60,
        dx: sx,
        nx,
        y0: 0,
        dy: 0,
        ny: 1,
      });
      worstX = Math.max(worstX, rel(period([...fx.z], sx), lamX));
      // across it, where the fold makes a standing pattern — skipped at θ = 0, where k_t vanishes
      if (th > 0) {
        const kt = nu * sec * sec * Math.sin(th),
          lamY = (2 * Math.PI) / kt;
        const ny = 1200,
          sy = lamY / 30;
        const fy = waveField(p1, one, nu, {
          x0: -60,
          dx: 0,
          nx: 1,
          y0: 0,
          dy: sy,
          ny,
        });
        worstY = Math.max(worstY, rel(period([...fy.z], sy), lamY));
      }
    }
    ok(
      worstX < 2e-3,
      `longitudinal wavenumber is ν·secθ at every angle (worst ${(worstX * 100).toFixed(3)}%)`,
    );
    ok(
      worstY < 2e-3,
      `transverse wavenumber is ν·sec²θ·sinθ at every angle (worst ${(worstY * 100).toFixed(3)}%)`,
    );
  }

  // (c) THE HALF-ANGLE. The cusp itself is smeared by the Airy transition, whose width goes as R^{1/3}·λ^{2/3}
  // — at R = 80 m with λ = 5.8 m that is already ±14 m, or ±10°, so no threshold on the amplitude can resolve
  // 19.47° at any distance this side of a kilometre. What IS sharp is where the energy sits: measure the angle
  // containing 90% of a transverse cut's ζ², which converges on the Kelvin angle from outside.
  {
    const fine = thetaGrid(nu, L, thetaCutoff(14), 0.06);
    const sf = spectrum(wig, nu, fine.theta);
    const fp = [{ re: sf.re, im: sf.im, at: { dx: 0, dy: 0 } }];
    const angles: number[] = [];
    for (const R of [80, 160]) {
      const ny = 3001,
        yMax = 0.7 * R,
        dy = yMax / (ny - 1);
      const f = waveField(fp, fine, nu, {
        x0: -R,
        dx: 0,
        nx: 1,
        y0: 0,
        dy,
        ny,
      });
      let tot = 0;
      for (let j = 0; j < ny; j++) tot += f.z[j] * f.z[j];
      let acc = 0,
        a90 = NaN;
      for (let j = 0; j < ny; j++) {
        acc += f.z[j] * f.z[j];
        if (acc >= 0.9 * tot) {
          a90 = (Math.atan((j * dy) / R) * 180) / Math.PI;
          break;
        }
      }
      angles.push(a90);
    }
    const worst = Math.max(...angles.map((a) => Math.abs(a - 19.47)));
    ok(
      worst < 1.5,
      `90% of the wake's energy lies within the Kelvin angle (${angles.map((a) => a.toFixed(2) + "\u00b0").join(", ")} at R = 80, 160 m vs 19.47\u00b0)`,
    );
  }

  // NOT TESTED, deliberately: that the pattern vanishes ahead of the ship. It does not, and it is not supposed
  // to — this is the far-field FREE-WAVE part of the linear solution, whose companion local disturbance (not
  // modelled) is what cancels it upstream. For a fore-aft symmetric hull like Wigley the free-wave integral is
  // exactly antisymmetric in X, so |ζ| ahead equals |ζ| astern identically. The fore/aft convention is instead
  // fixed by matching the reference formulation, and the consumers of this module mask the region ahead of the
  // bow rather than trusting it.
}

// ---------- 7. field symmetry and placement ----------
{
  const U = 3.0,
    nu = G / (U * U);
  const grid = thetaGrid(nu, WIG.L, thetaCutoff(8), 0.3);
  const sp = spectrum(wig, nu, grid.theta);

  // ζ(X, Y) = ζ(X, −Y): A(θ) is even, so the field cannot be asymmetric
  {
    const ny = 41,
      fg = { x0: -40, dx: 1, nx: 20, y0: -10, dy: 0.5, ny };
    const f = waveField(
      [{ re: sp.re, im: sp.im, at: { dx: 0, dy: 0 } }],
      grid,
      nu,
      fg,
    );
    let worst = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < fg.nx; i++)
        worst = Math.max(
          worst,
          Math.abs(f.z[j * fg.nx + i] - f.z[(ny - 1 - j) * fg.nx + i]),
        );
    ok(
      worst < 1e-15 * Math.max(f.max, 1e-30) + 1e-18,
      `ζ(X, Y) = ζ(X, −Y) (worst ${worst.toExponential(2)} m)`,
    );
  }

  // placing a hull translates its field exactly — the property the fleet view leans on when hulls are dragged
  {
    const fg = { x0: -40, dx: 0.5, nx: 60, y0: -8, dy: 0.5, ny: 33 };
    const base = waveField(
      [{ re: sp.re, im: sp.im, at: { dx: 0, dy: 0 } }],
      grid,
      nu,
      fg,
    );
    const moved = waveField(
      [{ re: sp.re, im: sp.im, at: { dx: 7, dy: 2 } }],
      grid,
      nu,
      {
        ...fg,
        x0: fg.x0 + 7,
        y0: fg.y0 + 2,
      },
    );
    let worst = 0;
    for (let i = 0; i < base.z.length; i++)
      worst = Math.max(worst, Math.abs(base.z[i] - moved.z[i]));
    ok(
      worst < 1e-14 * Math.max(base.max, 1e-30) + 1e-18,
      `placement translates the pattern exactly (worst ${worst.toExponential(2)} m)`,
    );
  }

  // ---- fleets ----
  {
    const U2 = 3.0,
      cond = { U: U2, rho: RHO };
    const solo = waveResistance(wig, cond);
    const g = solo.grid;

    // a one-member fleet must be the single-hull formula, to the last bit
    const f1 = fleetResistance([{ cp: wig, at: { dx: 0, dy: 0 } }], cond, g);
    ok(
      rel(f1.rw, solo.rw) < 1e-12,
      "a one-member fleet reproduces the single-hull R_w exactly",
    );
    ok(
      rel(f1.interference, 1) < 1e-12,
      "a one-member fleet has interference factor 1",
    );

    // two coincident hulls: the amplitudes add, so |2F|² = 4|F|²
    const f2 = fleetResistance(
      [
        { cp: wig, at: { dx: 0, dy: 0 } },
        { cp: wig, at: { dx: 0, dy: 0 } },
      ],
      cond,
      g,
    );
    ok(
      rel(f2.rw, 4 * solo.rw) < 1e-12,
      "coincident hulls quadruple R_w (amplitudes superpose)",
    );

    // a symmetric catamaran must reproduce the classical interference factor 4cos²(½·k_t·s)
    for (const sep of [1.4, 3.0, 6.5]) {
      const cat = fleetResistance(
        [
          { cp: wig, at: { dx: 0, dy: sep / 2 } },
          { cp: wig, at: { dx: 0, dy: -sep / 2 } },
        ],
        cond,
        g,
      );
      let want = 0;
      for (let i = 0; i < g.theta.length; i++) {
        const sec = 1 / Math.cos(g.theta[i]),
          kt = (G / (U2 * U2)) * sec * sec * Math.sin(g.theta[i]);
        want +=
          ((4 * RHO * G * G) / (Math.PI * U2 * U2)) *
          sec ** 3 *
          (solo.re[i] ** 2 + solo.im[i] ** 2) *
          4 *
          Math.cos((kt * sep) / 2) ** 2 *
          g.weight[i];
      }
      ok(
        rel(cat.rw, want) < 1e-12,
        `catamaran at s = ${sep} m reproduces 4cos²(½·k_t·s) (IF ${cat.interference.toFixed(4)})`,
      );
    }

    // the fleet FIELD must be the sum of its members' fields — the property the drag interaction relies on
    {
      const fg = { x0: -50, dx: 1, nx: 40, y0: -12, dy: 1, ny: 25 };
      const at = [
        { dx: 0, dy: 2.2 },
        { dx: 4.5, dy: -2.2 },
      ];
      const sp2 = spectrum(wig, G / (U2 * U2), g.theta);
      const both = waveField(
        at.map((a) => ({ re: sp2.re, im: sp2.im, at: a })),
        g,
        G / (U2 * U2),
        fg,
      );
      const a0 = waveField(
        [{ re: sp2.re, im: sp2.im, at: at[0] }],
        g,
        G / (U2 * U2),
        fg,
      );
      const a1 = waveField(
        [{ re: sp2.re, im: sp2.im, at: at[1] }],
        g,
        G / (U2 * U2),
        fg,
      );
      let worst = 0;
      for (let i = 0; i < both.z.length; i++)
        worst = Math.max(worst, Math.abs(both.z[i] - (a0.z[i] + a1.z[i])));
      ok(
        worst < 1e-14 * Math.max(both.max, 1e-30) + 1e-18,
        `the fleet field is the sum of its members' fields (worst ${worst.toExponential(2)} m)`,
      );
    }
  }
}

// ---------- 8. the speed sweep: is the sampling resolving the KERNEL, not just the hull? ----------
//
// This is the rung whose absence let a real bug ship. The convergence block below doubles each control at ONE
// speed, and at that speed the fixed baseline grid happens to be ample — so everything looked converged while
// R_w at Fn 0.08 was wrong by a factor of thirty-five.
//
// The kernel exp(i·ν·secθ·X) has wavelength 2π/(ν·secθ) and ν = g/U², so the demand on the grid grows as the
// speed FALLS: on this hull the kernel goes through 17 cycles along the waterline at Fn 0.33 and over a
// thousand at Fn 0.04. A grid fixed at the geometry's own scale silently aliases, and aliasing does not look
// like noise — it looks like a confident, large, wrong number.
//
// So: sweep the useful Froude range, and at each speed check the auto-sized sampling against a deliberately
// finer one. Any regression in sizeFor shows up here as a percentage, at the speed where it bites.
{
  const secMax = DEFAULT_SEC_MAX;
  const probe = sampleCenterplane(model, S)!;
  const Lw = probe.wettedLength;
  info(
    `sweeping Fn ${USEFUL_FROUDE[0]}–${USEFUL_FROUDE[1]} on a ${Lw.toFixed(2)} m waterline, cutoff sec ${secMax}`,
  );
  info(
    "   Fn      U      cycles   auto R_w    nodes  col/cyc   vs 2× finer   baseline error",
  );
  let worst = 0,
    worstFn = 0,
    everUnconverged = false;
  for (const froude of [0.1, 0.13, 0.17, 0.22, 0.3, 0.4, 0.55, 0.75, 1.0]) {
    const U = froude * Math.sqrt(G * Lw),
      nu = G / (U * U);
    const grid = thetaGrid(nu, Lw, thetaCutoff(secMax), 2.0);
    const auto = sampleForBandwidth(model, S, nu, secMax)!;
    const rAuto = waveResistance(auto.cp, { U, rho: RHO }, grid).rw;
    // the reference: the same rule at twice the nodes per cycle, uncapped
    const fine = sampleCenterplane(
      model,
      S,
      sizeFor(probe, nu, secMax, undefined, 2 * NODES_PER_CYCLE),
    )!;
    const rFine = waveResistance(fine, { U, rho: RHO }, grid).rw;
    // and what the bare geometry floor would have said, which is the bug being regressed against
    const rBase = waveResistance(probe, { U, rho: RHO }, grid).rw;
    const d = rel(rAuto, rFine);
    if (d > worst) {
      worst = d;
      worstFn = froude;
    }
    if (!auto.resolution.converged) everUnconverged = true;
    info(
      `  ${froude.toFixed(2)} ${U.toFixed(2).padStart(6)} ${((nu * Lw * secMax) / (2 * Math.PI)).toFixed(0).padStart(9)} ` +
        `${rAuto.toFixed(1).padStart(9)} ${String(auto.cp.nodes).padStart(8)} ` +
        `${auto.resolution.perCycleLong.toFixed(1).padStart(8)} ${(d * 100).toFixed(3).padStart(12)}% ` +
        `${(rel(rBase, rFine) * 100).toFixed(1).padStart(14)}%`,
    );
  }
  ok(
    worst < 0.01,
    `auto-sized R_w is within 1% of a 2×-finer grid across Fn ${USEFUL_FROUDE[0]}–${USEFUL_FROUDE[1]} ` +
      `(worst ${(worst * 100).toFixed(3)}% at Fn ${worstFn})`,
  );
  ok(
    !everUnconverged,
    "the sizing rule reports convergence at every speed in the useful range",
  );

  // The specific regression: the geometry floor alone, at the speed the failure was reported.
  {
    const froude = 0.083,
      U = froude * Math.sqrt(G * Lw),
      nu = G / (U * U);
    const grid = thetaGrid(nu, Lw, thetaCutoff(secMax), 2.0);
    const rBase = waveResistance(probe, { U, rho: RHO }, grid).rw;
    const auto = sampleForBandwidth(model, S, nu, secMax)!;
    const rAuto = waveResistance(auto.cp, { U, rho: RHO }, grid).rw;
    ok(
      rel(rBase, rAuto) > 1,
      `the fixed geometry grid really is wrong below the useful range — Fn ${froude}: ` +
        `${rBase.toFixed(0)} N against ${rAuto.toFixed(0)} N auto-sized (this is the bug being regressed)`,
    );
    ok(
      !inUsefulRange(froude),
      `Fn ${froude} is outside the range this reports on (${USEFUL_FROUDE[0]}–${USEFUL_FROUDE[1]})`,
    );
  }

  // and the sizing must actually track ν rather than returning a constant. Compared across speeds where the
  // geometry floor is not the binding constraint, uPanels should scale with ν — i.e. with 1/U².
  {
    const at = (U: number): ReturnType<typeof sizeFor> =>
      sizeFor(probe, G / (U * U), secMax);
    const us = [0.3, 0.6, 1.2, 2.4, 4.8];
    const panels = us.map((U) => at(U).uPanels);
    ok(
      panels.every((p, i) => i === 0 || p <= panels[i - 1]),
      `sizeFor's longitudinal grid falls monotonically with speed (${panels.join(" → ")} over U = ${us.join(", ")} m/s)`,
    );
    // halving the speed quadruples ν; below the floor the ladder should follow it within its own quantization
    const ratio = at(0.3).uPanels / at(0.6).uPanels;
    ok(
      ratio >= 2.5,
      `halving the speed multiplies the longitudinal grid by ${ratio.toFixed(1)} (ν quadruples; the ladder quantizes)`,
    );
    ok(
      at(0.3).vPanels > at(2.4).vPanels,
      `sizeFor also refines the section axis, which the station fan makes oscillatory ` +
        `(vPanels ${at(2.4).vPanels} → ${at(0.3).vPanels})`,
    );
  }
}

// ---------- 8b. the angular cutoff, and whether the tail estimate can be believed ----------
//
// Truncating the θ integral at some secMax throws away real resistance, and how much depends strongly on the
// Froude number: at a flat sec 8 the loss is half a percent at Fn 0.17 and SIX percent at Fn 1.0. So the
// cutoff follows Fn (secMaxFor), and this rung measures what is actually left behind — against a sec-46
// reference computed from one cloud per speed, so the differences are pure truncation.
//
// It also holds the reported `tail` to the one property that matters for a warning: it must not UNDER-report.
// The estimator it replaced was a two-point power-law fit through an oscillating density, and it under-read
// the Fn 1.0 tail by a factor of sixteen — the number looked converged while R_w was six percent light.
{
  const probe = sampleCenterplane(model, S)!;
  const Lw = probe.wettedLength;
  const REF_SEC = 46;
  info("  Fn   cutoff   truncation   reported tail   (must not under-report)");
  let worstMiss = 0,
    worstUnder = 0;
  for (const froude of [0.15, 0.25, 0.4, 0.6, 0.8, 1.0]) {
    const U = froude * Math.sqrt(G * Lw),
      nu = G / (U * U),
      cond = { U, rho: RHO };
    const secMax = secMaxFor(froude);
    // one cloud, resolved for the reference cutoff, so nothing here is a sampling difference
    const cp = sampleCenterplane(model, S, sizeFor(probe, nu, REF_SEC))!;
    const at = (sec: number): ReturnType<typeof waveResistance> =>
      waveResistance(cp, cond, thetaGrid(nu, Lw, thetaCutoff(sec), 2.0));
    const full = at(REF_SEC).rw,
      cut = at(secMax);
    const miss = (full - cut.rw) / full;
    worstMiss = Math.max(worstMiss, miss);
    worstUnder = Math.max(worstUnder, miss - cut.tail);
    info(
      `  ${froude.toFixed(2)} ${secMax.toFixed(1).padStart(7)} ${(miss * 100).toFixed(3).padStart(11)}% ` +
        `${(cut.tail * 100).toFixed(3).padStart(14)}%`,
    );
  }
  ok(
    worstMiss < 0.01,
    `the Froude-aware cutoff keeps the truncation under 1% across the useful range (worst ${(worstMiss * 100).toFixed(2)}%)`,
  );
  ok(
    worstUnder <= 0,
    `the reported tail never under-states the truncation (worst shortfall ${(worstUnder * 100).toFixed(3)} points)`,
  );

  // and the regression proper: a flat sec 8 is what silently loses six percent at the top of the range
  {
    const froude = 1.0,
      U = froude * Math.sqrt(G * Lw),
      nu = G / (U * U);
    const cp = sampleCenterplane(model, S, sizeFor(probe, nu, REF_SEC))!;
    const at = (sec: number): number =>
      waveResistance(
        cp,
        { U, rho: RHO },
        thetaGrid(nu, Lw, thetaCutoff(sec), 2.0),
      ).rw;
    const flat8 = (at(REF_SEC) - at(8)) / at(REF_SEC);
    ok(
      flat8 > 0.04,
      `a flat sec-8 cutoff really does lose ${(flat8 * 100).toFixed(1)}% at Fn 1.0 (this is the bug being regressed)`,
    );
    ok(
      secMaxFor(1.0) > 20 && secMaxFor(0.12) < 10,
      `secMaxFor follows the Froude number (sec ${secMaxFor(0.12).toFixed(1)} at Fn 0.12 → ${secMaxFor(1.0).toFixed(1)} at Fn 1.0)`,
    );
  }
}

// ---------- 9. convergence: every refinement control, doubled ----------
//
// §2.4 of the plan: report the change in R_w and in sampled F(θ) when each control is doubled. These are
// numerical-stability figures for the discretisation, NOT accuracy bounds on thin-ship theory.
{
  const probes = [0.2, 0.6, 1.0, 1.25]; // θ probes in radians (≈11°, 34°, 57°, 72°)
  const base: Partial<MichellOptions> = {};
  const measure = (
    opts: Partial<MichellOptions>,
    dPhase: number,
    secMax: number,
  ): { rw: number; f: number[]; nodes: number; ms: number } => {
    const t0 = performance.now();
    const c = sampleCenterplane(model, S, opts)!;
    const nu = G / (CU * CU);
    const grid = thetaGrid(nu, c.wettedLength, thetaCutoff(secMax), dPhase);
    const r = waveResistance(c, { U: CU, rho: RHO }, grid);
    const s = spectrum(c, nu, probes);
    const f: number[] = [];
    for (let i = 0; i < probes.length; i++)
      f.push(Math.hypot(s.re[i], s.im[i]));
    return { rw: r.rw, f, nodes: c.nodes, ms: performance.now() - t0 };
  };

  const ref = measure(base, 1.0, 11.5);
  info(
    `baseline: R_w ${ref.rw.toFixed(2)} N over ${ref.nodes} nodes, sample+spectrum+R_w in ${ref.ms.toFixed(0)} ms`,
  );
  const controls: [string, Partial<MichellOptions>, number, number][] = [
    ["longitudinal panels ×2", { uPanels: 192 }, 1.0, 11.5],
    ["longitudinal nodes ×2", { uNodes: 6 }, 1.0, 11.5],
    ["section nodes ×2", { vNodes: 8 }, 1.0, 11.5],
    ["waterline grading ×2", { wlGrade: 10 }, 1.0, 11.5],
    ["span scan ×2", { scanV: 128 }, 1.0, 11.5],
    ["θ panels ×2", {}, 0.5, 11.5],
    ["θ cutoff → sec 23", {}, 1.0, 23],
  ];
  let worstRw = 0,
    worstF = 0;
  for (const [name, opts, dPhase, secMax] of controls) {
    const m = measure(opts, dPhase, secMax);
    const dRw = rel(m.rw, ref.rw);
    let dF = 0;
    for (let i = 0; i < probes.length; i++)
      dF = Math.max(dF, rel(m.f[i], ref.f[i]));
    // the θ cutoff genuinely adds resistance rather than refining it — report it, don't hold it to tolerance
    if (!name.startsWith("θ cutoff")) {
      worstRw = Math.max(worstRw, dRw);
      worstF = Math.max(worstF, dF);
    }
    info(
      `${name.padEnd(26)} ΔR_w ${(dRw * 100).toExponential(2)}%   max Δ|F(θ)| ${(dF * 100).toExponential(2)}%   ` +
        `${m.nodes} nodes  (${m.ms.toFixed(0)} ms)`,
    );
  }
  ok(
    worstRw < 0.01,
    `R_w is stable to under 1% under every refinement (worst ${(worstRw * 100).toExponential(2)}%)`,
  );
  ok(
    worstF < 0.01,
    `|F(θ)| is stable to under 1% under every refinement (worst ${(worstF * 100).toExponential(2)}%)`,
  );
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
