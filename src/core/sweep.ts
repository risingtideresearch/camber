// ---------- the swept solid: cutting the hull with a plane, and integrating what is under it ----------
//
// One place that knows how to turn "this hull, cut by this waterplane" into volume, centroid, sectional
// areas, wetted surface and the waterline curve. `hydro.ts` asks it for the upright cut and derives the
// naval-architecture coefficients; `stability.ts` marches it over heel and sinkage to build the KN table.
//
// ---- why the integration is not ∫A dx ----
//
// The hull is swept along the sheer PLAN, and a station plane is normal to the plan's heading. Where the
// plan turns, the planes FAN — they are not parallel constant-x slices — so the volume between two of them
// is not (area × Δx), and it is not (area × arc length) either: the plane sweeps faster on the outside of
// the turn than on the inside. Writing a point in the station plane at u as
//
//     X(u, a, z) = P(u) + a·n̂(u) + z·ẑ            (a = the in-plane offset along n̂, positive inboard)
//
// and differentiating, ∂X/∂u = |P'|(1 + κa)·T̂, so the volume element is
//
//     dV = |P'|·(1 + κ·a) dA du
//
// with κ the plan's signed curvature. Per section that is |P'|·A + (κ|P'|)·M_a, where M_a = ∫a dA — so the
// section's FIRST MOMENT about the plan origin is needed alongside its area, and the moments of the volume
// need second moments (M_aa, M_az) on top. That is the whole reason this module carries more than an area.
//
// Integrating ∫A dx instead — the plain sectional-area-curve method, which assumes constant-x sections —
// runs 6–11% high on the default hull. It is not a discretisation error: refining does not close it. See
// test/support/meshIntegral.ts, which checks this module against the 3D triangle mesh by an entirely
// separate route.
//
// ---- the two halves ----
//
// The sampling carries the STARBOARD half-section. The port half is its y-mirror, and — this matters — the
// mirrored points do NOT lie in the starboard station plane, so they cannot simply be appended to make one
// section. Each half is its own swept solid over its own frame. Mirroring the frame as well (P̄ = (Px, −Py),
// n̄ = (nx, −ny)) leaves n̄' = κ|P'|T̄ with the SAME κ, so both halves share one Jacobian and one (a, z)
// outline; only the waterline cutting them differs, and only once the hull is heeled. So a cut clips the
// same polygon twice, against two different immersion functions.
//
// Everything is in MODEL units. A caller wanting real-world displacement scales lengths by s = L_real/L
// (volume by s³) and multiplies by water density.

import { type Vec2, type Vec3 } from "./math";
import {
  bisectRoot,
  frameAt,
  sectionAt,
  sectionWorld,
  xTransom,
  loa,
  type Model,
  worldZ,
} from "./model";
import { type HullSample, type HullSampling } from "./mesh";

// The resolutions the numbers here were tuned at, for a caller that has no sampling of its own to pass in.
// A host that already sweeps the hull for something else — the 3D view, the editor's sampler — should hand
// over THAT sampling instead of building a second one at these.
export const HYDRO_NS = 240;
export const HYDRO_GIRTH = 10;
export const STABILITY_NS = 160;
export const STABILITY_GIRTH = 10;

// A vertex of a half-section outline: the in-plane offset `a`, the height `z`, and whether the edge LEAVING
// this vertex is hull skin (1) rather than one of the closures (0). The skin flag is what separates wetted
// surface from the centerline / deck / transom closures the outline needs in order to be a closed region.
type Vtx = [number, number, number]; // a, z, skin

export interface Column {
  u: number;
  x: number; // the plan's x here — for reporting stations, not for integrating
  px: number; // the plan origin...
  py: number;
  nx: number; // ...and the station plane's inboard normal
  ny: number;
  speed: number; // |P'|
  kSpeed: number; // κ|P'| — the two always appear together, so curvature is never divided out
  aC: number; // the centerline y = 0 sits at this constant a in the station plane
  poly: Vtx[]; // the starboard half-outline, closed on the centerline and the deck
  // The column's top point, and whether it is actually ON the sheer. Near a raked transom the transom trim
  // can cut a column off well below the sheer, so its first point is a transom edge — testing THAT against
  // the waterline would report the deck as awash when the real deck edge is metres clear.
  topA: number;
  topZ: number;
  topIsSheer: boolean;
  keel: boolean; // the section reaches the centerline (rather than stopping on the transom)
  f: number[]; // scratch: signed immersion per vertex, refilled per cut
}

