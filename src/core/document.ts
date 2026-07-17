// ---------- the on-disk hull-document format ----------
//
// One document = one hull.
//
// Coordinates are ABSOLUTE and in the document's own `unit` — what you read is what you get, with no
// increment encoding and no unitless scale to divide out. (Version 1 was increment-encoded against a
// unitless `length`; see `src/legacy/v1` for that format and the conversion out of it.)
//
// The coordinate frame: x runs aft → forward, y is the half-breadth off the centerline, z is up with the
// deck datum at z = 0 (so the hull lives at z ≤ 0). A station's points are given in the frame the sheer
// plan sweeps: `n` is the inboard offset along the plan curve's normal, and `z` is simply world z.
//
// This module is the format's declaration only: the types, the version tag, and the version test. The
// encode / decode between these structures and the live model lives in `json.ts`.

// The format version this build writes, and the newest it can read. Bump it when a change to the structures
// below is not readable by an older build; documents that declare a higher version are ones this build must
// refuse rather than misread.
export const VERSION = 2;

// The document's length unit. Every coordinate below is a number of these.
export type Unit = "mm" | "cm" | "m" | "in" | "ft";

export const UNITS: Unit[] = ["mm", "cm", "m", "in", "ft"];

// millimetres per unit — the common ground any two documents can be compared in
export const UNIT_MM: Record<Unit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

// A control point of the sheer plan: the hull's outline seen from above. These are the control polygon of a
// clamped cubic B-spline, NOT points on the curve — the curve interpolates only the first and last, and is
// pulled toward the interior ones. x must strictly increase, which is what makes the curve's own parameter
// u ∈ [0,1] a well-defined position along the hull.
export interface PlanPoint {
  x: number;
  y: number;
}

// A control point of the sheer trim: the real sheer line in profile, at or below the deck datum (z ≤ 0).
// The strip of swept surface above it is cut away. Interpolated (centripetal Catmull-Rom), so the curve
// passes through these exactly; k creases it.
export interface TrimPoint {
  x: number;
  z: number;
  k: number;
}

// A point of a station's section curve, in the station's swept frame.
export interface StationPoint {
  z: number;
  n: number; // along the normal of the sheer plan
  k?: number;
}

// A station: one authored section, positioned at u along the sheer plan. Sections between stations are
// lofted from these — point i of every station is one longitudinal curve — which is why all stations must
// carry the same number of points.
export interface Station {
  u: number; // [0, 1] parameter space along the sheer plan
  keelK: number; // Keel knuckle at this station
  points: StationPoint[]; // all stations have the same number of points S ≥ 2
}

// The transom: a raked plane at the stern given by two profile points, top and bottom. The hull keeps the
// forward side; the cut is a solid face.
export interface TransomPoint {
  x: number;
  z: number;
}

export interface HullDocument {
  version?: number; // format version; absent means 1
  name: string;
  unit: Unit;
  waterline: number;
  deckRakeDeg: number;
  sheerPlan: PlanPoint[]; // ≥ 2 points
  sheerTrim: TrimPoint[]; // ≥ 2 points
  transom: TransomPoint[]; // = 2 points
  stations: Station[]; // K ≥ 1 stations
}

// The version a document declares, read without parsing the rest of it (the version test has to work on a
// document this build may not understand). An absent tag is version 1 — the format's first release predates
// the tag, so untagged documents are version 1 forever, whatever VERSION becomes. A present-but-non-numeric
// tag is not a version at all: it reads as NaN, which fails every comparison below rather than passing as 1.
export function documentVersion(doc: unknown): number {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return NaN;
  const v = (doc as { version?: unknown }).version;
  if (v === undefined) return 1;
  return typeof v === "number" && isFinite(v) ? v : NaN;
}

// Can this build read the document? A newer format may reorganize anything, so a version > VERSION document
// tells us nothing we can trust — not even the fields whose names this build recognizes. Such a document is
// not shown in the library and is refused on import, rather than parsed into a plausible-looking wrong hull.
export const isReadableVersion = (doc: unknown): boolean =>
  documentVersion(doc) <= VERSION;
