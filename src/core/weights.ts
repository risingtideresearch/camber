// ---------- weights, CG, and equilibrium flotation ----------
//
// The buoyancy side (mesh.ts) tells us how much a hull displaces at a given attitude. This module supplies the
// WEIGHT side and closes the loop:
//   • structural weight from a single material — total molded surface area × an areal density (kg/m²), with
//     the structural CG at the shell's area centroid;
//   • cargo & machinery — user-placed point masses (engine, tanks, batteries, crew, cargo);
//   • the combined total weight W and center of gravity CG;
//   • the equilibrium float: the sinkage + trim (+ heel) at which displaced weight = W and the center of
//     buoyancy sits directly under the CG — i.e. where the boat actually floats, not where a slider is set;
//   • true initial stability GMt = KMt − KG (KMt is geometry; KG comes from the weight model).
//
// Everything is engine-agnostic: it consumes a Mesh and the mesh hydrostatics, so it works identically for an
// imported STL or the tessellated parametric hull. Units are SI throughout — meters, kg, kg/m³ — and the UI
// converts for display.

import { type Vec3 } from "./math";
import {
  type Mesh,
  type Attitude,
  meshHydrostatics,
  meshDisplacement,
  meshBounds,
  surfaceInfo,
} from "./mesh";

export type Water = "salt" | "fresh";
export const waterDensity = (w: Water): number => (w === "salt" ? 1025 : 1000); // kg/m³

// a placed point mass, in the canonical mesh frame (meters), mass in kg
export interface WeightItem {
  id: string;
  name: string;
  mass: number;
  x: number;
  y: number;
  z: number;
}

// the session-only loading state for the editor
export interface WeightsState {
  loa: number; // real overall length (m) — sets the mesh scale
  water: Water;
  arealDensity: number; // kg/m² — the single hull-shell material
  items: WeightItem[];
}

export function defaultWeightsState(): WeightsState {
  return {
    loa: 8,
    water: "salt",
    arealDensity: 8, // ~ a light GRP / plywood shell
    // a modest example ballast near the default hull's center of buoyancy, low down, so the page opens on a
    // stable, sensibly-floating boat rather than a bare (and unstable) empty shell. Edit or remove it.
    items: [
      newItem({ name: "ballast (example)", mass: 1500, x: 3.2, y: 0, z: -1.3 }),
    ],
  };
}

let nextItemId = 1;
export function newItem(partial?: Partial<WeightItem>): WeightItem {
  return {
    id: `item-${nextItemId++}`,
    name: partial?.name ?? "item",
    mass: partial?.mass ?? 100,
    x: partial?.x ?? 0,
    y: partial?.y ?? 0,
    z: partial?.z ?? 0,
  };
}

export interface WeightSummary {
  hullArea: number; // total molded surface area (m²)
  structureMass: number; // kg
  structureCG: Vec3; // m
  itemsMass: number; // kg
  totalMass: number; // W (kg)
  cg: Vec3; // combined center of gravity (m)
  closureError: number; // mesh health from surfaceInfo (0 ≈ watertight)
}

// structural mass (area × areal density) + placed items → total weight and combined CG (mass-weighted)
export function weightSummary(mesh: Mesh, state: WeightsState): WeightSummary {
  const surf = surfaceInfo(mesh),
    structureMass = surf.area * state.arealDensity;
  let m = structureMass,
    mx = structureMass * surf.centroid[0],
    my = structureMass * surf.centroid[1],
    mz = structureMass * surf.centroid[2],
    itemsMass = 0;
  for (const it of state.items) {
    m += it.mass;
    itemsMass += it.mass;
    mx += it.mass * it.x;
    my += it.mass * it.y;
    mz += it.mass * it.z;
  }
  const cg: Vec3 = m > 1e-9 ? [mx / m, my / m, mz / m] : [0, 0, 0];
  return {
    hullArea: surf.area,
    structureMass,
    structureCG: surf.centroid,
    itemsMass,
    totalMass: m,
    cg,
    closureError: surf.closureError,
  };
}

