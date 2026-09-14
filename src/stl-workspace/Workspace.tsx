import { Activity, useEffect, useMemo, useState } from "react";
import { Button } from "../components/Button";
import { AnalysisProvider, useAnalysis } from "../analysis/ui/AnalysisProvider";
import { WeightPanel } from "../analysis/ui/weight/WeightPanel";
import { StabilityPanel } from "../analysis/ui/StabilityPanel";
import { GeometryPreview } from "../analysis/ui/GeometryPreview";
import { HullSetup, RepairReview } from "./HullSetup";
import { openAnalysisWindow, type AnalysisView as View } from "./windows";
import { message, type Configuration, type Inspection } from "./setup";
import type { ProjectSession, ProjectSnapshot } from "./session";

const REFERENCE_METRICS = new Set([
  "LWL",
  "BWL",
  "DRAFT",
  "DISP_VOL",
  "WSA",
  "AW",
  "LCB",
  "LCF",
  "KB",
  "BMT",
  "KMT",
  "CB",
  "CW",
]);
export function Workspace({
  session,
  snapshot,
  onAttach,
  initialView,
  detached = false,
}: {
  session: ProjectSession;
  snapshot: ProjectSnapshot;
  onAttach: () => void;
  initialView?: View;
  detached?: boolean;
}) {
  const [view, setCurrentView] = useState<View>(
    initialView ?? (session.asset.bytes.byteLength ? "Hull" : "Weights"),
  );
  const [visited, setVisited] = useState<ReadonlySet<View>>(
    () =>
      new Set([
        initialView ?? (session.asset.bytes.byteLength ? "Hull" : "Weights"),
      ]),
  );
  const setView = (next: View) => {
    setCurrentView(next);
    setVisited((previous) => new Set([...previous, next]));
  };
  const [setup, setSetup] = useState(false);
  const [popupError, setPopupError] = useState("");
  const [retry, setRetry] = useState(0);
  const c = snapshot.configuration;
  const names = [
    ...JSON.stringify(snapshot.book).matchAll(/\bHULL\s*\.\s*([A-Z_]+)/g),
  ].map((m) => m[1]);
  const needsEnvelope = names.some(
    (name) => REFERENCE_METRICS.has(name) || name === "HULL_VOL",
  );
  const needsReference = names.some((name) => REFERENCE_METRICS.has(name));
  const hasPositions = snapshot.book.items.some((i) =>
    Object.values(i.fields).some((f) => f.k === "point" || f.k === "cut"),
  );
  const needsShell = names.some(
    (name) => name.startsWith("SHELL_") || name === "WSA",
  );
  const hull = useMemo(() => {
    void retry;
    return session.service.hull(c, needsEnvelope);
  }, [session, c, needsEnvelope, retry]);
  const active = (name: View) => view === name;
  const physical = !!c.metresPerUnit && !!c.frameConfirmed;
  const demand = {
    metrics: names.length > 0,
    outlines: false,
    cuts: active("Weights") || active("Stability"),
    stability: active("Stability") && physical,
  };
  const detach = () => {
    if (!openAnalysisWindow(session, view))
      setPopupError(
        "The browser blocked the window. Allow popups or keep using the full-size tabs.",
      );
    else setPopupError("");
  };
  const configure = (next: Configuration) => {
    try {
      session.configure(next, c);
    } catch (e) {
      setPopupError(message(e));
    }
  };
  const body = (name: View) => (
    <div className="stl-view">
      {name === "Weights" && (
        <>
          {needsShell && !c.wholeSurface && (
            <div className="stl-notice">
              <b>A formula needs a hull-material surface.</b> All supplied STL
              faces include any deck, transom, cabin or interior parts.{" "}
              <Button
                disabled={!c.metresPerUnit}
                onClick={() => configure({ ...c, wholeSurface: true })}
              >
                Use all supplied faces
              </Button>
            </div>
          )}
          {names.length > 0 && !c.metresPerUnit && (
            <div className="stl-notice">
              Manual weights work now. Set the scale to resolve hull formulas.{" "}
              <Button
                onClick={() => {
                  setView("Hull");
                  setSetup(true);
                }}
              >
                Set scale
              </Button>
            </div>
          )}
          {needsEnvelope && c.metresPerUnit > 0 && !c.frameConfirmed && (
            <div className="stl-notice">
              A formula needs the hull coordinate frame.{" "}
              <Button
                onClick={() => {
                  setView("Hull");
                  setSetup(true);
                }}
              >
                Set orientation
              </Button>
            </div>
          )}
          {hasPositions && !physical && (
            <div className="stl-notice">
              Point coordinates can be authored now. Calibrate the hull before
              placing them against its geometry.{" "}
              <Button
                onClick={() => {
                  setView("Hull");
                  setSetup(!!session.asset.bytes.byteLength);
                }}
              >
                Hull coordinates
              </Button>
            </div>
          )}
          {needsReference && c.waterlineZ === null && physical && (
            <div className="stl-notice">
              A formula needs hydrostatics at a reference waterline.{" "}
              <Button
                onClick={() => {
                  setView("Hull");
                  setSetup(false);
                }}
              >
                Set reference waterline
              </Button>
            </div>
          )}
          {needsEnvelope && physical && (
            <EnvelopeAssumptions session={session} configuration={c} />
          )}
          <WeightPanel />
        </>
      )}
      {name === "Stability" &&
        (!physical ? (
          <div className="stl-empty">
            <h2>Ready when you need it</h2>
            <p>
              Stability needs physical scale, a hull coordinate frame and a
              supported buoyancy envelope. A design waterline is not required.
            </p>
            <Button
              onClick={() => {
                setView("Hull");
                setSetup(!!session.asset.bytes.byteLength);
              }}
            >
              Set scale and orientation
            </Button>
          </div>
        ) : (
          <StabilityView
            key={retry}
            session={session}
            snapshot={snapshot}
            onRetry={() => setRetry((n) => n + 1)}
          />
        ))}
      {name === "Hull" &&
        (setup ? (
          <HullSetup
            key={JSON.stringify(c)}
            session={session}
            configuration={c}
            onClose={() => setSetup(false)}
          />
        ) : (
          <HullView
            key={JSON.stringify(c)}
            needsReference={needsReference}
            session={session}
            configuration={c}
            onSetup={() => setSetup(true)}
            onAttach={onAttach}
          />
        ))}
    </div>
  );
  return (
    <AnalysisProvider
      host={{
        hull,
        book: snapshot.book,
        displayUnit: "m",
        dispatch: session.dispatch,
      }}
      demand={demand}
    >
      <nav className="stl-navigation" aria-label="Project views">
        {(["Weights", "Stability", "Hull"] as const).map((name) => (
          <Button
            key={name}
            active={view === name}
            aria-pressed={view === name}
            onClick={() => setView(name)}
          >
            {name}
          </Button>
        ))}
        <span />
        {!detached && <Button onClick={detach}>Open in separate window</Button>}
      </nav>
      {popupError && <p role="alert">{popupError}</p>}
      {(["Weights", "Stability", "Hull"] as const).map((name) =>
        visited.has(name) ? (
          <Activity key={name} mode={view === name ? "visible" : "hidden"}>
            {body(name)}
          </Activity>
        ) : null,
      )}
    </AnalysisProvider>
  );
}

