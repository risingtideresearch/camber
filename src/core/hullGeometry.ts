// ---------- hull geometry: pure builders for the 3D view ----------
//
// Everything here builds plain { pos, nrm, count } Float32Array meshes (or Vec3 polylines) in MODEL space —
// no GL, no camera, no React. The 3D view (components/view3d/*) uploads these into three.js BufferGeometry
// and owns the camera/rendering; hullShader.ts owns the GLSL; hullLines3d.ts builds the lines-plan curves.
// Deck rake is NOT baked in here — it is applied once, as a rigid Y-axis rotation, by the scene's own
// <group> transform (rx = x·cosθ − z·sinθ, rz = x·sinθ + z·cosθ is exactly three's rotateY(−θ)) — so every
// builder below emits unraked, deck-flat coordinates.

import { type Vec2, type Vec3, V } from "./math";
import {
  type Model,
  frameAt,
  keepAt,
  knotLongitudinalsWorld,
  loa,
  sectionAt,
  stationWorld,
} from "./model";
import { crCurveAuto } from "./spline";
import {
  computeHullSampling,
  keelPointAt,
  longitudinalPointAt,
  sheerPointAt,
  sweptSection,
  transomOutline,
  trimmedHullGrid,
  type HullSample,
  type HullSampling,
} from "./mesh";
import { perfStep } from "./perf";
import { curveCombs3, type Comb3, type CurvatureSettings } from "./comb";

export interface Mesh {
  pos: Float32Array;
  nrm: Float32Array;
  count: number;
}
export const emptyMesh = (): Mesh => ({
  pos: new Float32Array(0),
  nrm: new Float32Array(0),
  count: 0,
});

// The "longitudinal" of a single station-point index: the locus that control point traces along the hull.
// That locus is exactly the LOFT of point idx — the curve v2 interpolates across the stations — read at each
// u and placed into the world by the frame there, the same construction the hull surface uses. So the curve
// rides exactly on the swept sheet (it is the keel line when idx is the keel point, a chine line at a
// knuckle, etc.). Each sample is trimmed exactly as the hull is — `keepAt` is the same signed min of the
// sheer trim, the centerline and the transom plane the mesh uses — so the line stops where the hull does (an
// overshooting keel point, for instance, only shows where it actually reaches the centerline). Returned as
// starboard plus its port mirror, each broken across trimmed-away spans; the view draws them as ribbons.
export function buildLongitudinalCurve(model: Model, idx: number): Vec3[][] {
  if (idx < 0 || idx >= model.loft.S) return [];
  const N = 160;
  const W: Vec3[] = [],
    keep: boolean[] = []; // each sample trimmed the same way the hull surface is
  for (let i = 0; i <= N; i++) {
    const u = i / N,
      fr = frameAt(model, u),
      nz = model.loft.at(u).pts[idx];
    W.push(stationWorld(fr, nz[0], nz[1]));
    keep.push(keepAt(model, fr, nz) >= 0);
  }
  const runs: Vec3[][] = [];
  for (const sgn of [1, -1])
    for (const run of keptRuns(
      W.map((p): Vec3 => [p[0], sgn * p[1], p[2]]),
      keep,
    ))
      runs.push(run);
  return runs;
}

