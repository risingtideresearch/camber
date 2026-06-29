// ---------- hydrostatics: naval-architecture metrics from the swept hull ----------
//
// Everything here is derived by sampling the trimmed sections along the hull and integrating, at the
// model's current design waterline (`immersion(x,z) > 0` ⇔ submerged, already floated at deckRake). All
// outputs are in MODEL units — lengths in model units, areas in units², volume in units³, the form
// coefficients dimensionless. A display layer scales lengths by s = L_real/L (areas s², volume s³) and
// multiplies volume by water density to get displacement; see the blender UI.
//
// The integration is the standard sectional-area-curve method: immersed cross-section area A(x), waterline
// beam b(x), wetted girth and area centroid per station, trapezoid-integrated along x. At deckRake = 0 the
// waterline is a clean horizontal cut in every section; at a small rake it is the usual station-plane
// approximation (exact in the limit).

import { lerp, type Vec3 } from "./math.js";
import { state, L, clippedSection, forwardLimit, immersion, worldZ } from "./model.js";

export interface Hydro {
  // principal dimensions (model units)
  lwl: number; // waterline length (wetted span)
  bwl: number; // max waterline beam
  draft: number; // T — deepest immersion
  // areas / volume (model units)
  vol: number; // ∇ displaced volume
  waterplaneArea: number; // A_w
  midshipArea: number; // A_m (immersed section at amidships)
  maxSectionArea: number;
  wettedArea: number; // WSA
  // centroids (model units; x from the transom reference, z in world height)
  lcb: number;
  lcf: number;
  kb: number;
  // initial stability (model units)
  bmt: number;
  kmt: number;
  bml: number;
  kml: number;
  // form coefficients (dimensionless)
  cb: number;
  cp: number;
  cm: number;
  cw: number;
  cvp: number;
  // angles (degrees)
  deadrise: number; // at amidships
  halfEntrance: number; // waterline half-angle of entrance at the bow
  // span + health
  xAft: number;
  xFwd: number; // wetted span [xAft, xFwd] (LWL = xFwd − xAft)
  closed: boolean; // every wetted section closes on the centerline (∇ trustworthy)
  validWaterplane: boolean; // false when the waterline sits above the sheer (no WL crossing) → coeffs are NaN
}

const M = 48; // default section columns
const NS = 240; // default longitudinal sampling (coarser is fine for the heatmap — see hydrostatics args)

interface Strip {
  x: number;
  area: number; // full immersed cross-section area
  beam: number; // full waterline beam
  girth: number; // full wetted girth (both sides)
  zMom: number; // full area's world-z first moment (Σ z·dA), for KB
  draft: number; // deepest immersion in this section
  keel: boolean; // section closes on the centerline
}

// immersed integrals for one section: area between the section curve and the centerline below the WL,
// plus the wetted girth, the world-z area moment, and the waterline beam. Works on the starboard half;
// the caller doubles to full width.
function stripOf(sec: { pts: Vec3[] }): Omit<Strip, "x" | "draft" | "keel"> {
  let areaH = 0,
    girthH = 0,
    zMomH = 0,
    bHalf = 0;
  const p = sec.pts;
  for (let i = 0; i < p.length - 1; i++) {
    let a = p[i],
      b = p[i + 1];
    const ia = immersion(a[0], a[2]),
      ib = immersion(b[0], b[2]);
    // waterline beam: half-breadth at any sheer↔keel crossing of the WL (outermost wins)
    if (ia < 0 !== ib < 0 && ia !== ib) {
      const t = -ia / (ib - ia);
      bHalf = Math.max(bHalf, Math.abs(lerp(a[1], b[1], t)));
    }
    if (ia <= 0 && ib <= 0) continue; // dry segment
    // clip the segment to its submerged part (immersion ≥ 0)
    if (ia < 0) a = lerp3(a, b, -ia / (ib - ia));
    else if (ib < 0) b = lerp3(a, b, ia / (ia - ib));
    const dz = Math.abs(a[2] - b[2]),
      ya = a[1],
      yb = b[1];
    areaH += ((ya + yb) / 2) * dz; // ∫ y dz
    girthH += Math.hypot(b[1] - a[1], b[2] - a[2]);
    const zw = worldZ((a[0] + b[0]) / 2, (a[2] + b[2]) / 2);
    zMomH += ((ya + yb) / 2) * dz * zw;
  }
  return { area: 2 * areaH, beam: 2 * bHalf, girth: 2 * girthH, zMom: 2 * zMomH };
}
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// deadrise (deg) of a section near the keel: least-squares slope of (half-breadth, depth) over the lowest
// ~7% of the model depth, as an angle from horizontal
function deadriseAt(sec: { pts: Vec3[]; keel: boolean }): number {
  if (!sec.keel) return NaN;
  const p = sec.pts,
    keel = p[p.length - 1],
    band = p.filter((q) => q[2] <= keel[2] + 0.02 * L); // lowest ~2% of length above the keel
  if (band.length < 3) return NaN;
  let n = 0,
    sy = 0,
    sz = 0,
    syz = 0,
    syy = 0;
  for (const q of band) {
    const y = Math.abs(q[1]),
      z = q[2];
    n++;
    sy += y;
    sz += z;
    syz += y * z;
    syy += y * y;
  }
  const den = n * syy - sy * sy;
  if (Math.abs(den) < 1e-9) return NaN;
  const dzdy = (n * syz - sy * sz) / den; // rise/run of the bottom near the keel
  return Math.atan(Math.abs(dzdy)) * (180 / Math.PI); // deadrise = angle of the bottom from horizontal
}