function HullView({
  session,
  configuration: c,
  onSetup,
  onAttach,
  needsReference,
}: {
  needsReference: boolean;
  session: ProjectSession;
  configuration: Configuration;
  onSetup: () => void;
  onAttach: () => void;
}) {
  const [answer, setAnswer] = useState<{
    c: Configuration;
    inspection: Inspection;
  }>({ c: session.initialConfiguration, inspection: session.initialPreview });
  const [error, setError] = useState("");
  const [waterline, setWaterline] = useState(
    c.waterlineZ === null ? "" : String(c.waterlineZ),
  );
  useEffect(() => {
    let current = true;
    void session.service.preview(c).then(
      (inspection) => {
        if (current) setAnswer({ c, inspection });
      },
      (e) => {
        if (current) setError(message(e));
      },
    );
    return () => {
      current = false;
    };
  }, [session, c]);
  const configure = (next: Configuration) => {
    try {
      session.configure(next, c);
    } catch (e) {
      setError(message(e));
    }
  };
  if (!session.asset.bytes.byteLength)
    return (
      <div className="stl-empty">
        <h2>No hull attached</h2>
        <p>
          Your weight book works without one. Attach an STL whenever you need
          geometry.
        </p>
        <Button onClick={onAttach}>Attach STL</Button>
      </div>
    );
  const geometry = answer.c === c ? answer.inspection.geometry : undefined;
  return (
    <section className="stl-hull">
      <div className="stl-context-bar">
        <span>
          {!c.metresPerUnit
            ? "Scale not set"
            : !c.frameConfirmed
              ? "Scale set · coordinates not applied"
              : "Scale and coordinates set"}
        </span>
        <Button onClick={onSetup}>
          {c.metresPerUnit ? "Edit calibration" : "Set scale"}
        </Button>
      </div>
      {geometry ? (
        <GeometryPreview
          geometry={geometry}
          calibrated={!!c.metresPerUnit}
          waterline={c.waterlineZ ?? undefined}
          keelZ={c.metresPerUnit ? c.keelZ : undefined}
          trim={(c.trimDegrees * Math.PI) / 180}
        />
      ) : (
        <p role="status">Preparing preview…</p>
      )}
      {error && <p role="alert">{error}</p>}
      <details className="stl-details">
        <summary>Small openings</summary>
        <label className="stl-check">
          <input
            type="checkbox"
            checked={c.autoPatchSmallHoles !== false}
            onChange={(e) =>
              configure({ ...c, autoPatchSmallHoles: e.target.checked })
            }
          />
          Automatically seal tiny mesh gaps for calculations
        </label>
        <p>
          Assumes gaps are mesh defects, not flooding openings. Original STL
          faces remain unchanged. Explicitly applied repairs take precedence.
        </p>
      </details>
      <details
        className="stl-details"
        open={needsReference && c.waterlineZ === null ? true : undefined}
      >
        <summary>Reference waterline and surface scope</summary>
        <p>
          A reference waterline is optional. Stability uses displacement and KG;
          it does not require a design waterline.
        </p>
        <label>
          Reference waterline height (m)
          <input
            aria-label="Reference waterline height (m)"
            type="number"
            step="any"
            value={waterline}
            onChange={(e) => setWaterline(e.target.value)}
          />
        </label>
        <Button
          disabled={!c.frameConfirmed || !c.metresPerUnit}
          onClick={() =>
            configure({
              ...c,
              waterlineZ: waterline === "" ? null : Number(waterline),
            })
          }
        >
          Apply reference waterline
        </Button>
        <Button
          onClick={() => {
            setWaterline("");
            configure({ ...c, waterlineZ: null });
          }}
        >
          Clear reference
        </Button>
        <label className="stl-check">
          <input
            type="checkbox"
            checked={c.wholeSurface}
            onChange={(e) =>
              configure({ ...c, wholeSurface: e.target.checked })
            }
          />
          Use all supplied physical faces in hull-material formulas (including
          any deck, transom, cabin or interior faces)
        </label>
        <p>
          Repair patches are excluded. No shell scope is assumed from an STL
          filename or face normal.
        </p>
      </details>
      {c.repair && (
        <p>
          Applied repairs are used for buoyancy analysis. This preview shows the
          original surface.
        </p>
      )}
    </section>
  );
}

