// ---------- the blend math: a convex combination of a hull family, plus the barycentric blend control ----------
//
// A blend of variants V₁…Vₙ with weights wᵢ ≥ 0, Σwᵢ = 1 is `Σ wᵢ·Vᵢ`, taken componentwise over the shared
// topology (the document stores absolute coordinates, and a convex combination of strictly-ordered absolute
// sequences is itself strictly ordered, so blending absolutes is valid — and that is what keeps every blend a
// well-formed hull: the plan's x, the trim's x, and the stations' u all stay strictly increasing).
//
// Blending is defined only within one topology and one unit, so promoteFamily() must first lift the family to
// a common form; the blend then carries the family's (i.e. the first hull's) unit.
//
// A station's u blends like everything else, so the sections travel along the hull between the variants. That
// only means anything because the family is index-aligned by CORRESPONDENCE — station j of every hull is the
// same place on the boat (see promote.ts) — otherwise the blend would mix a bow section into a stern one.
//
// The blend control is a position → weight map: a 1-D slider for two hulls, a barycentric polygon "pad" for
// three or more (mean-value coordinates over the vertices). Every interior point is a valid blend, which is
// what lets the metric heatmap / scatter sample the whole space on a grid.

import { clamp } from "../core/math";
import { captureViewLength, prepare, type Model } from "../core/model";
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
  const mix = (f: (h: Hull) => number): number =>
    hulls.reduce((a, h, k) => a + w[k] * f(h), 0);

  model.unit = hulls[0].data.unit; // the family shares one unit (promoteFamily converted them)
  model.sheerPlan = hulls[0].data.sheerPlan.map((_, i) => ({
    x: mix((h) => h.data.sheerPlan[i].x),
    y: mix((h) => h.data.sheerPlan[i].y),
  }));
  model.sheerTrim = hulls[0].data.sheerTrim.map((_, i) => ({
    x: mix((h) => h.data.sheerTrim[i].x),
    z: mix((h) => h.data.sheerTrim[i].z),
    k: mix((h) => h.data.sheerTrim[i].k),
  }));
  model.transom = hulls[0].data.transom.map((_, i) => ({
    x: mix((h) => h.data.transom[i].x),
    z: mix((h) => h.data.transom[i].z),
  }));
  // station j of every hull is the same PLACE on the boat (promote.ts's correspondence), so its position
  // along the hull blends with its shape
  model.stations = hulls[0].data.stations.map((st0, j) => ({
    u: mix((h) => h.data.stations[j].u),
    keelK: mix((h) => h.data.stations[j].keelK),
    points: st0.points.map((_, i) => ({
      n: mix((h) => h.data.stations[j].points[i].n),
      z: mix((h) => h.data.stations[j].points[i].z),
      k: mix((h) => h.data.stations[j].points[i].k),
    })),
  }));
  captureViewLength(model); // a blend installs a whole hull, so it restates what the 2D views draw against
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
function insidePoly(p: Pt, V: Pt[]): boolean {
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
function meanValue(p: Pt, V: Pt[]): number[] {
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
