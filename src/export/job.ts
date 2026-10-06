import type { ExportRequest, ExportResponse } from "./types";

export interface ExportJob {
  cancel(): void;
}

/** One worker per captured export. Cancellation/disposal also ignores any queued replies. */
export function startExportJob(
  request: ExportRequest,
  receive: (response: ExportResponse) => void,
  makeWorker: () => Worker = () =>
    new Worker(new URL("../worker/exportWorker.ts", import.meta.url), {
      type: "module",
    }),
): ExportJob {
  const worker = makeWorker();
  let active = true;
  const cancel = () => {
    if (!active) return;
    active = false;
    worker.terminate();
  };
  worker.onmessage = (event: MessageEvent<ExportResponse>) => {
    if (!active) return;
    if (event.data.type !== "progress") cancel();
    receive(event.data);
  };
  worker.onerror = (event) => {
    if (!active) return;
    event.preventDefault();
    cancel();
    receive({ type: "error", error: event.message || "Export worker failed" });
  };
  worker.onmessageerror = () => {
    if (!active) return;
    cancel();
    receive({
      type: "error",
      error: "Could not read the export worker response",
    });
  };
  try {
    worker.postMessage(request);
  } catch (error) {
    cancel();
    throw error;
  }
  return { cancel };
}
