// ---------- mesh hydrostatics: displacement / buoyancy / waterplane from an arbitrary triangle mesh ----------
//
// Unlike hydro.ts (which samples the parametric swept sections and assumes port/starboard symmetry and an
// emergent centerline keel), this engine works on a raw triangle soup — an imported STL, or the parametric
// hull tessellated. That is what lets the app analyse ANY hull. A mesh is carried in a canonical real-world
// frame: x fore-aft (bow +x), y transverse (centered on 0), z up with the top of the hull at z ≈ 0 and the
// hull hanging below (z ≤ 0). Lengths are REAL METERS (the STL is scaled to a typed LOA; the parametric hull
// by loa/L), so volumes are m³ and, times water density, give displacement directly.
//
// The float attitude is (trim, heel, sink): the mesh is rotated by trim (about y) and heel (about x) into the
// floated frame, then the waterline is the horizontal plane z = 0 after subtracting `sink`. Submerged = z ≤ 0.
//
// Volume, center of buoyancy, waterplane area / centroid / inertia are all obtained CAP-FREE by the divergence
// theorem over the submerged (clipped) hull triangles alone. For a surface closed below the waterline whose
// only opening is the waterplane, ∮_closed g·n_z dA = ∭ ∂g/∂z dV, and the flat waterplane cap (z = 0)
// contributes nothing to any of the integrals we need (each integrand carries a factor that vanishes on the
// cap). So there is no loop-stitching and no requirement that the deck be closed — exactly right for hulls,
// which are open on top. Inconsistent-but-globally-flippable winding is corrected by the overall volume sign.

import { type Vec3 } from "./math";
import { type Model, L, prepare } from "./model";
import { trimmedHullGrid } from "./step";
import { type Axis, type StlState } from "./stlImport";

// A triangle soup in the canonical real-world frame. `positions` is 9 doubles per triangle (3 verts × xyz),
// in meters. Doubles (not Float32) so the divergence-theorem sums keep precision on large meshes.
export interface Mesh {
  positions: Float64Array;
  count: number;
}

// how the hull sits in the water: trim about the transverse (y) axis and heel about the longitudinal (x) axis,
// both in radians, plus `sink` — how far (m) the waterline plane is below the frame's z = 0 datum.
export interface Attitude {
  trim: number;
  heel: number;
  sink: number;
}

export interface MeshHydro {
  vol: number; // ∇ displaced volume (m³)
  cb: Vec3; // center of buoyancy (floated frame, m)
  awp: number; // waterplane area (m²)
  lcf: number; // longitudinal center of flotation (floated-frame x, m)
  tcf: number; // transverse center of flotation (y, m)
  it: number; // transverse waterplane inertia about the centroidal longitudinal axis (m⁴) → BMt
  il: number; // longitudinal waterplane inertia about the centroidal transverse axis (m⁴) → BMl
  wsa: number; // wetted surface area (m²)
  keelZ: number; // deepest point (floated-frame z, m; negative below the waterline)
  draft: number; // T — max immersion (m)
  ok: boolean; // a real, positive-volume immersion was found
}

// ---------- construction ----------

// the signed source component an STL Axis selects (mirrors stlImport.pick, kept local to avoid exporting it)
function pick(axis: Axis, x: number, y: number, z: number): number {
  switch (axis) {
    case "X":
      return x;
    case "-X":
      return -x;
    case "Y":
      return y;
    case "-Y":
      return -y;
    case "Z":
      return z;
    default:
      return -z; // "-Z"
  }
}

