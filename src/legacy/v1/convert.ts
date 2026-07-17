// ---------- reading a version 1 hull document into the current format ----------
//
// v1 and v2 differ in two ways that matter here, and one that doesn't.
//
//   1. ENCODING (mechanical). v1 stores forward/depth increments against an anchor; v2 stores absolute
//      coordinates. Undoing the increments is a running sum — no information is lost or invented.
//
//   2. SECTIONS (not mechanical). v1 has TEMPLATES with no position: the section at x is a barycentric
//      blend Σⱼ w[j]·templates[j], where w(x) is a curve authored across the plan stations. v2 has STATIONS
//      at definite u along the plan, lofted between. So a template has to be GIVEN a position it never had,
//      and the only thing in a v1 document that says where a template belongs is where its weight peaks.
//      That is what this conversion reads: each template lands at the u where its weight curve is locally
//      maximal — where the v1 hull looked most like that template.
//
//      A template may peak more than once. A symmetric hull (a kayak) typically carries one template whose
//      weight is high at both ends and dips amidships; it is one template doing two jobs. Such a template
//      becomes SEVERAL stations, one per local maximum — otherwise only one end of the hull would keep its
//      shape. This is why the station count can exceed the template count.
//
//   3. SCALE (a rename). v1 coordinates are unitless, against a `length` that is only a scale. v2
//      coordinates are absolute in a real unit. The numbers are carried across UNCHANGED and declared as
//      millimetres, so a v1 hull of length 1000 reads as a 1000 mm hull — the same shape at a plausible
//      size. Nothing is rescaled, so the conversion round-trips the geometry exactly.
//
// The station points themselves are used AS AUTHORED — no refitting. v1 faired a section with a
// knuckle-aware monotone Hermite through those points; v2 fairs it with a centripetal Catmull-Rom. Both
// interpolate the points, so the section still passes through every point the author placed, but the curve
// between them differs slightly. That is a deliberate, accepted difference: a least-squares refit would
// preserve the old curve at the cost of moving the author's points, which is the worse trade for a document
// that will be edited from here on.

import { clamp } from "../../core/math";
import { pchipSlopes, hermiteEval } from "../../core/pchip";
import { planCurve } from "../../core/bspline";
import {
  VERSION as V2,
  type HullDocument as V2Doc,
  type Station as V2Station,
} from "../../core/document";
import type { HullDocument as V1Doc } from "./document";

// ---------- decode: v1's increments → absolute ----------

interface AbsPlan {
  x: number;
  y: number;
  w: number[];
}
interface AbsTrim {
  x: number;
  z: number;
  k: number;
}
interface AbsPoint {
  n: number;
  d: number; // depth below the deck datum (world z = −d)
  k: number;
}

const knuckle = (v: unknown): number =>
  typeof v === "number" && isFinite(v) ? clamp(v, 0, 1) : 0;

// project a vector onto the simplex: clamp negatives (float noise) away, renormalize to Σ = 1
function normSimplex(w: number[]): number[] {
  let s = 0;
  const c = w.map((v) => {
    const x = v > 0 ? v : 0;
    s += x;
    return x;
  });
  return s > 0 ? c.map((v) => v / s) : c.map(() => 1 / c.length);
}

function decPlan(plan: V1Doc["sheerPlan"]): AbsPlan[] {
  let x = 0;
  return plan.map((p, i) => {
    x = i === 0 ? p.dx : x + p.dx;
    return { x, y: p.y, w: normSimplex(p.w) };
  });
}

function decTrim(trim: V1Doc["sheerTrim"]): AbsTrim[] {
  let x = 0;
  return trim.map((p, i) => {
    x = i === 0 ? p.dx : x + p.dx;
    return { x, z: -p.depth, k: knuckle(p.k) };
  });
}

function decTemplate(pts: V1Doc["templates"][number]): AbsPoint[] {
  let d = 0;
  return pts.map((p, i) => {
    d = i === 0 ? 0 : d + p.dd;
    return { n: p.n, d, k: knuckle(p.k) };
  });
}

// ---------- v1's weight curve, reproduced ----------
// Each barycentric component wⱼ(x) was interpolated across the control x's with monotone PCHIP and the
// vector renormalized onto the simplex. Reproduced here rather than imported: the live model no longer has
// weights at all, and this has to keep reading v1 the way v1 meant it however the model moves on.
function buildWeightSampler(cps: AbsPlan[]): (x: number) => number[] {
  if (cps.length <= 1) {
    const w = cps.length ? normSimplex(cps[0].w) : [1];
    return () => w.slice();
  }
  const K = cps[0].w.length,
    xs = cps.map((c) => c.x),
    xLo = xs[0],
    xHi = xs[xs.length - 1];
  const comps = Array.from({ length: K }, (_, j) => {
    const ys = cps.map((c) => c.w[j]);
    return { ys, m: pchipSlopes(xs, ys) };
  });
  return (x: number) => {
    const xc = clamp(x, xLo, xHi);
    return normSimplex(comps.map((c) => hermiteEval(xs, c.ys, c.m, xc)));
  };
}

// ---------- where does a template belong? ----------

