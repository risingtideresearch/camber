// ---------- STEP (ISO 10303-21, AP214) export of the trimmed hull ----------
// The hull is sampled into a rectangular grid of stations (u) × along-section points (v). A genuine
// bicubic B-spline surface is interpolated through that grid (Piegl & Tiller, "The NURBS Book",
// Algorithm A9.4 — global surface interpolation), so the exported surface passes exactly through the
// station sections and is fair between them. The grid spans the FULL breadth (starboard sheer → keel →
// port sheer) so the keel is interior to one B_SPLINE_SURFACE_WITH_KNOTS face — C² smooth across the
// centerline, with no mirror seam to fold into a welt. The transom is a single planar face sharing the
// hull's aft edge. Both live in one OPEN_SHELL (the hull is open along the deck/sheer edge).

import { V, type Vec3 } from "./math.js";
import { L, sweptSection, xTransom, state, prepare, forwardLimit } from "./model.js";

// ---------- B-spline numerics ----------

// largest knot span index containing u (Piegl & Tiller A2.1)
function findSpan(n: number, p: number, u: number, U: number[]): number {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let low = p,
    high = n + 1,
    mid = (low + high) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

// the p+1 nonzero basis functions at u, for indices [span-p .. span] (A2.2)
function basisFuns(span: number, u: number, p: number, U: number[]): number[] {
  const N = new Array(p + 1).fill(0),
    left = new Array(p + 1).fill(0),
    right = new Array(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

// chord-length parameters through a set of points, normalised to [0,1]
function chordParams(pts: Vec3[]): number[] {
  const n = pts.length,
    d: number[] = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.max(Math.hypot(...V.sub(pts[i], pts[i - 1])), 1e-9);
    d.push(total);
  }
  return d.map((x) => x / (total || 1));
}

// averaged parameters across a family of point rows (A9.3-style averaging)
function averagedParams(rows: Vec3[][]): number[] {
  const cnt = rows[0].length,
    acc = new Array(cnt).fill(0);
  for (const r of rows) {
    const t = chordParams(r);
    for (let i = 0; i < cnt; i++) acc[i] += t[i];
  }
  return acc.map((x) => x / rows.length);
}

// clamped knot vector from data parameters by averaging (Eq. 9.8)
function knotsFromParams(ub: number[], p: number): number[] {
  const n = ub.length - 1,
    U: number[] = [];
  for (let i = 0; i <= p; i++) U.push(0);
  for (let j = 1; j <= n - p; j++) {
    let s = 0;
    for (let i = j; i <= j + p - 1; i++) s += ub[i];
    U.push(s / p);
  }
  for (let i = 0; i <= p; i++) U.push(1);
  return U;
}

// LU decomposition (Doolittle, partial pivoting) of a square matrix, in place on a copy
function luDecompose(A: number[][]): { LU: number[][]; piv: number[] } {
  const n = A.length,
    LU = A.map((r) => r.slice()),
    piv = Array.from({ length: n }, (_, i) => i);
  for (let k = 0; k < n; k++) {
    let mx = Math.abs(LU[k][k]),
      pr = k;
    for (let i = k + 1; i < n; i++)
      if (Math.abs(LU[i][k]) > mx) {
        mx = Math.abs(LU[i][k]);
        pr = i;
      }
    if (pr !== k) {
      [LU[k], LU[pr]] = [LU[pr], LU[k]];
      [piv[k], piv[pr]] = [piv[pr], piv[k]];
    }
    const d = LU[k][k] || 1e-12;
    for (let i = k + 1; i < n; i++) {
      LU[i][k] /= d;
      for (let j = k + 1; j < n; j++) LU[i][j] -= LU[i][k] * LU[k][j];
    }
  }
  return { LU, piv };
}
function luSolve(LU: number[][], piv: number[], b: number[]): number[] {
  const n = LU.length,
    y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[piv[i]];
    for (let j = 0; j < i; j++) s -= LU[i][j] * y[j];
    y[i] = s;
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let j = i + 1; j < n; j++) s -= LU[i][j] * x[j];
    x[i] = s / (LU[i][i] || 1e-12);
  }
  return x;
}

