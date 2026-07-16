// ---------- the on-disk hull-document format ----------
//
// One document = one hull
//
// It is increment-encoded — sheer/trim points carry a forward step `dx` (point
// 0 holds the anchor x₀), section points carry a depth step `dd` (point 0 is
// the pinned sheer point), and the transom is `{x, depthTop, dDepthBot,
// transomRake}`. Increments are what make any convex blend valid. `length` is
// the document's unitless scale (the current model's L).
//
// This module is the format's declaration only: the types, the version tag, and
// the version test. The encode / decode between these structures and the live
// model's absolute coordinates lives in `json.ts`.

// The format version this build writes, and the newest it can read. Bump it when a change to the structures
// below is not readable by an older build; documents that declare a higher version are ones this build must
// refuse rather than misread.
export const VERSION = 1;

// Lengths are in the document's own `length` units; `k` and `keelK` are optional on read and default to 0
// (smooth).
export interface PlanPoint {
  dx: number; // forward step from the previous station; point 0 holds the anchor x₀
  y: number;
  w: number[]; // the station's blend weights over the templates: barycentric, length K, in the simplex
}
export interface TrimPoint {
  dx: number;
  depth: number; // below the deck datum (z = −depth)
  k?: number;
}
export interface SectionPoint {
  dd: number; // depth step from the previous point; point 0 is the pinned sheer point
  n: number;
  k?: number;
}
export interface Transom {
  x: number;
  depthTop: number;
  dDepthBot: number; // top-to-bottom depth step; > 0, the bottom edge is deeper
  transomRake: number; // run-over-rise dx/dz; 0 is upright
}
export interface HullDocument {
  version?: number; // format version; absent means 1 — the original format predates the tag
  name?: string;
  length: number; // the document's unitless scale
  waterline?: number; // depth below the sheer origin
  deckRakeDeg?: number;
  sheerPlan: PlanPoint[]; // ≥ 2 stations; each carries its blend weights
  sheerTrim: TrimPoint[]; // ≥ 2 points
  transom: Transom;
  templates: SectionPoint[][]; // K ≥ 1 templates, index-aligned, all of the same length S ≥ 2
  keelK?: number[]; // length K; per-template keel knuckle
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
