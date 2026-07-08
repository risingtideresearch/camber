import { HILITE, COL } from "./colors";
import { el } from "./draw2d";
import { type Vec3, V } from "./math";
import {
  type Model,
  L,
  weightsAt,
  frameAt,
  xTransom,
  forwardLimit,
  sweptSection,
  trimmedSheerViz,
  worldZ,
} from "./model";
import { ModelSelection, selStationIdx } from "./modelSelection";
import { trimmedHullGrid } from "./step";
import {
  defaultCurvature,
  polylineComb3,
  type CurvatureSettings,
} from "./comb";
import { ZMIN, ZMAX } from "./view";
import { type StlState, transformStl } from "./stlImport";

// the 3D view's mutually-exclusive display mode: "render" = shaded trimmed hull; "body" / "buttocks" /
// "waterline" = the lines plan (SVG overlay) with that non-chine family; "zebra" = zebra-striped trimmed hull
// (fairness check); "sheet" = the untrimmed shaded sweep (one side, no trims/mirror).
// "body" / "buttocks" / "waterline" are the three lines-plan modes: same drawing, differing only in which
// non-chine line family is drawn (stations / constant-y cuts / constant-z cuts). render / zebra / sheet are
// the shaded GL modes. Independently of the mode, `showMesh` overlays the hull's quad grid as a wireframe on
// any shaded GL mode, to inspect the mesh itself.

export type View3DMode =
  "render" | "body" | "buttocks" | "waterline" | "zebra" | "sheet";

export const LINES_MODES: View3DMode[] = ["body", "buttocks", "waterline"];

export interface Draw3dParams {
  rot: { yaw: number; pitch: number };
  zoom: number; // 3D view zoom multiplier on the fixed framing (1 = default; scroll wheel adjusts)
  view3dMode: View3DMode; // mutually-exclusive 3D display mode (render / body / buttocks / waterline / zebra / sheet)
  showMesh: boolean; // overlay the hull's quad-grid wireframe on the shaded GL modes (render / zebra / sheet)
  meshQuads: boolean; // wireframe as quads (true) or as the raw triangles the shaded hull renders (false)
  meshM: number; // longitudinals per half-section — the M fed to bilgeRows/sweptSection (girth resolution)
  meshN: number; // sampled sections along the length — the N fed to bilgeRows (station resolution)
  curvature: CurvatureSettings; // the editor-wide curvature-comb overlay (which 3D combs, and how dense) —
  // a curvature-analysis overlay independent of the mode; only its d3* / count fields are read here
}

export const MESH_M_DEFAULT = 64; // default longitudinals per half-section (girth resolution)
export const MESH_N_DEFAULT = 256; // default sections along the length (station resolution)

export function createDraw3dParams(): Draw3dParams {
  return {
    rot: { yaw: -0.62, pitch: 0.42 },
    zoom: 1,
    view3dMode: "render", // shaded trimmed hull by default
    showMesh: false, // wireframe overlay off by default
    meshQuads: true, // wireframe shows quads by default
    meshM: MESH_M_DEFAULT,
    meshN: MESH_N_DEFAULT,
    curvature: defaultCurvature(),
  };
}

// ---------- 3D shaded hull (WebGL) ----------
// Orthographic camera that reproduces the old projection: yaw spins about the vertical (z = up), pitch
// tilts. The vertex shader maps world (x,y,z) to NDC the same way the SVG renderer mapped to screen, and
// fills a real depth buffer so the transom/hull overlap correctly. Per-pixel Phong + specular; a zebra
// mode bands the surface by the reflected eye direction so unfair (non-smooth) spots show as kinked lines.
let GL: WebGLRenderingContext | null = null,
  prog: WebGLProgram | null = null,
  attr: Record<string, number> = {}, // vertex attribute locations (GLint)
  loc: Record<string, WebGLUniformLocation | null> = {}, // uniform locations
  posBuf: WebGLBuffer | null = null,
  nrmBuf: WebGLBuffer | null = null,
  // imported-STL overlay buffers (static: rebuilt only when a new file / axis map / scale changes)
  stlPosBuf: WebGLBuffer | null = null,
  stlNrmBuf: WebGLBuffer | null = null,
  stlLineBuf: WebGLBuffer | null = null;
let stlTriVerts = 0, // vertex counts of the currently uploaded STL buffers
  stlLineVerts = 0,
  stlSig = ""; // cache key of the uploaded transform (geometry id + axis map + scale + design box)
interface Mesh {
  pos: Float32Array;
  nrm: Float32Array;
  count: number;
}
const emptyMesh = (): Mesh => ({
  pos: new Float32Array(0),
  nrm: new Float32Array(0),
  count: 0,
});
const VERT_SRC = `
attribute vec3 aPos; attribute vec3 aNormal;
uniform float uc1,us1,uc2,us2,uKX,uKY,uCX,uCY,ucxm,uczm,uDepth,uRakeC,uRakeS;
varying vec3 vN; varying vec3 vW; varying float vWZ;
void main(){
  float rx=aPos.x*uRakeC - aPos.z*uRakeS;     // deck rake: rotate the hull about y through the sheer origin
  float rz=aPos.x*uRakeS + aPos.z*uRakeC;
  float X=rx-ucxm, Z=rz-uczm, y=aPos.y;
  float X1=X*uc1 - y*us1;
  float Y1=X*us1 + y*uc1;
  float sx=X1, sy=Y1*us2 + Z*uc2;            // screen-space position (world units), boat-centered
  float ndcx=(sx-uCX)*uKX;                    // fit-to-box: per-axis scale → isometric at any canvas aspect
  float ndcy=(sy-uCY)*uKY;
  float ndcz=(uc2*Y1 - us2*Z)/uDepth;        // nearer (old depth large) → smaller → passes LESS test
  gl_Position=vec4(ndcx,ndcy,ndcz,1.0);
  vN=vec3(aNormal.x*uRakeC - aNormal.z*uRakeS, aNormal.y, aNormal.x*uRakeS + aNormal.z*uRakeC);
  vW=aPos;
  vWZ=rz;                                      // true (raked) world height, for the waterline boot-top
}`;
const FRAG_SRC = `
precision highp float;
varying vec3 vN; varying vec3 vW; varying float vWZ;
uniform vec3 uLight,uView,uBase; uniform float uStripes,uAlpha,uWaterZ,uPaint; uniform int uZebra,uFlat;
void main(){
  if(uFlat==1){ gl_FragColor=vec4(uBase,uAlpha); return; } // unshaded flat colour (guide-line overlays)
  vec3 N=normalize(vN), V=normalize(uView);
  if(dot(N,V)<0.0) N=-N;                      // two-sided
  vec3 Lc=normalize(uLight);
  // half-Lambert: wrap the light around so the terminator is soft (less harsh) and the form still reads
  float diff=dot(N,Lc)*0.5+0.5; diff*=diff;
  vec3 H=normalize(Lc+V);
  float spec=pow(max(dot(N,H),0.0),26.0);     // broader, gentler highlight than a tight 48
  if(uZebra==1){
    vec3 R=reflect(-V,N);
    float band=sin(atan(R.z,R.y)*uStripes);
    float s=smoothstep(-0.14,0.14,band);
    vec3 col=mix(vec3(0.07,0.09,0.15),vec3(0.97,0.98,1.0),s)*(0.66+0.34*diff);
    gl_FragColor=vec4(col,uAlpha);
  } else {
    // below the design waterline the hull wears bottom paint: a darker body, but still glossy so the
    // surface reads. A soft 8mm boot-top (smoothstep) avoids an aliased paint line; uPaint gates it off.
    float sub=(1.0 - smoothstep(uWaterZ-4.0, uWaterZ+4.0, vWZ)) * uPaint;
    vec3 body=uBase*0.34 + uBase*diff*0.80;
    body=mix(body, uBase*(0.14 + 0.34*diff), sub);  // darken the diffuse body below the DWL
    vec3 col=body + vec3(1.0)*spec*0.40;            // softer specular highlight on top (still glossy)
    gl_FragColor=vec4(clamp(col,0.0,1.0),uAlpha);
  }
}`;

