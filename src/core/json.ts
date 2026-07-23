// ---------- hull-document JSON: encode / decode, plus editor export / import ----------
//
// The format itself — the `HullDocument` structures and the version tag — is declared in `document.ts`. This
// module is the crossing between it and the live model. Version 2 stores absolute coordinates in a real
// unit, which is what the model works in too, so the crossing is now mostly validation rather than
// arithmetic: nothing is rescaled and nothing is un-incremented.
//
// A version 1 document is CONVERTED on the way in (`src/legacy/v1`) and is a v2 hull from that moment on.
// Nothing downstream of `parseDocument` knows v1 exists.
//
// Together with `document.ts` this is the single source of truth for the format — the editor and the
// interpolation viewer both go through it.

import { clamp } from "./math";
import {
  VERSION,
  UNIT_MM,
  UNITS,
  documentVersion,
  isReadableVersion,
  type HullDocument,
  type Unit,
} from "./document";
import { convertV1ToV2 } from "../legacy/v1/convert";
import type { HullDocument as V1Doc } from "../legacy/v1/document";
import {
  captureViewLength,
  type Model,
  type PlanCP,
  type TrimCP,
  type TransomCP,
  type StationCP,
} from "./model";

// ---------- a parsed hull in the model's coordinates ----------
export interface HullData {
  name: string;
  unit: Unit;
  sheerPlan: PlanCP[];
  sheerTrim: TrimCP[];
  transom: TransomCP[];
  stations: StationCP[];
}
export interface ParsedDoc {
  waterline: number;
  deckRake: number; // radians
  topology: {
    sheerPlan: number;
    sheerTrim: number;
    section: number; // points per station
    stationCount: number;
  };
  hull: HullData;
}

// ---------- export ----------
export function buildJson(model: Model): string {
  const doc: HullDocument = {
    version: VERSION,
    name: model.name,
    unit: model.unit,
    waterline: model.waterline,
    deckRakeDeg: (model.deckRake * 180) / Math.PI,
    sheerPlan: model.sheerPlan.map((p) => ({ x: p.x, y: p.y })),
    sheerTrim: model.sheerTrim.map((p) => ({ x: p.x, z: p.z, k: p.k })),
    transom: model.transom.map((p) => ({ x: p.x, z: p.z })),
    stations: model.stations.map((s) => ({
      u: s.u,
      keelK: s.keelK,
      points: s.points.map((p) => ({ z: p.z, n: p.n, k: p.k })),
    })),
  };
  return JSON.stringify(doc, null, 2);
}

// ---------- structural validators ----------
// These throw a clear message rather than loading a broken model; nothing is committed until it all passes.
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
function arr(v: unknown, ctx: string, min: number): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${ctx} must be an array`);
  if (v.length < min)
    throw new Error(`${ctx} must have at least ${min} entries`);
  return v;
}
// an optional knuckle: absent or non-finite (a corrupted document) → 0 (smooth)
const knuckle = (v: unknown): number =>
  typeof v === "number" && isFinite(v) ? clamp(v, 0, 1) : 0;

function unitOf(v: unknown, ctx: string): Unit {
  if (typeof v !== "string" || !UNITS.includes(v as Unit))
    throw new Error(`${ctx} must be one of ${UNITS.join(", ")}`);
  return v as Unit;
}

// ---------- decode ----------
function decodeHull(v: Record<string, unknown>): HullData {
  const c = "document"; // error-message prefix — the whole document IS the hull

  // the plan: a B-spline control polygon. x must strictly increase — that is what makes the curve's own
  // parameter u a monotone position along the hull, which every station's `u` is stated in.
  const rawPlan = arr(v.sheerPlan, `${c}.sheerPlan`, 2);
  const sheerPlan: PlanCP[] = rawPlan.map((p, i) => {
    const o = obj(p, `${c}.sheerPlan[${i}]`);
    return {
      x: num(o.x, `${c}.sheerPlan[${i}].x`),
      y: num(o.y, `${c}.sheerPlan[${i}].y`),
    };
  });
  for (let i = 1; i < sheerPlan.length; i++)
    if (sheerPlan[i].x <= sheerPlan[i - 1].x)
      throw new Error(
        `${c}.sheerPlan[${i}].x must be > the previous point's x`,
      );

  const rawTrim = arr(v.sheerTrim, `${c}.sheerTrim`, 2);
  const sheerTrim: TrimCP[] = rawTrim.map((p, i) => {
    const o = obj(p, `${c}.sheerTrim[${i}]`);
    return {
      x: num(o.x, `${c}.sheerTrim[${i}].x`),
      z: num(o.z, `${c}.sheerTrim[${i}].z`),
      k: knuckle(o.k),
    };
  });
  for (let i = 1; i < sheerTrim.length; i++)
    if (sheerTrim[i].x <= sheerTrim[i - 1].x)
      throw new Error(
        `${c}.sheerTrim[${i}].x must be > the previous point's x`,
      );

  const rawTr = arr(v.transom, `${c}.transom`, 2);
  if (rawTr.length !== 2)
    throw new Error(`${c}.transom must have exactly 2 points (top and bottom)`);
  const transom: TransomCP[] = rawTr.map((p, i) => {
    const o = obj(p, `${c}.transom[${i}]`);
    return {
      x: num(o.x, `${c}.transom[${i}].x`),
      z: num(o.z, `${c}.transom[${i}].z`),
    };
  });
  if (transom[1].z >= transom[0].z)
    throw new Error(`${c}.transom[1] (the bottom) must be below transom[0]`);

  // stations: index-aligned, so they fix one shared point count S. They must also be ordered and distinct
  // in u — the loft interpolates across them and cannot have two sections in the same place.
  const rawSts = arr(v.stations, `${c}.stations`, 1);
  const first = obj(rawSts[0], `${c}.stations[0]`);
  const nSec = arr(first.points, `${c}.stations[0].points`, 2).length;
  const stations: StationCP[] = rawSts.map((s, j) => {
    const o = obj(s, `${c}.stations[${j}]`),
      pts = arr(o.points, `${c}.stations[${j}].points`, 2);
    if (pts.length !== nSec)
      throw new Error(
        `${c}.stations[${j}].points must have ${nSec} points (every station shares one count)`,
      );
    return {
      u: clamp(num(o.u, `${c}.stations[${j}].u`), 0, 1),
      keelK: knuckle(o.keelK),
      points: pts.map((p, i) => {
        const q = obj(p, `${c}.stations[${j}].points[${i}]`);
        return {
          n: num(q.n, `${c}.stations[${j}].points[${i}].n`),
          z: num(q.z, `${c}.stations[${j}].points[${i}].z`),
          k: knuckle(q.k),
        };
      }),
    };
  });
  stations.sort((a, b) => a.u - b.u);
  for (let j = 1; j < stations.length; j++)
    if (stations[j].u <= stations[j - 1].u)
      throw new Error(
        `${c}.stations: two stations share the same u (${stations[j].u})`,
      );

  return {
    name: typeof v.name === "string" ? v.name : "",
    unit: unitOf(v.unit, `${c}.unit`),
    sheerPlan,
    sheerTrim,
    transom,
    stations,
  };
}