export interface StationGeom {
  cols: Column[];
  // K — the lowest world height anywhere on the hull, and the ONE datum every vertical height in the
  // program is measured above: hydro's KB / KMt / KMl and stability's KN, KG and VCG alike. It is pure
  // geometry, so it does not move when the design waterline does, and it is defined at every heel.
  keelZ: number;
  lowestSheerZ: number; // lowest actual sheer-edge point in world height
  cosRake: number;
  sinRake: number;
}

/** Close the skin before transom trimming on the centreline/deck, THEN clip the solid by
 * the transom plane. Clipping an already-trimmed skin and closing horizontally
 * omits (or adds) wedges in fanning station planes. No division by transom rake:
 * vertical, reversed and nearly vertical transoms use the same half-plane test.
 * The outgoing-edge skin tags survive clipping; every new closing edge is non-skin. */
export function stationPolygon(
  frame: Pick<Column, "px" | "py" | "nx" | "ny">,
  skin: readonly Vec3[],
  transom: Model["transom"],
): Vtx[] {
  if (skin.length < 2 || Math.abs(frame.ny) < 1e-9) return [];
  const { px, py, nx, ny } = frame,
    aC = -py / ny;
  const poly: Vtx[] = skin.map((p) => [
    (p[0] - px) * nx + (p[1] - py) * ny,
    p[2],
    1,
  ]);
  poly[poly.length - 1][2] = 0;
  if (Math.abs(poly[poly.length - 1][0] - aC) > 1e-12)
    poly.push([aC, skin[skin.length - 1][2], 0]);
  poly.push([aC, skin[0][2], 0]);
  const [a, b] = transom,
    slope = (b.x - a.x) / (b.z - a.z || 1);
  return clipSubmerged(
    poly,
    poly.map((p) => px + p[0] * nx - a.x - slope * (p[1] - a.z)),
  );
}

/** The sampling's girth lattice, trimmed on sheer/centreline but NOT transom.
 * Resolve the two end roots on the actual curve, just as mesh.ts does. Keeping
 * columns whose skin is behind the transom matters: their interior can still be
 * ahead of it. Empty solid columns are retained as zero quadrature endpoints. */
function skinBeforeTransom(model: Model, row: readonly HullSample[]): Vec3[] {
  const keep = (p: Vec3) => Math.min(model.trimZ(p[0]) - p[2], p[1]);
  let lo = -1,
    hi = -1;
  row.forEach((p, i) => {
    if (keep(p.pos) >= 0) {
      if (lo < 0) lo = i;
      hi = i;
    }
  });
  if (lo < 0) return [];
  const points: Vec3[] = [];
  const root = (a: HullSample, b: HullSample): Vec3 => {
    const frame = frameAt(model, a.u),
      section = sectionAt(model, a.u);
    const at = (v: number) => sectionWorld(frame, section, v);
    return at(bisectRoot((v) => keep(at(v)), a.v, b.v, keep(a.pos)));
  };
  if (lo > 0) points.push(root(row[lo - 1], row[lo]));
  for (let i = lo; i <= hi; i++) points.push(row[i].pos);
  if (hi + 1 < row.length) points.push(root(row[hi], row[hi + 1]));
  return points;
}