function StabilityView({
  session,
  snapshot,
  onRetry,
}: {
  session: ProjectSession;
  snapshot: ProjectSnapshot;
  onRetry: () => void;
}) {
  const { stability, weight } = useAnalysis();
  const [answer, setAnswer] = useState<{
    key: string;
    inspection: Inspection;
  }>();
  const [error, setError] = useState("");
  const c = snapshot.configuration;
  const key = JSON.stringify([
    c.metresPerUnit,
    c.axes,
    c.origin,
    c.repair,
    c.autoPatchSmallHoles,
  ]);
  useEffect(() => {
    let current = true;
    void session.service.request<Inspection>(c, { type: "validate" }).then(
      (inspection) => {
        if (current) setAnswer({ key, inspection });
      },
      (e) => {
        if (current) setError(message(e));
      },
    );
    return () => {
      current = false;
    };
  }, [session, c, key]);
  const report = answer?.key === key ? answer.inspection.report : undefined;
  return (
    <>
      <div className="stl-context-bar">
        <span>
          {stability.status === "pending"
            ? "Validating envelope and computing stability…"
            : report?.openHydrostatics
              ? "Validated open sheer · stops at first rim immersion"
              : report?.closed
                ? "Closed envelope · downflooding unknown"
                : "Buoyancy analysis"}
        </span>
        {stability.status === "pending" ? (
          <Button onClick={() => session.service.cancel()}>
            Cancel calculation
          </Button>
        ) : stability.status === "error" ? (
          <Button onClick={onRetry}>Retry calculation</Button>
        ) : null}
      </div>
      {error && <p role="alert">{error}</p>}
      <AutomaticPatchNotice
        session={session}
        configuration={c}
        inspection={answer?.key === key ? answer.inspection : undefined}
      />
      {report?.envelopeError ? (
        <>
          <p role="alert">
            {report.envelopeError}. The weight book and original surface remain
            usable.
          </p>
          <RepairReview
            key={key}
            session={session}
            configuration={c}
            onAccepted={onRetry}
          />
        </>
      ) : (
        <StabilityPanel
          stability={stability}
          unit="m"
          density={snapshot.book.density}
          sheetResults={weight.results}
          loading={snapshot.loading}
          onLoadingChange={session.loading}
        />
      )}
    </>
  );
}

