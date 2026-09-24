import type { createSamplingRun } from "../core/sheet/sampling";
import type { SamplingCommand, SamplingEvent } from "./samplingProtocol";

type Run = ReturnType<typeof createSamplingRun>;
/** Each scheduled turn is bounded. Generation checks invalidate queued callbacks
 * on cancel/replacement; extending preserves the same evaluator and accumulators. */
export function createSamplingController(
  create: (command: Extract<SamplingCommand, { type: "start" }>) => Run,
  emit: (event: SamplingEvent) => void,
  schedule: (callback: () => void) => void = (callback) => {
    setTimeout(callback, 0);
  },
) {
  let run: Run | undefined,
    runId = "",
    generation = 0,
    running = false;
  const publish = () => {
    if (run) emit({ kind: "snapshot", result: run.snapshot() });
  };
  const fail = (error: unknown) => {
    running = false;
    generation++;
    const message = error instanceof Error ? error.message : String(error);
    if (run)
      emit({
        kind: "snapshot",
        result: run.snapshot({ status: "failed", message }),
      });
    else emit({ kind: "error", runId, message });
  };
  const queue = () => {
    const token = generation;
    schedule(() => {
      if (token !== generation || !running || !run) return;
      try {
        const checkpoint = run.advance();
        emit({ kind: "progress", runId, completedTrials: run.completed });
        if (checkpoint) publish();
        if (run.done) running = false;
        else queue();
      } catch (error) {
        fail(error);
      }
    });
  };
  return (command: SamplingCommand) => {
    if (command.type !== "start" && command.runId !== runId) return;
    try {
      if (command.type === "start") {
        generation++;
        running = false;
        run = undefined;
        runId = command.request.runId;
        run = create(command);
        running = true;
        publish();
        queue();
      } else if (command.type === "cancel") {
        if (!running || !run) return;
        generation++;
        running = false;
        emit({
          kind: "snapshot",
          result: run.snapshot({ status: "cancelled" }),
        });
      } else {
        if (running) return; // Ignore a repeated refinement click already in flight.
        if (!run || !run.done)
          throw new Error("Only a completed run can be refined");
        run.extend(command.checkpoints);
        generation++;
        running = true;
        publish();
        queue();
      }
    } catch (error) {
      fail(error);
    }
  };
}