// collocation matrix N[k][i] = N_{i,p}(ub[k]) for a clamped curve through ub with knots U
function collocation(ub: number[], p: number, U: number[]): number[][] {
  const n = ub.length - 1,
    A = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
  for (let k = 0; k <= n; k++) {
    const span = findSpan(n, p, ub[k], U),
      bf = basisFuns(span, ub[k], p, U);
    for (let t = 0; t <= p; t++) A[k][span - p + t] = bf[t];
  }
  return A;
}

// clamped knot vector from data params over their OWN range [ub0, ubN] (interior = averaged). Like
// knotsFromParams but it doesn't hardcode [0,1], so it can interpolate a sub-segment of a curve.
function clampedKnotsRange(ub: number[], p: number): number[] {
  const n = ub.length - 1,
    U: number[] = [];
  for (let i = 0; i <= p; i++) U.push(ub[0]);
  for (let j = 1; j <= n - p; j++) {
    let s = 0;
    for (let i = j; i <= j + p - 1; i++) s += ub[i];
    U.push(s / p);
  }
  for (let i = 0; i <= p; i++) U.push(ub[n]);
  return U;
}

// Global bicubic interpolation with hard creases at the given v-columns (knuckle lines + keel). Same as
// interpSurface in u (smooth longitudinally); in v it interpolates each smooth strip [crease..crease]
// independently and splices them into ONE surface with a multiplicity-q v-knot at each crease — so the
// surface CAN break tangent there. It only actually creases where the data corners (a knuckle at full
// strength); where the knuckle has faded the strip data is smooth and the join is near-smooth (a small C0
// residual — see the deferred derivative-constrained refinement). Falls back to a smooth strip wherever a
// crease would leave a segment too short to interpolate at degree q.
function interpSurfaceCreased(
  Q: Vec3[][],
  creaseCols: number[],
): { net: Vec3[][]; p: number; q: number; U: number[]; Vk: number[] } {
  const nu = Q.length - 1,
    nv = Q[0].length - 1,
    p = Math.min(3, nu),
    q = Math.min(3, nv);
  const ub = averagedParams(transpose(Q)),
    vb = averagedParams(Q),
    U = knotsFromParams(ub, p);
  const mk = (cols: number): number[][] =>
    Array.from({ length: nu + 1 }, () => new Array<number>(cols).fill(0));
  // pass 1: interpolate down u for each v-column → intermediate u-controls R[c][i][l] (smooth in u)
  const Au = luDecompose(collocation(ub, p, U)),
    R = [mk(nv + 1), mk(nv + 1), mk(nv + 1)];
  for (let l = 0; l <= nv; l++)
    for (let c = 0; c < 3; c++) {
      const sol = luSolve(Au.LU, Au.piv, Q.map((row) => row[l][c]));
      for (let i = 0; i <= nu; i++) R[c][i][l] = sol[i];
    }
  // segment bounds in v: split at crease columns, dropping any that would leave a strip shorter than q+1
  const creases = creaseCols.filter((c) => c > 0 && c < nv).sort((a, b) => a - b);
  const bounds = [0];
  for (const c of creases) if (c - bounds[bounds.length - 1] >= q + 1 && nv - c >= q + 1) bounds.push(c);
  bounds.push(nv);
  // per-segment params/knots/LU, and the spliced combined v-knot vector
  const segs = bounds.slice(0, -1).map((a, si) => {
    const b = bounds[si + 1],
      params = vb.slice(a, b + 1),
      knots = clampedKnotsRange(params, q);
    return { a, b, knots, lu: luDecompose(collocation(params, q, knots)) };
  });
  let Vk: number[] = [];
  for (let si = 0; si < segs.length; si++) {
    if (si === 0) Vk = segs[si].knots.slice();
    else {
      const vc = vb[segs[si].a]; // crease param: drop the (q+1) clamp from each side, splice in q copies ⇒ C0
      Vk = Vk.slice(0, Vk.length - (q + 1)).concat(new Array(q).fill(vc), segs[si].knots.slice(q + 1));
    }
  }
  const Ncv = Vk.length - q - 1; // combined v-control count
  const P = [mk(Ncv), mk(Ncv), mk(Ncv)];
  for (let i = 0; i <= nu; i++)
    for (let c = 0; c < 3; c++) {
      let col = 0;
      for (let si = 0; si < segs.length; si++) {
        const sg = segs[si],
          ctrl = luSolve(sg.lu.LU, sg.lu.piv, R[c][i].slice(sg.a, sg.b + 1));
        // segments share the crease control (each clamped segment interpolates its endpoint) ⇒ skip ctrl[0]
        const start = si === 0 ? 0 : 1;
        for (let k = start; k < ctrl.length; k++) P[c][i][col++] = ctrl[k];
      }
    }
  const net: Vec3[][] = Array.from({ length: nu + 1 }, (_, i) =>
    Array.from({ length: Ncv }, (_, l): Vec3 => [P[0][i][l], P[1][i][l], P[2][i][l]]),
  );
  return { net, p, q, U, Vk };
}

