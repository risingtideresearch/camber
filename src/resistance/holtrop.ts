// ---------- Holtrop-Mennen resistance prediction ----------
//
// The statistical bare-hull resistance method of Holtrop & Mennen (1982, "An approximate power
// prediction method", ISP 29/335) with the 1984 wave-resistance re-analysis (Holtrop 1984, ISP 31/363).
// Unlike Michell's integral — which is a physics calculation off the actual offsets and captures a hull's
// individual humps/hollows but, being thin-ship, under-predicts the absolute level for beamy hulls — this
// is a regression over ~330 model tests that only sees bulk coefficients (B/L, C_P, C_B, LCB, i_E). Its
// job here is the ABSOLUTE LEVEL a beamy hull actually needs; Michell keeps the shape. See PowerPanel.
//
// Total resistance decomposes as
//   R_total = R_F·(1+k1) + R_APP + R_W + R_B + R_TR + R_A.
// Everything is at FULL SCALE (real L and V) — Holtrop is not scale-free (C_F is a Reynolds function and
// R_W carries an absolute ∇ρg), so feed it the real ship, not model units.
//
// Transcription traps this code is careful about (they bite everyone):
//   • c2 and c3 are frequently PRINTED SWAPPED in secondary sources; c3 is the small (~0.02) bulb term,
//     c2 = exp(−1.89√c3) is the ~0.76 multiplier.
//   • c15 is NEGATIVE (−1.69385); some tables drop the sign.
//   • the 1982 oscillatory coefficient m2 = c15·C_P²·exp(−0.1·Fn⁻²) differs from the 1984 replacement
//     m4 = c15·0.4·exp(−0.034·Fn⁻³·²⁹); the published 1982 worked example needs m2, so `variant` selects.
//   • seawater ν = 1.18831e-6 m²/s (the freshwater value will not reproduce the example's C_F).
//   • lcb is a PERCENTAGE of L, positive FORWARD of amidships (negative = aft).
//
// Validated against the [HM82] L=205 m tanker example in test/holtrop.ts.

const G = 9.81; // Holtrop's calibration gravity
const RHO = { salt: 1025, fresh: 1000 }; // kg/m³
const NU = { salt: 1.18831e-6, fresh: 1.13902e-6 }; // m²/s at 15 °C (ITTC)

export interface HoltropShip {
  L: number; // waterline length (m)
  B: number; // waterline beam (m)
  T: number; // draft T (m); trim-by-stern ignored, T_F = T_A = T
  vol: number; // ∇ displaced volume (m³)
  cp: number; // prismatic coefficient
  cm: number; // midship-section coefficient
  cwp: number; // waterplane-area coefficient
  lcb: number; // LCB as % of L forward of amidships (negative = aft)
  S?: number; // wetted surface (m²); omit or ≤0 to use the Holtrop estimate
  iE?: number; // half-angle of entrance (deg); omit to use the Holtrop estimate
  aT?: number; // immersed transom area A_T (m²), default 0 (no transom)
  aBT?: number; // transverse bulb area at the FP A_BT (m²), default 0 (no bulb)
  hB?: number; // height of the bulb-area centroid above the keel (m), default 0
  cStern?: number; // afterbody shape: −25 pram, −10 V, 0 normal, +10 U/Hogner (default 0)
  sApp?: number; // appendage wetted area (m²), default 0
  kApp?: number; // appendage form factor (1+k2), default 1.5
  salt?: boolean; // seawater (default true)
}

