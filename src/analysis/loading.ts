/** Persisted manual condition. Standalone hosts use metres, m³ and tonnes for
 * displacement uncertainty; other hosts may keep this state local to their display units. */
export interface StabilityLoadingState {
  condition: { vol: number; kg: number } | null;
  spread: { x: LoadingTolerance; y: LoadingTolerance } | null;
  linkSheet: boolean;
}
interface LoadingTolerance {
  on: boolean;
  linked: boolean;
  lo: number;
  hi: number;
}
export const EMPTY_LOADING: StabilityLoadingState = {
  condition: null,
  spread: null,
  linkSheet: false,
};
