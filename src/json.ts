// ---------- HullDocument JSON: the on-disk format, plus editor export / import ----------
//
// The on-disk shape is the `HullDocument` from the data model (see README): one `topology`
// (control-point counts), one shared `length`, and one or more `variants`. Each variant is
// increment-encoded — sheer/trim points carry a forward step `dx` (point 0 holds the anchor x₀),
// section points carry a depth step `dd` (point 0 is the pinned sheer point), and the transom is
// `{x, depthTop, dDepthBot, transomRake}`. Increments are what make any convex blend valid.
//
// The live model works in absolute coordinates, so we ENCODE on export and DECODE on import. This
// module is the single source of truth for the format — the editor and the interpolation viewer
// both go through it.

import { clamp } from "./math.js";
import {
  state,
  L,
  type SheerCP,
  type TrimCP,
  type TransomCP,
  type StationCP,
} from "./model.js";

// ---------- on-disk types ----------
interface PlanPoint {
  dx: number;
  y: number;
}
interface TrimPoint {
  dx: number;
  depth: number;
}
interface SectionPoint {
  dd: number;
  n: number;
  k: number;
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
  aft: StationCP[];
  fore: StationCP[];
}
export interface ParsedDoc {
  length: number;
  waterline: number; // depth below the sheer origin
  deckRake: number; // radians
  topology: { sheerPlan: number; sheerTrim: number; section: number };
  variants: HullData[];
}

// ---------- encode: absolute model coords → increment-encoded on-disk form ----------
const encPlan = (cp: SheerCP[]): PlanPoint[] =>
  cp.map((p, i) => ({ dx: i === 0 ? p.x : p.x - cp[i - 1].x, y: p.y }));
const encTrim = (trim: TrimCP[]): TrimPoint[] =>
  trim.map((p, i) => ({ dx: i === 0 ? p.x : p.x - trim[i - 1].x, depth: -p.z }));
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
    return { x, y: p.y };
  });
}
function decTrim(trim: TrimPoint[]): TrimCP[] {
  let x = 0;
  return trim.map((p, i) => {
    x = i === 0 ? p.dx : x + p.dx;
    return { x, z: -p.depth };
  });
}
function decSection(pts: SectionPoint[]): StationCP[] {
  let d = 0;
  return pts.map((p, i) => {
    d = i === 0 ? 0 : d + p.dd;
    return { n: p.n, d, k: clamp(p.k, 0, 1) };
  });
}
function decTransom(t: Transom): TransomCP[] {
  const top: TransomCP = { x: t.x, z: -t.depthTop };
  const z = -(t.depthTop + t.dDepthBot); // bottom-edge height
  return [top, { x: t.x + (z - top.z) * t.transomRake, z }];
}

// ---------- export: the current model as a single-variant HullDocument ----------
export function buildJson(): string {
  const s = state.sheer;
  const doc = {
    length: L,
    waterline: state.waterline,
    deckRakeDeg: (state.deckRake * 180) / Math.PI,
    topology: {
      sheerPlan: s.cp.length,
      sheerTrim: s.trim.length,
      section: state.AFT.length,
    },
    variants: [
      {
        sheerPlan: encPlan(s.cp),
        sheerTrim: encTrim(s.trim),
        transom: encTransom(s.transom),
        aft: encSection(state.AFT),
        fore: encSection(state.FORE),
      },
    ],
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
function intCount(v: unknown, ctx: string, min: number): number {
  const n = num(v, ctx);
  if (!Number.isInteger(n) || n < min) throw new Error(`${ctx} must be an integer ≥ ${min}`);
  return n;
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

// parse + validate a HullDocument and decode every variant to absolute model coordinates. Throws on
// any structural problem; nothing is committed until the whole document validates.
export function parseDocument(text: string): ParsedDoc {
  const doc = obj(JSON.parse(text), "document");
  if (!("topology" in doc) || !("variants" in doc))
    throw new Error("not a HullDocument (missing topology and/or variants)");
  const length = num(doc.length, "length");
  // waterline + deck rake are optional (older documents predate them); default to 0 = WL at the deck, no rake
  const waterline = typeof doc.waterline === "number" && isFinite(doc.waterline) ? doc.waterline : 0;
  const deckRakeDeg =
    typeof doc.deckRakeDeg === "number" && isFinite(doc.deckRakeDeg) ? doc.deckRakeDeg : 0;
  const t = obj(doc.topology, "topology");
  const nPlan = intCount(t.sheerPlan, "topology.sheerPlan", 2);
  const nTrim = intCount(t.sheerTrim, "topology.sheerTrim", 2);
  const nSec = intCount(t.section, "topology.section", 2);

  if (!Array.isArray(doc.variants) || doc.variants.length < 1)
    throw new Error("variants must be a non-empty array");

  const variants: HullData[] = doc.variants.map((vv, vi) => {
    const v = obj(vv, `variants[${vi}]`);
    const c = `variants[${vi}]`;
    const cp = decPlan(
      points(v.sheerPlan, `${c}.sheerPlan`, nPlan, (o, i) => ({
        dx: num(o.dx, `${c}.sheerPlan[${i}].dx`),
        y: num(o.y, `${c}.sheerPlan[${i}].y`),
      })),
    );
    const trim = decTrim(
      points(v.sheerTrim, `${c}.sheerTrim`, nTrim, (o, i) => ({
        dx: num(o.dx, `${c}.sheerTrim[${i}].dx`),
        depth: num(o.depth, `${c}.sheerTrim[${i}].depth`),
      })),
    );
    const section = (key: "aft" | "fore") =>
      decSection(
        points(v[key], `${c}.${key}`, nSec, (o, i) => ({
          dd: num(o.dd, `${c}.${key}[${i}].dd`),
          n: num(o.n, `${c}.${key}[${i}].n`),
          k: typeof o.k === "number" ? o.k : 0, // k optional, defaults to 0 (smooth)
        })),
      );
    const to = obj(v.transom, `${c}.transom`);
    const transom = decTransom({
      x: num(to.x, `${c}.transom.x`),
      depthTop: num(to.depthTop, `${c}.transom.depthTop`),
      dDepthBot: num(to.dDepthBot, `${c}.transom.dDepthBot`),
      transomRake: num(to.transomRake, `${c}.transom.transomRake`),
    });
    return {
      name: typeof v.name === "string" ? v.name : undefined,
      cp,
      trim,
      transom,
      aft: section("aft"),
      fore: section("fore"),
    };
  });

  return {
    length,
    waterline,
    deckRake: (deckRakeDeg * Math.PI) / 180,
    topology: { sheerPlan: nPlan, sheerTrim: nTrim, section: nSec },
    variants,
  };
}

// load a parsed variant into the live model
export function loadHull(v: HullData): void {
  state.sheer.cp = v.cp;
  state.sheer.trim = v.trim;
  state.sheer.transom = v.transom;
  state.AFT = v.aft;
  state.FORE = v.fore;
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
