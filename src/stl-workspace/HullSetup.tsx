import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { GeometryPreview } from "../analysis/ui/GeometryPreview";
import {
  message,
  placedReferences,
  sourceAxisLengths,
  type Configuration,
  type Inspection,
} from "./setup";
import type { ProjectSession } from "./session";
import type { RepairPolicy } from "../analysis/mesh/repair";

const AXES = [1, -1, 2, -2, 3, -3] as const;
const axisName = (axis: number) =>
  `${axis > 0 ? "+" : "−"}${"XYZ"[Math.abs(axis) - 1]}`;
function direction(
  c: Configuration,
  index: 0 | 2,
  axis: Configuration["axes"][0],
): Configuration {
  const axes = [...c.axes] as Configuration["axes"];
  axes[index] = axis;
  const other = index === 0 ? 2 : 0;
  if (Math.abs(axes[other]) === Math.abs(axis))
    axes[other] = AXES.find((a) => a > 0 && Math.abs(a) !== Math.abs(axis))!;
  const missing = [1, 2, 3].find(
    (a) => a !== Math.abs(axes[0]) && a !== Math.abs(axes[2]),
  )!;
  axes[1] = missing as Configuration["axes"][0];
  const permutation = axes.map(Math.abs);
  const inversions = permutation.flatMap((v, i) =>
    permutation.slice(i + 1).filter((w) => v > w),
  ).length;
  if ((inversions % 2 ? -1 : 1) * Math.sign(axes[0] * axes[2]) < 0)
    axes[1] *= -1;
  return { ...c, axes, frameConfirmed: false, repair: undefined };
}

