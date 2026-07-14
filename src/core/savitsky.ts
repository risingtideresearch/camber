// ---------- Savitsky planing resistance ----------
//
// The Savitsky (1964, "Hydrodynamic Design of Planing Hulls", Marine Technology 1/4) prismatic-planing
// method: the resistance branch for a hull up on plane, which neither Michell (thin-ship displacement
// wave resistance) nor Holtrop (displacement-ship regression) can see, because planing drag comes from
// dynamic lift on a trimmed bottom, not from making waves. This is the high-Froude method in the blend.
//
// The hull is idealized as a prismatic planing surface of beam b and deadrise β. At speed V the running
// trim τ and mean wetted length-to-beam ratio λ are found from two equilibrium conditions:
//   • lift = weight — fixes the load coefficient C_Lβ = W / (½ρV²b²), hence (via the deadrise
//     correction) the zero-deadrise C_L0, which the empirical lift law ties to (τ, λ);
//   • moment about the CG = 0 — with thrust along the keel through the CG this reduces to the
//     longitudinal centre of pressure sitting under the CG: l_p = LCG.
// Because the centre-of-pressure law depends only on C_V and λ, the moment condition is a 1-D solve for
// λ; C_L0 then gives τ directly. Total drag is the sum of the induced/pressure part W·tanτ and the skin
// friction on the wetted bottom projected to the horizontal, D = W·tanτ + R_f/cosτ.
//
// Validated in test/savitsky.ts against the OpenPlaning library (a tested Python implementation) run in
// its base Savitsky-'64 configuration, over the planing speed range — τ, λ and V_m to a couple of
// percent. Total drag runs a few percent under OpenPlaning because this base method omits whisker-spray
// drag and the wave-rise wetted-length correction (both Savitsky-Brown '76 additions) — a known,
// documented gap, acceptable for a first-order planing estimate and the blend's high-speed anchor.
//
// Everything is full-scale SI. Savitsky's lift law takes τ in DEGREES (the 1.1 exponent is calibrated
// that way); tan/cos take radians — the code is explicit about which is which.

const G = 9.8066; // Savitsky's calibration gravity
const RHO = { salt: 1025, fresh: 1000 }; // kg/m³
const NU = { salt: 1.18831e-6, fresh: 1.13902e-6 }; // m²/s at 15 °C (ITTC)

export interface SavitskyShip {
  weight: number; // W, displacement as a force (N)
  beam: number; // b, planing (chine) beam (m)
  beta: number; // deadrise (deg)
  lcg: number; // longitudinal centre of gravity, forward of the transom (m)
  salt?: boolean; // seawater (default true)
}

export interface SavitskyResult {
  fnB: number; // beam Froude / speed coefficient C_V = V/√(gb)
  fnVol: number; // volumetric Froude number V/√(g·∇^⅓) — the regime indicator for the blend
  tau: number; // running trim (deg)
  lambda: number; // mean wetted length-to-beam ratio
  vm: number; // mean bottom velocity (m/s)
  cLbeta: number; // load coefficient C_Lβ
  cL0: number; // zero-deadrise lift coefficient
  cp: number; // centre-of-pressure fraction l_p/(λb)
  cf: number; // ITTC-57 friction coefficient (on V_m)
  rFric: number; // skin-friction drag component (N)
  rInduced: number; // induced/pressure drag W·tanτ (N)
  rTotal: number; // total bare-hull resistance (N)
  inRange: boolean; // false when outside Savitsky's tested envelope (not yet planing / extreme trim)
}

// solve f(x)=target on [lo,hi] by bisection (f monotonic over the bracket); returns the clamped bracket
// end if the target lies outside f's range there
const bisect = (
  f: (x: number) => number,
  target: number,
  lo: number,
  hi: number,
  iters = 60,
): number => {
  let flo = f(lo) - target;
  const fhi = f(hi) - target;
  if (flo * fhi > 0) return Math.abs(flo) < Math.abs(fhi) ? lo : hi; // no sign change → nearest end
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi),
      fm = f(mid) - target;
    if (fm === 0) return mid;
    if (flo * fm < 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return 0.5 * (lo + hi);
};

// centre-of-pressure fraction l_p/(λb) (Savitsky 1964)
const cpFrac = (cv: number, lambda: number): number =>
  0.75 - 1 / (5.21 * (cv / lambda) ** 2 + 2.39);

// Savitsky resistance at speed V (m/s).
export function savitsky(s: SavitskyShip, V: number): SavitskyResult {
  const { weight: W, beam: b, beta, lcg } = s;
  const salt = s.salt ?? true;
  const rho = RHO[salt ? "salt" : "fresh"];
  const nu = NU[salt ? "salt" : "fresh"];

  const cv = V / Math.sqrt(G * b); // beam Froude / speed coefficient C_V
  const vol = W / (rho * G); // displaced volume, for the volumetric Froude number
  const fnVol = V / Math.sqrt(G * Math.cbrt(vol));
  const cLbeta = W / (0.5 * rho * V * V * b * b); // load coefficient (lift = weight)

  // zero-deadrise lift from the deadrise correction  C_Lβ = C_L0 − 0.0065·β·C_L0^0.6  (solve for C_L0)
  const cL0 = bisect(
    (c) => c - 0.0065 * beta * c ** 0.6,
    cLbeta,
    cLbeta,
    cLbeta + 0.0065 * beta * (cLbeta + 1) ** 0.6 + 1,
  );

  // moment balance → centre of pressure under the CG: cpFrac(C_V,λ)·λ·b = LCG. cpFrac·λ rises with λ,
  // so bisect λ over a physical bracket.
  const lambda = bisect((lam) => cpFrac(cv, lam) * lam * b, lcg, 0.2, 12);

  // lift law  C_L0 = τ^1.1·(0.0120·√λ + 0.0055·λ^2.5/C_V²)  → τ (degrees), λ now known
  const liftGeom =
    0.012 * Math.sqrt(lambda) + (0.0055 * lambda ** 2.5) / cv ** 2;
  const tau = (cL0 / liftGeom) ** (1 / 1.1); // degrees
  const tauR = (tau * Math.PI) / 180;

  // mean bottom velocity: V reduced by the (deadrise-corrected) dynamic lift spread over the bottom
  const dyn = 0.012 * tau ** 1.1 * Math.sqrt(lambda);
  const vm =
    V *
    Math.sqrt(
      Math.max(
        0,
        1 - (dyn - 0.0065 * beta * dyn ** 0.6) / (lambda * Math.cos(tauR)),
      ),
    );

  // skin friction on the wetted bottom (area λb²), ITTC-57 on the mean velocity
  const rn = (vm * lambda * b) / nu;
  const cf = 0.075 / (Math.log10(rn) - 2) ** 2;
  const rFric = 0.5 * rho * vm * vm * lambda * b * b * cf;

  const rInduced = W * Math.tan(tauR);
  const rTotal = rInduced + rFric / Math.cos(tauR);

  // Savitsky (1964) tested envelope: planing (C_V ≳ 1), trim ~2–15°, λ ≲ 4
  const inRange = cv >= 1 && tau >= 2 && tau <= 15 && lambda <= 4;

  return {
    fnB: cv,
    fnVol,
    tau,
    lambda,
    vm,
    cLbeta,
    cL0,
    cp: cpFrac(cv, lambda),
    cf,
    rFric,
    rInduced,
    rTotal,
    inRange,
  };
}