// Bring an imported STL into the canonical frame: apply the user's axis remap (so x is fore-aft, y transverse,
// z up), scale uniformly so the fore-aft extent equals the typed LOA (meters), then translate so x starts at 0,
// y is centered on the centerline, and the top of the mesh sits at z = 0 (freeboard measured down from the
// highest point). Absolute vertical placement is irrelevant to the flotation solve — the waterline is solved —
// but this keeps the frame consistent with the parametric hull for display and item placement.
export function meshFromStl(state: StlState, loa: number): Mesh {
  const { geom, settings } = state,
    src = geom.positions,
    n = src.length,
    pos = new Float64Array(n);
  let x0 = Infinity,
    y0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    z1 = -Infinity;
  for (let i = 0; i < n; i += 3) {
    const x = pick(settings.axisX, src[i], src[i + 1], src[i + 2]),
      y = pick(settings.axisY, src[i], src[i + 1], src[i + 2]),
      z = pick(settings.axisZ, src[i], src[i + 1], src[i + 2]);
    pos[i] = x;
    pos[i + 1] = y;
    pos[i + 2] = z;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  }
  const s = loa > 0 && x1 - x0 > 1e-12 ? loa / (x1 - x0) : 1,
    ycen = (y0 + y1) / 2;
  for (let i = 0; i < n; i += 3) {
    pos[i] = (pos[i] - x0) * s;
    pos[i + 1] = (pos[i + 1] - ycen) * s;
    pos[i + 2] = (pos[i + 2] - z1) * s; // top → 0
  }
  return { positions: pos, count: n / 9 };
}

// Tessellate the parametric hull into the same canonical frame (scaled by loa/L), so the SAME engine analyses
// the designed hull as a fallback when no STL is loaded — and so mesh-hydro can be cross-checked against the
// section-based hydro.ts. Mirrors stl.ts's full-width construction: starboard grid reflected to port, quads
// split into triangles, and the aft ring closed with a transom fan.
export function meshFromModel(model: Model, loa: number): Mesh {
  prepare(model);
  const M = 24,
    { grid: half } = trimmedHullGrid(model, 80, M);
  if (half.length < 4) return { positions: new Float64Array(0), count: 0 };
  const full: Vec3[][] = half.map((row) => {
    const r = row.slice();
    for (let j = M - 1; j >= 0; j--) r.push([row[j][0], -row[j][1], row[j][2]]);
    return r;
  });
  const s = loa > 0 ? loa / L : 1,
    NS = full.length - 1,
    COLS = full[0].length,
    tris: number[] = [];
  const push = (p: Vec3): void => void tris.push(p[0] * s, p[1] * s, p[2] * s);
  const tri = (a: Vec3, b: Vec3, c: Vec3): void => {
    push(a);
    push(b);
    push(c);
  };
  for (let i = 0; i < NS; i++)
    for (let j = 0; j < COLS - 1; j++) {
      const a = full[i][j],
        b = full[i][j + 1],
        c = full[i + 1][j + 1],
        d = full[i + 1][j];
      tri(a, d, c);
      tri(a, c, b);
    }
  const aft = full[0];
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const p of aft) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const ctr: Vec3 = [cx / aft.length, cy / aft.length, cz / aft.length];
  for (let j = 0; j < COLS - 1; j++) tri(aft[j], aft[j + 1], ctr);
  return { positions: Float64Array.from(tris), count: tris.length / 9 };
}

// pick the analysis subject: the imported STL if present, else the parametric hull
export function subjectMesh(
  model: Model,
  stl: StlState | null,
  loa: number,
): Mesh {
  return stl ? meshFromStl(stl, loa) : meshFromModel(model, loa);
}

// ---------- total surface area + area centroid (for the material-based structural weight) ----------
export interface SurfaceInfo {
  area: number; // total molded surface area (m²)
  centroid: Vec3; // area-weighted centroid (m) — the structural CG under a uniform shell
  closureError: number; // |Σ area-normal| / Σ area; ~0 for a cleanly closed mesh, larger if leaky/flipped
}

