// I/O and numeric smoke tests.
//
// Cheap end-to-end checks of the file-format and interpolation building blocks the geometry tests
// take for granted:
//
//   - STL round-trip: buildStl (ASCII export of the default hull) → parseStl must give back a
//     non-empty triangle soup whose bounding box is symmetric in y (the export mirrors the
//     starboard half across the centerline, so any asymmetry is a serialization/parsing bug).
//   - STL closed: with all three surfaces on (hull, transom, deck) the export must be watertight
//     and consistently wound — every directed edge matched by exactly one edge the other way, and
//     a positive signed volume (facets wound outward). Any gap on a seam (keel, transom, sheer) or
//     an inside-out patch (the port mirror, the transom, the deck) fails it.
//   - STL options: each surface can be left out, and the hull alone (the default without the deck)
//     is open along the sheer — so the option is doing something.
//   - Binary STL: a hand-built 84 + 2×50-byte buffer with two known triangles must parse to exactly
//     those vertices (guards the fixed-offset binary walk and its little-endian reads).
//   - pchip: the monotone Hermite interpolant must pass through its knots exactly — the eased
//     C2-Fritsch-Carlson slopes may reshape the curve BETWEEN knots, never at them.
//   - bspline: a clamped B-spline interpolates only its first and last control points; the sampler
//     must hit those endpoint values, and the plan curve's nearest-point query (which is what a
//     station handle rides during a plan drag) must agree with a brute-force scan of the curve.
//
// Run with `npm run test:io` (tsx runs this directly under node). Non-zero exit on any failure so
// it can gate CI alongside the geometry tests.

import { assemble } from "../src/core/runtime";
import { defaultHull } from "../src/core/hull";
import { buildStl } from "../src/core/stl";
import { parseStl } from "../src/core/stlImport";
import { pchipSlopes, hermiteEval } from "../src/core/pchip";
import { clampedBSplineSamplerX, planCurve } from "../src/core/bspline";
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
  const model = assemble(defaultHull());
  const geom = parseStl(asciiBuffer(buildStl(model)));
  const asym = Math.abs(geom.bbox[1] + geom.bbox[4]); // bbox = [x0,y0,z0, x1,y1,z1]
  const ok = geom.triangleCount > 0 && asym <= 1e-6;
  return {
    ok,
    detail: `${geom.triangleCount} triangles, y-asymmetry ${asym.toExponential(2)}`,
  };
}

// the edges of a triangle soup, keyed by their endpoints' exact coordinates: how many times each directed
// edge occurs, and the soup's signed volume (the sum of the tetrahedra each facet spans with the origin —
// positive when the facets are wound outward round a closed solid)
function edgeBook(positions: Float32Array): {
  edges: Map<string, number>;
  volume: number;
} {
  const edges = new Map<string, number>();
  let volume = 0;
  const key = (i: number): string =>
    `${positions[i]},${positions[i + 1]},${positions[i + 2]}`;
  for (let t = 0; t + 8 < positions.length; t += 9) {
    const k = [key(t), key(t + 3), key(t + 6)];
    for (let e = 0; e < 3; e++) {
      const d = k[e] + "→" + k[(e + 1) % 3];
      edges.set(d, (edges.get(d) ?? 0) + 1);
    }
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.subarray(t, t + 9);
    volume +=
      (ax * (by * cz - bz * cy) -
        ay * (bx * cz - bz * cx) +
        az * (bx * cy - by * cx)) /
      6;
  }
  return { edges, volume };
}

// the directed edges with no twin (the same two vertices the other way round): the boundary of the soup
// plus every edge of an inconsistently wound pair
function unmatchedEdges(edges: Map<string, number>): number {
  let n = 0;
  for (const [d, c] of edges) {
    const [a, b] = d.split("→");
    if (c !== 1 || edges.get(b + "→" + a) !== 1) n++;
  }
  return n;
}

// STL closed: hull + transom + deck must be a watertight, outward-wound solid
function stlClosed(): { ok: boolean; detail: string } {
  const model = assemble(defaultHull());
  const all = { hull: true, transom: true, deck: true };
  const geom = parseStl(asciiBuffer(buildStl(model, "camber", all)));
  const { edges, volume } = edgeBook(geom.positions);
  const open = unmatchedEdges(edges);
  const ok = geom.triangleCount > 0 && open === 0 && volume > 0;
  return {
    ok,
    detail: `${geom.triangleCount} triangles, ${open} unmatched edges, signed volume ${volume.toExponential(3)}`,
  };
}

// STL options: each surface is left out when unticked, and without the deck the sheer stays open
function stlOptions(): { ok: boolean; detail: string } {
  const model = assemble(defaultHull());
  const count = (o: { hull: boolean; transom: boolean; deck: boolean }) =>
    parseStl(asciiBuffer(buildStl(model, "camber", o))).triangleCount;
  const hull = count({ hull: true, transom: false, deck: false }),
    transom = count({ hull: false, transom: true, deck: false }),
    deck = count({ hull: false, transom: false, deck: true }),
    all = count({ hull: true, transom: true, deck: true });
  const noDeck = parseStl(
    asciiBuffer(
      buildStl(model, "camber", { hull: true, transom: true, deck: false }),
    ),
  );
  const openNoDeck = unmatchedEdges(edgeBook(noDeck.positions).edges);
  let refused = false;
  try {
    buildStl(model, "camber", { hull: false, transom: false, deck: false });
  } catch {
    refused = true;
  }
  const ok =
    hull > 0 &&
    transom > 0 &&
    deck > 0 &&
    all === hull + transom + deck &&
    openNoDeck > 0 &&
    refused;
  return {
    ok,
    detail: `hull ${hull} + transom ${transom} + deck ${deck} = ${all} triangles; ${openNoDeck} open edges without the deck; empty selection ${refused ? "refused" : "ACCEPTED"}`,
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

// plan curve: uAtPoint must find the GLOBAL nearest point, matched against a dense brute-force scan.
// The probes are the awkward ones — off the beam amidships, off the bow where the plan turns hard toward
// the centerline, and past either end, where the answer is the clamped endpoint rather than a foot.
function planNearestPoint(): { ok: boolean; detail: string } {
  const c = planCurve([
    [0, 300],
    [1000, 480],
    [2500, 500],
    [4000, 380],
    [5000, 0],
  ]);
  const probes: Vec2[] = [
    [2500, 600], // abeam, amidships
    [4900, 200], // off the bow, in the turn
    [1000, 100], // inboard, where a station's segment reaches
    [5200, -100], // past the stem
    [-300, 300], // aft of the transom
  ];
  const N = 100000;
  let worst = 0;
  for (const q of probes) {
    let ref = 0,
      rd = Infinity;
    for (let i = 0; i <= N; i++) {
      const u = i / N,
        p = c.at(u),
        d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < rd) {
        rd = d;
        ref = u;
      }
    }
    worst = Math.max(worst, Math.abs(c.uAtPoint(q) - ref));
  }
  return {
    ok: worst <= 1e-4,
    detail: `worst u error ${worst.toExponential(2)}`,
  };
}

function main(): number {
  const cases: { name: string; run: () => { ok: boolean; detail: string } }[] =
    [
      { name: "stl round-trip", run: stlRoundTrip },
      { name: "stl closed mesh", run: stlClosed },
      { name: "stl export options", run: stlOptions },
      { name: "stl binary parse", run: stlBinary },
      { name: "pchip knot interpolation", run: pchipKnots },
      { name: "bspline endpoints", run: bsplineEndpoints },
      { name: "plan nearest point", run: planNearestPoint },
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
