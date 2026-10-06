import { buildHydrostaticTable } from "../core/hydrostaticExport";
import { assemble } from "../core/runtime";
import type {
  HydrostaticExportRequest,
  HydrostaticExportResponse,
} from "./hydrostaticExportProtocol";

const send = (message: HydrostaticExportResponse) =>
  (self as unknown as Worker).postMessage(message);
self.onmessage = (event: MessageEvent<HydrostaticExportRequest>) => {
  try {
    const { state, options } = event.data;
    const table = buildHydrostaticTable(
      assemble(state),
      options,
      (completedRows, totalRows) =>
        send({ type: "progress", completedRows, totalRows }),
    );
    send({ type: "complete", json: JSON.stringify(table, null, 2) });
  } catch (error) {
    send({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
