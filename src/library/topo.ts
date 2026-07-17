import { parseDocument } from "../core/json";
import type { DesignRow } from "../core/supabase";
import type { Unit } from "../core/document";

// A design's control-point counts (and its size): shown as stat chips on its card.
//
// These no longer GATE blending. v1 hulls were unitless against a shared `length`, so only same-length hulls
// could blend; v2 coordinates are absolute in a real unit, and promoteFamily reconciles both the unit and the
// counts — a blend of a 4 m and a 6 m hull is simply a 5 m hull.
export interface Topo {
  loa: number; // length overall, in `unit`
  unit: Unit;
  plan: number;
  trim: number;
  section: number; // points per station
  stations: number;
}

// parseDocument infers the counts from the document's arrays. Returns null if the document can't be parsed —
// the card then shows no chips.
export function topoOf(row: DesignRow): Topo | null {
  try {
    const p = parseDocument(JSON.stringify(row.document)),
      plan = p.hull.sheerPlan;
    return {
      loa: plan[plan.length - 1].x - plan[0].x,
      unit: p.hull.unit,
      plan: p.topology.sheerPlan,
      trim: p.topology.sheerTrim,
      section: p.topology.section,
      stations: p.topology.stationCount,
    };
  } catch {
    return null;
  }
}