// Local maxima of f over u ∈ [0,1], each refined to ~1e-6.
//
// Boundary samples count: a template that hands off monotonically (v1's default aft→fore path) peaks at
// u = 0 or u = 1 and has no interior maximum at all, so ignoring the ends would leave it homeless.
//
// A PLATEAU — f flat across several samples, as when a single template carries the whole hull at weight 1 —
// is one maximum at its middle, not one per sample.
function localMaxima(f: (u: number) => number, N = 400): number[] {
  const w: number[] = [];
  for (let i = 0; i <= N; i++) w.push(f(i / N));
  const out: number[] = [];
  let i = 0;
  while (i <= N) {
    const rise = i === 0 || w[i] > w[i - 1] + 1e-12;
    if (!rise) {
      i++;
      continue;
    }
    // walk the plateau of equal values starting at i
    let j = i;
    while (j < N && Math.abs(w[j + 1] - w[i]) <= 1e-12) j++;
    const fall = j === N || w[j + 1] < w[i] - 1e-12;
    if (fall) {
      if (j > i) out.push((i + j) / 2 / N); // plateau → its midpoint
      else out.push(refineMax(f, Math.max(0, i - 1) / N, Math.min(N, i + 1) / N));
    }
    i = j + 1;
  }
  return out;
}

// golden-section-free ternary refinement of a bracketed maximum
function refineMax(f: (u: number) => number, a: number, b: number): number {
  for (let it = 0; it < 60; it++) {
    const m1 = a + (b - a) / 3,
      m2 = b - (b - a) / 3;
    if (f(m1) < f(m2)) a = m1;
    else b = m2;
  }
  return (a + b) / 2;
}

// Two stations at the same u would make the loft's knots non-monotonic, which no v2 hull can represent. It
// takes two templates peaking at the same place to hit this — rare, but a document that does it must still
// convert — so collisions are spread apart by the minimum the loft can tell apart. The shape moves by less
// than the nudge.
const U_EPS = 1e-3;
function separate(stations: V2Station[]): V2Station[] {
  const s = stations.slice().sort((a, b) => a.u - b.u);
  for (let i = 1; i < s.length; i++)
    if (s[i].u - s[i - 1].u < U_EPS) s[i].u = s[i - 1].u + U_EPS;
  // a nudge at the bow end can push past 1; pull the whole run back inside if so
  const over = s.length ? s[s.length - 1].u - 1 : 0;
  if (over > 0) for (const st of s) st.u = clamp(st.u - over, 0, 1);
  return s;
}

// A local maximum this far below the template's own best is a ripple in the weight curve, not a place the
// hull genuinely looks like that template; it does not earn a station of its own. Generous, so that a
// near-symmetric hull whose two ends differ a little still keeps both.
const PEAK_KEEP = 0.5;

// ---------- the conversion ----------

export function convertV1ToV2(doc: V1Doc): V2Doc {
  const plan = decPlan(doc.sheerPlan),
    trim = decTrim(doc.sheerTrim),
    templates = doc.templates.map(decTemplate),
    K = templates.length;
  const weightAt = buildWeightSampler(plan),
    curve = planCurve(plan.map((p): [number, number] => [p.x, p.y]));
  // the weight of template j as a function of the plan's own parameter — v1 authored w against x, v2 places
  // stations against u, and the plan curve is the bridge
  const wOf = (j: number) => (u: number) => weightAt(curve.at(u)[0])[j] ?? 0;

  const stations: V2Station[] = [];
  for (let j = 0; j < K; j++) {
    const f = wOf(j);
    let peaks = localMaxima(f);
    if (!peaks.length) peaks = [refineMax(f, 0, 1)]; // flat/degenerate: one station, best-effort
    const best = Math.max(...peaks.map(f));
    const keep = peaks.filter((u) => f(u) >= best * PEAK_KEEP);
    for (const u of keep.length ? keep : peaks)
      stations.push({
        u: clamp(u, 0, 1),
        keelK: clamp(knuckle(doc.keelK?.[j]), 0, 1),
        points: templates[j].map((p) => ({ z: -p.d, n: p.n, k: p.k })),
      });
  }

  const [top, bot] = decTransomPoints(doc.transom);
  return {
    version: V2,
    name: doc.name ?? "",
    unit: "mm", // v1 was unitless; the numbers carry across as written (see the header)
    waterline: doc.waterline ?? 0,
    deckRakeDeg: doc.deckRakeDeg ?? 0,
    sheerPlan: plan.map((p) => ({ x: p.x, y: p.y })),
    sheerTrim: trim.map((p) => ({ x: p.x, z: p.z, k: p.k })),
    transom: [top, bot],
    stations: separate(stations),
  };
}

// v1's transom was a point plus a depth-step and a rake slope; v2 states both profile points outright
function decTransomPoints(t: V1Doc["transom"]): [
  { x: number; z: number },
  { x: number; z: number },
] {
  const top = { x: t.x, z: -t.depthTop },
    z = -(t.depthTop + t.dDepthBot);
  return [top, { x: t.x + (z - top.z) * t.transomRake, z }];
}
