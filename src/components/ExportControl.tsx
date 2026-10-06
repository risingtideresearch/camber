import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_SURFACES, type SurfaceToggles } from "../core/hullGeometry";
import { downloadBlob } from "../export/download";
import { startExportJob, type ExportJob } from "../export/job";
import type {
  ExportFormat,
  ExportOptions,
  ExportSource,
  HydrostaticCoverage,
} from "../export/types";
import { Button } from "./Button";
import { HydrostaticExportOptions } from "./HydrostaticExportOptions";
import "./ExportControl.css";

interface ExportControlProps {
  name: string;
  sourceLabel: string;
  captureSource: () => ExportSource;
  disabled?: boolean;
}

const SURFACES: { key: keyof SurfaceToggles; label: string }[] = [
  { key: "hull", label: "Hull skin" },
  { key: "transom", label: "Transom closure" },
  { key: "deck", label: "Deck cap" },
];

/** The same export flow for a saved library row and the editor's current authored hull. */
export function ExportControl({
  name,
  sourceLabel,
  captureSource,
  disabled = false,
}: ExportControlProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const jobRef = useRef<ExportJob | null>(null);
  const titleId = useId();
  const sourceId = useId();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [surfaces, setSurfaces] = useState<SurfaceToggles>(DEFAULT_SURFACES);
  const [coverage, setCoverage] = useState<HydrostaticCoverage>("grid");
  const [fine, setFine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [captured, setCaptured] = useState<{
    name: string;
    label: string;
  } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const noSurfaces =
    format === "stl" && !surfaces.hull && !surfaces.transom && !surfaces.deck;

  useEffect(() => () => jobRef.current?.cancel(), []);

  const show = () => {
    dialogRef.current?.showModal();
    setOpen(true);
  };
  const cancel = () => {
    jobRef.current?.cancel();
    jobRef.current = null;
    setBusy(false);
    setProgress(null);
    setStatus("Export cancelled. No file was downloaded.");
  };
  const start = () => {
    if (jobRef.current || disabled || noSurfaces) return;
    setError(null);
    setProgress(null);
    setStatus("Preparing the captured hull…");
    setBusy(true);
    try {
      // Capture at confirmation, not when the dialog opens, and never use preview sampling.
      const source = captureSource();
      setCaptured({ name: source.name || "Untitled", label: sourceLabel });
      const options: ExportOptions =
        format === "stl"
          ? { format, surfaces: { ...surfaces } }
          : format === "hydrostatics"
            ? { format, coverage, fine }
            : { format };
      jobRef.current = startExportJob(
        { source, options, generatedAt: new Date().toISOString() },
        (response) => {
          if (response.type === "progress") {
            setProgress({
              completed: response.completedRows,
              total: response.totalRows,
            });
            setStatus(
              `Exporting attitude rows: ${response.completedRows} / ${response.totalRows}`,
            );
            return;
          }
          jobRef.current = null;
          setBusy(false);
          setProgress(null);
          if (response.type === "error") {
            setStatus(null);
            setError(response.error);
            return;
          }
          try {
            const { filename, text, mime } = response.artifact;
            downloadBlob(filename, new Blob([text], { type: mime }));
            setStatus(`Downloaded ${filename}.`);
          } catch (e) {
            setStatus(null);
            setError(e instanceof Error ? e.message : String(e));
          }
        },
      );
    } catch (e) {
      setBusy(false);
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <Button
        disabled={disabled && !busy}
        onClick={show}
        aria-haspopup="dialog"
      >
        {busy ? "Exporting…" : "Export…"}
      </Button>
      {!open && (
        <span className="export-announcement" role="status">
          {error ? `Export failed: ${error}` : status}
        </span>
      )}
      <dialog
        ref={dialogRef}
        className="export-dialog"
        aria-labelledby={titleId}
        aria-describedby={sourceId}
        onClose={() => setOpen(false)}
      >
        <div className="export-content">
          <h2 id={titleId}>
            Export “{busy ? captured?.name : name || "Untitled"}”
          </h2>
          <p id={sourceId} className="export-source">
            Source: {busy ? captured?.label : sourceLabel}
          </p>
          <fieldset disabled={busy} className="export-settings">
            <legend className="export-announcement">Export settings</legend>
            <label className="export-field">
              <span>Export type</span>
              <select
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value as ExportFormat);
                  setStatus(null);
                  setError(null);
                }}
              >
                <optgroup label="Design document">
                  <option value="json">Camber hull document (.json)</option>
                </optgroup>
                <optgroup label="Geometry">
                  <option value="step">CAD surface (.step)</option>
                  <option value="stl">Triangle mesh (.stl)</option>
                </optgroup>
                <optgroup label="Analysis data">
                  <option value="hydrostatics">
                    Hydrostatic table (.hydrostatics.json)
                  </option>
                </optgroup>
              </select>
            </label>
            {format === "json" && (
              <p>
                A re-importable hull document in its authored units. The weight
                sheet is not included.
              </p>
            )}
            {format === "step" && (
              <p>
                B-spline hull surface and planar transom in millimetres. An open
                shell, without a deck cap.
              </p>
            )}
            {format === "stl" && (
              <>
                <p>
                  ASCII triangle mesh in millimetres. STL does not store units.
                </p>
                <fieldset className="export-surfaces">
                  <legend>Surfaces</legend>
                  {SURFACES.map(({ key, label }) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={surfaces[key]}
                        onChange={(e) =>
                          setSurfaces((s) => ({
                            ...s,
                            [key]: e.target.checked,
                          }))
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <p>
                  Include hull, transom and deck for a closed envelope. Without
                  the deck, the hull remains open along the sheer.
                </p>
                {noSurfaces && (
                  <p className="export-error">Select at least one surface.</p>
                )}
              </>
            )}
            {format === "hydrostatics" && (
              <>
                <p>
                  Hydrostatic-table v1 JSON in metres, describing an idealized
                  closed envelope.
                </p>
                <HydrostaticExportOptions
                  coverage={coverage}
                  fine={fine}
                  onCoverage={setCoverage}
                  onFine={setFine}
                />
              </>
            )}
          </fieldset>
          <p>
            The hull is captured when you click Export. Later edits do not
            change a running export.
          </p>
          {busy && (
            <p>
              You can close this dialog and continue working. Reopen Export… to
              view progress or cancel.
            </p>
          )}
          {progress && (
            <progress
              aria-label="Hydrostatic export progress"
              value={progress.completed}
              max={progress.total}
            />
          )}
          {status && (
            <p className="export-status" role="status">
              {status}
            </p>
          )}
          {error && (
            <p className="export-error" role="alert">
              Export failed: {error}
            </p>
          )}
          <div className="export-actions">
            <Button onClick={() => dialogRef.current?.close()}>Close</Button>
            {busy ? (
              <Button onClick={cancel}>Cancel export</Button>
            ) : (
              <Button
                variant="primary"
                disabled={disabled || noSurfaces}
                onClick={start}
              >
                Export
              </Button>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
