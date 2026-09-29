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

export interface LoadingValues {
  readonly mass: number;
  readonly vcg: number | null;
  readonly lcg: number | null;
}

export const loadingKey = (loading: LoadingCondition | undefined): string =>
  JSON.stringify(loading ?? DEFAULT_LOADING);
