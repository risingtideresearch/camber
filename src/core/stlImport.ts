// ---------- STL import: parse, axis remap, fit-to-design-space ----------
// A session-only reference mesh imported from an .stl file and shown in the 3D view alongside the designed
// hull for visual comparison. Nothing here touches the model or is ever saved — the parsed geometry plus a
// handful of display settings live in EditorApp state and are drawn by draw3d over the WebGL hull. (STL
// EXPORT of the designed hull lives in stl.ts; this is the unrelated import path.)

// Each world axis is sourced from one signed axis of the STL's own coordinate frame, so a mesh authored in a
// different up/forward convention can be brought into the hull's frame (x = length, y = breadth, z = up).
export type Axis = "X" | "-X" | "Y" | "-Y" | "Z" | "-Z";
export const AXES: Axis[] = ["X", "-X", "Y", "-Y", "Z", "-Z"];

// The raw parsed mesh in the STL file's own coordinates: a flat triangle soup (9 floats per triangle) plus
// its axis-aligned bounding box. `id` is a fresh token per parse so the renderer can cache transformed GL
// buffers and rebuild them only when a NEW file is loaded (not on every rotate).
export interface StlGeometry {
  id: number;
  positions: Float32Array; // 3 vertices × 3 coords per triangle, in file coordinates
  triangleCount: number;
  bbox: number[]; // [x0,y0,z0, x1,y1,z1]
}

export interface StlSettings {
  visible: boolean;
  axisX: Axis; // world x is taken from this signed STL axis (identity default: "X")
  axisY: Axis;
  axisZ: Axis;
  scale: number; // uniform scale applied after the axis remap
  opacity: number; // 0..1, for the semi-transparent overlay
  shaded: boolean; // draw the shaded surface
  wireframe: boolean; // draw the triangle edges
}

// everything draw3d needs to render the STL: the raw geometry, the live display settings, and the hull design
// box (captured once at import) the mesh is centered within and fit to.
export interface StlState {
  geom: StlGeometry;
  designBox: number[]; // [x0,y0,z0, x1,y1,z1] world bounds of the hull, frozen at import time
  settings: StlSettings;
}

let nextStlId = 1;

// ---------- parsing ----------

// Parse either a binary or an ASCII STL. Binary is detected by the size relation (84-byte header +
// 50 bytes/triangle, allowing trailing bytes some exporters emit) whenever the header does not begin with
// "solid"; a file that does begin with "solid" is still binary if the size relation holds exactly, since
// some binary files also begin with it.
export function parseStl(buffer: ArrayBuffer): StlGeometry {
  if (buffer.byteLength >= 84) {
    const tri = new DataView(buffer).getUint32(80, true),
      size = 84 + tri * 50;
    const solid =
      new TextDecoder().decode(new Uint8Array(buffer, 0, 5)) === "solid";
    if (size === buffer.byteLength || (size <= buffer.byteLength && !solid))
      return parseBinary(buffer, tri);
  }
  return parseAscii(new TextDecoder().decode(new Uint8Array(buffer)));
}

function parseBinary(buffer: ArrayBuffer, tri: number): StlGeometry {
  const dv = new DataView(buffer),
    positions = new Float32Array(tri * 9);
  let o = 84,
    p = 0;
  for (let i = 0; i < tri; i++) {
    o += 12; // skip the per-facet normal — we recompute normals after the axis remap
    for (let v = 0; v < 9; v++, o += 4) positions[p++] = dv.getFloat32(o, true);
    o += 2; // attribute byte count
  }
  return finish(positions);
}

function parseAscii(text: string): StlGeometry {
  const verts: number[] = [],
    re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)))
    verts.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (verts.length < 9 || verts.length % 9 !== 0)
    throw new Error("Not a valid STL file (no triangles found).");
  return finish(new Float32Array(verts));
}

function finish(positions: Float32Array): StlGeometry {
  if (positions.length < 9) throw new Error("STL file contains no triangles.");
  let x0 = Infinity,
    y0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  }
  return {
    id: nextStlId++,
    positions,
    triangleCount: positions.length / 9,
    bbox: [x0, y0, z0, x1, y1, z1],
  };
}

// ---------- axis remap ----------

// the signed source component an Axis selects from an STL vertex
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

// the [min,max] the remapped world axis spans, derived from the STL bbox (a signed axis permutation, so the
// box maps corner-to-corner without sampling vertices)
function axisRange(axis: Axis, bbox: number[]): [number, number] {
  const [x0, y0, z0, x1, y1, z1] = bbox;
  switch (axis) {
    case "X":
      return [x0, x1];
    case "-X":
      return [-x1, -x0];
    case "Y":
      return [y0, y1];
    case "-Y":
      return [-y1, -y0];
    case "Z":
      return [z0, z1];
    default:
      return [-z1, -z0]; // "-Z"
  }
}

