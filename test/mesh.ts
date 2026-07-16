// Mesh-hydrostatics regression test.
//
// The mesh engine (src/core/mesh.ts) computes displaced volume, center of buoyancy, and waterplane properties
// from a raw triangle soup by a cap-free divergence-theorem integral over the submerged clipped triangles.
// This test pins that math against closed-form answers for a rectangular box (volume, CB, waterplane area &
// inertia, wetted area at a known draft), checks that inward-wound geometry still yields a positive volume,
// verifies the flotation solver floats a box at the draft its weight implies, and cross-checks the tessellated
// PARAMETRIC hull against the independent section-based hydro.ts so the two engines agree on ∇.
//
// Run with `npm run test:mesh` (tsx). Non-zero exit on any failure so it can gate CI.

import {
  type Mesh,
  meshHydrostatics,
  meshFromModel,
  meshFromStl,
} from "../src/core/mesh";
import {
  weightSummary,
  solveFlotation,
  waterDensity,
} from "../src/core/weights";
import { createModel, resetModel, prepare } from "../src/core/model";
import { hydrostatics } from "../src/core/hydro";
import { parseStl, type StlState } from "../src/core/stlImport";
import { type Vec3 } from "../src/core/math";

let failures = 0;
function check(name: string, got: number, want: number, tol: number): void {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(34)} got ${got.toFixed(4)}  want ${want.toFixed(4)}  (±${tol})${ok ? "" : "  ✗"}`,
  );
}

// a closed axis-aligned box: x∈[0,Lx], y∈[-B/2,B/2], z∈[-D,0], outward-wound (12 triangles). `flip` reverses
// the winding so we can confirm the volume sign is auto-corrected.
function box(Lx: number, B: number, D: number, flip = false): Mesh {
  const c: Record<string, Vec3> = {
    a: [0, -B / 2, -D],
    b: [Lx, -B / 2, -D],
    d: [Lx, B / 2, -D],
    e: [0, B / 2, -D],
    f: [0, -B / 2, 0],
    g: [Lx, -B / 2, 0],
    h: [Lx, B / 2, 0],
    i: [0, B / 2, 0],
  };
  const quads: Vec3[][] = [
    [c.a, c.e, c.d, c.b], // bottom (−z)
    [c.f, c.g, c.h, c.i], // top (+z)
    [c.a, c.f, c.i, c.e], // x=0 (−x)
    [c.b, c.d, c.h, c.g], // x=Lx (+x)
    [c.a, c.b, c.g, c.f], // y=−B/2 (−y)
    [c.e, c.i, c.h, c.d], // y=+B/2 (+y)
  ];
  const tris: number[] = [];
  for (const q of quads) {
    const f = flip ? [q[0], q[3], q[2], q[1]] : q;
    for (const [p, r, s] of [
      [f[0], f[1], f[2]],
      [f[0], f[2], f[3]],
    ])
      tris.push(...p, ...r, ...s);
  }
  return { positions: Float64Array.from(tris), count: tris.length / 9 };
}

console.log(
  "Mesh hydrostatics — box closed form, winding, flotation solve, and parametric cross-check\n",
);

// ---- box at a known draft ----
const Lx = 4,
  B = 2,
  D = 1,
  T = 0.5;
console.log(`Box ${Lx}×${B}×${D}, submerged to draft T=${T}:`);
const h = meshHydrostatics(box(Lx, B, D), { trim: 0, heel: 0, sink: -D + T });
check("volume", h.vol, Lx * B * T, 1e-6);
check("CB x", h.cb[0], Lx / 2, 1e-6);
check("CB y", h.cb[1], 0, 1e-6);
check("CB z (= −T/2)", h.cb[2], -T / 2, 1e-6);
check("waterplane area", h.awp, Lx * B, 1e-6);
check("LCF", h.lcf, Lx / 2, 1e-6);
check("transverse inertia It", h.it, (Lx * B ** 3) / 12, 1e-6);
check("longitudinal inertia Il", h.il, (B * Lx ** 3) / 12, 1e-6);
check("wetted area", h.wsa, Lx * B + 2 * Lx * T + 2 * B * T, 1e-6);
check("draft", h.draft, T, 1e-6);

// ---- winding auto-correction ----
console.log("\nInward-wound box (volume sign must auto-correct):");
const hf = meshHydrostatics(box(Lx, B, D, true), {
  trim: 0,
  heel: 0,
  sink: -D + T,
});
check("volume (flipped winding)", hf.vol, Lx * B * T, 1e-6);

// ---- flotation solve: a box loaded to float at draft T ----
console.log("\nFlotation solve — box loaded to float at T=0.5:");
const rho = waterDensity("salt"),
  W = rho * Lx * B * T; // the weight that should sink the box to T
const bmesh = box(Lx, B, D);
const summary = weightSummary(bmesh, {
  loa: Lx,
  water: "salt",
  arealDensity: 0, // ignore structure; a single centered ballast item carries all the weight
  items: [{ id: "w", name: "load", mass: W, x: Lx / 2, y: 0, z: -T / 2 }],
});
const flo = solveFlotation(bmesh, summary, "salt");
check("solved displacement = W", flo.dispMass, W, 1);
check("solved draft = T", flo.hydro.draft, T, 1e-3);
check("solved trim ≈ 0°", flo.trimDeg, 0, 0.05);
check("solved heel ≈ 0°", flo.heelDeg, 0, 0.05);
check("KB = T/2", flo.kb, T / 2, 1e-3);
check("BMt = It/∇ = B²/12T", flo.bmt, B ** 2 / (12 * T), 1e-3);

// ---- cross-check the parametric hull's mesh volume vs the section-based hydro.ts ----
console.log(
  "\nParametric hull — mesh ∇ vs section-based hydro.ts ∇ (default hull, WL=150, rake=0):",
);
const model = createModel();
resetModel(model);
model.waterline = 150;
model.deckRake = 0;
prepare(model);
const hyd = hydrostatics(model);
const loa = 10,
  s = loa / 1000;
const pm = meshFromModel(model, loa);
const pmh = meshHydrostatics(pm, {
  trim: 0,
  heel: 0,
  sink: -model.waterline * s,
});
const meshVolModelUnits = pmh.vol / s ** 3;
if (hyd) {
  const rel = Math.abs(meshVolModelUnits - hyd.vol) / hyd.vol;
  console.log(
    `  mesh ∇ = ${meshVolModelUnits.toFixed(0)} (model units³), section ∇ = ${hyd.vol.toFixed(0)}, rel diff ${(rel * 100).toFixed(1)}%`,
  );
  check("mesh vs section ∇ agree", rel, 0, 0.12);
} else {
  failures++;
  console.log("  FAIL  hydrostatics() returned null");
}

// ---- full STL round-trip: serialize the box to ASCII STL, parse it, and analyse via the STL import path ----
console.log(
  "\nSTL import path — box → ASCII STL → parseStl → meshFromStl → hydrostatics:",
);
function meshToAsciiStl(m: Mesh): string {
  const p = m.positions;
  let s = "solid box\n";
  for (let i = 0; i < p.length; i += 9) {
    s += "  facet normal 0 0 0\n    outer loop\n";
    for (let v = 0; v < 9; v += 3)
      s += `      vertex ${p[i + v]} ${p[i + v + 1]} ${p[i + v + 2]}\n`;
    s += "    endloop\n  endfacet\n";
  }
  return s + "endsolid box\n";
}
const stlText = meshToAsciiStl(box(Lx, B, D));
const geom = parseStl(new TextEncoder().encode(stlText).buffer);
const state: StlState = {
  geom,
  designBox: [0, 0, 0, 1, 1, 1],
  settings: {
    visible: true,
    axisX: "X",
    axisY: "Y",
    axisZ: "Z",
    scale: 1,
    opacity: 0.5,
    shaded: true,
    wireframe: false,
  },
};
// LOA = Lx ⇒ scale = 1, so meshFromStl reproduces the box in the canonical frame exactly
const stlMesh = meshFromStl(state, Lx);
check("parsed triangle count", geom.triangleCount, 12, 0);
const sh = meshHydrostatics(stlMesh, { trim: 0, heel: 0, sink: -D + T });
check("STL-path volume", sh.vol, Lx * B * T, 1e-4);
check("STL-path draft", sh.draft, T, 1e-4);
check("STL-path waterplane area", sh.awp, Lx * B, 1e-4);

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failing check(s)`,
);
process.exit(failures === 0 ? 0 : 1);
