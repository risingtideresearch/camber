import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Dropdown } from "../components/Dropdown";
import { useDocumentSnapshot } from "./documentStoreHooks";
import type {
  HydrostaticExportRequest,
  HydrostaticExportResponse,
} from "../worker/hydrostaticExportProtocol";
import "./HydrostaticExport.css";

type Coverage = "upright" | "fixed" | "grid";

function download(json: string, name: string) {
  const filename = (name.trim() || "untitled-hull").replace(
    /[^\p{L}\p{N}._-]+/gu,
    "-",
  );
  const url = URL.createObjectURL(
    new Blob([json], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filename}.hydrostatics.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Leave the URL alive until the browser has consumed the download request.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HydrostaticExport() {
  const snapshot = useDocumentSnapshot();
  const [open, setOpen] = useState(false);
  const [coverage, setCoverage] = useState<Coverage>("grid");
  const [fine, setFine] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  const cancel = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setBusy(false);
    setStatus("Export cancelled. No file was downloaded.");
  };
  const start = () => {
    if (workerRef.current) {
      setOpen(true);
      return;
    }
    setOpen(true);
    setStatus("Sampling the captured hull…");
    setError(null);
    setBusy(true);
    // Capture plain authored state at the click, never the UI's possibly stale
    // preview lattice. Edits made while the worker runs do not change this export.
    const state = {
      ...snapshot.state.hull,
      name: snapshot.meta.name || snapshot.state.hull.name,
    };
    const designTrimDeg = state.deckTrim / (Math.PI / 180);
    const step = fine ? 2.5 : 5;
    const request: HydrostaticExportRequest = {
      state,
      options: {
        heelDeg:
          coverage === "upright"
            ? [0]
            : Array.from({ length: 360 / step + 1 }, (_, i) => -180 + i * step),
        trimDeg:
          coverage === "upright"
            ? [0]
            : coverage === "fixed"
              ? [designTrimDeg]
              : [-5, 0, 5, designTrimDeg],
        immersionSteps: fine ? 128 : 64,
        numSections: fine ? 400 : 240,
        girthSteps: fine ? 16 : 10,
        generatedAt: new Date().toISOString(),
        ...(snapshot.meta.design.currentId
          ? { modelId: snapshot.meta.design.currentId }
          : {}),
      },
    };
    try {
      const worker = new Worker(
        new URL("../worker/hydrostaticExportWorker.ts", import.meta.url),
        { type: "module" },
      );
      workerRef.current = worker;
      const stop = () => {
        worker.terminate();
        workerRef.current = null;
        setBusy(false);
      };
      worker.onmessage = (event: MessageEvent<HydrostaticExportResponse>) => {
        if (workerRef.current !== worker) return;
        const response = event.data;
        if (response.type === "progress") {
          setStatus(
            `Exporting attitude rows: ${response.completedRows} / ${response.totalRows}`,
          );
        } else if (response.type === "error") {
          stop();
          setStatus(null);
          setError(response.error);
        } else {
          stop();
          try {
            download(response.json, state.name);
            setStatus(
              "Hydrostatic table downloaded. This file describes an idealized closed envelope.",
            );
          } catch (e) {
            setStatus(null);
            setError(e instanceof Error ? e.message : String(e));
          }
        }
      };
      worker.onerror = (event) => {
        if (workerRef.current !== worker) return;
        event.preventDefault();
        stop();
        setStatus(null);
        setError(event.message || "Export worker failed");
      };
      worker.postMessage(request);
    } catch (e) {
      workerRef.current?.terminate();
      workerRef.current = null;
      setBusy(false);
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dropdown
      label={busy ? "Exporting hydrostatics…" : "Export hydrostatics"}
      onToggle={start}
      open={open}
      onOpenChange={setOpen}
      align="right"
      disabled={!snapshot.meta.initialized}
      menuLabel="Hydrostatic export options"
      title="Download a hydrostatic-table v1 JSON from the current hull, in metres"
    >
      <div className="hydro-export">
        <div className="dd-group">Hydrostatic table JSON · v1</div>
        <label className="dd-row">
          <span>Coverage</span>
          <select
            aria-label="Hydrostatic export coverage"
            value={coverage}
            disabled={busy}
            onChange={(e) => setCoverage(e.target.value as Coverage)}
          >
            <option value="grid">Heel and trim grid</option>
            <option value="fixed">Heel at design trim</option>
            <option value="upright">Upright only (0° / 0°)</option>
          </select>
        </label>
        <label className="dd-row">
          <span>Resolution</span>
          <select
            aria-label="Hydrostatic export resolution"
            value={fine ? "fine" : "standard"}
            disabled={busy}
            onChange={(e) => setFine(e.target.value === "fine")}
          >
            <option value="standard">Standard: 5° / 64 immersion steps</option>
            <option value="fine">Fine: 2.5° / 128 immersion steps</option>
          </select>
        </label>
        <p>
          {coverage === "upright"
            ? "Only heel = trim = 0 is supported. This cannot provide large-angle GZ curves."
            : coverage === "fixed"
              ? "Heel −180…180° at the authored design trim only. No free-trim coverage."
              : "Heel −180…180°; trims −5°, 0°, +5° plus authored design trim. No extrapolation beyond this grid."}
        </p>
        <p>
          {fine
            ? "400 longitudinal intervals; 16 girth substeps per section segment."
            : "240 longitudinal intervals; 10 girth substeps per section segment."}{" "}
          Every row includes dry and fully immersed endpoints.
        </p>
        <p>
          Includes idealized deck/transom/end closures and sampled deck-edge
          markers. Opening/downflooding limits are unknown. No loading CG,
          density, mesh or stability verdict is exported.
        </p>
        <p>
          The hull is captured when export starts. Refine sampling to check
          convergence; the chosen resolution is not an accuracy guarantee.
        </p>
        {status && <p role="status">{status}</p>}
        {error && (
          <p className="hydro-export-error" role="alert">
            Export failed: {error}
          </p>
        )}
        {busy ? (
          <Button onClick={cancel}>Cancel export</Button>
        ) : (
          <Button onClick={start}>Download hydrostatic table</Button>
        )}
      </div>
    </Dropdown>
  );
}