function AutomaticPatchNotice({
  session,
  configuration,
  inspection,
}: {
  session: ProjectSession;
  configuration: Configuration;
  inspection?: Inspection;
}) {
  const [error, setError] = useState("");
  const count = inspection?.automaticPatches?.holes.length;
  if (!count) return null;
  return (
    <div className="stl-notice" role="status">
      <b>
        {count} small {count === 1 ? "gap sealed" : "gaps sealed"} for
        calculation.
      </b>{" "}
      Treated as mesh defects, not flooding openings. Original STL unchanged.{" "}
      <Button
        onClick={() => {
          try {
            session.configure(
              { ...configuration, autoPatchSmallHoles: false },
              configuration,
            );
          } catch (e) {
            setError(message(e));
          }
        }}
      >
        Leave small openings unsealed
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function EnvelopeAssumptions({
  session,
  configuration,
}: {
  session: ProjectSession;
  configuration: Configuration;
}) {
  const [answer, setAnswer] = useState<{
    configuration: Configuration;
    inspection: Inspection;
  }>();
  useEffect(() => {
    let current = true;
    void session.service
      .request<Inspection>(configuration, { type: "validate" })
      .then(
        (inspection) => {
          if (current) setAnswer({ configuration, inspection });
        },
        () => {
          /* The formula query reports geometry failures. */
        },
      );
    return () => {
      current = false;
    };
  }, [session, configuration]);
  return (
    <AutomaticPatchNotice
      session={session}
      configuration={configuration}
      inspection={
        answer?.configuration === configuration ? answer.inspection : undefined
      }
    />
  );
}