// Reduce an already-swept hull to what cutting needs.
//
// The sampling is passed IN rather than built here, for two reasons. It is waterline-independent — it trims
// on sheer / centerline / transom, all pure geometry — so one sweep serves every cut at every heel and every
// sinkage after it, and a host that already has one (the 3D view, the editor's cached sampler) should not
// pay for a second. It also makes the resolution the caller's decision rather than a constant buried here.
export function stationGeometry(
  model: Model,
  hs: HullSampling,
): StationGeom | null {
  const cols: Column[] = [];
  const cosRake = Math.cos(model.deckRake),
    sinRake = Math.sin(model.deckRake);
  let keelZ = Infinity,
    lowestSheerZ = Infinity;
  const H = 1e-5;
  const unitT = (u: number): Vec2 => {
    const [dx, dy] = model.plan.d(Math.min(1, Math.max(0, u))),
      l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };

  for (const c of hs.columns) {
    const u = hs.uParams[c.i],
      [px, py] = model.plan.at(u),
      [dx, dy] = model.plan.d(u),
      speed = Math.hypot(dx, dy),
      T = unitT(u),
      nx = T[1],
      ny = -T[0]; // n̂ = (Ty, −Tx): inboard, for a sheer lying to starboard
    if (Math.abs(ny) < 1e-9) continue; // the plan running straight across: no centerline in this plane
    // κ|P'| = Tx·Ty' − Ty·Tx', central-differenced on the unit tangent
    const Tp = unitT(u + H),
      Tm = unitT(u - H),
      kSpeed = (T[0] * (Tp[1] - Tm[1]) - T[1] * (Tp[0] - Tm[0])) / (2 * H);

    const pts = skinBeforeTransom(model, hs.sheet[c.i]),
      aC = -py / ny;
    const poly = stationPolygon({ px, py, nx, ny }, pts, model.transom);
    for (const v of poly) {
      const z = worldZ(model, px + v[0] * nx, v[1]);
      if (z < keelZ) keelZ = z;
    }
    const top = pts[0];
    const topIsSheer =
      !!top &&
      top[0] >= xTransom(model, top[2]) &&
      Math.abs(model.trimZ(top[0]) - top[2]) < 1e-6 * loa(model);
    if (topIsSheer)
      lowestSheerZ = Math.min(lowestSheerZ, worldZ(model, top[0], top[2]));
    cols.push({
      u,
      x: px,
      px,
      py,
      nx,
      ny,
      speed,
      kSpeed,
      aC,
      poly,
      topA: top ? (top[0] - px) * nx + (top[1] - py) * ny : 0,
      topZ: top?.[2] ?? 0,
      topIsSheer,
      keel: c.keel,
      f: new Array<number>(poly.length).fill(0),
    });
  }
  if (
    cols.filter((c) => c.poly.length >= 3).length < 3 ||
    !Number.isFinite(keelZ) ||
    !Number.isFinite(lowestSheerZ)
  )
    return null;
  return { cols, keelZ, lowestSheerZ, cosRake, sinRake };
}

// ---------- polygon integrals ----------

// Area and the moments the Jacobian needs, by fanning the outline into triangles from its first vertex.
// Positive area whichever way the outline was wound. A triangle carries a linear field exactly, and for two
// linear fields f, g over a triangle ∫fg dA = (A/12)·[Σ fᵢgᵢ + (Σfᵢ)(Σgᵢ)] — which covers M_aa and M_az.
interface Moments {
  A: number;
  Ma: number;
  Mz: number;
  Maa: number;
  Maz: number;
}
const ZERO_M: Moments = { A: 0, Ma: 0, Mz: 0, Maa: 0, Maz: 0 };

function moments(poly: Vtx[]): Moments {
  const n = poly.length;
  if (n < 3) return ZERO_M;
  const p0 = poly[0];
  let A = 0,
    Ma = 0,
    Mz = 0,
    Maa = 0,
    Maz = 0;
  for (let i = 1; i < n - 1; i++) {
    const p1 = poly[i],
      p2 = poly[i + 1],
      at =
        ((p1[0] - p0[0]) * (p2[1] - p0[1]) -
          (p2[0] - p0[0]) * (p1[1] - p0[1])) /
        2;
    if (at === 0) continue;
    const sa = p0[0] + p1[0] + p2[0],
      sz = p0[1] + p1[1] + p2[1];
    A += at;
    Ma += (at * sa) / 3;
    Mz += (at * sz) / 3;
    Maa +=
      (at * (p0[0] * p0[0] + p1[0] * p1[0] + p2[0] * p2[0] + sa * sa)) / 12;
    Maz +=
      (at * (p0[0] * p0[1] + p1[0] * p1[1] + p2[0] * p2[1] + sa * sz)) / 12;
  }
  const s = A < 0 ? -1 : 1;
  return { A: s * A, Ma: s * Ma, Mz: s * Mz, Maa: s * Maa, Maz: s * Maz };
}

