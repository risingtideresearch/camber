// ---------- the Automerge document shape for a Camber hull ----------
//
// This mirrors the `HullDocument` on-disk format produced by `src/json.ts` (increment-encoded), plus the
// editor's session fields (`waterline`, `deckRakeDeg`) and the Patchwork metadata/title. The tool round-
// trips between this structure and the editor via the same `buildJson` / `parseDocument` path the file
// import/export uses, so the document stays a faithful, inspectable `HullDocument`.

export interface PlanPoint {
  dx: number;
  y: number;
}
export interface TrimPoint {
  dx: number;
  depth: number;
}
export interface SectionPoint {
  dd: number;
  n: number;
  k: number;
}
export interface WeightPoint {
  dx: number;
  w: number[];
}
export interface Transom {
  x: number;
  depthTop: number;
  dDepthBot: number;
  transomRake: number;
}

export interface Topology {
  sheerPlan: number;
  sheerTrim: number;
  section: number;
  templateCount: number;
  weightPoints: number;
}

export interface Variant {
  name?: string;
  sheerPlan: PlanPoint[];
  sheerTrim: TrimPoint[];
  transom: Transom;
  templates: SectionPoint[][];
  keelK: number[];
  weights: WeightPoint[];
}

export interface CamberHullDoc {
  "@patchwork"?: { type: "camber-hull" };
  title: string;
  length: number;
  waterline: number;
  deckRakeDeg: number;
  topology: Topology;
  variants: Variant[];
}