export function hydrostatics(ns: number = NS, m: number = M): Hydro | null {
  const xf = forwardLimit();
  if (!(xf > 0)) return null;
  const strips: Strip[] = [];
  for (let k = 0; k <= ns; k++) {
    const x = (xf * k) / ns,
      sec = clippedSection(x, m);
    if (sec.aft) continue;
    let dmax = 0;
    for (const q of sec.pts) dmax = Math.max(dmax, immersion(q[0], q[2]));
    if (dmax <= 0) continue; // dry section (above the waterline)
    const s = stripOf(sec);
    if (s.area <= 0) continue;
    strips.push({ x, ...s, draft: dmax, keel: sec.keel });
  }
  if (strips.length < 3) return null;

  // trapezoid integrals over the wetted stations
  let vol = 0,
    aw = 0,
    wsa = 0,
    lcbN = 0,
    lcfN = 0,
    kbN = 0,
    it = 0;
  for (let i = 0; i < strips.length - 1; i++) {
    const a = strips[i],
      b = strips[i + 1],
      dx = b.x - a.x,
      avg = (p: number, q: number) => ((p + q) / 2) * dx;
    vol += avg(a.area, b.area);
    aw += avg(a.beam, b.beam);
    wsa += avg(a.girth, b.girth);
    lcbN += avg(a.x * a.area, b.x * b.area);
    lcfN += avg(a.x * a.beam, b.x * b.beam);
    kbN += avg(a.zMom, b.zMom);
    it += avg(a.beam ** 3 / 12, b.beam ** 3 / 12);
  }
  const xAft = strips[0].x,
    xFwd = strips[strips.length - 1].x,
    lwl = xFwd - xAft,
    amid = (xAft + xFwd) / 2;
  const bwl = Math.max(...strips.map((s) => s.beam)),
    draft = Math.max(...strips.map((s) => s.draft)),
    maxSectionArea = Math.max(...strips.map((s) => s.area));
  const midStrip = strips.reduce((m, s) => (Math.abs(s.x - amid) < Math.abs(m.x - amid) ? s : m));
  const midshipArea = midStrip.area;
  const lcb = vol > 0 ? lcbN / vol : amid,
    lcf = aw > 0 ? lcfN / aw : amid,
    // KB reported above the keel baseline (the deepest immersed point), not the deck datum
    kb = (vol > 0 ? kbN / vol : 0) + state.waterline + draft;
  // longitudinal waterplane inertia about the LCF
  let il = 0;
  for (let i = 0; i < strips.length - 1; i++) {
    const a = strips[i],
      b = strips[i + 1],
      dx = b.x - a.x;
    il += ((a.beam * (a.x - lcf) ** 2 + b.beam * (b.x - lcf) ** 2) / 2) * dx;
  }

  // a degenerate waterplane (no WL crossing — e.g. the waterline sits above the sheer) makes every
  // waterplane-referenced metric meaningless; report ∇ / WSA / draft and flag the rest N/A.
  const wpOk = bwl > 1e-6 && aw > 1e-6;
  const na = (v: number): number => (wpOk ? v : NaN);
  // Cp uses the SAME midship area as Cm, so the identity Cb = Cp·Cm holds exactly
  const cb = na(vol / (lwl * bwl * draft || 1)),
    cm = na(midshipArea / (bwl * draft || 1)),
    cp = na(vol / (midshipArea * lwl || 1)),
    cw = na(aw / (lwl * bwl || 1)),
    cvp = na(vol / (aw * draft || 1));
  const bmt = na(it / (vol || 1)),
    bml = na(il / (vol || 1));

  // waterline half-angle of entrance: slope of the half-beam over the forward ~10% of LWL
  let halfEntrance = NaN;
  const fwd = strips.filter((s) => s.x >= xFwd - 0.1 * lwl && s.beam > 0);
  if (fwd.length >= 2) {
    const f0 = fwd[0],
      f1 = fwd[fwd.length - 1];
    if (f1.x !== f0.x) halfEntrance = Math.atan(Math.abs(f1.beam - f0.beam) / 2 / (f1.x - f0.x)) * (180 / Math.PI);
  }

  return {
    lwl,
    bwl,
    draft,
    vol,
    waterplaneArea: aw,
    midshipArea,
    maxSectionArea,
    wettedArea: wsa,
    lcb,
    lcf: na(lcf),
    kb,
    bmt,
    kmt: na(kb + bmt),
    bml,
    kml: na(kb + bml),
    cb,
    cp,
    cm,
    cw,
    cvp,
    deadrise: deadriseAt(clippedSection(amid, m)),
    halfEntrance,
    xAft,
    xFwd,
    closed: strips.every((s) => s.keel),
    validWaterplane: wpOk,
  };
}
