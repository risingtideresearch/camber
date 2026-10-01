import { useMemo, useState } from "react";
import { Button } from "../components/Button";
import { canApplyEquilibrium } from "../core/equilibrium";
import {
  DEFAULT_LOADING,
  loadingKey,
  type LoadingPurpose,
} from "../core/loading";
import { unitScale } from "../core/json";
import { defaultSession } from "../core/runtime";
import { resolveScenario } from "../core/sheet/resolveScenario";
import { scenariosOf, SHARED_WORKSPACE } from "../core/sheet/scenarios";
import type { LoadingBatchRequest } from "../worker/loadingComputation";
import {
  useDocumentDispatch,
  useDocumentRuntime,
  useDocumentSnapshot,
} from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { OpenPanelButton } from "./OpenPanelButton";
import { DetachPanelButton } from "./DetachPanelButton";
import {
  LoadingAttitudePreview,
  LoadingConstraintFields,
  LoadingPurposePicker,
} from "./LoadingAttitudePreview";
import { LoadingScenarioComparison } from "./LoadingScenarioComparison";
import {
  degrees,
  readLoadingConstraints,
  showLoadingValue as show,
  type LoadingConstraintInputs,
} from "./loadingPresentation";
import { useLoadingAnalysis } from "./useLoadingAnalysis";
import "./LoadingPanel.css";

interface LoadingPanelProps {
  /** Present when hosted inside Weights; return to its output formulas in place. */
  readonly onEditEstimate?: () => void;
  readonly scenarioId?: string | null;
}

export function LoadingPanel(props: LoadingPanelProps = {}) {
  const snapshot = useDocumentSnapshot();
  // A newly opened design gets its own controls/reference and cancels old work.
  return <LoadingWorkspace key={snapshot.meta.design.currentId} {...props} />;
}

