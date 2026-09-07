// Pure hull queries: one worker-local sweep, lazy independent results, no React or store.
import { createCamberComputation } from "../analysis/camber/compute";
import type {
  CamberQueryRequest,
  CamberQueryResponse,
} from "../analysis/camber/protocol";

const compute = createCamberComputation();
self.onmessage = (event: MessageEvent<CamberQueryRequest>) => {
  const { id, source, kind, input } = event.data;
  let response: CamberQueryResponse;
  try {
    response = { id, ...compute(source, kind, input) };
  } catch (reason) {
    response = {
      id,
      contextId: source.key,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
  self.postMessage(response);
};