export function surfaceInfo(mesh: Mesh): SurfaceInfo {
  const p = mesh.positions;
  let area = 0,
    cx = 0,
    cy = 0,
    cz = 0,
    nx = 0,
    ny = 0,
    nz = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ex0 = p[i + 3] - p[i],
      ex1 = p[i + 4] - p[i + 1],
      ex2 = p[i + 5] - p[i + 2],
      fx0 = p[i + 6] - p[i],
      fx1 = p[i + 7] - p[i + 1],
      fx2 = p[i + 8] - p[i + 2];
    const ax = 0.5 * (ex1 * fx2 - ex2 * fx1),
      ay = 0.5 * (ex2 * fx0 - ex0 * fx2),
      az = 0.5 * (ex0 * fx1 - ex1 * fx0),
      a = Math.hypot(ax, ay, az);
    area += a;
    cx += (a * (p[i] + p[i + 3] + p[i + 6])) / 3;
    cy += (a * (p[i + 1] + p[i + 4] + p[i + 7])) / 3;
    cz += (a * (p[i + 2] + p[i + 5] + p[i + 8])) / 3;
    nx += ax;
    ny += ay;
    nz += az;
  }
  const centroid: Vec3 =
    area > 1e-12 ? [cx / area, cy / area, cz / area] : [0, 0, 0];
  return {
    area,
    centroid,
    closureError: area > 1e-12 ? Math.hypot(nx, ny, nz) / area : 0,
  };
}

// ---------- the hydrostatic integration ----------

// clip a convex polygon to the submerged half-space z ≤ 0 (Sutherland–Hodgman against one plane), inserting
// the z = 0 crossing where an edge straddles it. Input a triangle; output 0, 3, or 4 vertices.
function clipBelow(poly: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length],
      inA = a[2] <= 0,
      inB = b[2] <= 0;
    if (inA) out.push(a);
    if (inA !== inB) {
      const t = a[2] / (a[2] - b[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0]);
    }
  }
  return out;
}

// A LEAN evaluator for the flotation solver's inner loop: only the displaced volume, its longitudinal centroid
// (cbx), and the deepest point — the two quantities the sinkage + trim solve actually needs. Skipping the
// waterplane, transverse/vertical moments, and wetted area roughly halves the per-call cost, and the solver
// runs this thousands of times; the full meshHydrostatics is then evaluated just once, at the solved attitude.
export function meshDisplacement(
  mesh: Mesh,
  att: Attitude,
): { vol: number; cbx: number; keelZ: number } {
  const p = mesh.positions,
    ct = Math.cos(att.trim),
    st = Math.sin(att.trim),
    cf = Math.cos(att.heel),
    sf = Math.sin(att.heel),
    sink = att.sink;
  // reused per-triangle buffers — this runs thousands of times per solve, so it must not allocate
  const vx = _dvx,
    vy = _dvy,
    vz = _dvz,
    cxb = _dcx,
    cyb = _dcy,
    czb = _dcz;
  let vol = 0,
    Mx = 0,
    minZ = Infinity;
  for (let i = 0; i < p.length; i += 9) {
    // rotate the 3 vertices into the floated frame (inlined, no arrays)
    for (let j = 0; j < 3; j++) {
      const x = p[i + j * 3],
        y = p[i + j * 3 + 1],
        z = p[i + j * 3 + 2],
        x1 = x * ct + z * st,
        z1 = -x * st + z * ct;
      vx[j] = x1;
      vy[j] = y * cf - z1 * sf;
      vz[j] = y * sf + z1 * cf - sink;
    }
    if (vz[0] < minZ) minZ = vz[0];
    if (vz[1] < minZ) minZ = vz[1];
    if (vz[2] < minZ) minZ = vz[2];
    // clip the triangle to the submerged half-space z ≤ 0 into the c* buffers (≤ 4 verts)
    let n = 0;
    for (let e = 0; e < 3; e++) {
      const b = (e + 1) % 3,
        za = vz[e],
        zb = vz[b];
      if (za <= 0) {
        cxb[n] = vx[e];
        cyb[n] = vy[e];
        czb[n] = za;
        n++;
      }
      if (za <= 0 !== zb <= 0 && za !== zb) {
        const t = za / (za - zb);
        cxb[n] = vx[e] + (vx[b] - vx[e]) * t;
        cyb[n] = vy[e] + (vy[b] - vy[e]) * t;
        czb[n] = 0;
        n++;
      }
    }
    // fan-triangulate the clipped polygon; accumulate ∇ (∮ z·n_z) and its x-moment (∮ x²/2·n_x)
    for (let k = 1; k < n - 1; k++) {
      const ax = cxb[0],
        az = czb[0],
        bx = cxb[k],
        by = cyb[k],
        bz = czb[k],
        cx = cxb[k + 1],
        cy = cyb[k + 1],
        cz = czb[k + 1],
        ay = cyb[0];
      const ex1 = by - ay,
        ex2 = bz - az,
        fx1 = cy - ay,
        fx2 = cz - az,
        ex0 = bx - ax,
        fx0 = cx - ax;
      const Nx = 0.5 * (ex1 * fx2 - ex2 * fx1),
        Nz = 0.5 * (ex0 * fx1 - ex1 * fx0);
      vol += ((az + bz + cz) / 3) * Nz;
      Mx +=
        Nx *
        ((ax * ax + bx * bx + cx * cx + ax * bx + bx * cx + cx * ax) / 6) *
        0.5;
    }
  }
  const sign = vol < 0 ? -1 : 1;
  vol *= sign;
  return {
    vol,
    cbx: vol > 1e-12 ? (sign * Mx) / vol : 0,
    keelZ: Number.isFinite(minZ) ? minZ : 0,
  };
}
// module-level scratch buffers for meshDisplacement (single-threaded; reused across calls)
const _dvx = new Float64Array(3),
  _dvy = new Float64Array(3),
  _dvz = new Float64Array(3),
  _dcx = new Float64Array(4),
  _dcy = new Float64Array(4),
  _dcz = new Float64Array(4);

