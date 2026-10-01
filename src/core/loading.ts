// A loading condition is shared session state, not another weight estimate. SI units
// keep manual inputs invariant when the hull's drawing unit changes.
export interface LoadingCondition {
  readonly source: "sheet" | "manual";
  readonly scenarioId: string | null;
  readonly mass: number | null; // kg
  readonly vcg: number | null; // metres above the current keel baseline
  readonly lcg: number | null; // metres along the hull from the transom reference
}

export const DEFAULT_LOADING: LoadingCondition = {
  source: "sheet",
  scenarioId: null,
  mass: null,
  vcg: null,
  lcg: null,
};

/** Whether the estimate follows the solved attitude or remains frozen at the start. */
export type LoadingPurpose = "balance-design" | "compare-scenarios";

/** null frees an angle; a number holds it at that angle, in radians. */
export interface LoadingConstraints {
  readonly trim: number | null;
  readonly heel: number | null;
}

export interface LoadingValues {
  readonly mass: number;
  /** Metres from centreline, starboard positive. Absent on older estimates. */
  readonly tcg?: number | null;
  readonly vcg: number | null;
  readonly lcg: number | null;
}

export const loadingKey = (loading: LoadingCondition | undefined): string =>
  JSON.stringify(loading ?? DEFAULT_LOADING);
