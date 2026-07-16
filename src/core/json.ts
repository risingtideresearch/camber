// ---------- hull-document JSON: encode / decode, plus editor export / import ----------
//
// The format itself — the `HullDocument` structures, the increment encoding they use, and the version tag —
// is declared in `document.ts`. This module is the crossing between it and the live model: the model works
// in absolute coordinates, so we ENCODE on export and DECODE on import. `length` is the document's unitless
// scale; coordinates are rescaled to the model's L on import, so a document authored at any length lands at
// the model's scale.
//
// Together with `document.ts` this is the single source of truth for the format — the editor and the
// interpolation viewer both go through it.

import { clamp } from "./math";
import {
  VERSION,
  isReadableVersion,
  type HullDocument,
  type PlanPoint,
  type TrimPoint,
  type SectionPoint,
  type Transom,
} from "./document";
import {
  type Model,
  L,
  normSimplex,
  type SheerCP,
  type TrimCP,
  type TransomCP,
  type StationCP,
} from "./model";

// ---------- a parsed hull in the live model's absolute coordinates ----------
export interface HullData {
  name?: string;
  cp: SheerCP[];
  trim: TrimCP[];
  transom: TransomCP[];
  templates: StationCP[][]; // K templates, index-aligned
  keelK: number[]; // per-template keel (centerline) knuckle, index-aligned with templates
  // blend weights ride on cp[i].w (the unified station)
}
export interface ParsedDoc {
  length: number;
  waterline: number; // depth below the sheer origin
  deckRake: number; // radians
  topology: {
    sheerPlan: number;
    sheerTrim: number;
    section: number;
    templateCount: number;
  };
  hull: HullData;
}

// ---------- encode: absolute model coords → increment-encoded on-disk form ----------
const encPlan = (cp: SheerCP[]): PlanPoint[] =>
  cp.map((p, i) => ({
    dx: i === 0 ? p.x : p.x - cp[i - 1].x,
    y: p.y,
    w: p.w.slice(),
  }));
const encTrim = (trim: TrimCP[]): TrimPoint[] =>
  trim.map((p, i) => ({
    dx: i === 0 ? p.x : p.x - trim[i - 1].x,
    depth: -p.z,
    k: p.k,
  }));
export const encSection = (pts: StationCP[]): SectionPoint[] =>
  pts.map((p, i) => ({ dd: i === 0 ? 0 : p.d - pts[i - 1].d, n: p.n, k: p.k }));
function encTransom(t: TransomCP[]): Transom {
  const [top, bot] = t; // [0] = top edge (near sheer), [1] = bottom edge (near keel)
  return {
    x: top.x,
    depthTop: -top.z,
    dDepthBot: top.z - bot.z, // (−bot.z) − (−top.z); the bottom is deeper, so this is > 0
    transomRake: (bot.x - top.x) / (bot.z - top.z || 1), // slope from x = x_top + (z − z_top)·rake
  };
}

// ---------- decode: increment-encoded on-disk form → absolute model coords ----------
function decPlan(plan: PlanPoint[]): SheerCP[] {
  let x = 0;
  return plan.map((p, i) => {
    x = i === 0 ? p.dx : x + p.dx;
    return { x, y: p.y, w: normSimplex(p.w) };
  });
}
function decTrim(trim: TrimPoint[]): TrimCP[] {
  let x = 0;
  return trim.map((p, i) => {
    x = i === 0 ? p.dx : x + p.dx;
    return { x, z: -p.depth, k: clamp(p.k ?? 0, 0, 1) };
  });
}
function decSection(pts: SectionPoint[]): StationCP[] {
  let d = 0;
  return pts.map((p, i) => {
    d = i === 0 ? 0 : d + p.dd;
    return { n: p.n, d, k: clamp(p.k ?? 0, 0, 1) };
  });
}
function decTransom(t: Transom): TransomCP[] {
  const top: TransomCP = { x: t.x, z: -t.depthTop };
  const z = -(t.depthTop + t.dDepthBot); // bottom-edge height
  return [top, { x: t.x + (z - top.z) * t.transomRake, z }];
}

