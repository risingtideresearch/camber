import { UNIT_MM, type Unit } from "./document";

/** A pure length conversion, independent of hull parsing. */
export const unitScale = (from: Unit, to: Unit): number =>
  UNIT_MM[from] / UNIT_MM[to];
