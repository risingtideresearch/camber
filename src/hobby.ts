// ---------- Hobby curve (open, tension 1, curl 1) — used for the sheer line ----------

import { clamp, type Vec2 } from "./math.js";

interface HobbySeg {
  P0: Vec2;
  P1: Vec2;
  P2: Vec2;
  P3: Vec2;
}

function hobbyF(theta: number, phi: number): number {
  // metafont velocity function
  const st = Math.sin(theta),
    ct = Math.cos(theta),
    sp = Math.sin(phi),
    cp = Math.cos(phi);
  const num = 2 + Math.SQRT2 * (st - sp / 16) * (sp - st / 16) * (ct - cp);
  const den =
    3 * (1 + 0.5 * (Math.sqrt(5) - 1) * ct + 0.5 * (3 - Math.sqrt(5)) * cp);
  return num / den;
}

function angReduce(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function hobbySegs(pts: Vec2[]): HobbySeg[] {
  const K = pts.length - 1; // segments 0..K-1, knots 0..K
  if (K < 1) return [];
  const dx: number[] = [],
    dy: number[] = [],
    d: number[] = [],
    om: number[] = [];
  for (let i = 0; i < K; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    d[i] = Math.hypot(dx[i], dy[i]);
    om[i] = Math.atan2(dy[i], dx[i]);
  }
  const psi = [0]; // psi[i] = turn at interior knot i
  for (let i = 1; i < K; i++) psi[i] = angReduce(om[i] - om[i - 1]);
  let theta: number[] = [],
    phi: number[] = [];
  if (K === 1) {
    theta = [0];
    phi = [0];
  } else {
    const N = K + 1,
      a = Array(N).fill(0),
      b = Array(N).fill(0),
      c = Array(N).fill(0),
      r = Array(N).fill(0);
    b[0] = 1;
    c[0] = 1;
    r[0] = -psi[1]; // start curl: v0 + v1 = -psi1
    for (let k = 1; k <= K - 1; k++) {
      // mock-curvature continuity at knot k
      const psk1 = k + 1 <= K - 1 ? psi[k + 1] : 0;
      a[k] = 1 / d[k - 1];
      b[k] = 2 * (1 / d[k - 1] + 1 / d[k]);
      c[k] = 1 / d[k];
      r[k] = (-2 * psi[k]) / d[k - 1] - psk1 / d[k];
    }
    a[K] = 1;
    b[K] = 1;
    r[K] = 0; // end curl: v_{K-1} + v_K = 0
    for (let i = 1; i < N; i++) {
      const mi = a[i] / b[i - 1];
      b[i] -= mi * c[i - 1];
      r[i] -= mi * r[i - 1];
    }
    const v = Array(N);
    v[N - 1] = r[N - 1] / b[N - 1];
    for (let i = N - 2; i >= 0; i--) v[i] = (r[i] - c[i] * v[i + 1]) / b[i];
    for (let i = 0; i < K; i++) theta[i] = v[i];
    for (let i = 0; i < K - 1; i++) phi[i] = v[i + 1] + psi[i + 1];
    phi[K - 1] = v[K];
  }
  const segs: HobbySeg[] = [];
  for (let i = 0; i < K; i++) {
    const rho = hobbyF(theta[i], phi[i]),
      sig = hobbyF(phi[i], theta[i]);
    const aS = om[i] + theta[i],
      aE = om[i] + phi[i],
      P0 = pts[i],
      P3 = pts[i + 1];
    segs.push({
      P0,
      P3,
      P1: [
        P0[0] + rho * d[i] * Math.cos(aS),
        P0[1] + rho * d[i] * Math.sin(aS),
      ],
      P2: [
        P3[0] - sig * d[i] * Math.cos(aE),
        P3[1] - sig * d[i] * Math.sin(aE),
      ],
    });
  }
  return segs;
}

// sample a Hobby curve into a monotone-in-x table, then give back y(x) by linear interpolation
export function hobbySamplerX(pts: Vec2[]): (x: number) => number {
  const segs = hobbySegs(pts);
  if (!segs.length) {
    const y = pts.length ? pts[0][1] : 0;
    return () => y;
  }
  const xs: number[] = [],
    ys: number[] = [],
    SUB = 24;
  for (const s of segs)
    for (let i = 0; i <= SUB; i++) {
      const t = i / SUB,
        u = 1 - t;
      const x =
        u * u * u * s.P0[0] +
        3 * u * u * t * s.P1[0] +
        3 * u * t * t * s.P2[0] +
        t * t * t * s.P3[0];
      const y =
        u * u * u * s.P0[1] +
        3 * u * u * t * s.P1[1] +
        3 * u * t * t * s.P2[1] +
        t * t * t * s.P3[1];
      if (xs.length && x <= xs[xs.length - 1]) continue; // keep strictly increasing for inversion
      xs.push(x);
      ys.push(y);
    }
  const lo = xs[0],
    hi = xs[xs.length - 1];
  return (x: number) => {
    x = clamp(x, lo, hi);
    let i = 0;
    while (i < xs.length - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / (xs[i + 1] - xs[i] || 1);
    return ys[i] + (ys[i + 1] - ys[i]) * t;
  };
}
