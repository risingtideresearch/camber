import { assemble } from "../core/runtime";
import { createWeightGeometryProcessor } from "./weightGeometryComputation";
import type {
  WeightGeometryHull,
  WeightGeometryRequest,
  WeightGeometryResponse,
} from "./weightGeometryProtocol";

let process: ReturnType<typeof createWeightGeometryProcessor> | undefined;
let initializationError: string | undefined;
self.onmessage = (
  event: MessageEvent<WeightGeometryHull | WeightGeometryRequest>,
) => {
  const request = event.data;
  if ("type" in request) {
    try {
      process = createWeightGeometryProcessor(
        assemble(request.state),
        request.sampling,
      );
      initializationError = undefined;
    } catch (error) {
      initializationError =
        error instanceof Error ? error.message : String(error);
    }
    return;
  }
  let response: WeightGeometryResponse;
  try {
    if (!process)
      throw new Error(initializationError ?? "Section hull is unavailable");
    response = process(request);
  } catch (error) {
    response = {
      key: request.key,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  (self as unknown as Worker).postMessage(response);
};
