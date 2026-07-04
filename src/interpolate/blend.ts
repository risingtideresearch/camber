// ---------- the blend math: a convex combination of a hull family, plus the barycentric blend control ----------
//
// A blend of variants V₁…Vₙ with weights wᵢ ≥ 0, Σwᵢ = 1 is `Σ wᵢ·Vᵢ`, taken componentwise over the shared
// topology (the exported JSON stores absolute coordinates, and a convex combination of strictly-ordered
// absolute sequences is itself strictly ordered, so blending absolutes is valid). Blending is defined only
// within one topology, so promoteFamily() must first lift the family to a common form.
//
// The blend control is a position → weight map: a 1-D slider for two hulls, a barycentric polygon "pad" for
// three or more (mean-value coordinates over the vertices). Every interior point is a valid blend, which is
// what lets the metric heatmap / scatter sample the whole space on a grid.

import { clamp } from "../core/math";
import {
  L,
  prepare,
  type Model,
  type Sheer,
  type StationCP,
} from "../core/model";
import { hydrostatics, type Hydro } from "../core/hydro";
import type { HullData } from "../core/json";

// a loaded hull: a name plus its decoded absolute-coordinate data. Weights are NOT stored here — they are
// derived from the blend-control position (weightsFromControl), keeping the control the single source of truth.
export interface Hull {
  name: string;
  data: HullData;
}

// ---------- the blend: Σ wᵢ·Vᵢ componentwise over the shared topology → the given model ----------
export function blend(model: Model, hulls: Hull[], weights: number[]): void {
  const total = weights.reduce((a, x) => a + x, 0) || 1;
  const w = weights.map((x) => x / total); // normalize to Σ = 1 (barycentric)

  const plan = hulls[0].data.cp.map((cp0, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.cp[i].x, 0),
    y: hulls.reduce((a, h, k) => a + w[k] * h.data.cp[i].y, 0),
    // the blend weights ride on the station — a convex blend of simplex points is itself in the simplex
    w: cp0.w.map((_, j) =>
      hulls.reduce((a, h, k) => a + w[k] * h.data.cp[i].w[j], 0),
    ),
  }));
  const trim = hulls[0].data.trim.map((_, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.trim[i].x, 0),
    z: hulls.reduce((a, h, k) => a + w[k] * h.data.trim[i].z, 0),
    k: hulls.reduce((a, h, kk) => a + w[kk] * h.data.trim[i].k, 0),
  }));
  const transom = hulls[0].data.transom.map((_, i) => ({
    x: hulls.reduce((a, h, k) => a + w[k] * h.data.transom[i].x, 0),
    z: hulls.reduce((a, h, k) => a + w[k] * h.data.transom[i].z, 0),
  }));
  // each template j, blended point-for-point across the family (templates are index-aligned)
  const templates: StationCP[][] = hulls[0].data.templates.map((tpl, j) =>
    tpl.map((_, i) => ({
      n: hulls.reduce((a, h, k) => a + w[k] * h.data.templates[j][i].n, 0),
      d: hulls.reduce((a, h, k) => a + w[k] * h.data.templates[j][i].d, 0),
      k: hulls.reduce((a, h, kk) => a + w[kk] * h.data.templates[j][i].k, 0),
    })),
  );
  model.sheer = { cp: plan, trim, transom, yf: () => 0, zf: () => 0 } as Sheer;
  model.templates = templates;
}

// ---------- the blend control: a slider param (2 hulls) / a polygon pad puck (3+ hulls) ----------
export const PAD = 260,
  PADC = PAD / 2,
  PADR = 96; // polygon circumradius (leaves a margin for the vertex dots)
export type Pt = { x: number; y: number };

