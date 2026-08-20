// ---------- hydrostatics: naval-architecture metrics from the swept hull ----------
//
// Everything here is derived from ONE cut of the hull at the model's current design waterline (already
// floated at deckRake). `sweep.ts` does the integrating — it owns the fanning-station-plane Jacobian and the
// polygon clipping — and this module turns its answers into the numbers a designer reads: the principal
// dimensions, the centroids, the initial stability and the form coefficients.
//
// All outputs are in MODEL units — lengths in model units, areas in units², volume in units³, the form
// coefficients dimensionless. A display layer scales lengths by s = L_real/L (areas s², volume s³) and
// multiplies volume by water density to get displacement; see the blender UI.
//
// Two things are worth knowing about how these are obtained, because both used to be done differently:
//
//   • The VOLUME integrals go through `sweep.ts`, so they carry its Jacobian. The old sectional-area-curve
//     method here — trapezoid A(x) against plan x — assumed constant-x sections, which these are not: a
//     station plane is normal to the plan's heading and the planes fan as the plan turns. That ran ∇ about
//     7% high on the default hull. Sectional area is now measured in the station plane itself rather than
//     projected onto (y, z), which also nudges Cm.
//
//   • The WATERPLANE integrals — A_w, LCF, I_t, I_l — also come from `sweep.ts`, in the same coordinates as
//     the volume, replacing the ∫b dx that had the same fanning bug. I_t is a cubed transverse quantity, so
//     it was biased harder than the volume was; and because BMt = I_t/∇, the two have to be consistent with
//     each other or hydro's KMt stops agreeing with the large-angle KN that stability.ts computes from the
//     same hull. (A shoelace over the waterline curve is a tempting alternative — the waterplane really is
//     planar — but a polygon through the per-station crossings is an inscribed chord approximation that is
//     0.5% low at 200 columns and converges only at first order. The sweep integral is exact at any count.)

import { type Vec3 } from "./math";
import { type Model, loa } from "./model";
import { sweptSection, type HullSampling } from "./mesh";
import { cut, stationGeometry } from "./sweep";