function transpose(Q: Vec3[][]): Vec3[][] {
  const r = Q.length,
    c = Q[0].length,
    out: Vec3[][] = Array.from({ length: c }, () => new Array(r));
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) out[j][i] = Q[i][j];
  return out;
}

// a full knot vector → distinct values and their multiplicities (STEP wants the compressed form)
function compressKnots(U: number[]): { knots: number[]; mults: number[] } {
  const knots: number[] = [],
    mults: number[] = [];
  for (const u of U) {
    const last = knots.length - 1;
    if (last >= 0 && Math.abs(u - knots[last]) < 1e-12) mults[last]++;
    else {
      knots.push(u);
      mults.push(1);
    }
  }
  return { knots, mults };
}

// ---------- hull sampling ----------

// A rectangular grid of the starboard hull whose AFT boundary row is exactly the transom intersection
// curve. Columns are constant depth-fractions (j=0 sheer-trim → j=M keel); for each column we find where
// that fraction crosses the transom plane and sweep forward from there to the bow. Because the sections
// are full (sheer→keel, never renormalised to a clipped sliver), the surface stays fair right to the
// stern, and row 0 lies on the transom plane so the hull and transom share an exact edge.
export function trimmedHullGrid(NS: number, M: number): { grid: Vec3[][]; creaseCols: number[] } {
  const cols = M + 1,
    gate = (p: Vec3): number => p[0] - xTransom(p[2]),
    fair = (x: number): Vec3[] => sweptSection(x, M, true, false).pts;
  // per column, locate the aft crossing of the transom plane (first inside transition scanning forward)
  const SCAN = 240,
    xaf = new Array<number>(cols).fill(0),
    found = new Array<boolean>(cols).fill(false);
  let prev = fair(0);
  for (let k = 1; k <= SCAN; k++) {
    const x = (L * k) / SCAN,
      cur = fair(x);
    for (let j = 0; j < cols; j++) {
      if (found[j]) continue;
      const ga = gate(prev[j]),
        gb = gate(cur[j]);
      if (ga < 0 && gb >= 0) {
        xaf[j] = (L * (k - 1 + ga / (ga - gb))) / SCAN;
        found[j] = true;
      }
    }
    prev = cur;
  }
  const xf = forwardLimit(); // the hull closes here, not necessarily at L (the fine bow trims away forward)
  const grid: Vec3[][] = Array.from({ length: NS + 1 }, () => new Array<Vec3>(cols));
  for (let j = 0; j < cols; j++)
    for (let i = 0; i <= NS; i++) {
      // cosine spacing clusters stations at the transom edge and the bow so the fine bow tapers gradually
      const t = 0.5 * (1 - Math.cos((Math.PI * i) / NS));
      const x = xaf[j] + (xf - xaf[j]) * t; // sweep forward from the transom edge to the bow closure
      grid[i][j] = fair(x)[j];
    }
  // crease columns (knuckle lines + keel) — consistent along the hull; read from a representative closed section
  let creaseCols: number[] = [];
  for (let i = 2; i <= 7; i++) {
    const s = sweptSection((L * i) / 10, M, true, false);
    if (!s.aft && s.keel) {
      creaseCols = s.creaseCols;
      break;
    }
  }
  return { grid, creaseCols };
}

