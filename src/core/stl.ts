// ---------- STL export: a triangle mesh of the trimmed hull ----------
//
// The very geometry the 3D view renders: the shared sampling's trimmed quad/tri mesh (`buildHullMesh`, both
// halves) plus the flat transom panel (`buildTransomMesh`), emitted facet by facet. So the exported solid is
// exactly what is on screen — trimmed in both directions, with the transom closed by its own planar face
// rather than a centroid fan. The deck stays open (as the STEP OPEN_SHELL does).
//
// Output is ASCII STL in MILLIMETRES. STL carries no unit of its own and is universally read as mm, so a hull
// authored in another unit is converted on the way out — the model's coordinates are absolute in `model.unit`
// now, so "the model's native units" is no longer a synonym for millimetres.

import { type Model, prepare } from "./model";
import { computeHullSampling } from "./mesh";
import { buildHullMesh, buildTransomMesh, type Mesh } from "./hullGeometry";
import { unitScale } from "./json";
import { V, type Vec3 } from "./math";

function facet(a: Vec3, b: Vec3, c: Vec3): string {
  const n = V.cross(V.sub(b, a), V.sub(c, a));
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const f = (v: number): string => v.toFixed(4);
  return (
    `  facet normal ${f(n[0] / len)} ${f(n[1] / len)} ${f(n[2] / len)}\n` +
    `    outer loop\n` +
    `      vertex ${f(a[0])} ${f(a[1])} ${f(a[2])}\n` +
    `      vertex ${f(b[0])} ${f(b[1])} ${f(b[2])}\n` +
    `      vertex ${f(c[0])} ${f(c[1])} ${f(c[2])}\n` +
    `    endloop\n` +
    `  endfacet\n`
  );
}

// build an ASCII STL string for the current model (call after resetModel + loadJsonText, as STEP export does)
export function buildStl(model: Model, name = "camber"): string {
  prepare(model); // ensure the derived curves are current
  // R = 6 on the default 5-point section gives a 24-column half, as v1's M did
  const sampling = computeHullSampling(model, 80, 6);
  const { hull } = buildHullMesh(sampling, true, false, false);
  if (hull.count < 3) throw new Error("hull has too few sections to export");
  const transom = buildTransomMesh(model, sampling);
  const s = unitScale(model.unit, "mm");

  // every mesh emits 3 vertices (9 floats) per triangle, already wound with the normal facing out of the hull
  const facetsOf = (m: Mesh): string => {
    let out = "";
    for (let t = 0; t + 8 < m.pos.length; t += 9) {
      const p = (o: number): Vec3 => [
        m.pos[t + o] * s,
        m.pos[t + o + 1] * s,
        m.pos[t + o + 2] * s,
      ];
      out += facet(p(0), p(3), p(6));
    }
    return out;
  };

  return (
    `solid ${name}\n` +
    facetsOf(hull) +
    facetsOf(transom) +
    `endsolid ${name}\n`
  );
}
