// ---------- hull-document JSON: the on-disk format, plus editor export / import ----------
//
// One document = one hull (no topology block, no variants wrapper — control-point counts are implied by the
// arrays). It is increment-encoded — sheer/trim points carry a forward step `dx` (point 0 holds the anchor
// x₀), section points carry a depth step `dd` (point 0 is the pinned sheer point), and the transom is
// `{x, depthTop, dDepthBot, transomRake}`. Increments are what make any convex blend valid. `length` is the
// document's unitless scale (the current model's L); coordinates are rescaled to L on import, so a legacy
// 4000-unit document still loads correctly.
//
// The importer also still reads the LEGACY shape (a `topology`/`variants` wrapper around one or more hulls)
// so older saved/exported documents keep working. The live model works in absolute coordinates, so we ENCODE
// on export and DECODE on import. This module is the single source of truth for the format — the editor and
// the interpolation viewer both go through it.

import { clamp } from "./math.js";
import {
  state,
  L,
  buildWeightSampler,
  type SheerCP,
  type TrimCP,
  type TransomCP,
  type StationCP,
  type WeightCP,
} from "./model.js";

// ---------- on-disk types ----------
interface PlanPoint {
  dx: number;
  y: number;
  w?: number[]; // unified format: the station's blend weights ride on the plan point. Absent in old docs.
}
interface TrimPoint {
  dx: number;
  depth: number;
  k: number;
}
interface SectionPoint {
  dd: number;
  n: number;
  k: number;
}
interface WeightPoint {
  dx: number;
  w: number[]; // barycentric weights over the templates; in the simplex
}
interface Transom {
  x: number;
  depthTop: number;
  dDepthBot: number;
  transomRake: number;
}

// ---------- a parsed variant in the live model's absolute coordinates ----------
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
  variants: HullData[];
}

// ---------- encode: absolute model coords → increment-encoded on-disk form ----------
const encPlan = (cp: SheerCP[]): PlanPoint[] =>
  cp.map((p, i) => ({ dx: i === 0 ? p.x : p.x - cp[i - 1].x, y: p.y, w: p.w.slice() }));
const encTrim = (trim: TrimCP[]): TrimPoint[] =>
  trim.map((p, i) => ({ dx: i === 0 ? p.x : p.x - trim[i - 1].x, depth: -p.z, k: p.k }));
const encSection = (pts: StationCP[]): SectionPoint[] =>
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
    return { x, y: p.y, w: Array.isArray(p.w) ? p.w.slice() : [] }; // w filled by migration if absent
  });
}
function decTrim(trim: TrimPoint[]): TrimCP[] {
  let x = 0;
  return trim.map((p, i) => {
    x = i === 0 ? p.dx : x + p.dx;
    return { x, z: -p.depth, k: clamp(p.k, 0, 1) };
  });
}
function decSection(pts: SectionPoint[]): StationCP[] {
  let d = 0;
  return pts.map((p, i) => {
    d = i === 0 ? 0 : d + p.dd;
    return { n: p.n, d, k: clamp(p.k, 0, 1) };
  });
}
function decWeights(pts: WeightPoint[]): WeightCP[] {
  let x = 0;
  return pts.map((p, i) => {
    x = i === 0 ? p.dx : x + p.dx;
    let s = 0;
    const w = p.w.map((v) => {
      const c = v > 0 ? v : 0;
      s += c;
      return c;
    });
    return { x, w: s > 0 ? w.map((v) => v / s) : w.map(() => 1 / w.length) };
  });
}
function decTransom(t: Transom): TransomCP[] {
  const top: TransomCP = { x: t.x, z: -t.depthTop };
  const z = -(t.depthTop + t.dDepthBot); // bottom-edge height
  return [top, { x: t.x + (z - top.z) * t.transomRake, z }];
}

// ---------- export: the current model as a single-hull document ----------
// One document = one hull. `length` is the unitless scale (the model's L) and doubles as a scale/version tag
// for the importer (legacy multi-hull documents carry a `topology`/`variants` wrapper and length 4000).
// Control-point counts are implied by the array lengths, so there is no separate topology block.
export function buildJson(): string {
  const s = state.sheer;
  const doc = {
    length: L,
    waterline: state.waterline,
    deckRakeDeg: (state.deckRake * 180) / Math.PI,
    sheerPlan: encPlan(s.cp), // each plan point carries its blend weights w
    sheerTrim: encTrim(s.trim),
    transom: encTransom(s.transom),
    templates: state.templates.map(encSection),
    keelK: state.keelK.slice(),
  };
  return JSON.stringify(doc, null, 2);
}

