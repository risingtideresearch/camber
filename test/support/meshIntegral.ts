// An INDEPENDENT integration of the immersed hull, for checking `sweep.ts` against.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
//  DO NOT REFACTOR THIS TO SHARE CODE WITH src/core/sweep.ts.
//
//  Its entire value is that it reaches the same numbers by a different route: a surface integral over the
//  3D triangle mesh the STL exporter writes, versus a volume sweep over station-plane polygons — different
//  discretisation, different theorem, no common code. The moment it imports a helper from the thing it
//  verifies, it stops being an oracle and becomes a tautology that agrees with any bug it inherits.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Every vertex is rotated into the HEELED WORLD frame, where the waterplane is horizontal at Z = wlZ:
//
//     X = x·cos r − z·sin r ,  Y = y ,  Z = x·sin r + z·cos r     (deckRake, about the transverse axis)
//     Y' = Y·cos φ + Z·sin φ ,  Z' = Z·cos φ − Y·sin φ            (heel, about the longitudinal axis)
//
// Both are proper rotations, so volume is preserved. Each triangle is clipped to Z' ≤ wlZ, then two surface
// integrals are summed, chosen so that their normal component VANISHES on the waterplane:
//
//     ∇·(0, 0, Z'−w) = 1        → ∇
//     ∇·(0, Y'²/2, 0) = Y'      → ∫Y' dV
//
// That is what lets an OPEN mesh be integrated: the waterplane cap contributes nothing, so it never has to
// be built. The deck is likewise open in the mesh, so a caller MUST restrict itself to conditions where the
// deck edge is dry — with the deck under, the mesh leaks there and the numbers are meaningless.
//
// KN comes out directly in this frame: buoyancy acts along +Z', so the righting arm is the transverse
// offset between B and K, and K sits at Y' = keelZ·sin φ.

import { type HullSampling } from "../../src/core/mesh";
import { buildHullMesh, buildTransomMesh } from "../../src/core/hullGeometry";
import type { Model } from "../../src/core/model";

type P3 = [number, number, number];

// clip a triangle to the half-space Z ≤ w, preserving winding
function clipBelow(t: [P3, P3, P3], w: number): [P3, P3, P3][] {
  const d = [t[0][2] - w, t[1][2] - w, t[2][2] - w];
  const inN = d.filter((v) => v <= 0).length;
  if (inN === 3) return [t];
  if (inN === 0) return [];
  const mix = (a: P3, b: P3): P3 => {
    const q = (w - a[2]) / (b[2] - a[2]);
    return [a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q, w];
  };
  let k = 0;
  if (inN === 1)
    while (d[k] > 0) k++; // k = the one vertex still under
  else while (d[k] <= 0) k++; // k = the one vertex now clear
  const a = t[k],
    b = t[(k + 1) % 3],
    e = t[(k + 2) % 3];
  if (inN === 1) return [[a, mix(a, b), mix(a, e)]];
  const pab = mix(a, b),
    pae = mix(a, e);
  return [
    [pab, b, e],
    [pab, e, pae],
  ];
}

export function meshImmersed(
  model: Model,
  sampling: HullSampling,
  keelZ: number,
  phi: number,
  wlZ: number,
): { vol: number; kn: number } {
  const parts = [
    buildHullMesh(sampling, true, false, false).hull,
    buildTransomMesh(model, sampling),
  ];
  const cr = Math.cos(model.deckRake),
    sr = Math.sin(model.deckRake),
    c = Math.cos(phi),
    s = Math.sin(phi);
  const toHeeled = (p: P3): P3 => {
    const Z = p[0] * sr + p[2] * cr;
    return [p[0] * cr - p[2] * sr, p[1] * c + Z * s, Z * c - p[1] * s];
  };

  let vol = 0,
    mY = 0;
  for (const m of parts) {
    for (let t = 0; t + 8 < m.pos.length; t += 9) {
      const raw: P3[] = [0, 3, 6].map((o): P3 => [
        m.pos[t + o],
        m.pos[t + o + 1],
        m.pos[t + o + 2],
      ]);
      // the port half is a bare y-mirror, so its WINDING is inverted even though its stored normal is
      // right. Orient each triangle by its own normal rather than trusting the winding.
      const nrm: P3 = [m.nrm[t], m.nrm[t + 1], m.nrm[t + 2]];
      const gx =
        (raw[1][1] - raw[0][1]) * (raw[2][2] - raw[0][2]) -
        (raw[1][2] - raw[0][2]) * (raw[2][1] - raw[0][1]);
      const gy =
        (raw[1][2] - raw[0][2]) * (raw[2][0] - raw[0][0]) -
        (raw[1][0] - raw[0][0]) * (raw[2][2] - raw[0][2]);
      const gz =
        (raw[1][0] - raw[0][0]) * (raw[2][1] - raw[0][1]) -
        (raw[1][1] - raw[0][1]) * (raw[2][0] - raw[0][0]);
      const tri =
        gx * nrm[0] + gy * nrm[1] + gz * nrm[2] < 0
          ? [raw[0], raw[2], raw[1]]
          : raw;
      for (const q of clipBelow(tri.map(toHeeled) as [P3, P3, P3], wlZ)) {
        const [a, b, d] = q;
        // the area vector — half the edge cross product — carries both the normal and the area
        const ux = b[0] - a[0],
          uy = b[1] - a[1],
          uz = b[2] - a[2],
          vx = d[0] - a[0],
          vy = d[1] - a[1],
          vz = d[2] - a[2];
        const Ny = (uz * vx - ux * vz) / 2,
          Nz = (ux * vy - uy * vx) / 2;
        // the 3-midpoint rule is exact for the quadratic fields above
        const mid: P3[] = [
          [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
          [(b[0] + d[0]) / 2, (b[1] + d[1]) / 2, (b[2] + d[2]) / 2],
          [(d[0] + a[0]) / 2, (d[1] + a[1]) / 2, (d[2] + a[2]) / 2],
        ];
        let fV = 0,
          fY = 0;
        for (const p of mid) {
          fV += p[2] - wlZ;
          fY += (p[1] * p[1]) / 2;
        }
        vol += Nz * (fV / 3);
        mY += Ny * (fY / 3);
      }
    }
  }
  return { vol, kn: vol !== 0 ? mY / vol - keelZ * s : 0 };
}