function glShader(
  gl: WebGLRenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || "shader compile error");
  return s;
}

function initGL(cv3d: HTMLCanvasElement): void {
  GL = cv3d.getContext("webgl", {
    antialias: true,
    alpha: true,
    premultipliedAlpha: false,
  });
  const gl = GL!;
  prog = gl.createProgram()!;
  gl.attachShader(prog, glShader(gl, gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(prog, glShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  attr = {};
  loc = {};
  ["aPos", "aNormal"].forEach(
    (n) => (attr[n] = gl.getAttribLocation(prog!, n)),
  );
  [
    "uc1",
    "us1",
    "uc2",
    "us2",
    "uKX",
    "uKY",
    "uCX",
    "uCY",
    "ucxm",
    "uczm",
    "uDepth",
    "uRakeC",
    "uRakeS",
    "uLight",
    "uView",
    "uBase",
    "uStripes",
    "uAlpha",
    "uZebra",
    "uWaterZ",
    "uPaint",
    "uFlat",
  ].forEach((n) => (loc[n] = gl.getUniformLocation(prog!, n)));
  posBuf = gl.createBuffer();
  nrmBuf = gl.createBuffer();
  stlPosBuf = gl.createBuffer();
  stlNrmBuf = gl.createBuffer();
  stlLineBuf = gl.createBuffer();
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);
}

// the "longitudinal" of a single template-point index: the locus that control point traces as the section
// sweeps from stern to bow. At each x the blended point (lerp of the aft/fore control point by f = x/L) is
// placed into the world by the frame there — the same construction the hull surface uses — so the curve
// rides exactly on the swept sheet (it is the keel line when idx is the keel point, a chine line at a
// knuckle, etc.). Each sample is trimmed exactly as the hull is — by the sheer-trim line, the centerline,
// and the transom plane — so the line stops where the hull does (an overshooting keel point, for instance,
// only shows where it actually reaches the centerline). Drawn as a thin camera-facing ribbon (GL line
// width is unreliable), starboard plus its port mirror, nudged toward the eye by BIAS so it sits just
// proud of the surface without z-fighting.
function buildLongitudinalMesh(model: Model, idx: number, view: Vec3): Mesh {
  const tpl = model.templates;
  if (idx < 0 || idx >= tpl[0].length) return emptyMesh();
  const N = 160;
  const W: Vec3[] = [],
    keep: boolean[] = []; // each sample trimmed the same way the hull surface is
  for (let i = 0; i <= N; i++) {
    const x = (L * i) / N,
      wt = weightsAt(model, x); // the blend at this station mixes the same template point across all templates
    let n = 0,
      d = 0;
    for (let j = 0; j < tpl.length; j++) {
      n += wt[j] * tpl[j][idx].n;
      d += wt[j] * tpl[j][idx].d;
    }
    const fr = frameAt(model, x),
      w: Vec3 = [
        fr.p[0] + n * fr.n[0] + d * fr.d[0],
        fr.p[1] + n * fr.n[1] + d * fr.d[1],
        fr.p[2] + n * fr.n[2] + d * fr.d[2],
      ];
    W.push(w);
    // kept iff below the sheer-trim line (depth ≥ trim depth), not past the centerline (world y ≥ 0),
    // and forward of the raked transom plane (x ≥ xTransom(model, z)) — the same three clips the hull gets.
    keep.push(
      d >= -model.sheer.zf(x) && w[1] >= 0 && w[0] >= xTransom(model, w[2]),
    );
  }
  // starboard plus its port mirror, each broken across trimmed-away spans, as thin camera-facing ribbons
  const runs: Vec3[][] = [];
  for (const sgn of [1, -1])
    for (const run of keptRuns(
      W.map((p): Vec3 => [p[0], sgn * p[1], p[2]]),
      keep,
    ))
      runs.push(run);
  return ribbonMesh(runs, view, 1.25, 6); // half-width 1.25, bias 6 toward the eye (floats above the hull)
}

// split a sampled polyline into maximal runs of consecutive KEPT points (a trimmed-away span breaks the run)
function keptRuns(pts: Vec3[], keep: boolean[]): Vec3[][] {
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
// reliable width (WebGL clamps lineWidth to 1 on most browsers) and float just proud of the surface (BIAS
// toward the eye, so they don't z-fight). Each polyline becomes one connected ribbon; a 2-point polyline is a
// single segment (used for the curvature-comb hairs). Normals are set to `view` — the shader is two-sided and
// these are flat guides, so a flat toward-eye normal reads as a clean unshaded line.
function ribbonMesh(
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
// COMB_LEN world units. The comb geometry comes from the shared polylineComb3 (core/comb); this file only
// samples the curves and renders them (GL ribbons + the SVG lines-plan overlay).
const COMB_LEN = 90; // world-units length of the sharpest curvature hair (each comb auto-scales to this)
// the sheer accent (matches --sheer in the 2D lines views); its comb shares the hue, reading as one overlay
const SHEER_RGB = [0.867, 0.42, 0.125]; // for the GL ribbons (the SVG path uses COL.sheer, the same hue)
// on-screen (CSS-px) half-widths of the GL curve / comb ribbons. A fixed WORLD half-width would grow and
// shrink with the zoom / framing; instead the world half-width is derived from the pixel scale each draw
// (HW = px · dpr / pxScale, as pxScale is in device pixels), so the ribbons stay a constant on-screen size —
// like the SVG overlay's non-scaling strokes. Matches the SVG stroke weights (curve 2.2, comb ~1.2 full).
const SHEER_HALF_PX = 1.1,
  COMB_HALF_PX = 0.6;

// per-family colours — GL (linear-ish RGB) and the matching CSS hue for the SVG lines-plan overlay
const CURV_RGB: Record<string, number[]> = {
  sheer: SHEER_RGB, // orange
  keel: [0.059, 0.463, 0.376], // teal (--keel)
  long: [0.486, 0.227, 0.929], // violet (--fore)
  sect: [0.28, 0.34, 0.42], // slate
};
const CURV_CSS: Record<string, string> = {
  sheer: COL.sheer,
  keel: COL.keel,
  long: COL.fore,
  sect: "#475569",
};

// one curve of the overlay: the base curve plus its curvature comb, in world space. `mirror` = also draw the
// port y-reflection (sheer / longitudinals are one-sided starboard curves; the keel sits on the centerline
// and the sections are already full-width, so those carry mirror = false).
interface CurvCurve3 {
  curve: Vec3[];
  hairs: [Vec3, Vec3][];
  env: Vec3[];
  rgb: number[];
  css: string;
  mirror: boolean;
}

// build the enabled 3D curvature curves + combs for the current settings. World-space and rotation-
// independent, so draw3d caches this and only rebuilds it when the model / settings change (rotation reuses
// the cache). The section / longitudinal counts pick how many curves of each fan get a comb; the hair counts
// set each comb's density (shared with the 2D combs via CurvatureSettings).
function buildCurvature3(model: Model, s: CurvatureSettings): CurvCurve3[] {
  const out: CurvCurve3[] = [],
    xFwd = forwardLimit(model);
  const add = (
    curve: Vec3[],
    nHairs: number,
    key: string,
    mirror: boolean,
  ): void => {
    if (curve.length < 3) return;
    const c = polylineComb3(curve, nHairs, COMB_LEN);
    out.push({
      curve,
      hairs: c.hairs,
      env: c.env,
      rgb: CURV_RGB[key],
      css: CURV_CSS[key],
      mirror,
    });
  };

  // the trimmed sheer edge (the hull's 3D top edge) — the converged evaluator gives a smooth, dense curve
  if (s.d3Sheer)
    add(trimmedSheerViz(model, 600).curve, s.nLongHairs, "sheer", true);

  // the keel/centerline and the longitudinal fan both ride the fair hull grid (columns = longitudinals,
  // column 0 the sheer, column M the keel), so build it once if either is on.
  if (s.d3Centerline || (s.d3Longitudinals && s.nLongCombs > 0)) {
    const M = 40,
      { grid } = trimmedHullGrid(model, 140, M);
    if (s.d3Centerline)
      add(
        grid.map((row) => row[M]),
        s.nLongHairs,
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
          s.nLongHairs,
          "long",
          true,
        );
      }
    }
  }

  // the transverse section fan: true constant-x sections, full-width where they close across the keel
  if (s.d3Sections && s.nSectCombs > 0) {
    const M = 40,
      n = s.nSectCombs;
    for (let k = 0; k < n; k++) {
      const x = xFwd * (n === 1 ? 0.5 : (k + 0.5) / n),
        sec = sweptSection(model, x, M, true);
      if (sec.aft || sec.pts.length < 3) continue;
      let curve = sec.pts;
      if (sec.keel) {
        // mirror the starboard half to port through the shared keel point (dropped once), one smooth section
        curve = sec.pts.slice();
        for (let j = sec.pts.length - 2; j >= 0; j--)
          curve.push([sec.pts[j][0], -sec.pts[j][1], sec.pts[j][2]]);
      }
      add(curve, s.nSectHairs, "sect", false);
    }
  }
  return out;
}

// A fair section grid sampled uniformly in x and WITHOUT the transom cut (clipQuad does that below, so
// adjacent stations stay parallel — no sliver shear — and the surface is smooth all the way aft).
//
// For the TRIMMED hull each row is the FULL-WIDTH section: starboard sheer-trim → keel → port sheer-trim,
// built as ONE continuous curve (the starboard half plus its y-mirror, sharing the single keel point at
// the centre). The keel is therefore an interior column and inherits the section's C¹ smoothness across
// the centerline. The old approach sampled the starboard half and mirrored the whole SURFACE, which only
// joins smoothly if the half meets the centerline with zero depth-slope; at a steep (e.g. narrow-transom)
// stern it doesn't, so the mirror folded the keel into a visible welt ("pucker"). One continuous row has
// no seam to fold. For an OPEN section (never reaches the centerline) there is no port half to join, so
// the row carries an `open` flag and buildHullMesh leaves the centre strip unbridged (a real gap there).
//
// Untrimmed (the raw swept sheet) is unchanged: one side, full station deck → tmax, no trims, no mirror.
function bilgeRows(
  model: Model,
  N: number,
  M: number,
  trim: boolean,
): { rows: Vec3[][]; open: boolean[]; creaseS: number[][] } {
  const rows: Vec3[][] = [],
    open: boolean[] = [],
    creaseS: number[][] = []; // per row, per column: crease strength (0 = smooth, 1 = hard)

  // for the trimmed hull, stop the forward sweep at the bow closure so the surface tapers to a clean stem
  // (forward of it the forefoot is above the sheer trim — no hull); the raw untrimmed sheet runs to L.
  const xMax = trim ? forwardLimit(model) : L;
  for (let i = 0; i <= N; i++) {
    // cosine (Chebyshev) spacing clusters stations toward the transom and the bow, so the fine bow tapers
    // over many rows instead of collapsing in one — smoother shading and no abrupt facet at the stem.
    const x = xMax * 0.5 * (1 - Math.cos((Math.PI * i) / N));
    const s = sweptSection(model, x, M, trim, false);
    if (s.aft) continue;
    if (!trim) {
      rows.push(s.pts); // raw sheet: half only, meshed without a mirror
      open.push(true);
      creaseS.push(new Array(s.pts.length).fill(0));
      continue;
    }
    // full width: starboard sheer→keel (cols 0..M), then port keel→sheer (cols M+1..2M) as the y-mirror,
    // dropping the duplicate keel point so a closed section reads as one smooth curve through y=0.
    const full: Vec3[] = s.pts.slice();
    for (let j = M - 1; j >= 0; j--)
      full.push([s.pts[j][0], -s.pts[j][1], s.pts[j][2]]);
    rows.push(full);
    open.push(s.open);
    // map the half-section crease columns to the full row: a chine at half-col c sits at c and 2M−c; the
    // keel (half-col M) is the centre col M. Strength = the blended knuckle / keel-V from the section.
    const cs = new Array(2 * M + 1).fill(0);
    for (let t = 0; t < s.creaseCols.length; t++) {
      const c = s.creaseCols[t],
        k = s.creaseK[t];
      if (c === M) cs[M] = k;
      else {
        cs[c] = k;
        cs[2 * M - c] = k;
      }
    }
    creaseS.push(cs);
  }
  return { rows, open, creaseS };
}

// per-vertex grid normal (orientation irrelevant — shader is two-sided). side = 0 uses the central
// transverse difference (smooth); side = +1/−1 uses a ONE-SIDED difference (toward the next/previous
// column) — the two faces of a crease column, so a knuckle/keel-V reads as a hard edge.
function gridNormal(rows: Vec3[][], i: number, j: number, side = 0): Vec3 {
  const R = rows.length,
    C = rows[0].length;
  const a = rows[Math.min(i + 1, R - 1)][j],
    b = rows[Math.max(i - 1, 0)][j];
  const c = side < 0 ? rows[i][j] : rows[i][Math.min(j + 1, C - 1)],
    d = side > 0 ? rows[i][j] : rows[i][Math.max(j - 1, 0)];
  const n = V.cross(V.sub(c, d), V.sub(a, b));
  // On the centerline (the keel, y = 0) a smooth keel's normal must have no transverse component. The
  // central difference is one-sided in y here, tilting it; zero the y-component so the two halves join
  // smoothly. (A V keel reads from its off-centerline faces via the one-sided side ≠ 0 normals.)
  if (side === 0 && Math.abs(rows[i][j][1]) < 1e-6) n[1] = 0;
  return V.norm(n);
}

function pushTri(
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

// the transom plane gate: forward of the raked cut (kept) where this is ≥ 0
const transomGate = (model: Model, p: Vec3): number =>
  p[0] - xTransom(model, p[2]);

const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

interface PN {
  p: Vec3;
  n: Vec3;
}

// Sutherland–Hodgman clip of a quad against transomGate ≥ 0, carrying per-vertex normals. Returns the
// kept (forward) polygon and, if the quad straddles the plane, the cut segment lying on the transom.
function clipQuad(
  model: Model,
  poly: PN[],
): { inside: PN[]; cut: [Vec3, Vec3] | null } {
  const out: PN[] = [],
    cutPts: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length],
      ga = transomGate(model, a.p),
      gb = transomGate(model, b.p);
    if (ga >= 0) out.push(a);
    if (ga >= 0 !== gb >= 0) {
      const t = ga / (ga - gb),
        ip = lerpV(a.p, b.p, t),
        inrm = V.norm(lerpV(a.n, b.n, t));
      out.push({ p: ip, n: inrm });
      cutPts.push(ip);
    }
  }
  return {
    inside: out,
    cut: cutPts.length === 2 ? [cutPts[0], cutPts[1]] : null,
  };
}

// clip a single segment against transomGate ≥ 0 (the open-polyline analogue of clipQuad's edge clip): drop
// it if fully aft, keep it whole if fully forward, else trim the aft end down to the cut point.
function clipSegment(model: Model, a: Vec3, b: Vec3): [Vec3, Vec3] | null {
  const ga = transomGate(model, a),
    gb = transomGate(model, b);
  if (ga < 0 && gb < 0) return null;
  if (ga >= 0 && gb >= 0) return [a, b];
  const ip = lerpV(a, b, ga / (ga - gb));
  return ga >= 0 ? [a, ip] : [ip, b];
}

// the hull's quad grid as a GL_LINES segment soup, for the Mesh wireframe overlay: girth (row) edges and
// station (column) edges, at the EXACT hull-grid positions (no geometric offset). It is built once at
// rebuild and reused across rotate/zoom like the hull mesh itself. Staying superimposed on the shaded skin
// is handled at draw time by a polygon-offset on the FILL (the classic wireframe-over-solid trick) rather
// than a world-space nudge, so there is no visible gap between hull and wire and the grid reads from both
// sides of the surface (a back-face section shows its wire too).
// Mirrors buildHullMesh's own trims: transom-clipped segment by segment when trimmed, and the same open-
// section centre-column skip so the wireframe never bridges a gap the surface itself doesn't bridge.
// This is the quad-grid wire; the raw-triangle wire is captured from the emitted triangle soup in buildHullMesh.
const WIRE_RGB = [0.04, 0.05, 0.07]; // near-black grid lines, for contrast against the lit hull
function buildWireMesh(
  model: Model,
  rows: Vec3[][],
  open: boolean[],
  M: number,
  trimmed: boolean,
): Mesh {
  const R = rows.length,
    C = rows[0]?.length ?? 0,
    P: number[] = [],
    push = (a: Vec3, b: Vec3): void => {
      const seg = trimmed ? clipSegment(model, a, b) : [a, b];
      if (!seg) return;
      P.push(seg[0][0], seg[0][1], seg[0][2], seg[1][0], seg[1][1], seg[1][2]);
    };
  for (let i = 0; i < R; i++)
    for (let j = 0; j < C - 1; j++) push(rows[i][j], rows[i][j + 1]); // girth edges
  for (let j = 0; j < C; j++)
    for (let i = 0; i < R - 1; i++) {
      if (trimmed && j === M && (open[i] || open[i + 1])) continue; // no bridge over an open gap
      push(rows[i][j], rows[i + 1][j]); // station edges
    }
  return {
    pos: new Float32Array(P),
    nrm: new Float32Array(P.length),
    count: P.length / 3,
  };
}

// build the hull triangle soup by clipping the fair grid against the transom plane; also collect the cut
// segments so the transom panel can be built from the very same edge.
// trimmed ⇒ the rows are FULL-WIDTH (port-sheer → keel → starboard-sheer, no mirror): clip each quad
// against the transom plane and collect the cut edge — one continuous skin with a seamless keel.
// Untrimmed ⇒ emit the raw swept sheet as-is: one side, no sheer/transom/keel trim.
function buildHullMesh(
  model: Model,
  trimmed: boolean,
  wantWire: boolean,
  wireQuads: boolean, // wire as quads (true) or the raw shaded triangles (false); ignored unless wantWire
  M: number, // longitudinals per half-section (girth resolution)
  N: number, // sampled sections along the length (station resolution)
): { hull: Mesh; cuts: [Vec3, Vec3][]; wire: Mesh | null } {
  const { rows, open, creaseS } = bilgeRows(model, N, M, trimmed),
    R = rows.length,
    C = rows[0]?.length ?? 0,
    P: number[] = [],
    Nn: number[] = [],
    cuts: [Vec3, Vec3][] = [];
  if (R < 2 || C < 2)
    return {
      hull: { pos: new Float32Array(0), nrm: new Float32Array(0), count: 0 },
      cuts,
      wire: null,
    };
  const nrmC = rows.map((_, i) =>
    rows[i].map((_, j) => gridNormal(rows, i, j)),
  );
  // the normal at vertex (i,j) as seen from the strip on side `dir` (+1 = the strip to its right, −1 left).
  // On a crease column the two sides use one-sided normals (the crease's two faces), blended toward the
  // smooth central normal by the local crease strength — so a hard knuckle reads as an edge and a faded
  // one stays smooth. Off a crease column both sides return the shared central normal (no seam).
  const vN = (i: number, j: number, dir: number): Vec3 => {
    const s = creaseS[i]?.[j] ?? 0;
    if (s <= 1e-6) return nrmC[i][j];
    return V.norm(lerpV(nrmC[i][j], gridNormal(rows, i, j, dir), s));
  };
  // for the raw-triangle wire, capture the three edges of every emitted triangle (the transom-clipped fan
  // included) as a GL_LINES soup, so the overlay is byte-for-byte the shaded surface's own triangulation.
  const wantTriWire = wantWire && !wireQuads;
  const wireP: number[] = [];
  const wireEdge = (p: Vec3, q: Vec3): void => {
    wireP.push(p[0], p[1], p[2], q[0], q[1], q[2]);
  };
  const emit = (a: PN, b: PN, c: PN): void => {
    pushTri(P, Nn, a.p, a.n, b.p, b.n, c.p, c.n);
    if (wantTriWire) {
      wireEdge(a.p, b.p);
      wireEdge(b.p, c.p);
      wireEdge(c.p, a.p);
    }
  };
  for (let i = 0; i < R - 1; i++)
    for (let j = 0; j < C - 1; j++) {
      // the keel sits at column M of a full-width row; where the section is open there is no surface
      // across the centerline, so don't bridge the strip just inboard of the open bottom on the port side.
      if (trimmed && j === M && (open[i] || open[i + 1])) continue;
      // cols j / j+1 bound this strip: col j sees the strip on its right (+1), col j+1 on its left (−1)
      const quad: PN[] = [
        { p: rows[i][j], n: vN(i, j, +1) },
        { p: rows[i + 1][j], n: vN(i + 1, j, +1) },
        { p: rows[i + 1][j + 1], n: vN(i + 1, j + 1, -1) },
        { p: rows[i][j + 1], n: vN(i, j + 1, -1) },
      ];
      if (!trimmed) {
        emit(quad[0], quad[1], quad[2]); // raw sheet: the whole quad, untrimmed
        emit(quad[0], quad[2], quad[3]);
        continue;
      }
      const { inside, cut } = clipQuad(model, quad);
      if (cut) cuts.push(cut);
      for (let k = 1; k + 1 < inside.length; k++)
        emit(inside[0], inside[k], inside[k + 1]); // fan
    }
  return {
    hull: {
      pos: new Float32Array(P),
      nrm: new Float32Array(Nn),
      count: P.length / 3,
    },
    cuts,
    wire: !wantWire
      ? null
      : wireQuads
        ? buildWireMesh(model, rows, open, M, trimmed)
        : {
            pos: new Float32Array(wireP),
            nrm: new Float32Array(wireP.length),
            count: wireP.length / 3,
          },
  };
}

// the ordered starboard transom edge (sheer→keel) recovered from the hull-clip cut segments: collapse to
// a single half-breadth-vs-depth curve, snap the bottom onto the centerline so the two halves meet cleanly.
// The hull grid is now FULL WIDTH, so the cut segments span both halves; keep only the starboard side
// (y ≥ 0) — buildTransomMesh mirrors it back to port — else the edge zigzags across the centerline.
function transomCurve(cuts: [Vec3, Vec3][]): Vec3[] {
  const pts: Vec3[] = [];
  const seen = new Set<string>();
  for (const seg of cuts)
    for (const q of seg) {
      if (q[1] < -2) continue; // port side; the mirror rebuilds it (keep the centerline crossing, y≈0)
      const key = Math.round(q[2] / 4) + "," + Math.round(q[1] / 4);
      if (!seen.has(key)) {
        seen.add(key);
        pts.push(q);
      }
    }
  pts.sort((a, b) => b[2] - a[2]); // top (z high, at the sheer) → bottom (z low, at the keel)
  if (pts.length)
    pts[pts.length - 1] = [pts[pts.length - 1][0], 0, pts[pts.length - 1][2]];
  return pts;
}

// the flat transom panel, built from the shared hull edge so it meets the hull with no gap or overlap
function buildTransomMesh(model: Model, cuts: [Vec3, Vec3][]): Mesh {
  const e = transomCurve(cuts);
  if (e.length < 2)
    return { pos: new Float32Array(0), nrm: new Float32Array(0), count: 0 };
  const [ta, tb] = model.sheer.transom,
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

function drawMesh(
  gl: WebGLRenderingContext,
  mesh: Mesh,
  base: number[],
  primitive: number = gl.TRIANGLES,
): void {
  if (!mesh.count) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(attr.aPos);
  gl.vertexAttribPointer(attr.aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.nrm, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(attr.aNormal);
  gl.vertexAttribPointer(attr.aNormal, 3, gl.FLOAT, false, 0, 0);
  gl.uniform3fv(loc.uBase, base);
  gl.drawArrays(primitive, 0, mesh.count);
}

let meshHull: Mesh | null = null,
  meshTrans: Mesh | null = null,
  meshWire: Mesh | null = null, // the Mesh overlay's quad-grid wireframe; null when the overlay is off
  meshBBox: number[] | null = null; // [x0,y0,z0, x1,y1,z1] world bounds of the hull mesh, for fit-to-box
// the curvature-comb overlay geometry (world-space, rotation-independent): rebuilt only when the model /
// settings change, reused across rotations. null when the overlay is off.
let curvCache: CurvCurve3[] | null = null;

function computeBBox(pos: Float32Array): number[] | null {
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

// the world bounding box of the current hull mesh (for fitting an imported STL to the design space). Falls
// back to the nominal hull box when no mesh has been built yet (e.g. the view is in a lines-plan mode).
export function getHullBBox(): number[] {
  return (meshBBox ?? NOMINAL).slice();
}

// draw the imported STL as a translucent overlay over the shaded hull: shaded surface and/or wireframe edges,
// in a magenta clearly distinct from the blue hull. Depth-TESTED against the opaque hull (so hidden parts are
// occluded) but not depth-WRITING (so the translucent surface reads evenly without self-occlusion artifacts).
const STL_COLOR = [0.85, 0.24, 0.6]; // magenta — distinct from the blue hull and amber transom
function drawStlOverlay(gl: WebGLRenderingContext, stl: StlState): void {
  const s = stl.settings;
  if (!s.visible || (!s.shaded && !s.wireframe)) return;
  const sig = `${stl.geom.id}|${s.axisX}|${s.axisY}|${s.axisZ}|${s.scale}|${stl.designBox.join(",")}`;
  if (sig !== stlSig || stlTriVerts === 0) {
    const world = transformStl(stl);
    gl.bindBuffer(gl.ARRAY_BUFFER, stlPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, world.pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, stlNrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, world.nrm, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, stlLineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, world.lines, gl.STATIC_DRAW);
    stlTriVerts = world.pos.length / 3;
    stlLineVerts = world.lines.length / 3;
    stlSig = sig;
  }
  // point aPos / aNormal at the given buffers (aNormal is fed a valid buffer even when unused, so the flat
  // wireframe pass can reuse the line buffer for both attributes)
  const bind = (posB: WebGLBuffer | null, nrmB: WebGLBuffer | null): void => {
    gl.bindBuffer(gl.ARRAY_BUFFER, posB);
    gl.enableVertexAttribArray(attr.aPos);
    gl.vertexAttribPointer(attr.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmB);
    gl.enableVertexAttribArray(attr.aNormal);
    gl.vertexAttribPointer(attr.aNormal, 3, gl.FLOAT, false, 0, 0);
  };
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.uniform3fv(loc.uBase, STL_COLOR);
  gl.uniform1f(loc.uAlpha, s.opacity);
  gl.uniform1f(loc.uPaint, 0.0);
  gl.uniform1i(loc.uZebra, 0);
  if (s.shaded) {
    gl.uniform1i(loc.uFlat, 0);
    bind(stlPosBuf, stlNrmBuf);
    gl.drawArrays(gl.TRIANGLES, 0, stlTriVerts);
  }
  if (s.wireframe) {
    gl.uniform1i(loc.uFlat, 1); // flat magenta edges, no lighting
    bind(stlLineBuf, stlLineBuf);
    gl.drawArrays(gl.LINES, 0, stlLineVerts);
  }
  // restore the opaque-pass GL state for the next frame
  gl.uniform1i(loc.uFlat, 0);
  gl.uniform1f(loc.uAlpha, 1.0);
  gl.uniform1f(loc.uPaint, 1.0);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

// project a world point to screen space (world units), boat-centered — mirrors the vertex shader so the
// CPU can frame the camera to the mesh bounding box
function screenXY(
  px: number,
  py: number,
  pz: number,
  c1: number,
  s1: number,
  c2: number,
  s2: number,
  rc: number,
  rs: number,
  cxm: number,
  czm: number,
): [number, number] {
  const rx = px * rc - pz * rs,
    rz = px * rs + pz * rc,
    X = rx - cxm,
    Z = rz - czm,
    X1 = X * c1 - py * s1,
    Y1 = X * s1 + py * c1;
  return [X1, Y1 * s2 + Z * c2];
}

// the screen-space extent (and center) of the bbox's 8 corners under a given rotation
function projExtent(
  bb: number[],
  c1: number,
  s1: number,
  c2: number,
  s2: number,
  rc: number,
  rs: number,
  cxm: number,
  czm: number,
): { exX: number; exY: number; cX: number; cY: number } {
  let sxmin = Infinity,
    sxmax = -Infinity,
    symin = Infinity,
    symax = -Infinity;
  for (let ix = 0; ix < 2; ix++)
    for (let iy = 0; iy < 2; iy++)
      for (let iz = 0; iz < 2; iz++) {
        const [sx, sy] = screenXY(
          bb[ix ? 3 : 0],
          bb[iy ? 4 : 1],
          bb[iz ? 5 : 2],
          c1,
          s1,
          c2,
          s2,
          rc,
          rs,
          cxm,
          czm,
        );
        if (sx < sxmin) sxmin = sx;
        if (sx > sxmax) sxmax = sx;
        if (sy < symin) symin = sy;
        if (sy > symax) symax = sy;
      }
  return {
    exX: Math.max(sxmax - sxmin, 1),
    exY: Math.max(symax - symin, 1),
    cX: (sxmin + sxmax) / 2,
    cY: (symin + symax) / 2,
  };
}

// the zoom is fixed: it frames a NOMINAL hull box (≈ the default hull's overall size) at a reference
// orientation, so it depends only on the canvas size — not on the live rotation, the edited geometry, or
// the rake. The live hull then just sits inside that fixed frame, centered.
const REF_YAW = -0.62,
  REF_PITCH = 0.42,
  NOMINAL: number[] = [0, -238, -325, 1000, 238, 0]; // [x0,y0,z0, x1,y1,z1]

// ---------- lines-plan wireframe (SVG overlay) ----------
// A white, unshaded line drawing in the style of a hand-drawn hull lines plan: a transparent mesh of
// stations (transverse) and longitudinals, with the feature edges (sheer, keel, stem, transom, chines) bold
// and the interior grid thin. Rendered as SVG so the strokes can carry real, view-independent line weights
// (WebGL clamps lineWidth to 1 on most browsers). It reuses the 3D canvas's camera, so it rotates live.
const LINES_NS = 80,
  LINES_M = 10,
  LINES_STATION_STEP = 3; // draw a station (transverse) line every Nth grid row (≈ NS/STEP stations)
let linesGrid: { grid: Vec3[][]; creaseCols: number[] } | null = null;
interface ProjPt {
  x: number;
  y: number;
  d: number;
}

interface LineQuad {
  poly: ProjPt[];
  depth: number; // toward-eye; larger = nearer
  bold: [ProjPt, ProjPt][]; // sheer / keel / chine longitudinals (heavy)
  fam: [ProjPt, ProjPt][]; // the mode's non-chine family: stations / buttocks / waterlines (lighter)
  wl: [ProjPt, ProjPt][]; // design-waterline crossing through this facet (blue, all modes)
}

function drawLines(
  model: Model,
  selection: ModelSelection,
  params: Draw3dParams,
  svg: SVGSVGElement,
  rebuild: boolean,
  curv: CurvCurve3[] | null,
): void {
  if (rebuild || !linesGrid)
    linesGrid = trimmedHullGrid(model, LINES_NS, LINES_M);
  const { grid, creaseCols } = linesGrid;
  svg.replaceChildren();
  const NS = grid.length - 1,
    M = grid[0].length - 1;
  if (NS < 1 || M < 1) return;

  // project world (x,y,z) → screen, the same transform as the WebGL vertex shader (deck rake, then yaw about
  // up, then pitch); SVG y is down, so negate. `d` is the toward-eye depth (larger = nearer) for painter sort.
  const c1 = Math.cos(params.rot.yaw),
    s1 = Math.sin(params.rot.yaw),
    c2 = Math.cos(params.rot.pitch),
    s2 = Math.sin(params.rot.pitch),
    cT = Math.cos(model.deckRake),
    sT = Math.sin(model.deckRake);
  const proj = ([x, y, z]: Vec3): ProjPt => {
    const rx = x * cT - z * sT,
      rz = x * sT + z * cT;
    return {
      x: rx * c1 - y * s1,
      y: -((rx * s1 + y * c1) * s2 + rz * c2),
      d: -c2 * s1 * rx - c2 * c1 * y + s2 * rz,
    };
  };
  // projected point grids for both sides (starboard + the y-mirror)
  const SP = grid.map((row) => row.map(proj));
  const PP = grid.map((row) => row.map(([x, y, z]) => proj([x, -y, z])));
  const crease = new Set(creaseCols);
  const showStation = (i: number): boolean =>
    i === 0 || i === NS || i % LINES_STATION_STEP === 0;
  const gridM = grid.map((row) => row.map(([x, y, z]): Vec3 => [x, -y, z])); // port-side world points

  // line-family levels (only the active mode's are used): evenly spaced constant-y (buttocks) and constant
  // worldZ (waterlines), bracketed by the hull's own range so they sit inside it.
  let ymax = 0,
    zlo = Infinity,
    zhi = -Infinity;
  for (const row of grid)
    for (const p of row) {
      if (Math.abs(p[1]) > ymax) ymax = Math.abs(p[1]);
      const wz = worldZ(model, p[0], p[2]);
      if (wz < zlo) zlo = wz;
      if (wz > zhi) zhi = wz;
    }
  const NB = 8,
    NW = 12,
    buttLevels = Array.from(
      { length: NB },
      (_, k) => (ymax * (k + 1)) / (NB + 1),
    ),
    wlLevels = Array.from(
      { length: NW },
      (_, k) => zlo + ((zhi - zlo) * (k + 1)) / (NW + 1),
    );
  // marching: the segment where field f crosses `level` across a facet's 4 corners (linear on each edge)
  const march = (
    corn: { p: ProjPt; f: number }[],
    level: number,
  ): [ProjPt, ProjPt] | null => {
    const cr: ProjPt[] = [];
    for (let k = 0; k < 4; k++) {
      const a = corn[k],
        b = corn[(k + 1) % 4],
        fa = a.f - level,
        fb = b.f - level;
      if (fa < 0 !== fb < 0 && fa !== fb) {
        const t = fa / (fa - fb);
        cr.push({
          x: a.p.x + t * (b.p.x - a.p.x),
          y: a.p.y + t * (b.p.y - a.p.y),
          d: a.p.d + t * (b.p.d - a.p.d),
        });
      }
    }
    return cr.length >= 2 ? [cr[0], cr[1]] : null;
  };

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const quads: LineQuad[] = [];
  for (const [G, GW] of [
    [SP, grid],
    [PP, gridM],
  ] as [ProjPt[][], Vec3[][]][])
    for (let i = 0; i < NS; i++)
      for (let j = 0; j < M; j++) {
        const A = G[i][j],
          B = G[i][j + 1],
          C = G[i + 1][j + 1],
          D = G[i + 1][j];
        for (const p of [A, B, C, D]) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        const wA = GW[i][j],
          wB = GW[i][j + 1],
          wC = GW[i + 1][j + 1],
          wD = GW[i + 1][j];
        const bold: [ProjPt, ProjPt][] = [];
        if (j === 0 || crease.has(j)) bold.push([D, A]); // sheer / chine longitudinal
        if (j + 1 === M || crease.has(j + 1)) bold.push([B, C]); // keel / chine longitudinal
        if (i === 0) bold.push([A, B]); // transom trim line — bold in every mode (it is a hull edge)

        // the mode's non-chine family
        const fam: [ProjPt, ProjPt][] = [];
        if (params.view3dMode === "body") {
          if (showStation(i) && i !== 0) fam.push([A, B]); // station at this row (the transom is drawn bold)
          if (i === NS - 1 && showStation(NS)) fam.push([D, C]); // bow/forwardmost station
        } else if (params.view3dMode === "buttocks") {
          const corn = [
            { p: A, f: Math.abs(wA[1]) },
            { p: B, f: Math.abs(wB[1]) },
            { p: C, f: Math.abs(wC[1]) },
            { p: D, f: Math.abs(wD[1]) },
          ];
          for (const lv of buttLevels) {
            const s = march(corn, lv);
            if (s) fam.push(s);
          }
        } else {
          const corn = [
            { p: A, f: worldZ(model, wA[0], wA[2]) },
            { p: B, f: worldZ(model, wB[0], wB[2]) },
            { p: C, f: worldZ(model, wC[0], wC[2]) },
            { p: D, f: worldZ(model, wD[0], wD[2]) },
          ];
          for (const lv of wlLevels) {
            const s = march(corn, lv);
            if (s) fam.push(s);
          }
        }
        // design waterline (blue, all modes): worldZ crosses −waterline
        const dc = [
          { p: A, f: worldZ(model, wA[0], wA[2]) },
          { p: B, f: worldZ(model, wB[0], wB[2]) },
          { p: C, f: worldZ(model, wC[0], wC[2]) },
          { p: D, f: worldZ(model, wD[0], wD[2]) },
        ];
        const dwl = march(dc, -model.waterline);
        quads.push({
          poly: [A, B, C, D],
          depth: (A.d + B.d + C.d + D.d) / 4,
          bold,
          fam,
          wl: dwl ? [dwl] : [],
        });
      }
  quads.sort((a, b) => a.depth - b.depth); // far → near: nearer white facets are drawn last and occlude

  // FIXED zoom (matches the shaded view): the viewBox size frames the NOMINAL hull box at a reference
  // orientation, so it depends only on the overlay's pixel size — not the live rotation. Only the center
  // tracks the live hull, so it pivots in place at a constant size instead of rescaling as you rotate.
  const ref = projExtent(
    NOMINAL,
    Math.cos(REF_YAW),
    Math.sin(REF_YAW),
    Math.cos(REF_PITCH),
    Math.sin(REF_PITCH),
    1,
    0,
    L / 2,
    (ZMIN + ZMAX) / 2,
  );
  const w = svg.clientWidth || 800,
    h = svg.clientHeight || 400;
  const pxScale = 0.92 * Math.min(w / ref.exX, h / ref.exY) * params.zoom;
  const vbw = w / pxScale,
    vbh = h / pxScale,
    cx = (minX + maxX) / 2,
    cy = (minY + maxY) / 2;
  svg.setAttribute(
    "viewBox",
    `${(cx - vbw / 2).toFixed(1)} ${(cy - vbh / 2).toFixed(1)} ${vbw.toFixed(1)} ${vbh.toFixed(1)}`,
  );
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // Painter's: each quad is an opaque WHITE facet (a white hairline stroke only closes the anti-alias seams).
  // Nearer facets, drawn later, paint over the lines behind them, so the far side is hidden like a solid hull.
  // Per facet we draw the occluded interior lines: stations, chines, and the design-waterline crossing (blue).
  const pts = (q: ProjPt[]): string =>
    q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const line = (p0: ProjPt, p1: ProjPt, w: number, color: string): SVGElement =>
    el("line", {
      x1: p0.x.toFixed(1),
      y1: p0.y.toFixed(1),
      x2: p1.x.toFixed(1),
      y2: p1.y.toFixed(1),
      stroke: color,
      "stroke-width": w,
      "stroke-linecap": "round",
      "vector-effect": "non-scaling-stroke",
    });
  // The selected template point's longitudinal (the locus it sweeps) is drawn occluded like everything else:
  // its segments are mixed INTO the painter's order, each at its own depth, biased a hair toward the eye so it
  // sits just proud of its own facet (no z-fight) but is hidden behind any nearer surface. Built and trimmed
  // exactly like buildLongitudinalMesh. Amber, matching the shaded view's guide.
  type Item = {
    depth: number;
    q?: LineQuad;
    seg?: [ProjPt, ProjPt];
    color?: string; // for a seg item: its stroke (defaults to the amber guide colour)
    width?: number;
  };
  const items: Item[] = quads.map((q) => ({ depth: q.depth, q }));
  // world-space toward-eye direction (gradient of the projected depth): overlay segments are biased along it
  // so they clear the coarse flat-facet chords (they ride facet interiors, not edges) without z-fighting.
  let vx = -c2 * s1 * cT + s2 * sT,
    vy = -c2 * c1,
    vz = c2 * s1 * sT + s2 * cT;
  const vl = Math.hypot(vx, vy, vz) || 1,
    EYE_BIAS = 15;
  vx /= vl;
  vy /= vl;
  vz /= vl;
  const li = selStationIdx(model, selection);
  if (li !== null) {
    const tpl = model.templates,
      NP = 120,
      WP: Vec3[] = [],
      keep: boolean[] = [];
    for (let i = 0; i <= NP; i++) {
      const x = (L * i) / NP,
        wt = weightsAt(model, x);
      let n = 0,
        d = 0;
      for (let t = 0; t < tpl.length; t++) {
        n += wt[t] * tpl[t][li].n;
        d += wt[t] * tpl[t][li].d;
      }
      const fr = frameAt(model, x),
        w: Vec3 = [
          fr.p[0] + n * fr.n[0] + d * fr.d[0],
          fr.p[1] + n * fr.n[1] + d * fr.d[1],
          fr.p[2] + n * fr.n[2] + d * fr.d[2],
        ];
      WP.push(w);
      keep.push(
        d >= -model.sheer.zf(x) && w[1] >= 0 && w[0] >= xTransom(model, w[2]),
      );
    }
    for (const sgn of [1, -1])
      for (let i = 0; i < NP; i++) {
        if (!keep[i] || !keep[i + 1]) continue;
        const a = proj([
            WP[i][0] + vx * EYE_BIAS,
            sgn * WP[i][1] + vy * EYE_BIAS,
            WP[i][2] + vz * EYE_BIAS,
          ]),
          b = proj([
            WP[i + 1][0] + vx * EYE_BIAS,
            sgn * WP[i + 1][1] + vy * EYE_BIAS,
            WP[i + 1][2] + vz * EYE_BIAS,
          ]);
        items.push({ depth: (a.d + b.d) / 2, seg: [a, b] });
      }
  }
  // the curvature-comb overlay (each enabled curve + its comb), projected and mixed into the painter order
  // like the selected guide. A one-sided curve (sheer / longitudinals) draws both y-signs; a full-width or
  // on-centerline curve (sections / keel) draws once.
  if (curv)
    for (const cc of curv) {
      if (cc.curve.length < 2) continue;
      const projB = (p: Vec3, sgn: number): ProjPt =>
        proj([
          p[0] + vx * EYE_BIAS,
          sgn * p[1] + vy * EYE_BIAS,
          p[2] + vz * EYE_BIAS,
        ]);
      const signs = cc.mirror ? [1, -1] : [1];
      const addSeg = (a: Vec3, b: Vec3, width: number): void => {
        for (const sgn of signs) {
          const pa = projB(a, sgn),
            pb = projB(b, sgn);
          items.push({
            depth: (pa.d + pb.d) / 2,
            seg: [pa, pb],
            color: cc.css,
            width,
          });
        }
      };
      for (let i = 0; i + 1 < cc.curve.length; i++)
        addSeg(cc.curve[i], cc.curve[i + 1], 2.2);
      for (const [a, b] of cc.hairs) addSeg(a, b, 1);
      for (let i = 0; i + 1 < cc.env.length; i++)
        addSeg(cc.env[i], cc.env[i + 1], 1.2);
    }
  items.sort((a, b) => a.depth - b.depth); // far → near, facets and overlay segments together

  for (const it of items) {
    if (it.seg) {
      // the selected longitudinal (amber) by default; sheer/comb segments carry their own colour + width
      svg.append(
        line(it.seg[0], it.seg[1], it.width ?? 1.8, it.color ?? HILITE),
      );
      continue;
    }
    const q = it.q!;
    svg.append(
      el("polygon", {
        points: pts(q.poly),
        fill: "#ffffff", // white occlusion faces (the hull reads as a white shape on the grey background)
        stroke: "#ffffff",
        "stroke-width": 0.6,
        "stroke-linejoin": "round",
        "vector-effect": "non-scaling-stroke",
      }),
    );
    for (const [p0, p1] of q.wl) svg.append(line(p0, p1, 1.4, COL.wl)); // design waterline (blue)
    for (const [p0, p1] of q.fam) svg.append(line(p0, p1, 1, "#11181f")); // stations / buttocks / waterlines
    for (const [p0, p1] of q.bold) svg.append(line(p0, p1, 1.8, "#11181f")); // sheer / keel / chines (heavy)
  }
}

export function draw3d(
  cv3d: HTMLCanvasElement,
  lines: SVGSVGElement | null,
  model: Model,
  selection: ModelSelection,
  params: Draw3dParams,
  rebuild?: boolean,
  stl?: StlState | null,
): void {
  // the curvature-comb overlay geometry is world-space (rotation-independent), so rebuild it only when the
  // model / settings change (rebuild !== false) and reuse the cache on rotate / zoom / resize (rebuild false).
  if (rebuild !== false)
    curvCache = params.curvature.on
      ? buildCurvature3(model, params.curvature)
      : null;
  // lines-plan style: draw the SVG overlay and skip the WebGL surface entirely
  if (LINES_MODES.includes(params.view3dMode) && lines) {
    lines.style.display = "";
    drawLines(model, selection, params, lines, rebuild !== false, curvCache);
    return;
  }
  if (lines) lines.style.display = "none";
  if (!GL) initGL(cv3d);
  const trimmed = params.view3dMode !== "sheet";
  if (rebuild !== false || !meshHull) {
    const built = buildHullMesh(
      model,
      trimmed,
      params.showMesh,
      params.meshQuads,
      params.meshM,
      params.meshN,
    );
    meshHull = built.hull;
    meshTrans = trimmed ? buildTransomMesh(model, built.cuts) : null;
    meshBBox = computeBBox(meshHull.pos);
    meshWire = built.wire;
  }
  const gl = GL!,
    cv = gl.canvas as HTMLCanvasElement,
    dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(cv.clientWidth * dpr),
    h = Math.round(cv.clientHeight * dpr); // fill the canvas's CSS box (any aspect)
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  gl.viewport(0, 0, cv.width, cv.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(prog);
  const c1 = Math.cos(params.rot.yaw),
    s1 = Math.sin(params.rot.yaw),
    c2 = Math.cos(params.rot.pitch),
    s2 = Math.sin(params.rot.pitch);
  gl.uniform1f(loc.uc1, c1);
  gl.uniform1f(loc.us1, s1);
  gl.uniform1f(loc.uc2, c2);
  gl.uniform1f(loc.us2, s2);
  // Framing: a FIXED zoom (no auto-zoom). The scale frames the nominal hull box at the reference
  // orientation, unraked, so it changes only with the canvas size. The center tracks the LIVE rotation and
  // the live hull bounds, so the hull pivots in place, staying centered, at a constant size.
  const cxm = L / 2,
    czm = (ZMIN + ZMAX) / 2,
    rc = Math.cos(model.deckRake),
    rs = Math.sin(model.deckRake),
    bb = meshBBox ?? NOMINAL;
  const ref = projExtent(
      NOMINAL,
      Math.cos(REF_YAW),
      Math.sin(REF_YAW),
      Math.cos(REF_PITCH),
      Math.sin(REF_PITCH),
      1,
      0,
      cxm,
      czm,
    ),
    live = projExtent(bb, c1, s1, c2, s2, rc, rs, cxm, czm),
    pxScale = 0.92 * Math.min(w / ref.exX, h / ref.exY) * params.zoom;
  gl.uniform1f(loc.uKX, (pxScale * 2) / w);
  gl.uniform1f(loc.uKY, (pxScale * 2) / h);
  gl.uniform1f(loc.uCX, live.cX);
  gl.uniform1f(loc.uCY, live.cY);
  gl.uniform1f(loc.ucxm, cxm);
  gl.uniform1f(loc.uczm, czm);
  gl.uniform1f(loc.uDepth, 750); // depth-range scale; ÷4 with the unitless L=1000 rescale to keep ndcz unchanged
  gl.uniform1f(loc.uRakeC, Math.cos(model.deckRake)); // deck rake floats the hull at its trim
  gl.uniform1f(loc.uRakeS, Math.sin(model.deckRake));
  gl.uniform1f(loc.uAlpha, 1.0);
  gl.uniform1i(loc.uFlat, 0); // shaded (never flat) for the hull passes; the STL overlay toggles it
  const view = V.norm([-c2 * s1, -c2 * c1, s2]); // surface→eye direction (orthographic)
  gl.uniform3fv(loc.uView, view);
  // key light at the lower-left of the screen, off the view axis so 3/4 views read as form rather than flat
  // front-lighting, with a toward-eye term to keep the visible faces lit. The toward-eye / off-axis balance
  // (EYE vs SIDE) sets how grazing the light is: a very grazing light is maximally sensitive to tiny normal
  // tilts, so it amplifies sub-degree faceting noise in the swept mesh into false puckering. Keeping a solid
  // off-axis component preserves the form read while easing the grazing enough to quiet that meshing noise.
  const right: Vec3 = [c1, -s1, 0],
    up: Vec3 = [s2 * s1, s2 * c1, c2];
  const EYE = 0.72,
    SIDE = 0.62;
  gl.uniform3fv(
    loc.uLight,
    V.norm([
      EYE * view[0] - SIDE * right[0] - SIDE * up[0],
      EYE * view[1] - SIDE * right[1] - SIDE * up[1],
      EYE * view[2] - SIDE * right[2] - SIDE * up[2],
    ]),
  );
  gl.uniform1f(loc.uStripes, 11.0);
  gl.uniform1i(loc.uZebra, params.view3dMode === "zebra" ? 1 : 0);
  gl.uniform1i(loc.uFlat, 0); // the hull / transom are lit; only the guide-line overlays go flat (below)
  gl.uniform1f(loc.uWaterZ, -model.waterline); // boot-top height in world z; below it the hull is bottom-painted
  gl.uniform1f(loc.uPaint, 1.0); // hull + transom take bottom paint
  // with the wireframe overlay on, push the shaded FILL back by a polygon-offset (the classic wireframe-
  // over-solid trick) so the wire — drawn just below at the IDENTICAL hull-grid positions — stays crisply
  // superimposed on the skin from either side, with no z-fighting and no visible geometric gap. Lines are
  // unaffected by POLYGON_OFFSET_FILL, so only the fill is nudged.
  if (meshWire) {
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
  }
  drawMesh(gl, meshHull, [0.3, 0.5, 0.72]);
  if (meshTrans) {
    gl.uniform1i(loc.uZebra, 0);
    drawMesh(gl, meshTrans, [0.74, 0.55, 0.37]);
  } // transom always solid
  if (meshWire) {
    gl.disable(gl.POLYGON_OFFSET_FILL);
    drawMesh(gl, meshWire, WIRE_RGB, gl.LINES);
  }

  // selected station point → draw its longitudinal (swept locus along x) on top of the hull, in amber
  const li = selStationIdx(model, selection);
  if (li !== null) {
    gl.uniform1i(loc.uZebra, 0);
    gl.uniform1f(loc.uPaint, 0.0); // guide ribbon keeps its amber above and below the waterline
    drawMesh(gl, buildLongitudinalMesh(model, li, view), [0.96, 0.62, 0.04]); // matches the 2D link-marker amber
  }

  // imported reference STL, translucent, over everything (GL modes only — the lines-plan modes returned early)
  if (stl) drawStlOverlay(gl, stl);

  // curvature-comb overlay: each enabled curve (its port mirror too, where one-sided) and its comb, built
  // into camera-facing ribbons here each draw (view-dependent), from the cached world-space geometry.
  if (curvCache && curvCache.length) {
    const mir = (p: Vec3): Vec3 => [p[0], -p[1], p[2]];
    gl.uniform1i(loc.uZebra, 0);
    gl.uniform1i(loc.uFlat, 1); // flat, unshaded colour — matches the lines-plan overlay (no lighting/view shift)
    gl.uniform1f(loc.uPaint, 0.0); // the overlay keeps its colour above and below the waterline
    // fixed on-screen widths: divide the CSS-px half-width by the pixel scale (× dpr) to get world units, so
    // the ribbons don't scale with the zoom / framing (BIAS stays world-space — it only nudges depth, not size)
    const hwCurve = (SHEER_HALF_PX * dpr) / pxScale,
      hwComb = (COMB_HALF_PX * dpr) / pxScale;
    for (const cc of curvCache) {
      if (cc.curve.length < 2) continue;
      const curves: Vec3[][] = [cc.curve];
      if (cc.mirror) curves.push(cc.curve.map(mir));
      drawMesh(gl, ribbonMesh(curves, view, hwCurve, 9), cc.rgb);
      if (cc.hairs.length) {
        const comb: Vec3[][] = [cc.env];
        if (cc.mirror) comb.push(cc.env.map(mir));
        for (const [a, b] of cc.hairs) {
          comb.push([a, b]);
          if (cc.mirror) comb.push([mir(a), mir(b)]);
        }
        drawMesh(gl, ribbonMesh(comb, view, hwComb, 9), cc.rgb); // same colour as the base curve
      }
    }
    gl.uniform1i(loc.uFlat, 0); // restore lit shading for the next frame's hull draw
  }
}