// ---------- STEP text builder ----------

function fmt(x: number): string {
  const v = Math.abs(x) < 1e-9 ? 0 : x;
  return String(+v.toFixed(6));
}

class StepDoc {
  private lines: string[] = [];
  private id = 0;
  add(body: string): number {
    const i = ++this.id;
    this.lines.push(`#${i}=${body};`);
    return i;
  }
  point(p: Vec3): number {
    return this.add(`CARTESIAN_POINT('',(${fmt(p[0])},${fmt(p[1])},${fmt(p[2])}))`);
  }
  dir(d: Vec3): number {
    return this.add(`DIRECTION('',(${fmt(d[0])},${fmt(d[1])},${fmt(d[2])}))`);
  }
  body(schema: string): string {
    const head = [
      "ISO-10303-21;",
      "HEADER;",
      "FILE_DESCRIPTION(('camber hull surface'),'2;1');",
      `FILE_NAME('camber.step','${DATE}',(''),(''),'camber','camber','');`,
      `FILE_SCHEMA(('${schema}'));`,
      "ENDSEC;",
      "DATA;",
    ];
    return head.join("\n") + "\n" + this.lines.join("\n") + "\nENDSEC;\nEND-ISO-10303-21;\n";
  }
}

let DATE = "2026-01-01T00:00:00"; // stamped at export time (no Date.now in module scope)