// split a sampled polyline into maximal runs of consecutive KEPT points (a trimmed-away span breaks the run)
export function keptRuns(pts: Vec3[], keep: boolean[]): Vec3[][] {
  const runs: Vec3[][] = [];
  let cur: Vec3[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) cur.push(pts[i]);
    else {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

// ---------- the authored stations, as 3D construction lines ----------
//
// The Lines dropdown's "Stations" group: the model's own control geometry, drawn over whatever surface is up
// — nothing here is read off the mesh, unlike the sampled lines-plan families. Per station: its full section
// curve (the same crCurveAuto construction the 2D section editor draws, placed by the station's frame) and
// its knots — the authored control points — as their world centres, which the view draws as camera-facing
// dot markers at a constant screen size (the 3D reading of the 2D editors' fixed-size dots — see
// ringAttributes).
// Across the stations: the knot longitudinals, each knot index's untrimmed loft locus. All of it is
// one-sided (starboard), like the 2D editors it mirrors: it is the authored geometry, not the finished hull.
//
// Colours are returned as the station INDEX, mapped to the shared accent palette by the view — colors.ts
// reads CSS custom properties at import time, so a core module must not pull it in (the core also runs under
// node in the tests).
export interface StationLines3 {
  curves: { si: number; line: Vec3[] }[]; // per station: its full authored section curve
  knots: { si: number; centers: Vec3[] }[]; // per station: its knots' world centres
  longs: Vec3[][]; // the knot longitudinals, one polyline per knot index, drawn as one grey job
}

export function buildStationLines(
  model: Model,
  show: { curves: boolean; knots: boolean; longs: boolean },
): StationLines3 {
  const out: StationLines3 = { curves: [], knots: [], longs: [] };
  if (show.curves || show.knots)
    model.stations.forEach((st, si) => {
      const fr = frameAt(model, st.u);
      if (show.curves) {
        const c = crCurveAuto(
            st.points.map((p): Vec2 => [p.n, p.z]),
            st.points.map((p) => p.k),
          ),
          line: Vec3[] = [],
          N = 160;
        for (let i = 0; i <= N; i++) {
          const p = c.at((c.vmax * i) / N);
          line.push(stationWorld(fr, p[0], p[1]));
        }
        out.curves.push({ si, line });
      }
      if (show.knots)
        out.knots.push({
          si,
          centers: st.points.map((p) => stationWorld(fr, p.n, p.z)),
        });
    });
  if (show.longs) out.longs = knotLongitudinalsWorld(model);
  return out;
}

// ---------- ribbon geometry: the view-independent half of a camera-facing ribbon ----------
//
// A guide curve has to read at a reliable width, which WebGL's own one-pixel lines can't give it, so each is
// drawn as a thin flat ribbon turned to face the camera. The widening axis depends on the view, and building
// it here meant rewriting every vertex on every frame the camera moved — at the lines plan's density, several
// milliseconds of every orbit frame. So the widening now happens in the vertex shader (ribbonShader.ts) and
// this builds only what the camera can't change: two vertices per polyline point, one for each side, each
// carrying the curve's unit tangent there, plus the indices that stitch consecutive points into quads.
export interface RibbonAttributes {
  position: Float32Array; // the curve point itself — the shader offsets it sideways from here
  tangent: Float32Array; // the curve's unit tangent there (a point's two vertices share it)
  side: Float32Array; // −1 / +1: which edge of the ribbon this vertex is
  index: Uint16Array | Uint32Array;
  count: number; // vertices
}

export function ribbonAttributes(polylines: Vec3[][]): RibbonAttributes {
  let nPts = 0,
    nSeg = 0;
  for (const line of polylines)
    if (line.length >= 2) {
      nPts += line.length;
      nSeg += line.length - 1;
    }
  const position = new Float32Array(nPts * 6),
    tangent = new Float32Array(nPts * 6),
    side = new Float32Array(nPts * 2),
    count = nPts * 2,
    // a 16-bit index buffer is the cheaper upload, but the lines plan's families run well past 65,535
    // vertices — three would silently draw a wrapped-around mess rather than complain
    index =
      count > 65535 ? new Uint32Array(nSeg * 6) : new Uint16Array(nSeg * 6);
  let v = 0,
    ii = 0;
  for (const line of polylines) {
    const m = line.length;
    if (m < 2) continue;
    const base = v;
    for (let i = 0; i < m; i++) {
      // the central difference, one-sided at the ends — the same tangent the CPU widening used
      const t = V.norm(
          V.sub(line[Math.min(i + 1, m - 1)], line[Math.max(i - 1, 0)]),
        ),
        c = line[i];
      for (const s of [-1, 1]) {
        position[v * 3] = c[0];
        position[v * 3 + 1] = c[1];
        position[v * 3 + 2] = c[2];
        tangent[v * 3] = t[0];
        tangent[v * 3 + 1] = t[1];
        tangent[v * 3 + 2] = t[2];
        side[v] = s;
        v++;
      }
    }
    for (let i = 0; i + 1 < m; i++) {
      const a = base + 2 * i; // this point's pair is (a, a+1); the next point's is (a+2, a+3)
      index[ii++] = a;
      index[ii++] = a + 1;
      index[ii++] = a + 3;
      index[ii++] = a;
      index[ii++] = a + 3;
      index[ii++] = a + 2;
    }
  }
  return { position, tangent, side, index, count };
}

// ---------- ring geometry: the view-independent half of a camera-facing ring marker ----------
//
// The same split as the ribbon above, for the knot markers: what the camera can't change is only WHERE each
// marker is, so every vertex carries the marker's centre plus its angle around the ring and which rim it is,
// and the ring-marker shader (ribbonShader.ts) does the rest — offsetting into the view plane at a constant
// screen radius, like the 2D editors' fixed-size dots. Two vertices per angle step (the inner and outer rim),
// stitched into an annulus with the indices wrapping the seam.
export interface RingAttributes {
  position: Float32Array; // the marker's centre, repeated — the shader offsets every vertex from it
  angle: Float32Array; // this vertex's angle around the ring
  side: Float32Array; // −1 / +1: the inner or the outer rim
  index: Uint16Array | Uint32Array;
  count: number; // vertices
}

const RING_SEGS = 24;

export function ringAttributes(centers: Vec3[]): RingAttributes {
  const perRing = 2 * RING_SEGS,
    count = centers.length * perRing,
    position = new Float32Array(count * 3),
    angle = new Float32Array(count),
    side = new Float32Array(count),
    index =
      count > 65535
        ? new Uint32Array(centers.length * RING_SEGS * 6)
        : new Uint16Array(centers.length * RING_SEGS * 6);
  let v = 0,
    ii = 0;
  for (const c of centers) {
    const base = v;
    for (let i = 0; i < RING_SEGS; i++) {
      const t = (2 * Math.PI * i) / RING_SEGS;
      for (const s of [-1, 1]) {
        position[v * 3] = c[0];
        position[v * 3 + 1] = c[1];
        position[v * 3 + 2] = c[2];
        angle[v] = t;
        side[v] = s;
        v++;
      }
    }
    for (let i = 0; i < RING_SEGS; i++) {
      const a = base + 2 * i,
        b = base + 2 * ((i + 1) % RING_SEGS); // the next step's pair, wrapping the seam
      index[ii++] = a;
      index[ii++] = a + 1;
      index[ii++] = b + 1;
      index[ii++] = a;
      index[ii++] = b + 1;
      index[ii++] = b;
    }
  }
  return { position, angle, side, index, count };
}

// ---------- 3D curvature combs (curvature-analysis overlay) ----------
// A curvature "comb" (graph hairs): at sample points along a hull curve a hair is drawn perpendicular to it
// on the OUTSIDE of the bend (away from the centre of curvature), its length ∝ the curvature κ; joining the
// hair tips gives the envelope, whose kinks reveal curvature (G2) discontinuities. The CurvatureControls
// overlay draws four families of these on the 3D hull — the sheer edge, the keel/centerline, a fan of
// fore-aft longitudinals, and a fan of transverse sections — each self-scaled so its sharpest hair is
// COMB_LEN world units. The comb geometry comes from the shared exact-evaluator builders (core/comb) fed
// with each curve's converged original definition (model.ts); this file only picks the curves — the 3D view
// turns them into camera-facing ribbons (CameraFacingCurves.tsx).
// the length of the sharpest curvature hair (each comb auto-scales to this), as a fraction of the hull's own
// length — model coordinates are absolute now, so a fixed world number would read differently on a 5 m hull
// and a 500 mm one
export const COMB_LEN_F = 0.09;
// the sheer accent (matches --sheer in the 2D lines views); its comb shares the hue, reading as one overlay
export const SHEER_RGB = [0.867, 0.42, 0.125];

// per-family colours — linear-ish RGB (for the 3D ribbons) and the matching CSS hue (for the app's 2D views)
export const CURV_RGB: Record<string, number[]> = {
  sheer: SHEER_RGB, // orange
  keel: [0.059, 0.463, 0.376], // teal (--keel)
  long: [0.486, 0.227, 0.929], // violet (--fore)
  sect: [0.28, 0.34, 0.42], // slate
};
export const CURV_CSS: Record<string, string> = {
  sheer: "var(--sheer)",
  keel: "var(--keel)",
  long: "var(--fore)",
  sect: "#475569",
};

// one curve of the overlay: the base curve plus its curvature comb, in world space. `mirror` = also draw the
// port y-reflection (sheer / longitudinals are one-sided starboard curves; the keel sits on the centerline
// and the sections are already full-width, so those carry mirror = false).
export interface CurvCurve3 {
  curve: Vec3[];
  hairs: [Vec3, Vec3][];
  env: Vec3[];
  rgb: number[];
  css: string;
  mirror: boolean;
}

// build the enabled 3D curvature curves + combs for the current settings. World-space and rotation-
// independent, so the caller can cache this and only rebuild it when the model / settings change. The
// section / longitudinal counts pick how many curves of each fan get a comb; the hair counts set each comb's
// density (shared with the 2D combs via CurvatureSettings). The drawn CURVES stay the dense sampled
// polylines; each COMB is built from that curve's original converged evaluator (see comb.ts) — never by
// differencing the sampled polyline — so κ is exact and the envelope is stable under resampling.
export function buildCurvature3(
  model: Model,
  s: CurvatureSettings,
): CurvCurve3[] {
  const out: CurvCurve3[] = [],
    COMB_LEN = COMB_LEN_F * loa(model);
  const add = (
    curve: Vec3[],
    comb: Comb3 | null,
    key: string,
    mirror: boolean,
  ): void => {
    if (curve.length < 3) return;
    out.push({
      curve,
      hairs: comb?.hairs ?? [],
      env: comb?.env ?? [],
      rgb: CURV_RGB[key],
      css: CURV_CSS[key],
      mirror,
    });
  };
  // a partial evaluator yields one comb per existence run; the drawn 3D curves are single runs
  // (sweptSection keeps the largest interval), so keep the longest comb (hair spacing is uniform,
  // so most hairs = longest run)
  const longest = (cs: Comb3[]): Comb3 | null =>
    cs.reduce<Comb3 | null>(
      (a, b) => (!a || b.hairs.length > a.hairs.length ? b : a),
      null,
    );

  // the trimmed sheer edge (the hull's 3D top edge). `sheerPointAt` is the converged trim crossing at u, and
  // it is partial (null where there is no hull), so it serves as BOTH the dense drawn curve and the comb's
  // exact evaluator — v1 needed a bespoke shared-pass evaluator (trimmedSheerViz) only because its crossing
  // was not converged on its own.
  if (s.d3Sheer) {
    const N = 600,
      curve: Vec3[] = [];
    for (let i = 0; i <= N; i++) {
      const p = sheerPointAt(model, i / N);
      if (p) curve.push(p);
    }
    add(
      curve,
      longest(
        curveCombs3(
          (u) => sheerPointAt(model, u),
          0,
          1,
          s.nLongHairs,
          COMB_LEN,
        ),
      ),
      "sheer",
      true,
    );
  }

  // the keel/centerline and the longitudinal fan both ride the fair hull grid, so build it once if either is
  // on. The grid is FULL WIDTH — column 0 the starboard sheer, column M the keel, column 2M the port sheer —
  // while the exact evaluators index the HALF, so the combs read half-index j and the drawn curve column j.
  if (s.d3Centerline || (s.d3Longitudinals && s.nLongCombs > 0)) {
    const R = 10,
      { grid } = trimmedHullGrid(model, 140, R),
      M = (grid[0]?.length ?? 1) >> 1; // the keel's column: the rows are 2M+1 wide
    if (s.d3Centerline)
      add(
        grid.map((row) => row[M]),
        longest(
          curveCombs3(
            (u) => keelPointAt(model, u),
            0,
            1,
            s.nLongHairs,
            COMB_LEN,
          ),
        ),
        "keel",
        false,
      );
    if (s.d3Longitudinals && s.nLongCombs > 0) {
      const n = Math.min(s.nLongCombs, M - 1);
      for (let k = 0; k < n; k++) {
        // spread the combed columns across the interior girth (skip col 0 = sheer and col M = keel)
        const j =
          n === 1 ? Math.round(M / 2) : Math.round(1 + ((M - 2) * k) / (n - 1));
        add(
          grid.map((row) => row[j]),
          longest(
            curveCombs3(
              (u) => longitudinalPointAt(model, u, R, j),
              0,
              1,
              s.nLongHairs,
              COMB_LEN,
            ),
          ),
          "long",
          true,
        );
      }
    }
  }

  // the transverse section fan, full-width where the sections close across the keel
  if (s.d3Sections && s.nSectCombs > 0) {
    const n = s.nSectCombs;
    for (let k = 0; k < n; k++) {
      const u = n === 1 ? 0.5 : (k + 0.5) / n,
        sec = sweptSection(model, u, 10, true);
      if (sec.empty || sec.pts.length < 3) continue;
      let curve = sec.pts;
      if (sec.keel) {
        // mirror the starboard half to port through the shared keel point (dropped once), one smooth section
        curve = sec.pts.slice();
        for (let j = sec.pts.length - 2; j >= 0; j--)
          curve.push([sec.pts[j][0], -sec.pts[j][1], sec.pts[j][2]]);
      }
      // the comb: the section over its kept span, null wherever the hull's own trim cuts it away, so the run
      // edges converge onto the real clip
      const fr = frameAt(model, u),
        st = sectionAt(model, u);
      const f = (t: number): Vec3 | null => {
        const nz = st.at(t);
        return keepAt(model, fr, nz) >= 0
          ? stationWorld(fr, nz[0], nz[1])
          : null;
      };
      add(
        curve,
        longest(curveCombs3(f, 0, st.vmax, s.nSectHairs, COMB_LEN)),
        "sect",
        false,
      );
    }
  }
  return out;
}

export function pushTri(
  P: number[],
  Nn: number[],
  p0: Vec3,
  n0: Vec3,
  p1: Vec3,
  n1: Vec3,
  p2: Vec3,
  n2: Vec3,
): void {
  P.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
  Nn.push(n0[0], n0[1], n0[2], n1[0], n1[1], n1[2], n2[0], n2[1], n2[2]);
}

export const WIRE_RGB = [0.04, 0.05, 0.07]; // near-black grid lines, for contrast against the lit hull
const wireEdge = (arr: number[], a: Vec3, b: Vec3): void => {
  arr.push(a[0], a[1], a[2], b[0], b[1], b[2]);
};

// ---------- the hull mesh, welded from the shared sampling's trimmed cells ----------
//
// The sampling (mesh.ts) trimmed the SHEET itself into whole quads and boundary triangles — every vertex a
// HullSample carrying its girth index and crease strength, and shared boundary vertices shared by OBJECT
// IDENTITY. So the mesh builder no longer stitches ragged columns or splices a foot: it welds those faces onto
// a deduplicated vertex set (the same HullSample in two faces is one vertex) and mirrors the starboard half to
// port. The per-vertex normals ride ON the samples: each HullSample carries the surface normal computed
// straight from the sheet f(u,v) (mesh.ts), split into a −v side and a +v side so a knuckle keeps its edge — so
// the builder only reads and blends them, it no longer averages neighbouring faces. The trim, the boundary,
// the foot, and now the normals all live in the sampling.
//
// Only the STARBOARD half is built; the port half is its exact y-mirror (positions and normals negated), so
// the two halves meet on the centerline sharing the keel line. Every vertex keeps the surface normal the sheet
// f(u,v) gave it — the crease coefficient already shaped that, so nothing is blended or zeroed at emit.

export function buildHullMesh(
  sampling: HullSampling,
  trimmed: boolean,
  wantWire: boolean,
  wireQuads: boolean, // wire as quads (true) or the raw shaded triangles (false); ignored unless wantWire
): { hull: Mesh; wire: Mesh | null } {
  // weld the sampling's faces onto a deduplicated vertex set. Trimmed → the quad/tri mesh; the raw Sheet view
  // → every cell of the untrimmed grid.
  const verts: HullSample[] = [],
    vIdx = new Map<HullSample, number>();
  const idOf = (s: HullSample): number => {
    let id = vIdx.get(s);
    if (id === undefined) {
      id = verts.length;
      verts.push(s);
      vIdx.set(s, id);
    }
    return id;
  };
  const rawTris: [number, number, number][] = [];
  const weld = (a: HullSample, b: HullSample, c: HullSample): void => {
    rawTris.push([idOf(a), idOf(b), idOf(c)]);
  };
  perfStep(
    "Welding cells",
    () => {
      if (trimmed) {
        for (const q of sampling.hullQuads) {
          weld(q[0], q[1], q[2]);
          weld(q[0], q[2], q[3]);
        }
        for (const t of sampling.hullTris) weld(t[0], t[1], t[2]);
      } else {
        const sh = sampling.sheet;
        for (let i = 0; i + 1 < sh.length; i++)
          for (let k = 0; k + 1 < sh[i].length; k++) {
            weld(sh[i][k], sh[i + 1][k], sh[i + 1][k + 1]);
            weld(sh[i][k], sh[i + 1][k + 1], sh[i][k + 1]);
          }
      }
      return rawTris;
    },
    (t) => t.length,
    "tris",
  );
  if (rawTris.length < 1) return { hull: emptyMesh(), wire: null };

  const pos = verts.map((s) => s.pos),
    vg = verts.map((s) => s.vSheetIndex), // per-vertex girth (sheet-row) index
    // the two analytic surface normals each sample carries, both already unit: nLo approaching in −v (toward the
    // sheer), nHi in +v (toward the keel). Off a crease they are the one same vector; at a knuckle they part —
    // the section's own tangent break, already scaled by the crease coefficient that shaped it — and each face
    // simply takes the side it lies on. Nothing is blended in on top: the crease is in the geometry these
    // normals came from, so blending by the coefficient again would count it twice.
    nLo = verts.map((s) => s.nrmLo),
    nHi = verts.map((s) => s.nrmHi);

  // each triangle tagged with its centroid girth, for the crease-side test at emit
  interface Tri {
    a: number;
    b: number;
    c: number;
    g: number; // the triangle's centroid index, for the crease-side test
  }
  const tris: Tri[] = rawTris.map(([a, b, c]) => ({
    a,
    b,
    c,
    g: (vg[a] + vg[b] + vg[c]) / 3,
  }));

  // each vertex takes the surface normal of the side its face lies on: nHi for a face centred toward the keel
  // (girth index ≥ the vertex's), nLo toward the sheer. Off a crease the two sides are equal, so it makes no
  // difference; at a knuckle they differ and are kept as they are, which is what draws the chine.
  const nrmAt = (v: number, g: number): Vec3 => (g >= vg[v] ? nHi[v] : nLo[v]);

  // emit the starboard triangles (and the raw-triangle wire, if asked), then the port y-mirror
  const P: number[] = [],
    Nn: number[] = [],
    wantTriWire = wantWire && !wireQuads,
    triWireP: number[] = [];
  const hull = perfStep(
    "Triangles",
    () => {
      for (const t of tris) {
        pushTri(
          P,
          Nn,
          pos[t.a],
          nrmAt(t.a, t.g),
          pos[t.b],
          nrmAt(t.b, t.g),
          pos[t.c],
          nrmAt(t.c, t.g),
        );
        if (wantTriWire) {
          wireEdge(triWireP, pos[t.a], pos[t.b]);
          wireEdge(triWireP, pos[t.b], pos[t.c]);
          wireEdge(triWireP, pos[t.c], pos[t.a]);
        }
      }
      if (trimmed) {
        // the port half: the same triangles y-mirrored (positions and normals). Winding is irrelevant — the
        // material is double-sided — so the y-negated copy is the whole port skin, meeting starboard at the
        // keel.
        const nStar = P.length;
        for (let i = 0; i < nStar; i += 3) {
          P.push(P[i], -P[i + 1], P[i + 2]);
          Nn.push(Nn[i], -Nn[i + 1], Nn[i + 2]);
        }
        const wStar = triWireP.length;
        for (let i = 0; i < wStar; i += 3)
          triWireP.push(triWireP[i], -triWireP[i + 1], triWireP[i + 2]);
      }
      return {
        pos: new Float32Array(P),
        nrm: new Float32Array(Nn),
        count: P.length / 3,
      };
    },
    (m) => m.count / 3,
    "tris",
  );

  // The quad wire: THE CELLS THE SURFACE IS ACTUALLY MADE OF — every whole quad's four sides and every
  // boundary triangle's three, and nothing else. Drawing it instead from the trimmed columns (girth runs plus
  // rungs between matching sheet rows) put lines where there is no surface: two neighbouring columns end on
  // different trims at different fractional rows, so the chord closing them off ran outside the skin — past
  // the transom plane, or below the keel. The cells cannot lie that way: an edge is drawn only because a face
  // spans it. The hull's outline falls out for free, as the sides the marching-squares polygons brought with
  // them. On the raw Sheet view there is no trim, so the wire is the full untrimmed lattice, one-sided.
  //
  // Faces share their vertices by object identity, so an edge is keyed by its two welded vertex ids (order
  // normalized) and drawn once however many cells meet on it.
  const buildQuadWire = (): number[] => {
    const w: number[] = [];
    if (!trimmed) {
      const sh = sampling.sheet;
      for (const col of sh)
        for (let k = 0; k + 1 < col.length; k++)
          wireEdge(w, col[k].pos, col[k + 1].pos);
      for (let i = 0; i + 1 < sh.length; i++)
        for (let k = 0; k < sh[i].length; k++)
          wireEdge(w, sh[i][k].pos, sh[i + 1][k].pos);
      return w;
    }
    const nV = verts.length,
      seen = new Set<number>();
    const edge = (a: HullSample, b: HullSample): void => {
      const ia = vIdx.get(a) as number,
        ib = vIdx.get(b) as number,
        key = ia < ib ? ia * nV + ib : ib * nV + ia;
      if (seen.has(key)) return;
      seen.add(key);
      wireEdge(w, a.pos, b.pos);
    };
    // the whole quads: their four sides, never the diagonal the shading split them on
    for (const q of sampling.hullQuads)
      for (let e = 0; e < 4; e++) edge(q[e], q[(e + 1) % 4]);
    // the boundary cells, which the surface carries as triangles — so the wire shows them as triangles
    for (const t of sampling.hullTris)
      for (let e = 0; e < 3; e++) edge(t[e], t[(e + 1) % 3]);
    const nStar = w.length;
    for (let i = 0; i < nStar; i += 3) w.push(w[i], -w[i + 1], w[i + 2]);
    return w;
  };

  return {
    hull,
    wire: !wantWire
      ? null
      : perfStep(
          "Wireframe",
          () => {
            const wp = wireQuads ? buildQuadWire() : triWireP;
            return {
              pos: new Float32Array(wp),
              nrm: new Float32Array(wp.length),
              count: wp.length / 3,
            };
          },
          (m) => m.count / 2,
          "lines",
        ),
  };
}

// The flat transom panel: the plane's own face, closing the hull aft.
//
// It is built on NOTHING BUT the hull's own aft edge — `transomOutline` hands back the very vertices the mesh
// stitched its bottom boundary from, in the same order — so the panel and the skin share their whole common
// border vertex for vertex. There is no tolerance to tune and no seam to close: a gap could only appear if
// the two disagreed about where the hull ends, and they cannot, because there is only one answer and both
// read it.
//
// The outline is the starboard half, running from the sheer corner down to the foot on the centerline, and
// the panel is the region between it and its port mirror. That region is spanned as a ladder: each pair of
// consecutive outline points and their two mirrors make a quad. The rungs never cross (the outline descends
// monotonically away from the sheer), so the ladder tiles the panel exactly — the top rung is the straight
// line across the breadth at the sheer, which is the transom's top edge, and the bottom one degenerates to a
// point at the foot, where starboard and port meet on y = 0.
//
// The panel is planar by construction: every outline point but the foot is a linear crossing of a plane
// affine in (x, z), and the foot is a bisected corner that sits on the same plane to ~1e-3 of a lattice step.
// So one constant normal serves the whole face.
export function buildTransomMesh(model: Model, sampling: HullSampling): Mesh {
  const e = transomOutline(sampling);
  if (e.length < 2) return emptyMesh();
  const [ta, tb] = model.transom,
    slope = (tb.x - ta.x) / (tb.z - ta.z || 1),
    nt = V.norm([-1, 0, slope]), // outward (aft-facing)
    P: number[] = [],
    Nn: number[] = [];
  for (let i = 0; i + 1 < e.length; i++) {
    const a = e[i],
      b = e[i + 1],
      ap: Vec3 = [a[0], -a[1], a[2]],
      bp: Vec3 = [b[0], -b[1], b[2]];
    // a rung standing on the centerline is its own mirror, so the quad there is really a triangle: the half
    // of it that would span the point to itself has no area. That is the foot, and it is where the ladder
    // closes — emitting the empty half anyway would leave a degenerate triangle on the seam.
    if (a[1] !== 0) pushTri(P, Nn, a, nt, ap, nt, bp, nt);
    if (b[1] !== 0) pushTri(P, Nn, a, nt, bp, nt, b, nt);
  }
  return {
    pos: new Float32Array(P),
    nrm: new Float32Array(Nn),
    count: P.length / 3,
  };
}

export function computeBBox(pos: Float32Array): number[] | null {
  if (!pos.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i],
      y = pos[i + 1],
      z = pos[i + 2];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  }
  return [x0, y0, z0, x1, y1, z1];
}

// The world bounding box of the TRIMMED hull, for fitting an imported STL to the design space and for the
// camera's initial framing. Computed fresh (a cheap, coarse one-off sampling) rather than cached — STL import
// is a rare click-driven action, not a hot path, and the 3D view's own on-screen mesh may be at a different
// (Performance-controlled) resolution or even a different mode (e.g. "sheet"), so it must not be read off
// whatever happens to be on screen. Falls back to the model's nominal hull box when the hull has no sections
// at all (a degenerate model).
export function getHullBBox(model: Model): number[] {
  const { columns } = computeHullSampling(model, 128, 8);
  const pos: number[] = [];
  for (const c of columns)
    for (const s of c.pts) {
      pos.push(s.pos[0], s.pos[1], s.pos[2]); // starboard
      pos.push(s.pos[0], -s.pos[1], s.pos[2]); // port mirror
    }
  return computeBBox(new Float32Array(pos)) ?? nominalBox(model);
}

// the zoom is fixed: it frames a NOMINAL hull box (≈ a typical hull's overall size, as fractions of its own
// LOA) at a reference orientation, so it depends only on the hull's length — not on the live rotation, the
// edited geometry, or the rake. Used once, for the camera's initial framing (see nominalCameraFraming below)
// — not re-applied on every redraw the way v1's fixed-zoom projection was, since a real orbit camera now
// owns the live framing.
const REF_YAW = -0.62,
  REF_PITCH = 0.42;
export const nominalBox = (model: Model): number[] => {
  const l = loa(model) || 1; // [x0,y0,z0, x1,y1,z1]
  return [0, -0.238 * l, -0.325 * l, l, 0.238 * l, 0];
};

// The camera's one-time initial framing: a target (the nominal hull box's center) and a unit direction from
// that target toward the eye, at the same reference orientation the old fixed-zoom projection used, so the
// first paint looks like it always has. `radius` is the nominal box's half-diagonal, for sizing the initial
// camera distance / orthographic zoom to the hull's own scale (mm vs m hulls both frame sensibly).
export function nominalCameraFraming(model: Model): {
  target: Vec3;
  dirToEye: Vec3;
  radius: number;
} {
  const box = nominalBox(model),
    target: Vec3 = [(box[0] + box[3]) / 2, 0, (box[2] + box[5]) / 2],
    radius =
      0.5 * Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]),
    c1 = Math.cos(REF_YAW),
    s1 = Math.sin(REF_YAW),
    c2 = Math.cos(REF_PITCH),
    s2 = Math.sin(REF_PITCH);
  return { target, dirToEye: [-c2 * s1, -c2 * c1, s2], radius };
}