export interface Hydro {
  // principal dimensions (model units)
  lwl: number; // waterline length
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

// deadrise (deg) of a section near the keel: least-squares slope of (half-breadth, depth) over the lowest
// ~7% of the model depth, as an angle from horizontal
function deadriseAt(sec: { pts: Vec3[]; keel: boolean }, len: number): number {
  if (!sec.keel) return NaN;
  const p = sec.pts,
    keel = p[p.length - 1],
    band = p.filter((q) => q[2] <= keel[2] + 0.02 * len); // lowest ~2% of length above the keel
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

// `sampling` is the hull already swept — see `stationGeometry`. Use HYDRO_NS / HYDRO_GIRTH if there is no
// sampling to hand; reuse the host's if there is.
export function hydrostatics(
  model: Model,
  sampling: HullSampling,
): Hydro | null {
  const geom = stationGeometry(model, sampling);
  if (!geom) return null;
  const wlZ = -model.waterline;
  const c = cut(geom, 0, wlZ, true);
  if (c.vol <= 0) return null;

  // the wetted span, and the sectional-area curve's peak and its value amidships
  const wetIdx: number[] = [];
  for (let i = 0; i < c.wet.length; i++) if (c.wet[i]) wetIdx.push(i);
  if (wetIdx.length < 3) return null;
  const cols = geom.cols;
  const xAft = cols[wetIdx[0]].x,
    xFwd = cols[wetIdx[wetIdx.length - 1]].x,
    amid = (xAft + xFwd) / 2;
  const maxSectionArea = Math.max(...wetIdx.map((i) => c.area[i]));
  const midIdx = wetIdx.reduce((best, i) =>
    Math.abs(cols[i].x - amid) < Math.abs(cols[best].x - amid) ? i : best,
  );
  const midshipArea = c.area[midIdx];

  // ---- the waterplane ----
  // Its area, centroid and inertias come from `sweep.ts`, integrated in the same coordinates as the volume.
  // The waterline CURVE is still used, but only for the things that are properties of the curve itself —
  // the waterline's length and beam, and the entrance angle.
  const cr = geom.cosRake,
    sr = geom.sinRake;
  const wl2: [number, number][] = c.waterline.map((p) => [
    p[0] * cr - p[2] * sr,
    p[1],
  ]);
  const wp = c.wp;
  // ...and back to model x for reporting, since lcb and the station span are in model x
  const toModelX = (X: number): number => X * cr + wlZ * sr;

  const lcb = c.xB,
    // KB above K — `stationGeometry`'s keel baseline, which is the ONE vertical datum the whole hull is
    // measured from: hydro's KB / KMt / KMl and stability's KN, KG and VCG all count upward from it, so the
    // two modules' heights are directly comparable. Reading the datum off this cut instead (wlZ − draft, the
    // deepest immersed point) would tie it to the waterline — it agrees only while the hull's lowest point
    // happens to be submerged, and a heeled cut has no such point to read at all.
    kb = c.zBWorld - geom.keelZ;

  // A submerged deck edge invalidates the waterplane, not just a missing one: where the sheer is under, the
  // solid is capped by the deck and contributes NO free surface, so a curve traced through the skin
  // crossings encloses area the hull does not have. Every waterplane-referenced number goes N/A there —
  // which is what this flag was always for.
  const wpOk = !!wp && wl2.length >= 3 && !c.deckDown;
  const na = (v: number): number => (wpOk ? v : NaN);
  const aw = wp ? wp.area : 0,
    lcf = wp ? toModelX(wp.cx) : amid,
    bwl = wp ? 2 * Math.max(...wl2.map(([, y]) => Math.abs(y))) : 0,
    // waterline length from the curve itself rather than from the station spacing
    lwlRaw = wp
      ? Math.max(...wl2.map(([x]) => x)) - Math.min(...wl2.map(([x]) => x))
      : xFwd - xAft,
    lwl = lwlRaw > 1e-9 ? lwlRaw : xFwd - xAft;

  const cb = na(c.vol / (lwl * bwl * c.draft || 1)),
    cm = na(midshipArea / (bwl * c.draft || 1)),
    // Cp uses the SAME midship area as Cm, so the identity Cb = Cp·Cm holds exactly
    cp = na(c.vol / (midshipArea * lwl || 1)),
    cw = na(aw / (lwl * bwl || 1)),
    cvp = na(c.vol / (aw * c.draft || 1));
  const bmt = wpOk && wp ? wp.it / c.vol : NaN,
    bml = wpOk && wp ? wp.il / c.vol : NaN;

  // waterline half-angle of entrance: slope of the half-beam over the forward ~10% of the waterline. The
  // curve's starboard side runs aft → forward, so the last points on it are the bow.
  let halfEntrance = NaN;
  if (wp) {
    const xMax = Math.max(...wl2.map(([x]) => x));
    const fwd = wl2.filter(([x, y]) => x >= xMax - 0.1 * lwl && y > 0);
    if (fwd.length >= 2) {
      const f0 = fwd.reduce((a, b) => (b[0] < a[0] ? b : a)),
        f1 = fwd.reduce((a, b) => (b[0] > a[0] ? b : a));
      if (f1[0] !== f0[0])
        halfEntrance =
          Math.atan(Math.abs(f1[1] - f0[1]) / (f1[0] - f0[0])) *
          (180 / Math.PI);
    }
  }

  return {
    lwl,
    bwl,
    draft: c.draft,
    vol: c.vol,
    waterplaneArea: na(aw),
    midshipArea,
    maxSectionArea,
    wettedArea: c.wsa,
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
    deadrise: deadriseAt(
      sweptSection(model, model.plan.uAtX(amid), sampling.R, true),
      loa(model),
    ),
    halfEntrance,
    xAft,
    xFwd,
    closed: wetIdx.every((i) => cols[i].keel),
    validWaterplane: wpOk,
  };
}
