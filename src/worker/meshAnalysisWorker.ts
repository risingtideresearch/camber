import { createMeshComputation } from "../analysis/mesh/compute";
import { importAnalysisStl } from "../analysis/mesh/import";
import type { MeshRequest, MeshResponse } from "../analysis/mesh/protocol";
let compute: ReturnType<typeof createMeshComputation> | undefined;
let contextId: string | undefined;
self.onmessage = (event: MessageEvent<MeshRequest>) => {
  const request = event.data;
  let response: MeshResponse;
  if (request.type === "install") {
    try {
      if (contextId)
        throw new Error("A mesh worker owns one immutable asset/context");
      contextId = request.setup.analysis.id;
      const mesh = importAnalysisStl(request.buffer, request.setup);
      compute = createMeshComputation(mesh, request.setup.analysis);
      response = { type: "ready", contextId, report: mesh.report };
    } catch (reason) {
      response = {
        type: "ready",
        contextId: request.setup.analysis.id,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  } else {
    try {
      if (!compute || request.contextId !== contextId)
        throw new Error("Mesh context is not installed");
      response = {
        type: "answer",
        id: request.id,
        ...compute(request.kind, request.input),
      };
    } catch (reason) {
      response = {
        type: "answer",
        id: request.id,
        contextId: request.contextId,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }
  self.postMessage(response);
};
