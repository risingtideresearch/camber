// ---------- monotone cubic Hermite (PCHIP) — interpolates without overshoot (used for the stations) ----------

export function pchipSlopes(xs: number[], ys: number[]): number[] {
  const n = xs.length,
    h = Array(n - 1),
    d = Array(n - 1),
    m = Array(n);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  if (n === 1) return [0];
  if (n === 2) return [d[0], d[0]];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1],
        w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  m[0] = pchipEnd(h[0], h[1], d[0], d[1]);
  m[n - 1] = pchipEnd(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

function pchipEnd(h0: number, h1: number, d0: number, d1: number): number {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(m) !== Math.sign(d0)) m = 0;
  else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > 3 * Math.abs(d0))
    m = 3 * d0;
  return m;
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
