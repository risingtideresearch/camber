// ---------- hull geometry: pure builders for the 3D view ----------
//
// Everything here builds plain { pos, nrm, count } Float32Array meshes (or Vec3 polylines) in MODEL space —
// no GL, no camera, no React. The 3D view (components/view3d/*) uploads these into three.js BufferGeometry
// and owns the camera/rendering; hullShader.ts owns the GLSL; hullLines3d.ts builds the lines-plan curves.
// Deck rake is NOT baked in here — it is applied once, as a rigid Y-axis rotation, by the scene's own
// <group> transform (rx = x·cosθ − z·sinθ, rz = x·sinθ + z·cosθ is exactly three's rotateY(−θ)) — so every
// builder below emits unraked, deck-flat coordinates.

import { type Vec3, V } from "./math";
import {
  type Model,
  frameAt,
  keepAt,
  loa,
  sectionAt,
  stationWorld,
  xTransom,
} from "./model";
import {
  computeHullSampling,
  keelPointAt,
  longitudinalPointAt,
  sheerPointAt,
  sweptSection,
  trimmedHullGrid,
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
// overshooting keel point, for instance, only shows where it actually reaches the centerline). Drawn as a
// thin camera-facing ribbon, starboard plus its port mirror, nudged toward the eye by BIAS so it sits just
// proud of the surface without z-fighting.
export function buildLongitudinalMesh(
  model: Model,
  idx: number,
  view: Vec3,
): Mesh {
  if (idx < 0 || idx >= model.loft.S) return emptyMesh();
  const N = 160,
    len = loa(model);
  const W: Vec3[] = [],
    keep: boolean[] = []; // each sample trimmed the same way the hull surface is
  for (let i = 0; i <= N; i++) {
    const u = i / N,
      fr = frameAt(model, u),
      nz = model.loft.at(u).pts[idx];
    W.push(stationWorld(fr, nz[0], nz[1]));
    keep.push(keepAt(model, fr, nz) >= 0);
  }
  // starboard plus its port mirror, each broken across trimmed-away spans, as thin camera-facing ribbons
  const runs: Vec3[][] = [];
  for (const sgn of [1, -1])
    for (const run of keptRuns(
      W.map((p): Vec3 => [p[0], sgn * p[1], p[2]]),
      keep,
    ))
      runs.push(run);
  return ribbonMesh(runs, view, 0.00125 * len, 0.006 * len); // half-width + bias toward the eye
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

// Build a camera-facing ribbon mesh (a thin flat tube) tracing each polyline, so 3D guide curves render at a
// reliable width and float just proud of the surface (BIAS toward the eye, so they don't z-fight). Each
// polyline becomes one connected ribbon; a 2-point polyline is a single segment (used for the curvature-comb
// hairs). Normals are set to `view` — the caller's material for these is unlit, so the normal is unused, but
// kept so every Mesh has the same shape.
export function ribbonMesh(
  polylines: Vec3[][],
  view: Vec3,
  HW: number,
  BIAS: number,
): Mesh {
  const off = V.scale(view, BIAS),
    P: number[] = [],
    Nn: number[] = [];
  for (const line of polylines) {
    const m = line.length;
    if (m < 2) continue;
    const Ls: Vec3[] = [],
      Rs: Vec3[] = [];
    for (let i = 0; i < m; i++) {
      const t = V.norm(
        V.sub(line[Math.min(i + 1, m - 1)], line[Math.max(i - 1, 0)]),
      );
      let w = V.cross(t, view); // ribbon width axis ⟂ tangent and the eye ⇒ always faces the camera
      if (V.dot(w, w) < 1e-9) w = V.cross(t, [0, 0, 1]);
      const wn = V.scale(V.norm(w), HW),
        c = line[i];
      Ls.push([
        c[0] + wn[0] + off[0],
        c[1] + wn[1] + off[1],
        c[2] + wn[2] + off[2],
      ]);
      Rs.push([
        c[0] - wn[0] + off[0],
        c[1] - wn[1] + off[1],
        c[2] - wn[2] + off[2],
      ]);
    }
    for (let i = 0; i < m - 1; i++) {
      pushTri(P, Nn, Ls[i], view, Rs[i], view, Rs[i + 1], view);
      pushTri(P, Nn, Ls[i], view, Rs[i + 1], view, Ls[i + 1], view);
    }
  }
  return {
    pos: new Float32Array(P),
    nrm: new Float32Array(Nn),
    count: P.length / 3,
  };
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

// ---------- the hull mesh, stitched from the shared sampling's trimmed columns ----------
//
// The sampling (mesh.ts) trimmed each column into a variable-length row of world points, each tagged with the
// sheet index it came from. Two neighbouring columns are stitched into the surface by MATCHING those indices:
// where both carry the same integer index the strip between them is a quad; where a column's trimmed end is a
// fractional index the other lacks, the gap closes with a triangle. So the mesh rides the real trim edges
// with no constant-width padding — that is the whole point of the index tags.
//
// Only the STARBOARD half is built; the port half is its exact y-mirror (positions and normals negated), so
// the two halves are guaranteed to meet seamlessly on the centerline. A closing column ends on the keel
// (y = 0), and there the vertex normal's y-component is zeroed so the mirror joins smoothly (a round bottom
// reads round; the mirror of an (x,0,z) normal is itself). An OPEN column ends above the centerline, so
// starboard and port simply don't meet there — the correct gap, with no special case.

// a column laid out for stitching: world points, their sheet indices, and the crease strength at each point
// (non-zero only on a knuckled station knot). vBase is where its vertices start in the shared flat arrays.
interface Col {
  p: Vec3[];
  idx: number[];
  vBase: number;
}

// stitch two adjacent columns by walking their sheet indices together (a monotone merge): a matching integer
// rung emits the two triangles of a quad; wherever one column's next index runs ahead (a fractional trimmed
// end, or a rung the other column lost to the trim) a single triangle closes the gap.
function stitch(
  A: Col,
  B: Col,
  addTri: (a: number, b: number, c: number) => void,
): void {
  const na = A.idx.length,
    nb = B.idx.length;
  let i = 0,
    j = 0;
  while (i + 1 < na || j + 1 < nb) {
    const ai = i + 1 < na ? A.idx[i + 1] : Infinity,
      bj = j + 1 < nb ? B.idx[j + 1] : Infinity;
    if (Math.abs(ai - bj) < 1e-9) {
      addTri(A.vBase + i, A.vBase + i + 1, B.vBase + j);
      addTri(A.vBase + i + 1, B.vBase + j + 1, B.vBase + j);
      i++;
      j++;
    } else if (ai < bj) {
      addTri(A.vBase + i, A.vBase + i + 1, B.vBase + j);
      i++;
    } else {
      addTri(A.vBase + i, B.vBase + j + 1, B.vBase + j);
      j++;
    }
  }
}

export function buildHullMesh(
  model: Model,
  sampling: HullSampling,
  trimmed: boolean,
  wantWire: boolean,
  wireQuads: boolean, // wire as quads (true) or the raw shaded triangles (false); ignored unless wantWire
): { hull: Mesh; transomEdge: Vec3[]; wire: Mesh | null } {
  const sections = trimmed ? sampling.trimmedSections : sampling.sheetSections;

  // lay every non-empty column's vertices into shared flat arrays, carrying each vertex's sheet index and
  // crease strength (looked up from the column's crease knots; only exact-integer indices can be a knot)
  const cols: Col[] = [],
    verts: Vec3[] = [],
    vg: number[] = [], // per-vertex sheet index
    vk: number[] = []; // per-vertex crease strength
  for (const s of sections) {
    const idx = s.sheetIndex;
    if (s.empty || s.pts.length < 2 || !idx) continue;
    const cm = new Map<number, number>();
    for (let t = 0; t < s.creaseRows.length; t++)
      cm.set(s.creaseRows[t], s.creaseK[t]);
    const vBase = verts.length;
    for (let k = 0; k < s.pts.length; k++) {
      verts.push(s.pts[k]);
      vg.push(idx[k]);
      const r = Math.round(idx[k]);
      vk.push(Math.abs(idx[k] - r) < 1e-6 ? (cm.get(r) ?? 0) : 0);
    }
    cols.push({ p: s.pts, idx, vBase });
  }
  if (cols.length < 2)
    return { hull: emptyMesh(), transomEdge: [], wire: null };

  // the transom edge: the trimmed bottom of each column the TRANSOM stopped (not the centerline, which snaps
  // y to 0, and not an open section, which reaches no trim). Ordered top → bottom for the panel fan.
  const tEdge: Vec3[] = [];
  if (trimmed)
    for (const s of sampling.trimmedSections) {
      if (s.empty || s.keel || s.pts.length < 2) continue;
      const p = s.pts[s.pts.length - 1];
      if (Math.abs(p[0] - xTransom(model, p[2])) < 1e-6) tEdge.push(p);
    }
  tEdge.sort((a, b) => b[2] - a[2]);

  // face-normal accumulation, split by girth side: nLo gathers faces centred below a vertex's index, nHi
  // above. A smooth vertex uses nLo + nHi; a crease vertex blends toward its own side so a knuckle reads as
  // an edge and a faded knuckle stays smooth. Unnormalized cross products area-weight the average.
  const nLo = verts.map((): Vec3 => [0, 0, 0]),
    nHi = verts.map((): Vec3 => [0, 0, 0]);
  interface Tri {
    a: number;
    b: number;
    c: number;
    g: number; // the triangle's centroid index, for the crease-side test
  }
  const tris: Tri[] = [];
  const addTri = (a: number, b: number, c: number): void => {
    const fn = V.cross(V.sub(verts[b], verts[a]), V.sub(verts[c], verts[a])),
      g = (vg[a] + vg[b] + vg[c]) / 3;
    for (const v of [a, b, c]) {
      const bk = g >= vg[v] ? nHi[v] : nLo[v];
      bk[0] += fn[0];
      bk[1] += fn[1];
      bk[2] += fn[2];
    }
    tris.push({ a, b, c, g });
  };
  perfStep(
    "Stitching columns",
    () => {
      for (let c = 0; c + 1 < cols.length; c++)
        stitch(cols[c], cols[c + 1], addTri);
      return tris;
    },
    (t) => t.length,
    "tris",
  );

  // resolve each vertex's smooth normal (both sides), zeroing y on the keel of the trimmed hull so the mirror
  // joins with no transverse tilt (a smooth round bottom). The one-sided crease normals are formed at emit.
  const keelY = trimmed;
  const smoothN = verts.map((_, v): Vec3 => {
    const n: Vec3 = [
      nLo[v][0] + nHi[v][0],
      nLo[v][1] + nHi[v][1],
      nLo[v][2] + nHi[v][2],
    ];
    if (keelY && Math.abs(verts[v][1]) < 1e-6) n[1] = 0;
    return V.norm(n);
  });
  const nrmAt = (v: number, g: number): Vec3 => {
    if (vk[v] <= 1e-6) return smoothN[v];
    const side = g >= vg[v] ? nHi[v] : nLo[v],
      hn: Vec3 = [side[0], side[1], side[2]];
    if (keelY && Math.abs(verts[v][1]) < 1e-6) hn[1] = 0;
    return V.norm(V.lerp(smoothN[v], V.norm(hn), vk[v]));
  };

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
          verts[t.a],
          nrmAt(t.a, t.g),
          verts[t.b],
          nrmAt(t.b, t.g),
          verts[t.c],
          nrmAt(t.c, t.g),
        );
        if (wantTriWire) {
          wireEdge(triWireP, verts[t.a], verts[t.b]);
          wireEdge(triWireP, verts[t.b], verts[t.c]);
          wireEdge(triWireP, verts[t.c], verts[t.a]);
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

  // the quad-grid wire: girth edges (consecutive points within a column) plus longitudinal edges (matching
  // sheet indices across adjacent columns), starboard then y-mirrored — the raw-triangle wire is the emitted
  // triangle soup captured above.
  const buildQuadWire = (): number[] => {
    const w: number[] = [];
    for (const c of cols)
      for (let k = 0; k + 1 < c.p.length; k++) wireEdge(w, c.p[k], c.p[k + 1]);
    for (let ci = 0; ci + 1 < cols.length; ci++) {
      const A = cols[ci],
        B = cols[ci + 1];
      let i = 0,
        j = 0;
      while (i < A.idx.length && j < B.idx.length) {
        const d = A.idx[i] - B.idx[j];
        if (Math.abs(d) < 1e-9) {
          wireEdge(w, A.p[i], B.p[j]);
          i++;
          j++;
        } else if (d < 0) i++;
        else j++;
      }
    }
    if (trimmed) {
      const nStar = w.length;
      for (let i = 0; i < nStar; i += 3) w.push(w[i], -w[i + 1], w[i + 2]);
    }
    return w;
  };

  return {
    hull,
    transomEdge: tEdge,
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

// The flat transom panel, built from the hull's OWN aft edge (buildHullMesh reads it off the trimmed grid)
// so the two meet with no gap or overlap. The edge already runs top (at the sheer) → bottom, one point per
// column and all on the starboard side; the last point is snapped onto the centerline so the panel closes
// cleanly where the transom plane crosses it.
export function buildTransomMesh(model: Model, edge: Vec3[]): Mesh {
  if (edge.length < 2)
    return { pos: new Float32Array(0), nrm: new Float32Array(0), count: 0 };
  const e = edge.slice();
  e[e.length - 1] = [e[e.length - 1][0], 0, e[e.length - 1][2]];
  const [ta, tb] = model.transom,
    slope = (tb.x - ta.x) / (tb.z - ta.z || 1),
    nt = V.norm([-1, 0, slope]), // outward (aft-facing)
    P: number[] = [],
    Nn: number[] = [];
  for (let i = 0; i < e.length - 1; i++) {
    const a = e[i],
      b = e[i + 1],
      ap: Vec3 = [a[0], -a[1], a[2]],
      bp: Vec3 = [b[0], -b[1], b[2]];
    pushTri(P, Nn, a, nt, ap, nt, bp, nt);
    pushTri(P, Nn, a, nt, bp, nt, b, nt);
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
  const { trimmedSections } = computeHullSampling(model, 128, 8);
  const pos: number[] = [];
  for (const s of trimmedSections) {
    if (s.empty) continue;
    for (const p of s.pts) {
      pos.push(p[0], p[1], p[2]); // starboard
      pos.push(p[0], -p[1], p[2]); // port mirror
    }
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