export function HullSetup({
  session,
  configuration,
  onClose,
}: {
  session: ProjectSession;
  configuration: Configuration;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(configuration);
  const [answer, setAnswer] = useState({
    configuration: session.initialConfiguration,
    inspection: session.initialPreview,
  });
  const preview = answer.configuration === draft ? answer.inspection : {};
  const [error, setError] = useState("");
  const [knownLength, setKnownLength] = useState("");
  const sourceLengths = session.initialPreview.geometry
    ? sourceAxisLengths(
        session.initialPreview.geometry.bounds,
        session.initialConfiguration,
      )
    : null;
  const sourceLength = sourceLengths?.[Math.abs(draft.axes[0]) - 1];
  const formatLength = (length: number) =>
    length.toLocaleString(undefined, { maximumSignificantDigits: 8 });
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      void session.service.preview(draft).then(
        (value) => {
          if (current) setAnswer({ configuration: draft, inspection: value });
        },
        (e) => {
          if (current) setError(message(e));
        },
      );
    }, 100);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [session, draft]);
  const patch = (p: Partial<Configuration>) => {
    setDraft((c) => ({ ...c, ...p }));
    setError("");
  };
  const apply = async () => {
    try {
      let next = { ...draft, frameConfirmed: draft.metresPerUnit > 0 };
      const frameChanged =
        JSON.stringify([
          draft.metresPerUnit,
          draft.axes,
          draft.origin,
          draft.trimDegrees,
          draft.keelZ,
        ]) !==
        JSON.stringify([
          configuration.metresPerUnit,
          configuration.axes,
          configuration.origin,
          configuration.trimDegrees,
          configuration.keelZ,
        ]);
      const calibrationChanged =
        draft.metresPerUnit !== configuration.metresPerUnit ||
        JSON.stringify(draft.axes) !== JSON.stringify(configuration.axes);
      if (calibrationChanged) {
        const raw = await session.service.preview({
          ...draft,
          origin: [0, 0, 0],
        });
        if (!raw.geometry) throw new Error("Hull preview is not available");
        next = {
          ...next,
          ...placedReferences([0, 0, 0], raw.geometry.bounds),
          repair: undefined,
        };
      }
      const hasPositions = session
        .getSnapshot()
        .document.book.items.some((i) =>
          Object.values(i.fields).some((f) => f.k === "point" || f.k === "cut"),
        );
      if (
        frameChanged &&
        (hasPositions ||
          session.getSnapshot().document.loading.condition !== null) &&
        !window.confirm(
          "Changing calibration or the frame will reinterpret existing point, cut and manual loading coordinates. Their numbers and formulas stay unchanged; their physical locations relative to the hull may change. Continue? (Cancel keeps the current frame.)",
        )
      )
        return;
      session.configure(next, configuration);
      onClose();
    } catch (e) {
      setError(message(e));
    }
  };
  const place = async () => {
    try {
      const raw = await session.service.preview({
        ...draft,
        origin: [0, 0, 0],
      });
      if (!raw.geometry) return;
      patch({
        ...placedReferences([0, 0, 0], raw.geometry.bounds),
        frameConfirmed: false,
        repair: undefined,
      });
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <section className="stl-setup" aria-label="Hull calibration">
      <div className="stl-section-heading">
        <h2>Scale and coordinates</h2>
        <Button onClick={onClose}>Cancel</Button>
      </div>
      <div className="stl-calibration-grid">
        <div className="stl-fields">
          <label>
            STL source units
            <select
              aria-label="STL source units"
              value={draft.metresPerUnit}
              onChange={(e) =>
                patch({
                  metresPerUnit: Number(e.target.value),
                  frameConfirmed: false,
                  repair: undefined,
                })
              }
            >
              <option value={0}>Not set</option>
              <option value={1}>Metres</option>
              <option value={0.001}>Millimetres</option>
              <option value={0.01}>Centimetres</option>
              <option value={0.0254}>Inches</option>
              <option value={0.3048}>Feet</option>
              {![0, 1, 0.001, 0.01, 0.0254, 0.3048].includes(
                draft.metresPerUnit,
              ) && <option value={draft.metresPerUnit}>Custom scale</option>}
            </select>
          </label>
          {sourceLength !== undefined && (
            <div aria-label="STL base length">
              <strong>
                Base length: {formatLength(sourceLength)} STL units
              </strong>
              <small>
                Full extent along source {axisName(draft.axes[0])}, before
                scaling.
              </small>
              {draft.metresPerUnit > 0 && (
                <small>
                  With selected units:{" "}
                  {formatLength(sourceLength * draft.metresPerUnit)} m
                </small>
              )}
            </div>
          )}
          <div>
            <label>
              Or known forward extent (m)
              <input
                aria-label="Known length (m)"
                type="number"
                min="0"
                value={knownLength}
                onChange={(e) => setKnownLength(e.target.value)}
              />
            </label>
            <Button
              disabled={
                !sourceLength ||
                !(Number(knownLength) > 0) ||
                !Number.isFinite(Number(knownLength))
              }
              onClick={() => {
                if (sourceLength && sourceLength > 0)
                  patch({
                    metresPerUnit: Number(knownLength) / sourceLength,
                    frameConfirmed: false,
                    repair: undefined,
                  });
              }}
            >
              Set length
            </Button>
            <small>
              Scales the full extent along the chosen forward axis, not the
              waterline length.
            </small>
          </div>
          {([2, 0] as const).map((index) => (
            <fieldset key={index}>
              <legend>
                {index === 2 ? "Choose up" : "Choose bow direction"}
              </legend>
              <div className="stl-direction-buttons">
                {AXES.map((axis) => (
                  <Button
                    key={axis}
                    active={draft.axes[index] === axis}
                    aria-pressed={draft.axes[index] === axis}
                    onClick={() => {
                      setDraft(direction(draft, index, axis));
                      setError("");
                    }}
                  >
                    {axisName(axis)}
                  </Button>
                ))}
              </div>
            </fieldset>
          ))}
          <p>
            Preview arrows: x → bow, z ↑ up. Transverse y is derived to keep a
            right-handed frame. Camera orbit does not orient the hull.
          </p>
          <Button disabled={!draft.metresPerUnit} onClick={() => void place()}>
            Place zero at aft / centre / bottom
          </Button>
          <small>
            This is a bounding-box coordinate convention, not an inferred keel
            or centreline.
          </small>
          <details>
            <summary>Advanced frame</summary>
            {([0, 1, 2] as const).map((axis) => (
              <label key={axis}>
                Origin {"xyz"[axis]} (m)
                <input
                  type="number"
                  step="any"
                  value={draft.origin[axis]}
                  onChange={(e) =>
                    patch({
                      origin: draft.origin.map((v, i) =>
                        i === axis ? Number(e.target.value) : v,
                      ) as Configuration["origin"],
                      repair: undefined,
                      frameConfirmed: false,
                    })
                  }
                />
              </label>
            ))}
            <label>
              Fixed trim (degrees)
              <input
                aria-label="Fixed trim (degrees)"
                type="number"
                step="any"
                value={draft.trimDegrees}
                onChange={(e) => patch({ trimDegrees: Number(e.target.value) })}
              />
            </label>
            <label>
              KG zero height (m)
              <input
                type="number"
                step="any"
                value={draft.keelZ}
                onChange={(e) => patch({ keelZ: Number(e.target.value) })}
              />
            </label>
          </details>
          {error && <p role="alert">{error}</p>}
          <Button variant="primary" onClick={() => void apply()}>
            Apply calibration
          </Button>
        </div>
        {preview.geometry && (
          <GeometryPreview
            geometry={preview.geometry}
            calibrated={!!draft.metresPerUnit}
          />
        )}
      </div>
    </section>
  );
}

