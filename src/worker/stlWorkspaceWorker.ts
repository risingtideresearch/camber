import type { Inspection } from "../stl-workspace/setup";
import { WorkspaceEngine, type EngineAction } from "../stl-workspace/engine";
import { message, type Configuration } from "../stl-workspace/setup";
let engine: WorkspaceEngine;
self.onmessage = (
  e: MessageEvent<{
    id: number;
    buffer?: ArrayBuffer;
    configuration: Configuration;
    action: EngineAction;
  }>,
) => {
  const { id, buffer, configuration, action } = e.data;
  try {
    if (buffer) engine = new WorkspaceEngine(buffer);
    if (!engine) throw new Error("No STL is installed");
    const value = engine.run(configuration, action);
    const inspection = value as Inspection;
    const transfer = [
      inspection.geometry?.positions.buffer,
      inspection.changes?.positions.buffer,
    ].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
    self.postMessage({ id, value }, { transfer });
  } catch (e) {
    self.postMessage({ id, error: message(e) });
  }
};