const extent = (r: [number, number]): number => r[1] - r[0];
const boxExtent = (box: number[]): [number, number, number] => [
  box[3] - box[0],
  box[4] - box[1],
  box[5] - box[2],
];

// The scale that makes the remapped STL fit inside the design box with a 10% margin: the largest uniform
// scale whose remapped extent stays within 90% of the design box on every axis.
export function fitScale(
  geom: StlGeometry,
  axisX: Axis,
  axisY: Axis,
  axisZ: Axis,
  designBox: number[],
): number {
  const ex = [
      extent(axisRange(axisX, geom.bbox)),
      extent(axisRange(axisY, geom.bbox)),
      extent(axisRange(axisZ, geom.bbox)),
    ],
    d = boxExtent(designBox);
  let s = Infinity;
  for (let i = 0; i < 3; i++) if (ex[i] > 1e-9) s = Math.min(s, d[i] / ex[i]);
  return (Number.isFinite(s) ? s : 1) * 0.9;
}

// The default display settings for a freshly imported mesh: identity axes, fit-to-box scale, a translucent
// shaded surface, shown immediately so the user sees it land in the design space.
export function defaultStlSettings(
  geom: StlGeometry,
  designBox: number[],
): StlSettings {
  return {
    visible: true,
    axisX: "X",
    axisY: "Y",
    axisZ: "Z",
    scale: fitScale(geom, "X", "Y", "Z", designBox),
    opacity: 0.5,
    shaded: true,
    wireframe: false,
  };
}

// ---------- world transform (axis remap + scale + center) ----------

export interface StlWorldMesh {
  pos: Float32Array; // triangle soup, world coordinates
  nrm: Float32Array; // per-triangle (flat) normals, one per vertex
  lines: Float32Array; // triangle edges as GL_LINES pairs (6 verts per triangle)
}

// Remap the STL into the hull's coordinate frame: apply the signed axis mapping and uniform scale, then
// translate so the mesh's bounding box is centered on the design box (there is no separate position control,
// so centering keeps it overlapping the hull for comparison at any scale). Normals are recomputed flat from
// the transformed triangles — the shader is two-sided, so winding / handedness is irrelevant.
export function transformStl(state: StlState): StlWorldMesh {
  const { geom, settings, designBox } = state,
    { axisX, axisY, axisZ, scale } = settings,
    src = geom.positions,
    n = src.length,
    pos = new Float32Array(n);
  // translation that lands the scaled+remapped bbox center on the design box center
  const mid = (r: [number, number]): number => (r[0] + r[1]) / 2;
  const tx =
      (designBox[0] + designBox[3]) / 2 -
      scale * mid(axisRange(axisX, geom.bbox)),
    ty =
      (designBox[1] + designBox[4]) / 2 -
      scale * mid(axisRange(axisY, geom.bbox)),
    tz =
      (designBox[2] + designBox[5]) / 2 -
      scale * mid(axisRange(axisZ, geom.bbox));
  for (let i = 0; i < n; i += 3) {
    const x = src[i],
      y = src[i + 1],
      z = src[i + 2];
    pos[i] = scale * pick(axisX, x, y, z) + tx;
    pos[i + 1] = scale * pick(axisY, x, y, z) + ty;
    pos[i + 2] = scale * pick(axisZ, x, y, z) + tz;
  }
  const nrm = new Float32Array(n),
    lines = new Float32Array((n / 9) * 18); // 3 edges × 2 verts × 3 coords per triangle
  let li = 0;
  for (let t = 0; t < n; t += 9) {
    const ax = pos[t],
      ay = pos[t + 1],
      az = pos[t + 2];
    // face normal = (b-a) × (c-a), normalized (magnitude irrelevant: the shader normalizes)
    const ux = pos[t + 3] - ax,
      uy = pos[t + 4] - ay,
      uz = pos[t + 5] - az,
      vx = pos[t + 6] - ax,
      vy = pos[t + 7] - ay,
      vz = pos[t + 8] - az;
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (let v = 0; v < 9; v += 3) {
      nrm[t + v] = nx;
      nrm[t + v + 1] = ny;
      nrm[t + v + 2] = nz;
    }
    // three edges a-b, b-c, c-a
    const edge = (p: number, q: number): void => {
      lines[li++] = pos[p];
      lines[li++] = pos[p + 1];
      lines[li++] = pos[p + 2];
      lines[li++] = pos[q];
      lines[li++] = pos[q + 1];
      lines[li++] = pos[q + 2];
    };
    edge(t, t + 3);
    edge(t + 3, t + 6);
    edge(t + 6, t);
  }
  return { pos, nrm, lines };
}
