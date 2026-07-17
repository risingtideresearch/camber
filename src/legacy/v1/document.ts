// ---------- the version 1 hull-document format (read-only) ----------
//
// This is the ORIGINAL on-disk format, preserved exactly as it shipped. Nothing writes it any more: the app
// reads a v1 document, converts it to the current format (`convertV1ToV2`, alongside), and from then on the
// hull is a v2 hull. It lives here, apart from the live format in `src/core/document.ts`, so that the
// conversion has something stable to read and the current format is free to move.
//
// Two things about v1 shape the conversion (see `convert.ts` for what becomes of them):
//
//   • It is INCREMENT-encoded. Sheer/trim points carry a forward step `dx` (point 0 holds the anchor x₀),
//     section points carry a depth step `dd` (point 0 is the pinned sheer point), and the transom is
//     {x, depthTop, dDepthBot, transomRake}. Increments are what made any convex blend valid.
//
//   • Sections are TEMPLATES blended along the hull, not stations placed on it. Each plan station carries a
//     barycentric weight vector w over the templates, and the section at any x is Σⱼ w[j]·templates[j] —
//     so a template has no position of its own, only a weight curve. v2 has no such blend: a station sits
//     at a definite u along the plan.
//
// `length` is the document's unitless scale (the v1 model's L); v2 coordinates are absolute in a real unit.

// The version 1 format tag. A v1 document may also carry no `version` field at all — the first release
// predates the tag — which is why `documentVersion` reads an absent tag as 1.
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