// emit a B-spline surface as one bounded ADVANCED_FACE, reusing shared control points; returns face id
function emitSurfaceFace(
  d: StepDoc,
  net: Vec3[][],
  p: number,
  q: number,
  U: number[],
  Vk: number[],
): number {
  const nu = net.length - 1,
    nv = net[0].length - 1;
  const cp = net.map((row) => row.map((pt) => d.point(pt))); // shared cartesian points
  const surfRows = cp.map((row) => `(${row.map((id) => `#${id}`).join(",")})`).join(",");
  const uk = compressKnots(U),
    vk = compressKnots(Vk);
  const surf = d.add(
    `B_SPLINE_SURFACE_WITH_KNOTS('',${p},${q},(${surfRows}),.UNSPECIFIED.,.F.,.F.,.F.,` +
      `(${uk.mults.join(",")}),(${vk.mults.join(",")}),` +
      `(${uk.knots.map(fmt).join(",")}),(${vk.knots.map(fmt).join(",")}),.UNSPECIFIED.)`,
  );
  // four corner vertices (clamped surface interpolates the corners exactly)
  const v00 = d.add(`VERTEX_POINT('',#${cp[0][0]})`),
    vn0 = d.add(`VERTEX_POINT('',#${cp[nu][0]})`),
    v0m = d.add(`VERTEX_POINT('',#${cp[0][nv]})`),
    vnm = d.add(`VERTEX_POINT('',#${cp[nu][nv]})`);
  // boundary curves as B-spline curves reusing the net's edge rows/columns
  const curve = (ids: number[], deg: number, K: number[]): number => {
    const k = compressKnots(K);
    return d.add(
      `B_SPLINE_CURVE_WITH_KNOTS('',${deg},(${ids.map((i) => `#${i}`).join(",")}),` +
        `.UNSPECIFIED.,.F.,.F.,(${k.mults.join(",")}),(${k.knots.map(fmt).join(",")}),.UNSPECIFIED.)`,
    );
  };
  const colAt = (l: number) => cp.map((row) => row[l]); // varies in u
  const rowAt = (i: number) => cp[i].slice(); // varies in v
  const cV0 = curve(colAt(0), p, U), // v=0 edge, varies u: v00→vn0
    cVn = curve(colAt(nv), p, U), // v=max edge, varies u: v0m→vnm
    cU0 = curve(rowAt(0), q, Vk), // u=0 edge, varies v: v00→v0m
    cUn = curve(rowAt(nu), q, Vk); // u=max edge, varies v: vn0→vnm
  const eV0 = d.add(`EDGE_CURVE('',#${v00},#${vn0},#${cV0},.T.)`),
    eUn = d.add(`EDGE_CURVE('',#${vn0},#${vnm},#${cUn},.T.)`),
    eVn = d.add(`EDGE_CURVE('',#${v0m},#${vnm},#${cVn},.T.)`),
    eU0 = d.add(`EDGE_CURVE('',#${v00},#${v0m},#${cU0},.T.)`);
  // CCW loop in (u,v): (0,0)→(n,0)→(n,m)→(0,m)→(0,0)
  const o1 = d.add(`ORIENTED_EDGE('',*,*,#${eV0},.T.)`),
    o2 = d.add(`ORIENTED_EDGE('',*,*,#${eUn},.T.)`),
    o3 = d.add(`ORIENTED_EDGE('',*,*,#${eVn},.F.)`),
    o4 = d.add(`ORIENTED_EDGE('',*,*,#${eU0},.F.)`);
  const loop = d.add(`EDGE_LOOP('',(#${o1},#${o2},#${o3},#${o4}))`),
    bound = d.add(`FACE_OUTER_BOUND('',#${loop},.T.)`);
  return d.add(`ADVANCED_FACE('',(#${bound}),#${surf},.T.)`);
}

// Emit the planar transom face. Its bottom boundary reuses the single full-width hull surface's aft
// control row (net[0]) with the same degree/knots, so it is the IDENTICAL B-spline curve as the hull
// face's aft edge — the kernel sews them into one watertight skin. The aft row runs starboard-sheer →
// keel → port-sheer (the keel is interior, on the centerline), and the face is closed at the top by a
// straight line across the breadth between the two sheer ends.
function emitTransomFace(d: StepDoc, net: Vec3[][], q: number, Vk: number[]): number | null {
  const nv = net[0].length - 1;
  if (nv < 2) return null;
  const cp = net[0].map((p) => d.point([p[0], p[1], p[2]] as Vec3)); // full aft row, shared with the hull
  const vSheerS = d.add(`VERTEX_POINT('',#${cp[0]})`),
    vSheerP = d.add(`VERTEX_POINT('',#${cp[nv]})`);
  const k = compressKnots(Vk),
    cBottom = d.add(
      `B_SPLINE_CURVE_WITH_KNOTS('',${q},(${cp.map((i) => `#${i}`).join(",")}),` +
        `.UNSPECIFIED.,.F.,.F.,(${k.mults.join(",")}),(${k.knots.map(fmt).join(",")}),.UNSPECIFIED.)`,
    ),
    topVec = d.add(`VECTOR('',#${d.dir([0, 1, 0])},1.0)`),
    topLine = d.add(`LINE('',#${cp[nv]},#${topVec})`); // across the breadth at the sheer
  const eBottom = d.add(`EDGE_CURVE('',#${vSheerS},#${vSheerP},#${cBottom},.T.)`), // sheerS → keel → sheerP
    eTop = d.add(`EDGE_CURVE('',#${vSheerP},#${vSheerS},#${topLine},.T.)`);
  const o1 = d.add(`ORIENTED_EDGE('',*,*,#${eBottom},.T.)`),
    o2 = d.add(`ORIENTED_EDGE('',*,*,#${eTop},.T.)`);
  const loop = d.add(`EDGE_LOOP('',(#${o1},#${o2}))`),
    bound = d.add(`FACE_OUTER_BOUND('',#${loop},.T.)`);
  const [ta, tb] = state.sheer.transom,
    slope = (tb.x - ta.x) / (tb.z - ta.z || 1),
    place = d.add(`AXIS2_PLACEMENT_3D('',#${d.point(net[0][0])},#${d.dir(V.norm([1, 0, -slope]))},#${d.dir([0, 1, 0])})`),
    plane = d.add(`PLANE('',#${place})`);
  return d.add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
}

// ---------- public API ----------

export function buildStep(date: string): string {
  DATE = date;
  prepare(); // ensure the sheer samplers are current
  const M = 24,
    { grid: half, creaseCols: halfCrease } = trimmedHullGrid(48, M);
  if (half.length < 4) throw new Error("hull has too few sections to export");
  // full-width grid: starboard sheer→keel (cols 0..M), then port keel→sheer (cols M+1..2M) as the
  // y-mirror, dropping the duplicate keel point. The keel is therefore an INTERIOR column of one surface
  // — C² smooth across the centerline — instead of two half-surfaces mirrored at a seam (which only join
  // smoothly when the keel approach is exactly horizontal, and otherwise fold into a welt: the "pucker").
  const grid: Vec3[][] = half.map((row) => {
    const full = row.slice();
    for (let j = M - 1; j >= 0; j--) full.push([row[j][0], -row[j][1], row[j][2]] as Vec3);
    return full;
  });

  // full-width crease columns: a chine knuckle at half-col c sits at full-cols c and 2M−c; the keel (half
  // col M) is the centre col M. Mult-q v-knots there let the one surface carry those creases.
  const creaseSet = new Set<number>();
  for (const c of halfCrease) {
    if (c === M) creaseSet.add(M);
    else {
      creaseSet.add(c);
      creaseSet.add(2 * M - c);
    }
  }
  const creaseCols = [...creaseSet].sort((a, b) => a - b);

  const d = new StepDoc();
  const faces: number[] = [];
  const hull = interpSurfaceCreased(grid, creaseCols);
  faces.push(emitSurfaceFace(d, hull.net, hull.p, hull.q, hull.U, hull.Vk));
  const tf = emitTransomFace(d, hull.net, hull.q, hull.Vk);
  if (tf) faces.push(tf);

  const shell = d.add(`OPEN_SHELL('',(${faces.map((f) => `#${f}`).join(",")}))`),
    ssm = d.add(`SHELL_BASED_SURFACE_MODEL('',(#${shell}))`);
  // geometric context: millimetres, 0.01 mm accuracy
  const o = d.point([0, 0, 0]),
    z = d.dir([0, 0, 1]),
    x = d.dir([1, 0, 0]),
    axis = d.add(`AXIS2_PLACEMENT_3D('',#${o},#${z},#${x})`);
  const lu = d.add("( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )"),
    au = d.add("( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )"),
    su = d.add("( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )"),
    unc = d.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#${lu},'accuracy','')`),
    ctx = d.add(
      `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) ` +
        `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lu},#${au},#${su})) REPRESENTATION_CONTEXT('camber','3D') )`,
    );
  const rep = d.add(`MANIFOLD_SURFACE_SHAPE_REPRESENTATION('camber',(#${axis},#${ssm}),#${ctx})`);
  // product structure so the geometry is attached to a part
  const appctx = d.add("APPLICATION_CONTEXT('automotive design')");
  d.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appctx})`);
  const pctx = d.add(`PRODUCT_CONTEXT('',#${appctx},'mechanical')`),
    prod = d.add(`PRODUCT('camber','camber hull','',(#${pctx}))`),
    pdf = d.add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`),
    pdctx = d.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appctx},'design')`),
    pd = d.add(`PRODUCT_DEFINITION('','',#${pdf},#${pdctx})`),
    pds = d.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  d.add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);

  return d.body("AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }");
}

// build the STEP text for the current model and trigger a browser download
export function downloadStep(): void {
  const now = new Date(); // called from a user gesture, not module scope
  const stamp = now.toISOString().replace(/\.\d+Z$/, "");
  const text = buildStep(stamp);
  const blob = new Blob([text], { type: "application/step" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "camber-hull.step";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
