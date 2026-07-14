// ---------- Holtrop-Mennen form factor (1+k1) ----------
//
// The viscous-pressure allowance on top of flat-plate skin friction (Holtrop & Mennen 1982), from a
// handful of hull ratios. It rises with beam and fullness — the beam-driven drag a bare ITTC-57 friction
// line and thin-ship (Michell) wave resistance both miss. Assumes a normal stern (Cstern = 0, c13 = 1);
// the full Holtrop total (savitsky-adjacent holtrop.ts) folds Cstern into its own inline copy, which is
// why the two are not shared. Pure scalars — no hull-representation dependency.
//
// C_P and LCB are clamped to Holtrop's fitted envelope (C_P 0.55–0.85, LCB −4%..+2%); beamy, full,
// aft-LCB hulls otherwise drive the length of run negative. The result is clamped to [1, 2] so a
// pathological geometry can't blow up. Returns 1 (no allowance) on degenerate input.

export interface FormFactorDims {
  lwl: number;
  beam: number;
  draft: number;
  cp: number; // prismatic coefficient
  lcbPct: number; // LCB as % of L forward of amidships (negative = aft)
}

export function formFactor(d: FormFactorDims): number {
  const { lwl: L, beam: B, draft: T } = d;
  if (!(L > 0 && B > 0 && T > 0) || !(d.cp > 0)) return 1;
  const cp = Math.min(0.85, Math.max(0.55, d.cp));
  const lcb = Math.min(2, Math.max(-4, d.lcbPct));
  const tl = T / L,
    c12 =
      tl > 0.05
        ? tl ** 0.2228446
        : tl > 0.02
          ? 48.2 * (tl - 0.02) ** 2.078 + 0.479948
          : 0.479948,
    // length of run, floored positive as a backstop
    lr = Math.max(L * (1 - cp + (0.06 * cp * lcb) / (4 * cp - 1)), 0.05 * L);
  const oneK =
    0.93 +
    c12 *
      (B / lr) ** 0.92497 *
      (0.95 - cp) ** -0.521448 *
      (1 - cp + 0.0225 * lcb) ** 0.6906;
  return Number.isFinite(oneK) ? Math.min(2, Math.max(1, oneK)) : 1;
}
