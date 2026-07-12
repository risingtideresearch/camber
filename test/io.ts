// I/O and numeric smoke tests.
//
// Cheap end-to-end checks of the file-format and interpolation building blocks the geometry tests
// take for granted:
//
//   - STL round-trip: buildStl (ASCII export of the default hull) → parseStl must give back a
//     non-empty triangle soup whose bounding box is symmetric in y (the export mirrors the
//     starboard half across the centerline, so any asymmetry is a serialization/parsing bug).
//   - Binary STL: a hand-built 84 + 2×50-byte buffer with two known triangles must parse to exactly
//     those vertices (guards the fixed-offset binary walk and its little-endian reads).
//   - pchip: the monotone Hermite interpolant must pass through its knots exactly — the eased
//     C2-Fritsch-Carlson slopes may reshape the curve BETWEEN knots, never at them.
//   - bspline: a clamped B-spline interpolates only its first and last control points; the sampler
//     must hit those endpoint values.
//
// Run with `npm run test:io` (tsx runs this directly under node). Non-zero exit on any failure so
// it can gate CI alongside the geometry tests.

import { createModel, resetModel } from "../src/core/model";
import { buildStl } from "../src/core/stl";
import { parseStl } from "../src/core/stlImport";
import { pchipSlopes, hermiteEval } from "../src/core/pchip";
import { clampedBSplineSamplerX } from "../src/core/bspline";
import { type Vec2 } from "../src/core/math";

// copy a string into a fresh ArrayBuffer, as parseStl expects (a FileReader hands the app one)
function asciiBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

// a binary STL buffer (80-byte header + uint32 count + 50 bytes/triangle) for the given triangles
function binaryStl(tris: number[][][]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    o += 12; // per-facet normal — the parser skips it
    for (const v of t)
      for (const c of v) {
        dv.setFloat32(o, c, true);
        o += 4;
      }
    o += 2; // attribute byte count
  }
  return buf;
}

// STL round-trip: default hull → ASCII text → parse; triangles present, bbox symmetric in y
function stlRoundTrip(): { ok: boolean; detail: string } {
  const model = createModel();
  resetModel(model);
  const geom = parseStl(asciiBuffer(buildStl(model)));
  const asym = Math.abs(geom.bbox[1] + geom.bbox[4]); // bbox = [x0,y0,z0, x1,y1,z1]
  const ok = geom.triangleCount > 0 && asym <= 1e-6;
  return {
    ok,
    detail: `${geom.triangleCount} triangles, y-asymmetry ${asym.toExponential(2)}`,
  };
}

// binary STL: two known triangles must come back with exactly these vertices (f32-exact values)
function stlBinary(): { ok: boolean; detail: string } {
  const tris = [
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ],
  ];
  const geom = parseStl(binaryStl(tris));
  const want = tris.flat(2);
  let worst = 0;
  for (let i = 0; i < want.length; i++)
    worst = Math.max(worst, Math.abs(geom.positions[i] - want[i]));
  const ok = geom.triangleCount === 2 && worst === 0;
  return {
    ok,
    detail: `${geom.triangleCount} triangles, max vertex error ${worst}`,
  };
}

// pchip: the interpolant passes through its knots exactly for a small monotone data set
function pchipKnots(): { ok: boolean; detail: string } {
  const xs = [0, 1, 3, 4, 7];
  const ys = [0, 1, 2, 5, 6];
  const m = pchipSlopes(xs, ys);
  let worst = 0;
  for (let i = 0; i < xs.length; i++)
    worst = Math.max(worst, Math.abs(hermiteEval(xs, ys, m, xs[i]) - ys[i]));
  return { ok: worst <= 1e-12, detail: `max knot error ${worst}` };
}

// bspline: the clamped sampler hits its endpoint control-point values
function bsplineEndpoints(): { ok: boolean; detail: string } {
  const pts: Vec2[] = [
    [0, 2],
    [1, 5],
    [2, 1],
    [3, 4],
  ];
  const s = clampedBSplineSamplerX(pts);
  const e0 = Math.abs(s(0) - 2);
  const e1 = Math.abs(s(3) - 4);
  const ok = e0 <= 1e-6 && e1 <= 1e-6;
  return {
    ok,
    detail: `endpoint errors ${e0.toExponential(2)} / ${e1.toExponential(2)}`,
  };
}

function main(): number {
  const cases: { name: string; run: () => { ok: boolean; detail: string } }[] =
    [
      { name: "stl round-trip", run: stlRoundTrip },
      { name: "stl binary parse", run: stlBinary },
      { name: "pchip knot interpolation", run: pchipKnots },
      { name: "bspline endpoints", run: bsplineEndpoints },
    ];
  let failures = 0;
  console.log("I/O and numerics — STL round-trip/parse, pchip and bspline\n");
  for (const { name, run } of cases) {
    const { ok, detail } = run();
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(26)} ${detail}`);
  }
  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${cases.length - failures}/${cases.length} cases ok`,
  );
  return failures === 0 ? 0 : 1;
}

process.exit(main());