// Clip a closed outline to the half-plane `f ≥ 0` (Sutherland–Hodgman against one edge; exact, since a
// half-plane is convex). The skin flag rides along: a vertex introduced where the hull DIVES under the
// waterline keeps the skin flag of the edge it split, while one introduced where the hull surfaces starts
// the run along the waterline and so carries no skin. That is what keeps the girth honest.
function clipSubmerged(poly: Vtx[], f: number[]): Vtx[] {
  const out: Vtx[] = [],
    n = poly.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n,
      fa = f[i],
      fb = f[j];
    if (fa >= 0) out.push(poly[i]);
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb),
        a = poly[i],
        b = poly[j];
      out.push([
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        fa >= 0 ? 0 : a[2], // leaving the water starts the waterline run; entering it continues the skin
      ]);
    }
  }
  return out;
}

// Wetted girth of a clipped outline, and the moments the surface integral needs.
//
// The surface element of a swept sheet is |P'|(1 + κa) ds, so an AREA needs ∫a ds exactly as the volume needs
// ∫a dA. The surface's own CENTROID needs three more, because both the weight and the coordinate are affine
// in the section's (a, z):
//
//     ∫x dS = px·(speed·len + kSpeed·Msa) + nx·(speed·Msa + kSpeed·Msaa)
//     ∫z dS = speed·Msz + kSpeed·Msaz
//
// Each is integrated EXACTLY along a segment rather than sampled: over a straight edge both a and z are
// linear in the arc parameter, so a product of two of them is a quadratic with a closed form. `Msaa` is the
// ∫a² of that pair and `Msaz` the ∫az; the sixths and thirds below are those integrals, not approximations.
interface Girth {
  len: number;
  Msa: number;
  Msaa: number;
  Msz: number;
  Msaz: number;
}

function girthOf(poly: Vtx[]): Girth {
  let len = 0,
    Msa = 0,
    Msaa = 0,
    Msz = 0,
    Msaz = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    if (!a[2]) continue;
    const b = poly[(i + 1) % poly.length],
      d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const a0 = a[0],
      a1 = b[0],
      z0 = a[1],
      z1 = b[1];
    len += d;
    Msa += d * ((a0 + a1) / 2);
    Msaa += (d * (a0 * a0 + a0 * a1 + a1 * a1)) / 3;
    Msz += d * ((z0 + z1) / 2);
    Msaz += (d * (2 * a0 * z0 + a0 * z1 + a1 * z0 + 2 * a1 * z1)) / 6;
  }
  return { len, Msa, Msaa, Msz, Msaz };
}

// ---------- one cut ----------

export interface Cut {
  vol: number;
  // the immersed volume's centroid, in MODEL coordinates (x, y, z as the hull is authored)
  xB: number;
  yB: number;
  zB: number;
  zBWorld: number; // ...and its true world height, once floated at deckRake
  wsa: number; // wetted surface area
  // ...and where it acts: the SKIN's own centroid, in the same coordinates as the volume's. Zero-filled when
  // there is no skin. `wsaZWorld` is its true height once floated at deckRake, matching `zBWorld`.
  //
  // This is what makes "the shell weighs area × areal density and acts at the skin's own centroid" one line
  // in a weight sheet instead of a guess. Taken over the same clipped outlines the area is, so a cut above
  // the whole hull gives the centroid of the ENTIRE trimmed shell.
  wsaX: number;
  wsaZ: number;
  wsaZWorld: number;
  draft: number; // deepest immersion below the waterplane
  deckDown: boolean; // the sheer is under somewhere, so the watertight deck cap is carrying load
  sheerZ: number; // lowest heeled height of the sheer, independent of this cut's waterline
  // set only when `detail` was asked for
  area: number[]; // full immersed sectional area per column (both halves), aligned with cols
  // The waterplane, integrated in the SAME sweep coordinates as the volume — not shoelaced off the waterline
  // curve below. The width integrals are exact in each column and share volume's longitudinal quadrature;
  // a polygon through sampled crossings is only a drawing approximation. Using the same solid boundary
  // keeps dV/d(waterline) and area consistent, and hydro's KMt agreeing with stability's KN.
  // Only produced for an UPRIGHT cut (a heeled waterplane meets the station lines at a different angle);
  // null otherwise, and null when `detail` was not asked for.
  wp: {
    area: number;
    cx: number; // centroid, in world horizontal coordinates (x along the hull, y athwartships)
    cy: number;
    it: number; // second moment about the centroidal longitudinal axis → BMt
    il: number; // ...and about the centroidal transverse axis → BMl
  } | null;
  // A sampled closed waterline, including its transom boundary (not just skin crossings).
  // Empty when the legacy single-loop drawing cannot represent the section. The capped hull's
  // numerical section remains distinct from an open boat's free waterplane; callers check deckDown.
  waterline: Vec3[];
  /** Skin-only crossings on each half, excluding transom/deck/centreline closures. */
  waterlineSkin: readonly [Vec3[], Vec3[]];
  wet: boolean[]; // which columns have any immersed area
}

