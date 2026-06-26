// ---------- granular reconciliation of the editor's hull into the Automerge document ----------
//
// The editor re-serializes its whole single-variant `HullDocument` on every edit, but writing that
// wholesale into the document would make every change a full-document replacement: concurrent edits would
// clobber each other and the CRDT could never merge them. Instead, this module walks the serialized hull
// against the live document and assigns only the individual leaves that actually differ. Each control-
// point field (`dx`, `dd`, `n`, `k`, a weight component, …) becomes its own Automerge value, so two peers
// editing different points — or different variants — merge cleanly.
//
// The document keeps the increment-encoded form from the data model (so any convex blend of its variants
// stays valid by construction — the property the "author N hulls, find the optimal blend" workflow relies
// on). The editor edits one variant (`editIndex`); the others are never touched here.

import type {
  CamberHullDoc,
  PlanPoint,
  SectionPoint,
  Topology,
  TrimPoint,
  Transom,
  Variant,
  WeightPoint,
} from "./types.js";

// The fields a serialized single-variant hull carries (the shape of `JSON.parse(buildJson())`).
export interface HullFields {
  length: number;
  waterline: number;
  deckRakeDeg: number;
  topology: Topology;
  variants: [Variant];
}

// deep clone of plain hull data (used when a slot doesn't exist in the doc yet)
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function setLeaf<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  if (target[key] !== value) target[key] = value;
}

// reconcile an object with a fixed set of scalar fields (a point, the transom, the topology)
function reconcileScalars<T extends object>(target: T, src: T): void {
  for (const key of Object.keys(src) as (keyof T)[]) {
    if (target[key] !== src[key]) target[key] = src[key];
  }
}

function reconcileNumbers(target: number[], src: number[]): void {
  if (target.length > src.length) target.splice(src.length, target.length - src.length);
  for (let i = 0; i < src.length; i++) {
    if (i >= target.length) target.push(src[i]);
    else if (target[i] !== src[i]) target[i] = src[i];
  }
}

// reconcile an array of point objects, growing/shrinking to match and assigning changed fields in place
function reconcilePoints<T extends object>(target: T[], src: T[]): void {
  if (target.length > src.length) target.splice(src.length, target.length - src.length);
  for (let i = 0; i < src.length; i++) {
    if (i >= target.length) target.push(clone(src[i]));
    else reconcileScalars(target[i], src[i]);
  }
}

function reconcileWeights(target: WeightPoint[], src: WeightPoint[]): void {
  if (target.length > src.length) target.splice(src.length, target.length - src.length);
  for (let i = 0; i < src.length; i++) {
    if (i >= target.length) {
      target.push(clone(src[i]));
    } else {
      if (target[i].dx !== src[i].dx) target[i].dx = src[i].dx;
      reconcileNumbers(target[i].w, src[i].w);
    }
  }
}

function reconcileTemplates(target: SectionPoint[][], src: SectionPoint[][]): void {
  if (target.length > src.length) target.splice(src.length, target.length - src.length);
  for (let i = 0; i < src.length; i++) {
    if (i >= target.length) target.push(clone(src[i]));
    else reconcilePoints(target[i], src[i]);
  }
}

function reconcileVariant(target: Variant, src: Variant): void {
  reconcilePoints<PlanPoint>(target.sheerPlan, src.sheerPlan);
  reconcilePoints<TrimPoint>(target.sheerTrim, src.sheerTrim);
  reconcileScalars<Transom>(target.transom, src.transom);
  reconcileTemplates(target.templates, src.templates);
  reconcileNumbers(target.keelK, src.keelK);
  reconcileWeights(target.weights, src.weights);
}

// True when the document already has the structure to reconcile against the editor's variant.
export function isStructured(doc: CamberHullDoc, editIndex: number): boolean {
  return (
    !!doc.topology &&
    Array.isArray(doc.variants) &&
    !!doc.variants[editIndex] &&
    Array.isArray(doc.variants[editIndex].sheerPlan)
  );
}

// Establish the full structure on a document that has none yet (a freshly created / bare doc), leaving any
// other existing variants in place.
export function seedDoc(doc: CamberHullDoc, src: HullFields, editIndex: number): void {
  doc.length = src.length;
  doc.waterline = src.waterline;
  doc.deckRakeDeg = src.deckRakeDeg;
  doc.topology = clone(src.topology);
  if (!Array.isArray(doc.variants)) doc.variants = [];
  doc.variants[editIndex] = clone(src.variants[0]);
}

// Assign only the changed leaves of the editor's variant (and the shared scalars/topology) into the
// document. The document and `src` are both increment-encoded single-variant hulls.
export function reconcileDoc(doc: CamberHullDoc, src: HullFields, editIndex: number): void {
  if (!isStructured(doc, editIndex)) {
    seedDoc(doc, src, editIndex);
    return;
  }
  setLeaf(doc, "length", src.length);
  setLeaf(doc, "waterline", src.waterline);
  setLeaf(doc, "deckRakeDeg", src.deckRakeDeg);
  reconcileScalars(doc.topology, src.topology);
  reconcileVariant(doc.variants[editIndex], src.variants[0]);
}