// ---------- export: the current model as a hull document ----------
// `length` is the unitless scale (the model's L). Control-point counts are implied by the array lengths, so
// there is no separate topology block.
export function buildJson(model: Model): string {
  const s = model.sheer;
  const doc: HullDocument = {
    version: VERSION,
    length: L,
    waterline: model.waterline,
    deckRakeDeg: (model.deckRake * 180) / Math.PI,
    sheerPlan: encPlan(s.cp), // each plan point carries its blend weights w
    sheerTrim: encTrim(s.trim),
    transom: encTransom(s.transom),
    templates: model.templates.map(encSection),
    keelK: model.keelK.slice(),
  };
  return JSON.stringify(doc, null, 2);
}

// ---------- import / parse ----------
// structural validators that throw a clear message rather than loading a broken model
function num(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !isFinite(v))
    throw new Error(`${ctx} must be a finite number`);
  return v;
}
function obj(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(`${ctx} must be an object`);
  return v as Record<string, unknown>;
}
// a forward x-step: point 0 holds the anchor x₀; later points must step strictly forward (dx > 0),
// or the decoded x array is non-monotonic and no convex blend is valid
function step(v: unknown, ctx: string, i: number): number {
  const x = num(v, ctx);
  if (i > 0 && x <= 0) throw new Error(`${ctx} must be > 0`);
  return x;
}
// a depth step: point 0 is the pinned sheer point; later points must not step back up (dd ≥ 0 —
// a zero step is legitimate, e.g. the flat run of a flat-bottomed section)
function depthStep(v: unknown, ctx: string, i: number): number {
  const x = num(v, ctx);
  if (i > 0 && x < 0) throw new Error(`${ctx} must be ≥ 0`);
  return x;
}
// an optional knuckle: absent or non-finite (a corrupted document) → 0 (smooth)
const knuckle = (v: unknown): number =>
  typeof v === "number" && isFinite(v) ? v : 0;
// parse a fixed-length array of point objects, applying `field` to each (already an object)
function points<T>(
  v: unknown,
  ctx: string,
  count: number,
  field: (o: Record<string, unknown>, i: number) => T,
): T[] {
  if (!Array.isArray(v)) throw new Error(`${ctx} must be an array`);
  if (v.length !== count)
    throw new Error(`${ctx} must have ${count} points (matching the topology)`);
  return v.map((p, i) => field(obj(p, `${ctx}[${i}]`), i));
}
// a length-K barycentric weight vector of finite numbers (validity — simplex membership — is enforced
// on decode by clamping negatives and renormalizing, exactly as a convex blend would stay in the simplex)
function weightVec(v: unknown, ctx: string, k: number): number[] {
  if (!Array.isArray(v) || v.length !== k)
    throw new Error(
      `${ctx} must be an array of ${k} weights (one per template)`,
    );
  return v.map((x, i) => num(x, `${ctx}[${i}]`));
}

// decode the document's hull to absolute model coordinates. Control-point counts are taken from the arrays
// themselves: the templates fix K and the shared section-point count, the sheer arrays their own lengths.
function decodeHull(v: Record<string, unknown>): HullData {
  const c = "document"; // error-message prefix — the whole document IS the hull
  // templates first — they fix the template count K and the shared section-point count
  if (!Array.isArray(v.templates) || v.templates.length < 1)
    throw new Error(`${c}.templates must be a non-empty array`);
  const rawTpls = v.templates;
  if (!Array.isArray(rawTpls[0]))
    throw new Error(`${c}.templates[0] must be an array of section points`);
  const nSec = rawTpls[0].length;
  if (nSec < 2) throw new Error(`${c} sections must have ≥ 2 points`);
  const nTpl = rawTpls.length;
  const templates: StationCP[][] = rawTpls.map((tp, ti) =>
    decSection(
      points(tp, `${c}.templates[${ti}]`, nSec, (o, i) => ({
        dd: depthStep(o.dd, `${c}.templates[${ti}][${i}].dd`, i),
        n: num(o.n, `${c}.templates[${ti}][${i}].n`),
        k: knuckle(o.k),
      })),
    ),
  );

  // plan stations — each carries its blend weights w over the K templates
  if (!Array.isArray(v.sheerPlan) || v.sheerPlan.length < 2)
    throw new Error(`${c}.sheerPlan must be an array of ≥ 2 points`);
  const cp = decPlan(
    points(v.sheerPlan, `${c}.sheerPlan`, v.sheerPlan.length, (o, i) => ({
      dx: step(o.dx, `${c}.sheerPlan[${i}].dx`, i),
      y: num(o.y, `${c}.sheerPlan[${i}].y`),
      w: weightVec(o.w, `${c}.sheerPlan[${i}].w`, nTpl),
    })),
  );

  if (!Array.isArray(v.sheerTrim) || v.sheerTrim.length < 2)
    throw new Error(`${c}.sheerTrim must be an array of ≥ 2 points`);
  const trim = decTrim(
    points(v.sheerTrim, `${c}.sheerTrim`, v.sheerTrim.length, (o, i) => ({
      dx: step(o.dx, `${c}.sheerTrim[${i}].dx`, i),
      depth: num(o.depth, `${c}.sheerTrim[${i}].depth`),
      k: knuckle(o.k),
    })),
  );

  // keelK: optional per-template keel knuckle; missing/short/non-finite → 0 (smooth)
  const keelK = Array.from({ length: nTpl }, (_, j) =>
    Array.isArray(v.keelK) ? clamp(knuckle(v.keelK[j]), 0, 1) : 0,
  );

  const to = obj(v.transom, `${c}.transom`);
  const dDepthBot = num(to.dDepthBot, `${c}.transom.dDepthBot`);
  if (dDepthBot <= 0) throw new Error(`${c}.transom.dDepthBot must be > 0`); // the bottom edge is deeper
  const transom = decTransom({
    x: num(to.x, `${c}.transom.x`),
    depthTop: num(to.depthTop, `${c}.transom.depthTop`),
    dDepthBot,
    transomRake: num(to.transomRake, `${c}.transom.transomRake`),
  });

  return {
    name: typeof v.name === "string" ? v.name : undefined,
    cp,
    trim,
    transom,
    templates,
    keelK,
  };
}