export function meshHydrostatics(mesh: Mesh, att: Attitude): MeshHydro {
  const p = mesh.positions,
    ct = Math.cos(att.trim),
    st = Math.sin(att.trim),
    cf = Math.cos(att.heel),
    sf = Math.sin(att.heel);
  // body → floated frame: trim about y, then heel about x, then drop by `sink` so the waterline is z = 0
  const rot = (x: number, y: number, z: number): Vec3 => {
    const x1 = x * ct + z * st,
      z1 = -x * st + z * ct;
    return [x1, y * cf - z1 * sf, y * sf + z1 * cf - att.sink];
  };
  let vol = 0,
    Mx = 0,
    My = 0,
    Mz = 0,
    Awp = 0,
    WpMx = 0,
    WpMy = 0,
    WpXX = 0,
    WpYY = 0,
    wsa = 0,
    minZ = Infinity;
  for (let i = 0; i < p.length; i += 9) {
    const A = rot(p[i], p[i + 1], p[i + 2]),
      B = rot(p[i + 3], p[i + 4], p[i + 5]),
      C = rot(p[i + 6], p[i + 7], p[i + 8]);
    if (A[2] < minZ) minZ = A[2];
    if (B[2] < minZ) minZ = B[2];
    if (C[2] < minZ) minZ = C[2];
    const poly = clipBelow([A, B, C]);
    if (poly.length < 3) continue;
    for (let k = 1; k < poly.length - 1; k++) {
      const a = poly[0],
        b = poly[k],
        c = poly[k + 1];
      const ex0 = b[0] - a[0],
        ex1 = b[1] - a[1],
        ex2 = b[2] - a[2],
        fx0 = c[0] - a[0],
        fx1 = c[1] - a[1],
        fx2 = c[2] - a[2];
      // area-normal vector (|N| = triangle area, direction from the winding)
      const Nx = 0.5 * (ex1 * fx2 - ex2 * fx1),
        Ny = 0.5 * (ex2 * fx0 - ex0 * fx2),
        Nz = 0.5 * (ex0 * fx1 - ex1 * fx0);
      wsa += Math.hypot(Nx, Ny, Nz);
      const mx = (a[0] + b[0] + c[0]) / 3,
        my = (a[1] + b[1] + c[1]) / 3,
        mz = (a[2] + b[2] + c[2]) / 3;
      // ∫∫ q² dA / Area over a triangle = (Σ q² + Σ pairwise qq) / 6
      const qx =
          (a[0] * a[0] +
            b[0] * b[0] +
            c[0] * c[0] +
            a[0] * b[0] +
            b[0] * c[0] +
            c[0] * a[0]) /
          6,
        qy =
          (a[1] * a[1] +
            b[1] * b[1] +
            c[1] * c[1] +
            a[1] * b[1] +
            b[1] * c[1] +
            c[1] * a[1]) /
          6;
      // volume ∇ = ∮ z·n_z dA (cap contributes 0); its first moments give the buoyancy centroid
      vol += mz * Nz;
      Mx += Nx * qx * 0.5;
      My += Ny * qy * 0.5;
      Mz +=
        Nz *
        ((a[2] * a[2] +
          b[2] * b[2] +
          c[2] * c[2] +
          a[2] * b[2] +
          b[2] * c[2] +
          c[2] * a[2]) /
          6) *
        0.5;
      // waterplane integrals, also cap-free: A_wp = −∮ n_z dA, ∫∫x dA = −∮ x n_z dA, etc.
      Awp += -Nz;
      WpMx += -Nz * mx;
      WpMy += -Nz * my;
      WpXX += -Nz * qx;
      WpYY += -Nz * qy;
    }
  }
  // inward-wound meshes give a negative ∇; every integral above is linear in the (flippable) normal, so one
  // global sign fixes them all together.
  const sign = vol < 0 ? -1 : 1;
  vol *= sign;
  const ok = vol > 1e-12;
  const awp = sign * Awp > 1e-12 ? sign * Awp : 0;
  const cb: Vec3 = ok
    ? [(sign * Mx) / vol, (sign * My) / vol, (sign * Mz) / vol]
    : [0, 0, 0];
  const lcf = awp ? (sign * WpMx) / (sign * Awp) : 0,
    tcf = awp ? (sign * WpMy) / (sign * Awp) : 0;
  const it = awp ? Math.max(0, sign * WpYY - sign * Awp * tcf * tcf) : 0,
    il = awp ? Math.max(0, sign * WpXX - sign * Awp * lcf * lcf) : 0;
  const keelZ = Number.isFinite(minZ) ? minZ : 0;
  return {
    vol,
    cb,
    awp,
    lcf,
    tcf,
    it,
    il,
    wsa,
    keelZ,
    draft: keelZ < 0 ? -keelZ : 0,
    ok,
  };
}

