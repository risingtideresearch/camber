import {
  computeLoading,
  type LoadingRequest,
  type LoadingResponse,
} from "./loadingComputation";

self.onmessage = (event: MessageEvent<LoadingRequest>) => {
  let response: LoadingResponse;
  try {
    response = { proposal: computeLoading(event.data) };
  } catch (error) {
    response = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  (self as unknown as Worker).postMessage(response);
};
