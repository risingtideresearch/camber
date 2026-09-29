import { useDocumentSnapshot, useDocumentStore } from "./documentStoreHooks";
import { DEFAULT_LOADING, type LoadingCondition } from "../core/loading";
import { scenariosOf } from "../core/sheet/scenarios";

/** One condition across Loading, Weights and Stability. The estimate remains
 * authored/undoable; selecting how to read it is shared, transient session state. */
export function useLoadingCondition() {
  const snapshot = useDocumentSnapshot();
  const store = useDocumentStore();
  const loading = snapshot.session.loading ?? DEFAULT_LOADING;
  const scenarioId = scenariosOf(snapshot.state.weights).some(
    (s) => s.id === loading.scenarioId,
  )
    ? loading.scenarioId
    : null;
  const setLoading = (patch: Partial<LoadingCondition>) =>
    store.dispatchSession({ type: "setLoading", patch });
  return { loading, scenarioId, setLoading };
}
