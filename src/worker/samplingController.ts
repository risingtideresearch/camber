import type { createSamplingRun } from "../core/sheet/sampling";
import type { SamplingCommand, SamplingEvent } from "./samplingProtocol";

type Run = ReturnType<typeof createSamplingRun>;
type Start = Extract<SamplingCommand, { type: "start" }>;
type Job = { readonly id: string; readonly start?: Start; readonly run?: Run };

/** The visible reduction runs first. A view switch suspends the old run between
 * batches without discarding its accumulators; it resumes in the background once
 * the visible one completes. Completed accumulators are bounded for refinement. */
export function createSamplingController(
  create: (command: Start) => Run,
  emit: (event: SamplingEvent) => void,
  schedule: (callback: () => void) => void = (callback) => {
    setTimeout(callback, 0);
  },
) {
  const waiting: Job[] = [];
  const completed = new Map<string, Run>();
  let active: { id: string; run: Run } | null = null;
  const MAX_COMPLETED = 32;
  const publish = (job: { id: string; run: Run }) =>
    emit({ kind: "snapshot", result: job.run.snapshot() });
  const pump = () => {
    if (active || !waiting.length) return;
    const job = waiting.shift()!;
    try {
      const run = job.run ?? create(job.start!);
      active = { id: job.id, run };
      publish(active);
      queue(active);
    } catch (error) {
      emit({
        kind: "error",
        runId: job.id,
        message: error instanceof Error ? error.message : String(error),
      });
      pump();
    }
  };
  const queue = (job: { id: string; run: Run }) => {
    schedule(() => {
      if (active !== job) return;
      try {
        const checkpoint = job.run.advance();
        emit({
          kind: "progress",
          runId: job.id,
          completedTrials: job.run.completed,
        });
        if (checkpoint) publish(job);
        if (job.run.done) {
          completed.delete(job.id);
          completed.set(job.id, job.run);
          if (completed.size > MAX_COMPLETED)
            completed.delete(completed.keys().next().value!);
          active = null;
          pump();
        } else queue(job);
      } catch (error) {
        emit({
          kind: "snapshot",
          result: job.run.snapshot({
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        });
        active = null;
        pump();
      }
    });
  };
  return (command: SamplingCommand) => {
    const id = command.type === "start" ? command.request.runId : command.runId;
    if (command.type === "start") {
      if (
        active?.id === id ||
        waiting.some((job) => job.id === id) ||
        completed.has(id)
      )
        return;
      if (active) {
        waiting.unshift({ id: active.id, run: active.run });
        active = null; // The scheduled turn sees a different job and does nothing.
      }
      waiting.unshift({ id, start: command });
      pump();
    } else if (command.type === "prioritize") {
      const index = waiting.findIndex((job) => job.id === id);
      if (index < 0) return;
      const [selected] = waiting.splice(index, 1);
      if (active) {
        waiting.unshift({ id: active.id, run: active.run });
        active = null;
      }
      waiting.unshift(selected);
      pump();
    } else if (command.type === "cancel") {
      if (active?.id === id) {
        const job = active;
        active = null;
        emit({
          kind: "snapshot",
          result: job.run.snapshot({ status: "cancelled" }),
        });
        pump();
      } else {
        const index = waiting.findIndex((job) => job.id === id);
        if (index < 0) return;
        const [job] = waiting.splice(index, 1);
        try {
          const run = job.run ?? create(job.start!);
          emit({
            kind: "snapshot",
            result: run.snapshot({ status: "cancelled" }),
          });
        } catch (error) {
          emit({
            kind: "error",
            runId: id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      if (active?.id === id || waiting.some((job) => job.id === id)) return;
      const run = completed.get(id);
      if (!run) {
        emit({
          kind: "error",
          runId: id,
          message: "This run is no longer available for refinement",
        });
        return;
      }
      try {
        run.extend(command.checkpoints);
        completed.delete(id);
        waiting.push({ id, run });
        pump();
      } catch (error) {
        emit({
          kind: "error",
          runId: id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}
