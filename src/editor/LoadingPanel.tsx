import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button";
import { DEFAULT_LOADING, loadingKey } from "../core/loading";
import { unitScale } from "../core/json";
import { loadingOutputs } from "../core/sheet/loadingOutputs";
import { resolveScenario } from "../core/sheet/resolveScenario";
import { scenariosOf } from "../core/sheet/scenarios";
import type { EquilibriumMode } from "../core/equilibrium";
import type {
  LoadingProposal,
  LoadingRequest,
  LoadingResponse,
} from "../worker/loadingComputation";
import {
  useDocumentDispatch,
  useDocumentRuntime,
  useDocumentSnapshot,
} from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { OpenPanelButton } from "./OpenPanelButton";
import { DetachPanelButton } from "./DetachPanelButton";
import { ScenarioLoading } from "./weight/ScenarioLoading";
import { useStabilityAnalysis } from "./useStabilityAnalysis";
import { useWeightBookResults } from "./useWeightBookResults";
import "./LoadingPanel.css";

const show = (value: number | null, digits = 3) =>
  value === null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const degrees = (radians: number) => (radians * 180) / Math.PI;

interface Task {
  readonly key: string;
  readonly mode: EquilibriumMode;
  readonly pending: boolean;
  readonly proposal?: LoadingProposal;
  readonly error?: string;
}