// scale a decoded hull's length-dimensioned coordinates by `s` — used to lift a document authored at another
// scale to the model's unitless length. Knuckles k and blend weights w are dimensionless and left alone.
function scaleHull(d: HullData, s: number): void {
  d.cp.forEach((p) => ((p.x *= s), (p.y *= s)));
  d.trim.forEach((p) => ((p.x *= s), (p.z *= s)));
  d.transom.forEach((p) => ((p.x *= s), (p.z *= s)));
  d.templates.forEach((tpl) => tpl.forEach((p) => ((p.n *= s), (p.d *= s))));
}

// parse + validate a hull document and decode it to absolute model coordinates; counts come from the arrays.
// The document's `length` is its unitless scale — coordinates are rescaled to the model's L on import.
// Throws on any structural problem; nothing is committed until it all validates.
export function parseDocument(text: string): ParsedDoc {
  const doc = obj(JSON.parse(text), "document");
  // the version gate comes first: past it, nothing in the document can be trusted to mean what it says here
  if (!isReadableVersion(doc))
    throw new Error(
      `document version ${JSON.stringify(doc.version)} is not readable by this app (it reads version ${VERSION} and earlier)`,
    );
  if (!("sheerPlan" in doc))
    throw new Error("not a hull document (no sheerPlan)");
  const docLength =
    typeof doc.length === "number" && isFinite(doc.length) && doc.length > 0
      ? doc.length
      : L;
  const waterline =
    typeof doc.waterline === "number" && isFinite(doc.waterline)
      ? doc.waterline
      : 0;
  const deckRakeDeg =
    typeof doc.deckRakeDeg === "number" && isFinite(doc.deckRakeDeg)
      ? doc.deckRakeDeg
      : 0;

  const hull = decodeHull(doc);

  // normalize to the model's length (decoded coordinates are in the document's units)
  const s = L / docLength;
  if (Math.abs(s - 1) > 1e-9) scaleHull(hull, s);

  return {
    length: L,
    waterline: waterline * s,
    deckRake: (deckRakeDeg * Math.PI) / 180,
    topology: {
      sheerPlan: hull.cp.length,
      sheerTrim: hull.trim.length,
      section: hull.templates[0].length,
      templateCount: hull.templates.length,
    },
    hull,
  };
}

// load a parsed hull into the live model
export function loadHull(model: Model, v: HullData): void {
  model.sheer.cp = v.cp;
  model.sheer.trim = v.trim;
  model.sheer.transom = v.transom;
  model.templates = v.templates;
  model.keelK = v.keelK;
  model.x0 = clamp(model.x0, 0, L);
}

// editor import: load the document into the model
export function loadJsonText(model: Model, text: string): void {
  const parsed = parseDocument(text);
  loadHull(model, parsed.hull);
  model.waterline = parsed.waterline;
  model.deckRake = parsed.deckRake;
}