// ---------- unit conversion ----------
// Rescale a hull's length-dimensioned coordinates into `to`. Knuckles, u and keelK are dimensionless and
// left alone. Used when hulls authored in different units have to be compared or blended.
export function convertUnits(d: HullData, to: Unit): void {
  if (d.unit === to) return;
  const s = UNIT_MM[d.unit] / UNIT_MM[to];
  d.sheerPlan.forEach((p) => ((p.x *= s), (p.y *= s)));
  d.sheerTrim.forEach((p) => ((p.x *= s), (p.z *= s)));
  d.transom.forEach((p) => ((p.x *= s), (p.z *= s)));
  d.stations.forEach((st) =>
    st.points.forEach((p) => ((p.n *= s), (p.z *= s))),
  );
  d.unit = to;
}

export const unitScale = (from: Unit, to: Unit): number =>
  UNIT_MM[from] / UNIT_MM[to];

// ---------- import / parse ----------
// Parse + validate a hull document. A v1 document is converted first, so everything below this line — and
// everything downstream — only ever sees v2.
export function parseDocument(text: string): ParsedDoc {
  const raw = obj(JSON.parse(text), "document");
  // the version gate comes first: past it, nothing in the document can be trusted to mean what it says here
  if (!isReadableVersion(raw))
    throw new Error(
      `document version ${JSON.stringify(raw.version)} is not readable by this app (it reads version ${VERSION} and earlier)`,
    );
  if (!("sheerPlan" in raw))
    throw new Error("not a hull document (no sheerPlan)");

  const doc =
    documentVersion(raw) < 2
      ? (convertV1ToV2(raw as unknown as V1Doc) as unknown as Record<
          string,
          unknown
        >)
      : raw;

  const waterline =
    typeof doc.waterline === "number" && isFinite(doc.waterline)
      ? doc.waterline
      : 0;
  const deckRakeDeg =
    typeof doc.deckRakeDeg === "number" && isFinite(doc.deckRakeDeg)
      ? doc.deckRakeDeg
      : 0;
  const hull = decodeHull(doc);

  return {
    waterline,
    deckRake: (deckRakeDeg * Math.PI) / 180,
    topology: {
      sheerPlan: hull.sheerPlan.length,
      sheerTrim: hull.sheerTrim.length,
      section: hull.stations[0].points.length,
      stationCount: hull.stations.length,
    },
    hull,
  };
}

// load a parsed hull into the live model
export function loadHull(model: Model, v: HullData): void {
  model.name = v.name;
  model.unit = v.unit;
  model.sheerPlan = v.sheerPlan;
  model.sheerTrim = v.sheerTrim;
  model.transom = v.transom;
  model.stations = v.stations;
  model.x0 = clamp(model.x0, 0, v.sheerPlan[v.sheerPlan.length - 1].x);
  captureViewLength(model); // this hull, not the one it replaced, is what the 2D views are laid out for
}

// editor import: load the document into the model
export function loadJsonText(model: Model, text: string): void {
  const parsed = parseDocument(text);
  loadHull(model, parsed.hull);
  model.waterline = parsed.waterline;
  model.deckRake = parsed.deckRake;
}