export function RepairReview({
  session,
  configuration,
  onAccepted,
}: {
  session: ProjectSession;
  configuration: Configuration;
  onAccepted: () => void;
}) {
  const [proposal, setProposal] = useState<Inspection>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const search = async (policy?: RepairPolicy) => {
    setBusy(true);
    setError("");
    setProposal(undefined);
    try {
      setProposal(
        await session.service.request<Inspection>(configuration, {
          type: "repair",
          policy,
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const applyRepair = (repair?: RepairPolicy) => {
    try {
      session.configure(
        {
          ...configuration,
          repair,
          ...(repair ? {} : { autoPatchSmallHoles: false }),
        },
        configuration,
      );
      onAccepted();
    } catch (e) {
      setError(message(e));
    }
  };
  const report = proposal?.repair;
  return (
    <section className="stl-repair">
      <h3>Repair options</h3>
      <p>
        Only request repairs if you need buoyancy analysis. Original triangles
        remain available for weights and viewing.
      </p>
      <Button disabled={busy} onClick={() => void search()}>
        Find bounded repairs
      </Button>
      {busy && (
        <>
          <p role="status">
            Searching bounded repairs… Large files can take several minutes.
          </p>
          <Button onClick={() => session.service.cancel()}>
            Cancel calculation
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p>
            {report.degenerate} degenerate and {report.duplicate} duplicate
            faces removed. Maximum vertex movement{" "}
            {(report.maxVertexMove * 1000).toPrecision(3)} mm. Removed area{" "}
            {report.removedArea.toPrecision(3)} m².
          </p>
          {report.holes.map((hole, i) => (
            <p key={i}>
              Opening {i + 1}: span {(hole.diameter * 1000).toPrecision(3)} mm,
              area {hole.area.toPrecision(3)} m².
            </p>
          ))}
          <label className="stl-check">
            <input
              type="checkbox"
              checked={report.policy.fillSmallHoles}
              onChange={(e) =>
                void search({
                  ...report.policy,
                  version: 2,
                  fillSmallHoles: e.target.checked,
                })
              }
            />
            Patch bounded small openings
          </label>
          {proposal.geometry && (
            <GeometryPreview
              geometry={proposal.geometry}
              repairs={proposal.changes}
            />
          )}
          <p>
            Patches seal the listed openings for buoyancy calculations. Leave
            intentional vents or drains unpatched; flooding is not modelled.
          </p>
          <Button onClick={() => applyRepair(report.policy)}>
            Apply repairs
          </Button>
        </>
      )}
      {configuration.repair && (
        <Button onClick={() => applyRepair()}>Use original mesh</Button>
      )}
    </section>
  );
}