// Rotate the whole mesh into an attitude's floated frame (trim about y, heel about x, then drop by sink so the
// waterline is the horizontal plane z = 0). The 2D views draw this so the hull is shown as it floats — the
// waterline is a level line and submerged means z ≤ 0. Same transform meshHydrostatics integrates in.
export function floatedMesh(mesh: Mesh, att: Attitude): Mesh {
  const p = mesh.positions,
    out = new Float64Array(p.length),
    ct = Math.cos(att.trim),
    st = Math.sin(att.trim),
    cf = Math.cos(att.heel),
    sf = Math.sin(att.heel);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i],
      y = p[i + 1],
      z = p[i + 2],
      x1 = x * ct + z * st,
      z1 = -x * st + z * ct;
    out[i] = x1;
    out[i + 1] = y * cf - z1 * sf;
    out[i + 2] = y * sf + z1 * cf - att.sink;
  }
  return { positions: out, count: mesh.count };
}

// Slice the mesh by the axis-aligned plane {coord[axis] = value}; returns the cut segments (Vec3 pairs, mesh
// coords). Each triangle straddling the plane contributes one segment between its two edge crossings — enough
// to draw a section outline without stitching. axis: 0 = x (transverse section), 1 = y, 2 = z (waterline).
export function sliceMesh(
  mesh: Mesh,
  axis: 0 | 1 | 2,
  value: number,
): [Vec3, Vec3][] {
  const p = mesh.positions,
    segs: [Vec3, Vec3][] = [];
  for (let i = 0; i < p.length; i += 9) {
    const v: Vec3[] = [
      [p[i], p[i + 1], p[i + 2]],
      [p[i + 3], p[i + 4], p[i + 5]],
      [p[i + 6], p[i + 7], p[i + 8]],
    ];
    const hits: Vec3[] = [];
    for (let e = 0; e < 3; e++) {
      const a = v[e],
        b = v[(e + 1) % 3],
        da = a[axis] - value,
        db = b[axis] - value;
      if (da < 0 !== db < 0 && da !== db) {
        const t = da / (da - db);
        hits.push([
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ]);
      }
    }
    if (hits.length === 2) segs.push([hits[0], hits[1]]);
  }
  return segs;
}