// The heeled height of a point, as an affine function of the station plane's own (a, z). Heel rotates about
// the longitudinal axis, so h = ζ·cos φ − y·sin φ with ζ the zero-heel world height and y = ±(py + a·ny);
// substituting x = px + a·nx makes it C0 + C1·a + C2·z. `side` is +1 starboard, −1 port.
function heightCoeffs(
  g: StationGeom,
  c: Column,
  side: number,
  cosPhi: number,
  sinPhi: number,
): [number, number, number] {
  const { cosRake: cr, sinRake: sr } = g;
  return [
    c.px * sr * cosPhi - side * c.py * sinPhi,
    c.nx * sr * cosPhi - side * c.ny * sinPhi,
    cr * cosPhi,
  ];
}

// The span of heeled heights over the whole hull, both halves: the range a waterplane has to sweep to go
// from "everything dry" to "everything immersed". Brackets every displacement the hull can have at this heel.
export function heightSpan(g: StationGeom, heelRad: number): [number, number] {
  const cosPhi = Math.cos(heelRad),
    sinPhi = Math.sin(heelRad);
  let lo = Infinity,
    hi = -Infinity;
  for (const c of g.cols)
    for (const side of [1, -1]) {
      const [C0, C1, C2] = heightCoeffs(g, c, side, cosPhi, sinPhi);
      for (const v of c.poly) {
        const h = C0 + C1 * v[0] + C2 * v[1];
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
  return [lo, hi];
}

export function cut(
  g: StationGeom,
  heelRad: number,
  wlZ: number,
  detail = false,
): Cut {
  const cosPhi = Math.cos(heelRad),
    sinPhi = Math.sin(heelRad),
    cols = g.cols;
  // trapezoid state over u: the previous column's integrands
  let vol = 0,
    IX = 0,
    IY = 0,
    IZ = 0,
    wsa = 0,
    SX = 0,
    SZ = 0;
  let pV = 0,
    pX = 0,
    pY = 0,
    pZ = 0,
    pS = 0,
    pSX = 0,
    pSZ = 0,
    pU = 0,
    have = false;
  let draft = 0,
    deckDown = false,
    sheerZ = Infinity;
  const area: number[] = [],
    wet: boolean[] = [],
    wlStbd: Vec3[] = [],
    wlPort: Vec3[] = [];
  // The full waterline can meet a closure without meeting the skin in that column.
  let outlineSupported = true;
  const outer: [Vec3[], Vec3[]] = [[], []],
    inner: [Vec3[], Vec3[]] = [[], []],
    lastOutlineColumn = [-1, -1];
  // waterplane accumulators (upright only) — ∫dA, ∫X dA, ∫Y dA, ∫X² dA, ∫Y² dA, trapezoided over u
  const wantWp =
    detail && Math.abs(sinPhi) < 1e-12 && Math.abs(g.cosRake) > 1e-9;
  let wA = 0,
    wX = 0,
    wY = 0,
    wXX = 0,
    wYY = 0;
  const prevW = [0, 0, 0, 0, 0];
  const curW = [0, 0, 0, 0, 0];

  for (const [columnIndex, c] of cols.entries()) {
    let gV = 0,
      gX = 0,
      gY = 0,
      gZ = 0,
      gS = 0,
      gSX = 0,
      gSZ = 0,
      secArea = 0;
    curW.fill(0);
    for (const side of [1, -1]) {
      const [C0, C1, C2] = heightCoeffs(g, c, side, cosPhi, sinPhi);
      if (c.topIsSheer) {
        const topZ = c.topZ * C2 + c.topA * C1 + C0;
        if (topZ < sheerZ) sheerZ = topZ;
        if (topZ < wlZ) deckDown = true;
      }
      const poly = c.poly,
        f = c.f;
      let anyWet = false,
        anyDry = false;
      for (let i = 0; i < poly.length; i++) {
        const fi = wlZ - (C0 + C1 * poly[i][0] + C2 * poly[i][1]);
        f[i] = fi;
        if (fi >= 0) {
          anyWet = true;
          if (fi > draft) draft = fi;
        } else anyDry = true;
      }
      if (!anyWet) continue;
      const clipped = anyDry ? clipSubmerged(poly, f) : poly,
        m = moments(clipped),
        gr = girthOf(clipped);
      if (m.A <= 0) continue;
      secArea += m.A;
      // dV = |P'|(1 + κa) dA, and every moment is that weight times a coordinate that is affine in a or z
      const w0 = c.speed * m.A + c.kSpeed * m.Ma, // ∫dV
        w1 = c.speed * m.Ma + c.kSpeed * m.Maa, // ∫a dV
        wz = c.speed * m.Mz + c.kSpeed * m.Maz; // ∫z dV
      gV += w0;
      gX += c.px * w0 + c.nx * w1; // x = px + a·nx
      gY += side * (c.py * w0 + c.ny * w1); // y = ±(py + a·ny)
      gZ += wz;
      // ∫dS and its two first moments. y is left out: the two halves are mirror images, so the skin's
      // centroid is on the centerline by construction and computing it would only accumulate float noise.
      gS += c.speed * gr.len + c.kSpeed * gr.Msa;
      gSX +=
        c.px * (c.speed * gr.len + c.kSpeed * gr.Msa) +
        c.nx * (c.speed * gr.Msa + c.kSpeed * gr.Msaa);
      gSZ += c.speed * gr.Msz + c.kSpeed * gr.Msaz;

      if (detail) {
        // Intersect the ENTIRE closed polygon, not just its skin. Sort crossings
        // along the section's a axis and pair them into interior intervals. This
        // also subtracts gaps in re-entrant sections rather than filling to aC.
        const crossings: { a: number; z: number; skin: boolean }[] = [];
        for (let i = 0; i < poly.length; i++) {
          const j = (i + 1) % poly.length;
          if (f[i] >= 0 === f[j] >= 0) continue;
          const t = f[i] / (f[i] - f[j]);
          crossings.push({
            a: poly[i][0] + (poly[j][0] - poly[i][0]) * t,
            z: poly[i][1] + (poly[j][1] - poly[i][1]) * t,
            skin: !!poly[i][2],
          });
        }
        crossings.sort((a, b) => a.a - b.a);
        let intervals = 0;
        for (let i = 0; i + 1 < crossings.length; i += 2)
          if (crossings[i + 1].a > crossings[i].a) intervals++;
        if (intervals > 1) outlineSupported = false;
        const point = (p: { a: number; z: number }): Vec3 => [
          c.px + p.a * c.nx,
          side * (c.py + p.a * c.ny),
          p.z,
        ];
        const skin = crossings.find((p) => p.skin);
        if (skin) (side > 0 ? wlStbd : wlPort).push(point(skin));
        if (intervals > 0) {
          const sideIndex = side > 0 ? 0 : 1;
          // A dry/empty column between two intervals splits the outline into
          // separate runs. Never draw a chord across the missing waterplane.
          if (
            lastOutlineColumn[sideIndex] >= 0 &&
            lastOutlineColumn[sideIndex] !== columnIndex - 1
          )
            outlineSupported = false;
          lastOutlineColumn[sideIndex] = columnIndex;
          outer[sideIndex].push(point(crossings[0]));
          const last = crossings[crossings.length - 1];
          const p = point(last);
          if (Math.abs(last.a - c.aC) < 1e-10 * Math.max(1, Math.abs(c.aC)))
            p[1] = 0;
          inner[sideIndex].push(p);
        }
        if (wantWp)
          for (let i = 0; i + 1 < crossings.length; i += 2) {
            // The area element and its moments are the SAME Jacobian as volume,
            // divided by cos(rake). Interval ends may be skin, transom or deck.
            const lo = crossings[i].a,
              hi = crossings[i + 1].a,
              cr2 = g.cosRake;
            if (hi <= lo) continue;
            const mk = (k: number) =>
              (Math.pow(hi, k + 1) - Math.pow(lo, k + 1)) / (k + 1);
            const m0 = mk(0),
              m1 = mk(1),
              m2 = mk(2),
              m3 = mk(3);
            const W0 = (c.speed * m0 + c.kSpeed * m1) / cr2,
              W1 = (c.speed * m1 + c.kSpeed * m2) / cr2,
              W2 = (c.speed * m2 + c.kSpeed * m3) / cr2;
            const ax = (c.px - g.sinRake * wlZ) / cr2,
              bx = c.nx / cr2,
              ay = side * c.py,
              by = side * c.ny;
            curW[0] += W0;
            curW[1] += ax * W0 + bx * W1;
            curW[2] += ay * W0 + by * W1;
            curW[3] += ax * ax * W0 + 2 * ax * bx * W1 + bx * bx * W2;
            curW[4] += ay * ay * W0 + 2 * ay * by * W1 + by * by * W2;
          }
      }
    }

    if (detail) {
      area.push(secArea);
      wet.push(secArea > 0);
    }
    if (have) {
      const du = c.u - pU,
        avg = (p: number, q: number): number => ((p + q) / 2) * du;
      vol += avg(pV, gV);
      IX += avg(pX, gX);
      IY += avg(pY, gY);
      IZ += avg(pZ, gZ);
      wsa += avg(pS, gS);
      SX += avg(pSX, gSX);
      SZ += avg(pSZ, gSZ);
      if (wantWp) {
        wA += avg(prevW[0], curW[0]);
        wX += avg(prevW[1], curW[1]);
        wY += avg(prevW[2], curW[2]);
        wXX += avg(prevW[3], curW[3]);
        wYY += avg(prevW[4], curW[4]);
      }
    }
    for (let i = 0; i < 5; i++) prevW[i] = curW[i];
    pV = gV;
    pX = gX;
    pY = gY;
    pZ = gZ;
    pS = gS;
    pSX = gSX;
    pSZ = gSZ;
    pU = c.u;
    have = true;
  }

  // Remove only the shared centreline interior when joining the mirrored halves.
  // Keep non-centreline inner endpoints: those can be the transom boundary too.
  const boundary = (side: 0 | 1): Vec3[] => {
    const inside = inner[side],
      outside = outer[side];
    const first = inside.findIndex((p) => p[1] === 0);
    let last = -1;
    for (let i = inside.length - 1; i >= 0; i--)
      if (inside[i][1] === 0) {
        last = i;
        break;
      }
    // The legacy outline DTO cannot represent disconnected port/starboard loops.
    // Leave its drawing unavailable instead of inventing a connecting segment.
    if (first < 0) return [];
    // Only one continuous centreline seam may be removed. Leaving and then
    // rejoining it creates a hole, which this single-loop DTO cannot represent.
    for (let i = first; i <= last; i++) if (inside[i][1] !== 0) return [];
    return [
      ...inside.slice(0, first + 1).reverse(),
      ...outside,
      ...inside.slice(last).reverse(),
    ];
  };
  const stbd = boundary(0),
    port = boundary(1);
  const waterline: Vec3[] = [];
  if (outlineSupported && stbd.length && port.length)
    for (const p of [...stbd, ...port.reverse()]) {
      const prev = waterline[waterline.length - 1];
      if (!prev || p.some((v, i) => v !== prev[i])) waterline.push(p);
    }
  if (
    waterline.length > 1 &&
    waterline[0].every((v, i) => v === waterline[waterline.length - 1][i])
  )
    waterline.pop();

  const xB = vol > 0 ? IX / vol : 0,
    yB = vol > 0 ? IY / vol : 0,
    zB = vol > 0 ? IZ / vol : 0,
    wsaX = wsa > 0 ? SX / wsa : 0,
    wsaZ = wsa > 0 ? SZ / wsa : 0;
  return {
    vol,
    xB,
    yB,
    zB,
    zBWorld: xB * g.sinRake + zB * g.cosRake,
    wsa,
    wsaX,
    wsaZ,
    wsaZWorld: wsaX * g.sinRake + wsaZ * g.cosRake,
    draft,
    deckDown,
    sheerZ,
    area,
    waterline,
    waterlineSkin: [wlStbd, wlPort],
    wet,
    wp:
      wantWp && wA > 1e-9
        ? {
            area: wA,
            cx: wX / wA,
            cy: wY / wA,
            // parallel-axis back to the centroid
            it: wYY - (wY * wY) / wA,
            il: wXX - (wX * wX) / wA,
          }
        : null,
  };
}
