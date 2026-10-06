import { buildExport } from "../export/exporters";
import type { ExportRequest, ExportResponse } from "../export/types";

const send = (message: ExportResponse) =>
  (self as unknown as Worker).postMessage(message);

self.onmessage = (event: MessageEvent<ExportRequest>) => {
  try {
    const artifact = buildExport(event.data, (completedRows, totalRows) =>
      send({ type: "progress", completedRows, totalRows }),
    );
    send({ type: "complete", artifact });
  } catch (error) {
    send({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