// The mesh's open boundary edges — those used by exactly ONE triangle. For a hull open at the deck this is
// the sheer (deck-edge) loop; a watertight mesh returns none. Vertices are quantised to a bbox-relative
// tolerance so the per-triangle-duplicated STL vertices that meet at a shared edge are recognised as one.
// Used by the profile view to draw the sheer line exactly (no binning), and general enough for any STL.
export function boundaryEdges(mesh: Mesh): [Vec3, Vec3][] {
  const p = mesh.positions;
  if (p.length === 0) return [];
  let xn = Infinity,
    yn = Infinity,
    zn = Infinity,
    xx = -Infinity,
    yy = -Infinity,
    zz = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < xn) xn = p[i];
    if (p[i] > xx) xx = p[i];
    if (p[i + 1] < yn) yn = p[i + 1];
    if (p[i + 1] > yy) yy = p[i + 1];
    if (p[i + 2] < zn) zn = p[i + 2];
    if (p[i + 2] > zz) zz = p[i + 2];
  }
  const q = (Math.hypot(xx - xn, yy - yn, zz - zn) || 1) * 1e-6,
    key = (x: number, y: number, z: number): string =>
      `${Math.round(x / q)}_${Math.round(y / q)}_${Math.round(z / q)}`;
  const edges = new Map<string, { a: Vec3; b: Vec3; n: number }>();
  for (let i = 0; i < p.length; i += 9) {
    const v: Vec3[] = [
      [p[i], p[i + 1], p[i + 2]],
      [p[i + 3], p[i + 4], p[i + 5]],
      [p[i + 6], p[i + 7], p[i + 8]],
    ];
    const k = v.map((w) => key(w[0], w[1], w[2]));
    for (let e = 0; e < 3; e++) {
      const a = k[e],
        b = k[(e + 1) % 3];
      if (a === b) continue; // degenerate edge
      const ek = a < b ? `${a}|${b}` : `${b}|${a}`,
        ex = edges.get(ek);
      if (ex) ex.n++;
      else edges.set(ek, { a: v[e], b: v[(e + 1) % 3], n: 1 });
    }
  }
  const out: [Vec3, Vec3][] = [];
  for (const e of edges.values()) if (e.n === 1) out.push([e.a, e.b]);
  return out;
}

// the mesh's fore-aft / vertical extents in the canonical frame — for framing a solve and reporting freeboard
export function meshBounds(mesh: Mesh): {
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
} {
  const p = mesh.positions;
  let xMin = Infinity,
    xMax = -Infinity,
    zMin = Infinity,
    zMax = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < xMin) xMin = p[i];
    if (p[i] > xMax) xMax = p[i];
    if (p[i + 2] < zMin) zMin = p[i + 2];
    if (p[i + 2] > zMax) zMax = p[i + 2];
  }
  return { xMin, xMax, zMin, zMax };
}