export function downloadJson(): void {
  const blob = new Blob([buildJson()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "camber-hull.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- import / parse ----------
// structural validators that throw a clear message rather than loading a broken model
function num(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !isFinite(v)) throw new Error(`${ctx} must be a finite number`);
  return v;
}
function obj(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${ctx} must be an object`);
  return v as Record<string, unknown>;
}
// parse a fixed-length array of point objects, applying `field` to each (already an object)
function points<T>(
  v: unknown,
  ctx: string,
  count: number,
  field: (o: Record<string, unknown>, i: number) => T,
): T[] {
  if (!Array.isArray(v)) throw new Error(`${ctx} must be an array`);
  if (v.length !== count) throw new Error(`${ctx} must have ${count} points (matching the topology)`);
  return v.map((p, i) => field(obj(p, `${ctx}[${i}]`), i));
}
// a length-K barycentric weight vector of finite numbers (validity — simplex membership — is enforced
// on decode by clamping negatives and renormalizing, exactly as a convex blend would stay in the simplex)
function weightVec(v: unknown, ctx: string, k: number): number[] {
  if (!Array.isArray(v) || v.length !== k)
    throw new Error(`${ctx} must be an array of ${k} weights (one per template)`);
  return v.map((x, i) => num(x, `${ctx}[${i}]`));
}
// project a weight vector onto the simplex (clamp float noise away, renormalize to Σ = 1)
function normW(w: number[]): number[] {
  let s = 0;
  const c = w.map((v) => {
    const x = v > 0 ? v : 0;
    s += x;
    return x;
  });
  return s > 0 ? c.map((v) => v / s) : c.map(() => 1 / c.length);
}
// the default straight blend path: full weight on template 0 at the stern, handing off to the last
// template at the bow — the multi-template analog of the old linear x/L tween (an edge of the simplex)
function linearPath(k: number, length: number): WeightCP[] {
  const e = (j: number) => Array.from({ length: k }, (_, i) => (i === j ? 1 : 0));
  return [
    { x: 0, w: e(0) },
    { x: length, w: e(k - 1) },
  ];
}

// decode one hull — a flat document, or one entry of a legacy `variants` array — to absolute model
// coordinates. Control-point counts are taken from the arrays themselves; `docLength` only places the
// default blend handoff for legacy documents that lack per-station weights.
function decodeVariant(v: Record<string, unknown>, c: string, docLength: number): HullData {
  // templates first — they fix the template count K and the shared section-point count
  const rawTpls: unknown[] =
    "templates" in v
      ? Array.isArray(v.templates) && v.templates.length >= 1
        ? v.templates
        : (() => {
            throw new Error(`${c}.templates must be a non-empty array`);
          })()
      : "aft" in v && "fore" in v
        ? [v.aft, v.fore] // legacy aft/fore pair → two templates
        : (() => {
            throw new Error(`${c} has no templates (and no legacy aft/fore pair)`);
          })();
  if (!Array.isArray(rawTpls[0])) throw new Error(`${c}.templates[0] must be an array of section points`);
  const nSec = rawTpls[0].length;
  if (nSec < 2) throw new Error(`${c} sections must have ≥ 2 points`);
  const nTpl = rawTpls.length;
  const templates: StationCP[][] = rawTpls.map((tp, ti) =>
    decSection(
      points(tp, `${c}.templates[${ti}]`, nSec, (o, i) => ({
        dd: num(o.dd, `${c}.templates[${ti}][${i}].dd`),
        n: num(o.n, `${c}.templates[${ti}][${i}].n`),
        k: typeof o.k === "number" ? o.k : 0,
      })),
    ),
  );

  // plan stations (each carries its blend weights w in the unified format)
  if (!Array.isArray(v.sheerPlan) || v.sheerPlan.length < 2)
    throw new Error(`${c}.sheerPlan must be an array of ≥ 2 points`);
  const cp = decPlan(
    points(v.sheerPlan, `${c}.sheerPlan`, v.sheerPlan.length, (o, i) => ({
      dx: num(o.dx, `${c}.sheerPlan[${i}].dx`),
      y: num(o.y, `${c}.sheerPlan[${i}].y`),
      w: Array.isArray(o.w) ? weightVec(o.w, `${c}.sheerPlan[${i}].w`, nTpl) : undefined,
    })),
  );

  if (!Array.isArray(v.sheerTrim) || v.sheerTrim.length < 2)
    throw new Error(`${c}.sheerTrim must be an array of ≥ 2 points`);
  const trim = decTrim(
    points(v.sheerTrim, `${c}.sheerTrim`, v.sheerTrim.length, (o, i) => ({
      dx: num(o.dx, `${c}.sheerTrim[${i}].dx`),
      depth: num(o.depth, `${c}.sheerTrim[${i}].depth`),
      k: typeof o.k === "number" ? o.k : 0,
    })),
  );

  // keelK: optional per-template keel knuckle; missing/short → 0 (smooth)
  const keelK = Array.from({ length: nTpl }, (_, j) =>
    Array.isArray(v.keelK) && typeof v.keelK[j] === "number" ? clamp(v.keelK[j] as number, 0, 1) : 0,
  );

  // blend weights: unified (already on each station) or MIGRATE a legacy document — a separate `weights`
  // path, or none (→ the default linear handoff) — by sampling that path at each station's x.
  if (cp.every((p) => p.w.length === nTpl)) {
    cp.forEach((p) => (p.w = normW(p.w)));
  } else {
    const oldW =
      "weights" in v && Array.isArray(v.weights)
        ? decWeights(
            points(v.weights, `${c}.weights`, v.weights.length, (o, i) => ({
              dx: num(o.dx, `${c}.weights[${i}].dx`),
              w: weightVec(o.w, `${c}.weights[${i}].w`, nTpl),
            })),
          )
        : linearPath(nTpl, docLength);
    const wf = buildWeightSampler(oldW);
    cp.forEach((p) => (p.w = wf(p.x)));
  }

  const to = obj(v.transom, `${c}.transom`);
  const transom = decTransom({
    x: num(to.x, `${c}.transom.x`),
    depthTop: num(to.depthTop, `${c}.transom.depthTop`),
    dDepthBot: num(to.dDepthBot, `${c}.transom.dDepthBot`),
    transomRake: num(to.transomRake, `${c}.transom.transomRake`),
  });

  return { name: typeof v.name === "string" ? v.name : undefined, cp, trim, transom, templates, keelK };
}

// scale a decoded hull's length-dimensioned coordinates by `s` — used to lift a legacy 4000-unit document to
// the model's current unitless length. Knuckles k and blend weights w are dimensionless and left alone.
function scaleHull(d: HullData, s: number): void {
  d.cp.forEach((p) => ((p.x *= s), (p.y *= s)));
  d.trim.forEach((p) => ((p.x *= s), (p.z *= s)));
  d.transom.forEach((p) => ((p.x *= s), (p.z *= s)));
  d.templates.forEach((tpl) => tpl.forEach((p) => ((p.n *= s), (p.d *= s))));
}

// parse + validate a hull document and decode it to absolute model coordinates. Reads the current flat
// single-hull shape AND the legacy topology/variants wrapper; counts come from the arrays. The document's
// `length` is its unitless scale — coordinates are rescaled to the model's L on import (so a legacy 4000-unit
// document loads at the current scale). Throws on any structural problem; nothing is committed until it all
// validates.
export function parseDocument(text: string): ParsedDoc {
  const doc = obj(JSON.parse(text), "document");
  const legacy = "variants" in doc; // legacy multi-hull documents wrap variants in a topology/variants block
  if (!legacy && !("sheerPlan" in doc))
    throw new Error("not a hull document (no sheerPlan, and no legacy variants)");
  const docLength =
    typeof doc.length === "number" && isFinite(doc.length) && doc.length > 0 ? doc.length : L;
  const waterline = typeof doc.waterline === "number" && isFinite(doc.waterline) ? doc.waterline : 0;
  const deckRakeDeg =
    typeof doc.deckRakeDeg === "number" && isFinite(doc.deckRakeDeg) ? doc.deckRakeDeg : 0;

  const rawList: Record<string, unknown>[] = legacy
    ? Array.isArray(doc.variants) && doc.variants.length
      ? doc.variants.map((vv, i) => obj(vv, `variants[${i}]`))
      : (() => {
          throw new Error("variants must be a non-empty array");
        })()
    : [doc];
  const variants = rawList.map((v, i) => decodeVariant(v, legacy ? `variants[${i}]` : "document", docLength));

  // normalize to the model's length (decoded coordinates are in the document's units)
  const s = L / docLength;
  if (Math.abs(s - 1) > 1e-9) variants.forEach((d) => scaleHull(d, s));

  const t0 = variants[0];
  return {
    length: L,
    waterline: waterline * s,
    deckRake: (deckRakeDeg * Math.PI) / 180,
    topology: {
      sheerPlan: t0.cp.length,
      sheerTrim: t0.trim.length,
      section: t0.templates[0].length,
      templateCount: t0.templates.length,
    },
    variants,
  };
}

// load a parsed variant into the live model
export function loadHull(v: HullData): void {
  state.sheer.cp = v.cp;
  state.sheer.trim = v.trim;
  state.sheer.transom = v.transom;
  state.templates = v.templates;
  state.keelK = v.keelK;
  state.selected = null;
  state.x0 = clamp(state.x0, 0, L);
}

// editor import: load the document's first variant; returns the document's variant count
export function loadJsonText(text: string): number {
  const parsed = parseDocument(text);
  loadHull(parsed.variants[0]);
  state.waterline = parsed.waterline;
  state.deckRake = parsed.deckRake;
  return parsed.variants.length;
}

// open a file picker, read the chosen JSON, load it, then run `after` (a re-render). Errors are
// reported to the user; the model is left as-is on failure.
export function importJson(after: () => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const n = loadJsonText(String(reader.result));
        after();
        if (n > 1)
          alert(
            `This document has ${n} variants; the editor loaded the first. ` +
              `Open the interpolation viewer to blend all ${n}.`,
          );
      } catch (e) {
        alert("JSON import failed: " + (e instanceof Error ? e.message : String(e)));
      }
    };
    reader.readAsText(file);
  });
  input.click();
}