export interface HoltropResult {
  rf: number; // bare frictional resistance R_F (N)
  rvisc: number; // R_F·(1+k1) — friction with form factor (N)
  rapp: number; // appendage resistance (N)
  rw: number; // wave resistance (N)
  rb: number; // bulbous-bow pressure resistance (N)
  rtr: number; // transom-immersion resistance (N)
  ra: number; // model-ship correlation resistance (N)
  rTotal: number; // sum of the above (N)
  cf: number; // ITTC-57 friction coefficient
  formK: number; // 1 + k1
  iE: number; // half-angle of entrance actually used (deg)
  S: number; // wetted surface actually used (m²)
  fn: number; // Froude number
  rn: number; // Reynolds number
  inRange: boolean; // false when the hull sits outside Holtrop's fitted envelope (result is extrapolated)
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

// Holtrop's fitted envelope (roughly): C_P 0.55–0.85, L/B 3.9–15, LCB −4%..+2% of L. Outside it the
// regression has no data and its length-of-run / form-factor terms can go negative or blow up. We clamp
// the most sensitive inputs to this envelope so the method degrades to "the nearest in-range hull"
// rather than returning NaN — an honest extrapolation, flagged via `inRange`.
const CP_RANGE = [0.55, 0.85] as const;
const LCB_RANGE = [-4, 2] as const;
const LB_RANGE = [3.9, 15] as const;

// Holtrop's wetted-surface estimate — used only when no measured S is supplied.
export function holtropWettedArea(s: HoltropShip): number {
  const { L, B, T, cm, cwp } = s;
  const cb = s.vol / (L * B * T);
  const aBT = s.aBT ?? 0;
  return (
    L *
      (2 * T + B) *
      Math.sqrt(cm) *
      (0.453 + 0.4425 * cb - 0.2862 * cm - 0.003467 * (B / T) + 0.3696 * cwp) +
    2.38 * (aBT / cb)
  );
}

// Full resistance at speed V (m/s). `variant` picks the wave-resistance oscillatory term / regime:
// "1984" (default) adds the high-Froude regime and the m4/m3/c17 re-analysis; "1982" is the original
// (m2, low-speed only) needed to reproduce the published worked example.
export function holtrop(
  s: HoltropShip,
  V: number,
  variant: "1982" | "1984" = "1984",
): HoltropResult {
  const { L, B, T, vol, cm, cwp } = s;
  // clamp the regression's sensitive inputs to the fitted envelope (see CP_RANGE etc.); beamy hulls with
  // LCB well aft otherwise drive the length-of-run negative → NaN. `inRange` records whether any clamp bit.
  const cp = clamp(s.cp, CP_RANGE[0], CP_RANGE[1]);
  const lcb = clamp(s.lcb, LCB_RANGE[0], LCB_RANGE[1]);
  const inRange =
    s.cp === cp &&
    s.lcb === lcb &&
    L / B >= LB_RANGE[0] &&
    L / B <= LB_RANGE[1];
  const salt = s.salt ?? true;
  const rho = RHO[salt ? "salt" : "fresh"];
  const nu = NU[salt ? "salt" : "fresh"];
  const aT = s.aT ?? 0;
  const aBT = s.aBT ?? 0;
  const hB = s.hB ?? 0;
  const cStern = s.cStern ?? 0;

  const cb = vol / (L * B * T);
  const S = s.S && s.S > 0 ? s.S : holtropWettedArea(s);
  const fn = V / Math.sqrt(G * L);
  const rn = (V * L) / nu;
  const q = 0.5 * rho * V * V; // dynamic pressure ½ρV²

  // ---- friction (ITTC-57) + form factor (1+k1) ----
  const cf = 0.075 / (Math.log10(rn) - 2) ** 2;
  const rf = q * S * cf;

  const tl = T / L;
  const c12 =
    tl > 0.05
      ? tl ** 0.2228446
      : tl > 0.02
        ? 48.2 * (tl - 0.02) ** 2.078 + 0.479948
        : 0.479948;
  const c13 = 1 + 0.003 * cStern;
  // length of run, floored to a small positive length so a pathological (extrapolated) geometry can't
  // drive B/lr negative and NaN the fractional power
  const lr = Math.max(
    L * (1 - cp + (0.06 * cp * lcb) / (4 * cp - 1)),
    0.05 * L,
  );
  const formK = clamp(
    c13 *
      (0.93 +
        c12 *
          (B / lr) ** 0.92497 *
          (0.95 - cp) ** -0.521448 *
          (1 - cp + 0.0225 * lcb) ** 0.6906),
    1,
    2,
  );
  const rvisc = rf * formK;

  // ---- appendages ----
  const sApp = s.sApp ?? 0;
  const kApp = s.kApp ?? 1.5;
  const rapp = sApp > 0 ? q * kApp * sApp * cf : 0;

  // ---- half-angle of entrance (estimate when not measured) ----
  const iE =
    s.iE != null && Number.isFinite(s.iE)
      ? s.iE
      : 1 +
        89 *
          Math.exp(
            -((L / B) ** 0.80856) *
              (1 - cwp) ** 0.30484 *
              (1 - cp - 0.0225 * lcb) ** 0.6367 *
              (lr / B) ** 0.34574 *
              ((100 * vol) / L ** 3) ** 0.16302,
          );

  // ---- wave resistance ----
  const c7 =
    B / L < 0.11
      ? 0.229577 * (B / L) ** 0.33333
      : B / L > 0.25
        ? 0.5 - 0.0625 * (L / B)
        : B / L;
  const c1 =
    2223105 * c7 ** 3.78613 * (T / B) ** 1.07961 * (90 - iE) ** -1.37565;
  // c3 (small bulb term) → c2; NOT the other way round
  const c3 =
    aBT > 0
      ? (0.56 * aBT ** 1.5) / (B * T * (0.31 * Math.sqrt(aBT) + T - hB))
      : 0;
  const c2 = Math.exp(-1.89 * Math.sqrt(c3));
  const c5 = 1 - (0.8 * aT) / (B * T * cm);

  const c16 =
    cp < 0.8
      ? 8.07981 * cp - 13.8673 * cp ** 2 + 6.984388 * cp ** 3
      : 1.73014 - 0.7067 * cp;
  const m1 =
    0.0140407 * (L / T) -
    (1.75254 * vol ** (1 / 3)) / L -
    4.79323 * (B / L) -
    c16;
  const lambda = L / B < 12 ? 1.446 * cp - 0.03 * (L / B) : 1.446 * cp - 0.36;

  const lv = L ** 3 / vol;
  const c15 =
    lv < 512
      ? -1.69385
      : lv <= 1727
        ? -1.69385 + (L / vol ** (1 / 3) - 8) / 2.36
        : 0;
  // (L/B − 2) floored so a very beamy hull (L/B < 2) can't NaN this high-speed term
  const c17 =
    6919.3 *
    cm ** -1.3346 *
    (vol / L ** 3) ** 2.00977 *
    Math.max(L / B - 2, 0.01) ** 1.40692;
  const m3 = -7.2035 * (B / L) ** 0.326869 * (T / B) ** 0.605375;

  const volRhoG = vol * rho * G;
  const d = -0.9;
  // oscillatory coefficient: 1982 m2 vs 1984 m4
  const mOsc = (f: number): number =>
    variant === "1982"
      ? c15 * cp ** 2 * Math.exp(-0.1 * f ** -2)
      : c15 * 0.4 * Math.exp(-0.034 * f ** -3.29);
  const rwLow = (f: number): number =>
    c1 *
    c2 *
    c5 *
    volRhoG *
    Math.exp(m1 * f ** d + mOsc(f) * Math.cos(lambda * f ** -2));
  const rwHigh = (f: number): number =>
    c17 *
    c2 *
    c5 *
    volRhoG *
    Math.exp(m3 * f ** d + mOsc(f) * Math.cos(lambda * f ** -2));

  let rw: number;
  if (variant === "1982" || fn <= 0.4) rw = rwLow(fn);
  else if (fn >= 0.55) rw = rwHigh(fn);
  else rw = rwLow(0.4) + ((10 * fn - 4) * (rwHigh(0.55) - rwLow(0.4))) / 1.5;

  // ---- bulbous-bow pressure resistance ----
  let rb = 0;
  if (aBT > 0 && T - 1.5 * hB > 0) {
    const pB = (0.56 * Math.sqrt(aBT)) / (T - 1.5 * hB);
    const fri =
      V / Math.sqrt(G * (T - hB - 0.25 * Math.sqrt(aBT)) + 0.15 * V * V);
    rb =
      (0.11 * Math.exp(-3 * pB ** -2) * fri ** 3 * aBT ** 1.5 * rho * G) /
      (1 + fri ** 2);
  }

  // ---- transom-immersion resistance ----
  let rtr = 0;
  if (aT > 0) {
    const fnT = V / Math.sqrt((2 * G * aT) / (B + B * cwp));
    const c6 = fnT < 5 ? 0.2 * (1 - 0.2 * fnT) : 0;
    rtr = q * aT * c6;
  }

  // ---- model-ship correlation ----
  const c4 = T / L > 0.04 ? 0.04 : T / L;
  const ca =
    0.006 * (L + 100) ** -0.16 -
    0.00205 +
    0.003 * Math.sqrt(L / 7.5) * cb ** 4 * c2 * (0.04 - c4);
  const ra = q * S * ca;

  const rTotal = rvisc + rapp + rw + rb + rtr + ra;
  return {
    rf,
    rvisc,
    rapp,
    rw,
    rb,
    rtr,
    ra,
    rTotal,
    cf,
    formK,
    iE,
    S,
    fn,
    rn,
    inRange,
  };
}