export function LoadingPanel({
  onEditEstimate,
  scenarioId: selectedScenario,
}: {
  /** Present when hosted inside Weights; return to its output formulas in place. */
  readonly onEditEstimate?: () => void;
  readonly scenarioId?: string | null;
} = {}) {
  const snapshot = useDocumentSnapshot();
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const { perf, sampling } = useEditorUi();
  const authoredBook = snapshot.state.weights;
  const documentId = snapshot.meta.design.currentId;
  const [workspace, setWorkspace] = useState<{
    documentId: string | null;
    id: string | null;
  }>({ documentId, id: null });
  const requestedScenario =
    selectedScenario !== undefined
      ? selectedScenario
      : workspace.documentId === documentId
        ? workspace.id
        : null;
  const scenarioId = scenariosOf(authoredBook).some(
    (s) => s.id === requestedScenario,
  )
    ? requestedScenario
    : null;
  const loading = { ...DEFAULT_LOADING, scenarioId };
  const book = useMemo(
    () => resolveScenario(authoredBook, scenarioId),
    [authoredBook, scenarioId],
  );
  const {
    analysis,
    pending: analysisPending,
    error: analysisError,
  } = useStabilityAnalysis(snapshot, perf);
  const sheet = useWeightBookResults(
    book,
    model,
    sampling(),
    analysis?.metrics ?? null,
  );
  const outputs = loadingOutputs(sheet.results);
  const values = outputs.values;
  const [iterate, setIterate] = useState(true);
  const [task, setTask] = useState<Task | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const key = `${documentId}|${snapshot.revision}|${loadingKey(loading)}|${iterate}|${perf.numSections}|${perf.girthSteps}`;
  // A changed input invalidates and cancels the private calculation. No effect
  // ever starts a solve or writes attitude back to the document.
  useEffect(
    () => () => {
      worker.current?.terminate();
      worker.current = null;
    },
    [key],
  );
  const current = task?.key === key ? task : null;
  const busy = !!current?.pending;
  const proposal = current?.proposal;
  const scale = unitScale(model.unit, "m");
  const scenario = scenariosOf(authoredBook).find((s) => s.id === scenarioId);
  const label = scenario?.name ?? "Shared estimate";
  const ready =
    !sheet.pending && !sheet.error && !analysisPending && !analysisError;
  const canMatch = ready && values !== null;
  const canBalance = canMatch && values?.lcg !== null && values?.vcg !== null;

  const calculate = (mode: EquilibriumMode) => {
    worker.current?.terminate();
    setApplyError(null);
    setTask({ key, mode, pending: true });
    try {
      const active = new Worker(
        new URL("../worker/loadingWorker.ts", import.meta.url),
        { type: "module" },
      );
      worker.current = active;
      const finish = (response: LoadingResponse) => {
        if (worker.current !== active) return;
        active.terminate();
        worker.current = null;
        setTask({ key, mode, pending: false, ...response });
      };
      active.onmessage = (event: MessageEvent<LoadingResponse>) =>
        finish(event.data);
      active.onerror = (event) =>
        finish({ error: event.message || "Could not calculate equilibrium." });
      const request: LoadingRequest = {
        key,
        state: snapshot.state.hull,
        session: snapshot.session,
        sliceRevs: snapshot.sliceRevs,
        numSections: perf.numSections,
        girthSteps: perf.girthSteps,
        values,
        mode,
        book,
        density: book.density,
        iterate,
      };
      active.postMessage(request);
    } catch (error) {
      worker.current?.terminate();
      worker.current = null;
      setTask({ key, mode, pending: false, error: String(error) });
    }
  };
  const cancel = () => {
    worker.current?.terminate();
    worker.current = null;
    setTask(null);
    setApplyError(null);
  };
  const apply = async () => {
    if (!proposal || applying) return;
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
        label: `${label}${current?.mode === "displacement" ? " · displacement only" : ""}`,
      });
      if ("rejected" in outcome) setApplyError(outcome.rejected);
      else setTask(null);
    } catch (error) {
      setApplyError(String(error));
    } finally {
      setApplying(false);
    }
  };
  const last = snapshot.session.lastBalance;
  const outdated =
    last &&
    (last.revision !== snapshot.revision ||
      last.loadingKey !== loadingKey(loading));
  return (
    <div className="loading-panel">
      <section className="card loading-card loading-workflow">
        <header>
          <h2>Loading</h2>
          <div className="loading-controls">
            {onEditEstimate ? (
              <Button onClick={onEditEstimate}>Edit output formulas</Button>
            ) : (
              <OpenPanelButton
                kind="weights"
                weightScreen="sheet"
                label="Edit output formulas"
              />
            )}
            <OpenPanelButton kind="stability" label="Open stability" />
            {onEditEstimate && (
              <DetachPanelButton kind="loading" label="Open separately" />
            )}
          </div>
        </header>
        <section className="loading-step" aria-label="Scenario inputs">
          {selectedScenario !== undefined && <h3>{label}</h3>}
          {selectedScenario === undefined && (
            <label>
              Scenario{" "}
              <select
                aria-label="Loading scenario"
                value={scenarioId ?? ""}
                onChange={(event) =>
                  setWorkspace({ documentId, id: event.target.value || null })
                }
              >
                <option value="">Shared</option>
                {scenariosOf(authoredBook).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ScenarioLoading
            results={sheet.results}
            scenarioName={label}
            density={book.density}
          />
          <p className="loading-hint">
            Nominal scenario outputs. LCG is measured from the transom
            reference; VCG is height above the current keel baseline.
          </p>
          {(sheet.pending || analysisPending) && (
            <p role="status" className="loading-hint">
              Measuring estimate geometry…
            </p>
          )}
          {sheet.error && <p role="alert">{sheet.error}</p>}
          {analysisError && <p role="alert">{analysisError}</p>}
        </section>
        <section className="loading-step" aria-labelledby="loading-calculate">
          <h3 id="loading-calculate">Calculate floating attitude</h3>
          <div className="loading-actions">
            <div>
              <Button
                variant="primary"
                disabled={!canBalance || busy || applying}
                onClick={() => calculate("balance")}
              >
                Calculate equilibrium
              </Button>
              <p className="loading-hint">
                Find waterline and trim that balance this loading.
              </p>
            </div>
            <div>
              <Button
                disabled={!canMatch || busy || applying}
                onClick={() => calculate("displacement")}
              >
                Match displacement only
              </Button>
              <p className="loading-hint">
                Find waterline while keeping the current trim.
              </p>
            </div>
          </div>
          {!canMatch && ready && (
            <p className="loading-hint">
              A valid, positive displacement is needed to calculate.
            </p>
          )}
          {canMatch && !canBalance && (
            <p className="loading-hint">
              Full equilibrium also needs valid LCG and VCG. Displacement-only
              matching is available.
            </p>
          )}
          <label className="loading-iterate">
            <input
              type="checkbox"
              checked={iterate}
              disabled={applying}
              onChange={(event) => setIterate(event.target.checked)}
            />{" "}
            Update geometry-dependent formulas during the solve
          </label>
          {iterate && (
            <p className="loading-hint">
              Re-measure the estimate as the boat’s attitude changes, until it
              settles.
            </p>
          )}
          {!iterate && (
            <p className="loading-hint">
              Uses the current estimate without feedback. Geometry-dependent
              outputs may change after applying the attitude.
            </p>
          )}
          {busy && (
            <div className="loading-controls" role="status">
              Calculating on a private copy…{" "}
              <Button onClick={cancel}>Cancel</Button>
            </div>
          )}
          {current?.error && <p role="alert">{current.error}</p>}
        </section>
        <section className="loading-step" aria-labelledby="loading-preview">
          <h3 id="loading-preview">
            {proposal ? "Preview changes" : "Current floating attitude"}
          </h3>
          <p className="loading-hint">
            {proposal
              ? "Calculation complete. Review the proposed change before applying it."
              : "Calculate to preview a new attitude. The model stays unchanged until you apply it."}
          </p>
          <div className="loading-proposal">
            <table>
              <thead>
                <tr>
                  <th>Attitude</th>
                  <th>Current</th>
                  {proposal && <th>Proposed</th>}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Waterline depth</th>
                  <td>{show(model.waterline * scale)} m</td>
                  {proposal && <td>{show(proposal.waterline * scale)} m</td>}
                </tr>
                <tr>
                  <th>Deck trim</th>
                  <td>{show(degrees(model.deckTrim))}°</td>
                  {proposal && <td>{show(degrees(proposal.deckTrim))}°</td>}
                </tr>
              </tbody>
            </table>
            <p className="loading-hint">
              Waterline depth is measured below the deck datum.
            </p>
            {proposal && (
              <>
                {iterate &&
                  values &&
                  (proposal.values.mass !== values.mass ||
                    proposal.values.lcg !== values.lcg ||
                    proposal.values.vcg !== values.vcg) && (
                    <p className="loading-hint">
                      Updated estimate: {show(proposal.values.mass / 1000)} t ·
                      LCG {show(proposal.values.lcg)} m · VCG{" "}
                      {show(proposal.values.vcg)} m.
                    </p>
                  )}
                <details className="loading-diagnostics">
                  <summary>
                    {current.mode === "balance"
                      ? "Equilibrium converged"
                      : "Displacement matched"}{" "}
                    · Solver details
                  </summary>
                  <p className="loading-hint">
                    {proposal.iterations}{" "}
                    {proposal.iterations === 1 ? "iteration" : "iterations"} ·
                    Displacement error:{" "}
                    {show(Math.abs(proposal.volumeError) * 100, 4)}%
                    {proposal.balanceError !== null && (
                      <>
                        {" "}
                        · Longitudinal balance error:{" "}
                        {show(Math.abs(proposal.balanceError) * 1000, 2)} mm
                      </>
                    )}
                  </p>
                </details>
                <div className="loading-controls">
                  <Button
                    variant="primary"
                    disabled={applying}
                    onClick={() => void apply()}
                  >
                    {applying ? "Applying…" : "Apply to model"}
                  </Button>
                  <Button disabled={applying} onClick={cancel}>
                    Discard
                  </Button>
                </div>
              </>
            )}
          </div>
          {task && !current && (
            <p role="status" className="loading-hint">
              Inputs changed. Calculate again to preview the new attitude.
            </p>
          )}
          {applyError && <p role="alert">{applyError}</p>}
          {last && (
            <p className="loading-hint" role="status">
              {outdated
                ? `Last applied: ${last.label}. Scenario or geometry changed since that calculation.`
                : `Applied to model: ${last.label}. You can undo this change.`}
            </p>
          )}
        </section>
      </section>
    </div>
  );
}