// a body point's fore-aft / transverse position after rotating into the floated frame (trim about y, heel
// about x) — the same rotation meshHydrostatics applies, so CB and CG are compared in one frame.
function floatXY(
  cg: Vec3,
  trim: number,
  heel: number,
): { x: number; y: number } {
  const x1 = cg[0] * Math.cos(trim) + cg[2] * Math.sin(trim),
    z1 = -cg[0] * Math.sin(trim) + cg[2] * Math.cos(trim);
  return { x: x1, y: cg[1] * Math.cos(heel) - z1 * Math.sin(heel) };
}
function floatZ(cg: Vec3, trim: number, heel: number, sink: number): number {
  const z1 = -cg[0] * Math.sin(trim) + cg[2] * Math.cos(trim);
  return cg[1] * Math.sin(heel) + z1 * Math.cos(heel) - sink;
}

export interface Flotation {
  ok: boolean;
  note: string;
  attitude: Attitude;
  hydro: ReturnType<typeof meshHydrostatics>;
  dispMass: number; // displaced mass at the solved attitude (kg) — should equal W
  trimDeg: number; // + = bow down
  heelDeg: number; // static list from an off-center CG (small-angle); + = to starboard; 0 when unstable
  freeboardMin: number; // least height of the hull top above the waterline (m); < 0 ⇒ deck submerged
  // initial stability (m), on the keel baseline
  kb: number;
  bmt: number;
  kmt: number;
  kg: number;
  gmt: number;
  gml: number;
}

// Solve the sinkage giving the target displaced volume at a fixed trim/heel (∇ is monotone in sinkage), via
// bisection with early-exit once ∇ is within tolerance. Uses the LEAN evaluator and returns just the sink (the
// full hydrostatics is computed once, later). Returns null if even full immersion can't displace enough.
function solveSink(
  mesh: Mesh,
  vTarget: number,
  trim: number,
  heel: number,
): number | null {
  const b = meshBounds(mesh),
    corners = [b.xMin, b.xMax].flatMap((x) =>
      [b.zMin, b.zMax].map((z) => -x * Math.sin(trim) + z * Math.cos(trim)),
    );
  let lo = Math.min(...corners) - 1e-6,
    hi = Math.max(...corners) + 1e-6;
  const volAt = (sink: number): number =>
    meshDisplacement(mesh, { trim, heel, sink }).vol;
  if (volAt(hi) < vTarget) return null; // can't displace enough even fully immersed
  const tol = 1e-5 * vTarget;
  let mid = (lo + hi) / 2;
  for (let i = 0; i < 40; i++) {
    mid = (lo + hi) / 2;
    const v = volAt(mid);
    if (Math.abs(v - vTarget) <= tol) break; // early exit
    if (v < vTarget) lo = mid;
    else hi = mid;
  }
  return mid;
}

// Bracket-and-bisect a monotone residual on [-lim, lim], exiting early once |residual| is within tol; returns
// the balancing angle, or the clamped end if the residual never changes sign (can't balance in range).
function solveAngle(
  residual: (a: number) => number | null,
  lim: number,
  tol: number,
): number {
  const rl = residual(-lim),
    rh = residual(lim);
  if (rl === null || rh === null) return 0;
  if (Math.abs(rl) <= tol) return -lim;
  if (Math.abs(rh) <= tol) return lim;
  if (rl < 0 === rh < 0) return Math.abs(rl) < Math.abs(rh) ? -lim : lim; // no sign change
  let lo = -lim,
    hi = lim,
    mid = 0;
  for (let i = 0; i < 32; i++) {
    mid = (lo + hi) / 2;
    const rm = residual(mid);
    if (rm === null) return mid;
    if (Math.abs(rm) <= tol) break; // early exit
    if (rm < 0 === rl < 0) lo = mid;
    else hi = mid;
  }
  return mid;
}

const DEG = 180 / Math.PI;

