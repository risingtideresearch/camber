// ---------- painting a Kelvin wave field ----------
//
// The numerics live in michell.ts; this is the one place that turns an elevation grid into pixels, so the
// editor's panel and the standalone fleet page render identically. Nothing here knows about React.
//
// Two choices worth stating, because both are about not lying to the eye:
//
//   • THE RAMP IS DIVERGING AND ZERO-CENTRED. Wave elevation is signed, and a sequential ramp would make a
//     trough and a crest of equal size look different. Blue below, warm above, a neutral mid-tone at exactly
//     ζ = 0, and the scale is symmetric — so still water is one flat colour and the eye reads sign directly.
//   • THE INVALID REGION IS FADED, NOT CROPPED. What michell.ts computes is the far-field FREE-WAVE part of
//     the linear solution. It is physical astern of the hulls and meaningless on or ahead of them, where the
//     local disturbance it omits is what would cancel it. Cropping there would suggest a boundary exists;
//     fading says "this is where the model stops", which is the truth.

import type { FieldGrid, FieldResult } from "./michell";

export interface WakePaint {
  // amplitude the ramp saturates at [m]. Omit to use a robust percentile of the field itself.
  scale?: number;
  // fade the field ahead of this X [m] — normally the aftmost hull's stern. Omit for no fade.
  validAft?: number;
  fadeLength?: number; // [m] over which the fade runs (default: one transverse wavelength)
  gamma?: number; // <1 lifts small ripples; 1 is linear (default 0.75)
}

// trough → still → crest. Deep indigo through a neutral slate to a warm amber: the mid-tone is dark enough
// that both ends read as "lit", so neither sign dominates the picture.
const RAMP: [number, number, number][] = [
  [12, 32, 76],
  [30, 82, 150],
  [96, 148, 196],
  [148, 158, 168],
  [206, 158, 106],
  [226, 118, 52],
  [140, 52, 22],
];

function ramp(t: number, out: [number, number, number]): void {
  const u = Math.max(0, Math.min(1, (t + 1) / 2)) * (RAMP.length - 1),
    i = Math.min(RAMP.length - 2, Math.floor(u)),
    f = u - i,
    a = RAMP[i],
    b = RAMP[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
}

// A robust amplitude scale: the 99.5th percentile of |ζ|, so one caustic spike near the cusp cannot wash the
// rest of the pattern flat. Sampled rather than sorted in full — the grids are large and this only sets a
// display scale.
export function robustScale(z: Float64Array, q = 0.995): number {
  const n = Math.min(z.length, 20000),
    step = Math.max(1, Math.floor(z.length / n));
  const s: number[] = [];
  for (let i = 0; i < z.length; i += step) s.push(Math.abs(z[i]));
  if (!s.length) return 1;
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] || 1;
}

// Paint the field into RGBA. `nx × ny` pixels, one per grid sample, row 0 = the grid's y0 row.
export function paintWake(
  field: FieldResult,
  fg: FieldGrid,
  nu: number,
  opts: WakePaint = {},
): ImageData {
  const scale = opts.scale ?? robustScale(field.z),
    gamma = opts.gamma ?? 0.75;
  const fadeLen = opts.fadeLength ?? (2 * Math.PI) / nu;
  const img = new ImageData(fg.nx, fg.ny);
  const d = img.data,
    c: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < fg.ny; j++)
    for (let i = 0; i < fg.nx; i++) {
      const k = j * fg.nx + i;
      let t = field.z[k] / scale;
      // soft-clip so the caustic saturates gracefully instead of clamping to a hard edge
      t = Math.sign(t) * Math.pow(Math.min(1, Math.abs(t)), gamma);
      ramp(t, c);
      let a = 1;
      if (opts.validAft !== undefined) {
        const over = fg.x0 + i * fg.dx - opts.validAft;
        if (over > 0) a = Math.max(0, 1 - over / fadeLen);
      }
      // fade toward the neutral mid-tone rather than toward transparent, so the panel has no holes in it
      const m = RAMP[3];
      d[k * 4] = c[0] * a + m[0] * (1 - a);
      d[k * 4 + 1] = c[1] * a + m[1] * (1 - a);
      d[k * 4 + 2] = c[2] * a + m[2] * (1 - a);
      d[k * 4 + 3] = 255;
    }
  return img;
}

// the ramp as CSS stops, for a legend
export function rampCss(): string {
  return RAMP.map(
    (c, i) =>
      `rgb(${c[0]},${c[1]},${c[2]}) ${((i / (RAMP.length - 1)) * 100).toFixed(0)}%`,
  ).join(", ");
}
