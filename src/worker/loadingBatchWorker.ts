import {
  computeLoadingBatch,
  type LoadingBatchRequest,
} from "./loadingComputation";

self.onmessage = (event: MessageEvent<LoadingBatchRequest>) => {
  computeLoadingBatch(event.data, (response) => {
    (self as unknown as Worker).postMessage(response);
  });
};