// the regular-polygon vertices for n hulls (vertex 0 at the top, going clockwise)
export function padVerts(n: number): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { x: PADC + PADR * Math.cos(a), y: PADC + PADR * Math.sin(a) };
  });
}
// inside the (convex) polygon? winding-agnostic: inside ⇔ all edge cross-products share one sign
export function insidePoly(p: Pt, V: Pt[]): boolean {
  let pos = false,
    neg = false;
  for (let i = 0; i < V.length; i++) {
    const j = (i + 1) % V.length,
      cr =
        (V[j].x - V[i].x) * (p.y - V[i].y) - (V[j].y - V[i].y) * (p.x - V[i].x);
    if (cr > 1e-9) pos = true;
    else if (cr < -1e-9) neg = true;
  }
  return !(pos && neg);
}
// clamp p into the polygon (project onto the nearest edge), nudged a hair inward so the mean-value formula
// never sees a point exactly on an edge (where an angle → π and tan blows up)
export function clampPoly(p: Pt, V: Pt[]): Pt {
  let q = p;
  if (!insidePoly(p, V)) {
    let bd = Infinity;
    for (let i = 0; i < V.length; i++) {
      const a = V[i],
        b = V[(i + 1) % V.length],
        dx = b.x - a.x,
        dy = b.y - a.y,
        t = clamp(
          ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
          0,
          1,
        ),
        cx = a.x + t * dx,
        cy = a.y + t * dy,
        d = (cx - p.x) ** 2 + (cy - p.y) ** 2;
      if (d < bd) {
        bd = d;
        q = { x: cx, y: cy };
      }
    }
  }
  return { x: q.x + (PADC - q.x) * 1e-3, y: q.y + (PADC - q.y) * 1e-3 };
}
// mean-value coordinates of p w.r.t. polygon V — non-negative, summing to 1 inside a convex V, reducing to
// ordinary barycentric coordinates when V is a triangle
export function meanValue(p: Pt, V: Pt[]): number[] {
  const n = V.length,
    s = V.map((v) => ({ x: v.x - p.x, y: v.y - p.y })),
    r = s.map((d) => Math.hypot(d.x, d.y));
  for (let i = 0; i < n; i++)
    if (r[i] < 1e-6) return V.map((_, k) => (k === i ? 1 : 0));
  const half: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n,
      dot = s[i].x * s[j].x + s[i].y * s[j].y,
      crs = s[i].x * s[j].y - s[i].y * s[j].x;
    half[i] = Math.tan(Math.atan2(Math.abs(crs), dot) / 2);
  }
  let sum = 0;
  const w = V.map((_, i) => {
    const wi = (half[(i - 1 + n) % n] + half[i]) / r[i];
    sum += wi;
    return wi;
  });
  return w.map((x) => x / (sum || 1));
}

// the hull weights implied by the current control position (barycentric — non-negative, Σ = 1)
export function weightsFromControl(
  n: number,
  tTwo: number,
  puck: Pt,
): number[] {
  if (n === 2) return [1 - tTwo, tTwo];
  if (n >= 3) return meanValue(puck, padVerts(n));
  if (n === 1) return [1];
  return [];
}

// ---------- blend-space sampling (feeds both the heatmap and the scatter explorer) ----------
// One expensive pass per family: sample the blend space (the polygon interior for 3+ hulls, the slider param
// for 2) and store the full hydrostatics at each sample. The heatmap colours the pad by one metric; the
// scatter plots two metrics against each other. Resampled only when the family changes. A dedicated scratch
// model is used so the live blend is never disturbed.
export interface Sample {
  gx: number;
  gy: number; // pad grid cell (3+ hulls)
  pos: Pt; // pad position (3+ hulls)
  t: number; // slider param (2 hulls)
  h: Hydro | null;
}
export const HEAT_G = 31; // pad grid resolution (cells per side) — ~3× the samples of an 18-grid (count ∝ G²)
const SAMPLE_NS = 72, // hydrostatics resolution for the sampling pass (the live metrics panel uses full
  SAMPLE_M = 20; //     resolution). The per-cell cost is dominated by blend()+prepare(), not this, so the
//                       grid runs ~1 s (triangle) to ~3 s (pentagon) — done off the critical path.

export function computeSamples(model: Model, hulls: Hull[]): Sample[] {
  const samples: Sample[] = [];
  const n = hulls.length;
  if (n < 2) return samples;
  if (n === 2) {
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      blend(model, hulls, [1 - t, t]);
      prepare(model);
      samples.push({
        gx: i,
        gy: 0,
        pos: { x: 0, y: 0 },
        t,
        h: hydrostatics(model, SAMPLE_NS, SAMPLE_M),
      });
    }
  } else {
    const V = padVerts(n),
      cell = PAD / HEAT_G;
    for (let gy = 0; gy < HEAT_G; gy++)
      for (let gx = 0; gx < HEAT_G; gx++) {
        const cx = (gx + 0.5) * cell,
          cy = (gy + 0.5) * cell;
        if (!insidePoly({ x: cx, y: cy }, V)) continue;
        blend(model, hulls, meanValue({ x: cx, y: cy }, V));
        prepare(model);
        samples.push({
          gx,
          gy,
          pos: { x: cx, y: cy },
          t: 0,
          h: hydrostatics(model, SAMPLE_NS, SAMPLE_M),
        });
      }
  }
  return samples;
}

// the model's fixed length re-exported for callers that scale the readout
export { L };