function LoadingWorkspace({
  onEditEstimate,
  scenarioId: selectedScenario,
}: LoadingPanelProps) {
  const snapshot = useDocumentSnapshot();
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const { perf } = useEditorUi();
  const authoredBook = snapshot.state.weights;
  const documentId = snapshot.meta.design.currentId;
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<LoadingPurpose>("balance-design");
  const [inputs, setInputs] = useState<LoadingConstraintInputs>({
    fixTrim: false,
    trim: String(degrees(model.deckTrim)),
    fixHeel: false,
    heel: "0",
  });
  const [reference, setReference] = useState(SHARED_WORKSPACE);
  const [showChanges, setShowChanges] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<{
    key: string;
    error: string;
  } | null>(null);
  const choices = useMemo(
    () => [
      { id: SHARED_WORKSPACE, name: "Shared" },
      ...scenariosOf(authoredBook),
    ],
    [authoredBook],
  );
  const requestedScenario =
    selectedScenario !== undefined ? selectedScenario : workspace;
  const scenarioId = choices.some((choice) => choice.id === requestedScenario)
    ? requestedScenario
    : null;
  const activeId = scenarioId ?? SHARED_WORKSPACE;
  const label = choices.find((choice) => choice.id === activeId)!.name;
  const referenceId = choices.some((choice) => choice.id === reference)
    ? reference
    : SHARED_WORKSPACE;
  const constraintInputs = {
    ...inputs,
    trim: inputs.fixTrim ? inputs.trim : String(degrees(model.deckTrim)),
  };
  const { constraints, error: constraintError } = useMemo(
    () => readLoadingConstraints(inputs, purpose),
    [inputs, purpose],
  );
  const entries = useMemo(
    () =>
      (purpose === "balance-design"
        ? choices.filter((choice) => choice.id === activeId)
        : choices
      ).map(({ id }) => ({
        id,
        book: resolveScenario(
          authoredBook,
          id === SHARED_WORKSPACE ? null : id,
        ),
      })),
    [authoredBook, choices, activeId, purpose],
  );
  const key = JSON.stringify([
    documentId,
    snapshot.revision,
    purpose,
    purpose === "balance-design" ? activeId : null,
    constraints,
    perf.numSections,
    perf.girthSteps,
  ]);
  const request = useMemo<LoadingBatchRequest | null>(
    () =>
      constraints
        ? {
            key,
            state: snapshot.state.hull,
            // Loading selection and editor scrubbers cannot affect physical results.
            session: defaultSession(snapshot.state.hull),
            sliceRevs: snapshot.sliceRevs,
            numSections: perf.numSections,
            girthSteps: perf.girthSteps,
            purpose,
            constraints,
            entries,
          }
        : null,
    [
      key,
      snapshot.state.hull,
      snapshot.sliceRevs,
      perf.numSections,
      perf.girthSteps,
      purpose,
      constraints,
      entries,
    ],
  );
  const results = useLoadingAnalysis(request);
  const response = results.get(activeId);
  const proposal =
    response && "proposal" in response ? response.proposal : undefined;
  const scale = unitScale(model.unit, "m");
  const changeConstraints = (patch: Partial<LoadingConstraintInputs>) =>
    setInputs((previous) => ({
      ...previous,
      ...(patch.fixTrim === true && !previous.fixTrim
        ? { trim: String(degrees(model.deckTrim)) }
        : {}),
      ...patch,
    }));
  const apply = async () => {
    if (
      purpose !== "balance-design" ||
      !proposal ||
      applying ||
      !canApplyEquilibrium(proposal)
    )
      return;
    setApplying(true);
    setApplyError(null);
    try {
      const outcome = await dispatch({
        type: "applyFloatingAttitude",
        waterline: proposal.waterline,
        deckTrim: proposal.deckTrim,
        expectedRevision: snapshot.revision,
        expectedLoading: null,
        scenarioId,
        vcg: proposal.values.vcg,
        label: `${label} · upright design balance${constraints?.trim !== null ? " · fixed trim" : ""}`,
      });
      if ("rejected" in outcome)
        setApplyError({ key, error: outcome.rejected });
    } catch (error) {
      setApplyError({ key, error: String(error) });
    } finally {
      setApplying(false);
    }
  };
  const last = snapshot.session.lastBalance;
  const outdated =
    last &&
    (last.revision !== snapshot.revision ||
      last.loadingKey !== loadingKey({ ...DEFAULT_LOADING, scenarioId }));
  return (
    <div className="loading-panel">
      <section className="card loading-card loading-workflow">
        <header>
          <h2>Loading</h2>
          <div className="loading-controls">
            {onEditEstimate ? (
              <Button onClick={onEditEstimate}>Edit estimates</Button>
            ) : (
              <OpenPanelButton
                kind="weights"
                weightScreen="sheet"
                label="Edit estimates"
              />
            )}
            <OpenPanelButton kind="stability" label="Open stability" />
            {onEditEstimate && (
              <DetachPanelButton kind="loading" label="Open separately" />
            )}
          </div>
        </header>
        <LoadingPurposePicker
          purpose={purpose}
          onChange={setPurpose}
          disabled={applying}
        />
        {purpose === "balance-design" && (
          <section className="loading-step" aria-label="Design estimate">
            {selectedScenario === undefined ? (
              <label>
                Estimate{" "}
                <select
                  aria-label="Design estimate"
                  value={activeId}
                  disabled={applying}
                  onChange={(event) =>
                    setWorkspace(
                      event.target.value === SHARED_WORKSPACE
                        ? null
                        : event.target.value,
                    )
                  }
                >
                  {choices.map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <h3>Estimate: {label}</h3>
            )}
            <p className="loading-hint">
              Solves waterline and trim with heel held at 0°. Heel is not
              balanced and TCG is not used for transverse balance.
              Geometry-dependent sheet values follow this upright attitude.
              Apply stores the calculated waterline and trim.
            </p>
          </section>
        )}
        {purpose === "compare-scenarios" && (
          <p className="loading-hint">
            Each estimate is evaluated at the same starting design attitude,
            then its mass and hull-fixed centre of gravity remain unchanged
            during the solve. All scenarios use the same constraints. Nothing is
            applied to the model.
          </p>
        )}
        <LoadingConstraintFields
          inputs={constraintInputs}
          allowHeel={purpose === "compare-scenarios"}
          onChange={changeConstraints}
          disabled={applying}
        />
        <p className="loading-hint">
          Calculations update automatically. Supported trim is ±30°, with the
          sheer clear of the water. Free trim needs LCG and VCG.
          {purpose === "compare-scenarios" && (
            <>
              {" "}
              Heel is supported to ±45°; free heel needs VCG and TCG. Fixed
              angles are held, not necessarily balanced.
            </>
          )}
        </p>
        {constraintError && <p role="alert">{constraintError}</p>}
        {purpose === "balance-design" ? (
          <section
            className="loading-step loading-proposal"
            aria-label="Design balance result"
          >
            <h3>Upright design balance</h3>
            {!constraintError && !response && (
              <p role="status" className="loading-hint">
                Computing balanced attitude…
              </p>
            )}
            {response && "error" in response && (
              <p role="alert">{response.error}</p>
            )}
            <div className="loading-table-scroll">
              <LoadingAttitudePreview
                waterline={model.waterline}
                deckTrim={model.deckTrim}
                scale={scale}
                proposal={proposal}
              />
            </div>
            {proposal && (
              <>
                <details className="loading-diagnostics">
                  <summary>Solver details</summary>
                  <p className="loading-hint">
                    {proposal.iterations} iterations · Displacement error:{" "}
                    {show(Math.abs(proposal.volumeError) * 100)}%
                    {proposal.balanceError !== null && (
                      <>
                        {" "}
                        · Longitudinal balance error:{" "}
                        {show(Math.abs(proposal.balanceError) * 1000)} mm
                      </>
                    )}
                    {proposal.transverseBalanceError !== null && (
                      <>
                        {" "}
                        · Transverse balance error:{" "}
                        {show(
                          Math.abs(proposal.transverseBalanceError) * 1000,
                        )}{" "}
                        mm
                      </>
                    )}
                  </p>
                </details>
                {canApplyEquilibrium(proposal) && (
                  <div className="loading-controls">
                    <Button
                      variant="primary"
                      disabled={applying}
                      onClick={() => void apply()}
                    >
                      {applying ? "Applying…" : "Apply to model"}
                    </Button>
                  </div>
                )}
              </>
            )}
            {applyError?.key === key && <p role="alert">{applyError.error}</p>}
            {last && (
              <p className="loading-hint" role="status">
                {outdated
                  ? `Last applied: ${last.label}. Estimate or geometry changed since that calculation.`
                  : `Applied to model: ${last.label}. You can undo this change.`}
              </p>
            )}
          </section>
        ) : (
          !constraintError && (
            <section
              className="loading-step"
              aria-label="Loading scenario comparison"
            >
              <h3>Compare loading scenarios</h3>
              <LoadingScenarioComparison
                scenarios={choices}
                results={results}
                scale={scale}
                referenceId={referenceId}
                onReferenceChange={setReference}
                showChanges={showChanges}
                onShowChanges={setShowChanges}
                disabled={applying}
              />
            </section>
          )
        )}
        <p className="loading-hint">
          Waterline depth is measured below the deck datum. Positive trim is bow
          up; positive heel and TCG are starboard, negative are port. LCG is
          from the transom; VCG is above the keel baseline.
        </p>
      </section>
    </div>
  );
}