// Solve the free-floating equilibrium: sinkage + trim (+ heel) so ∇·ρ = W and the center of buoyancy sits
// under the CG. Alternates a trim solve and a heel solve (each an inner sinkage solve), which converges fast
// and lands heel ≈ 0 for a symmetric hull with a centered load.
export function solveFlotation(
  mesh: Mesh,
  summary: WeightSummary,
  water: Water,
): Flotation {
  const rho = waterDensity(water),
    W = summary.totalMass,
    vTarget = W / rho,
    cg = summary.cg,
    TRIM_LIM = 25 / DEG;
  const fail = (note: string): Flotation => ({
    ok: false,
    note,
    attitude: { trim: 0, heel: 0, sink: 0 },
    hydro: meshHydrostatics(mesh, { trim: 0, heel: 0, sink: 0 }),
    dispMass: 0,
    trimDeg: 0,
    heelDeg: 0,
    freeboardMin: 0,
    kb: 0,
    bmt: 0,
    kmt: 0,
    kg: 0,
    gmt: 0,
    gml: 0,
  });
  if (!(W > 0)) return fail("No weight — add a material density and/or items.");

  // Solve UPRIGHT (heel = 0): sinkage for the target volume, then trim so CB.x sits under CG.x. We deliberately
  // do NOT chase a heel equilibrium — for an unstable hull that would be the (degenerate, ±) loll angle, which
  // is confusing to show. Instead we report GMt and, for an off-center load, a small-angle static list. The
  // loop uses the lean evaluator; the full hydrostatics is computed once, at the solved attitude.
  if (solveSink(mesh, vTarget, 0, 0) === null)
    return fail("Too heavy — the hull can't displace this weight (it sinks).");
  const trim = solveAngle(
    (t) => {
      const s = solveSink(mesh, vTarget, t, 0);
      return s === null
        ? null
        : meshDisplacement(mesh, { trim: t, heel: 0, sink: s }).cbx -
            floatXY(cg, t, 0).x;
    },
    TRIM_LIM,
    1e-4, // 0.1 mm alignment of CB under CG
  );
  const sink = solveSink(mesh, vTarget, trim, 0);
  if (sink === null)
    return fail("Too heavy — the hull can't displace this weight (it sinks).");

  const att: Attitude = { trim, heel: 0, sink },
    hydro = meshHydrostatics(mesh, att), // the ONE full evaluation
    b = meshBounds(mesh);
  // least freeboard: the hull's highest point, rotated into the floated frame, above the waterline (z = 0)
  const topFloatZ =
    Math.max(
      ...[b.xMin, b.xMax].flatMap((x) =>
        [b.zMin, b.zMax].map(
          (z) => -x * Math.sin(att.trim) + z * Math.cos(att.trim),
        ),
      ),
    ) - att.sink;
  const kb = hydro.cb[2] - hydro.keelZ,
    bmt = hydro.vol > 0 ? hydro.it / hydro.vol : 0,
    bml = hydro.vol > 0 ? hydro.il / hydro.vol : 0,
    kg = floatZ(cg, att.trim, 0, att.sink) - hydro.keelZ,
    gmt = kb + bmt - kg;
  // static list from an off-center CG: the heeling lever (TCG·cosθ) balances the righting lever (GMt·sinθ), so
  // tanθ = TCG/GMt (bounded below 90°, unlike an asin form). A metacentric estimate — accurate for a moderate
  // list; a large value means the linear stability model is being pushed past where it holds (see the note).
  const listDeg = gmt > 0 ? Math.atan(cg[1] / gmt) * DEG : 0;
  return {
    ok: true,
    note:
      hydro.awp <= 0
        ? "No waterplane at equilibrium — check the mesh/scale."
        : gmt <= 0
          ? "Unstable upright (GMt ≤ 0) — the hull would loll to a heel angle; add ballast or lower the CG."
          : Math.abs(listDeg) > 15
            ? `Large list (${Math.abs(listDeg).toFixed(0)}°) from the off-center CG — the small-angle estimate is approximate here; center the load or add ballast.`
            : "",
    attitude: att,
    hydro,
    dispMass: hydro.vol * rho,
    trimDeg: att.trim * DEG,
    heelDeg: listDeg,
    freeboardMin: topFloatZ,
    kb,
    bmt,
    kmt: kb + bmt,
    kg,
    gmt,
    gml: kb + bml - kg,
  };
}
