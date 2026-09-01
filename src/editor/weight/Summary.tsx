// ---------- what the estimate answers, and what is wrong with it ----------
//
// Three pieces that read the book rather than list it: the summary view, the problems view, and the footer
// that follows you around every other view.
//
// The outputs used to be a page of rows constrained to three names. They are now three formulas on the book,
// written in the same language as everything else — `DISPLACEMENT = all up.mass` where that is all it is, and
// a real expression where it is not. Nothing is nominated and nothing can dangle: a formula resolves by name
// when the book is evaluated, so deleting the item it names turns the answer into an ordinary visible error
// rather than a silent nothing.

import type { DocumentCommand } from "../../core/commands";
import type { WeightBook } from "../../core/sheet/book";
import { outputResult, type BookResults } from "../../core/sheet/evaluate";
import { OUTPUTS } from "../../core/sheet/outputs";
import type { Problem } from "../../core/sheet/views";
import { FormulaField, ResultIssue } from "./weightFields";
import { showSpread, sig } from "./weightFormat";
import { globalCompletions } from "./weightCompletions";

// ---------- the summary ----------

export function Summary({
  book,
  results,
  reading,
  selected,
  onSelect,
  send,
}: {
  readonly book: WeightBook;
  readonly results: BookResults;
  readonly reading: "worst" | "likely";
  readonly selected: string;
  readonly onSelect: (name: string) => void;
  readonly send: (command: DocumentCommand) => void;
}) {
  // An output is written against the whole book and belongs to no item, so it gets the global half of the
  // completion list and no siblings — there is no "this item" to have any.
  const completions = globalCompletions(book, false);
  return (
    <table className="wsheet wsummarytable">
      <thead>
        <tr>
          <th className="wsummaryname">Value</th>
          <th>Formula</th>
          <th className="wsummaryresult">Result</th>
          <th className="wsummaryresult">Spread</th>
        </tr>
      </thead>
      <tbody>
        {OUTPUTS.map((spec) => {
          const result = outputResult(results, spec.name);
          const factor = result?.unit?.factor ?? 1;
          return (
            <tr
              key={spec.name}
              className={`wrow${selected === spec.name ? " focused" : ""}`}
              onClick={() => onSelect(spec.name)}
            >
              <th className="wsummaryname" title={spec.hint}>
                <span className="woutputlabel">{spec.label}</span>
                <span className="woutputname">{spec.name}</span>
              </th>
              <td className="wcell wcellscalar">
                <FormulaField
                  value={book.outputs[spec.name] ?? ""}
                  error={result?.error ?? null}
                  completions={completions}
                  placeholder="nothing answers this yet"
                  onCommit={(formula) =>
                    send({ type: "setOutput", name: spec.name, formula })
                  }
                />
                <ResultIssue message={result?.error} severity="error" />
              </td>
              <td className="wsummaryresult">
                {result?.reading
                  ? `${sig(result.reading.v / factor)} ${result.unit?.label ?? ""}`
                  : "—"}
              </td>
              <td className="wsummaryresult">
                {result?.reading
                  ? showSpread(result.reading, factor, reading) || "exact"
                  : "—"}
                <ResultIssue message={result?.unitWarning} severity="warning" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------- the problems view ----------

export function Problems({
  problems,
  onOpenItem,
}: {
  readonly problems: readonly Problem[];
  readonly onOpenItem: (itemId: string) => void;
}) {
  if (!problems.length)
    return (
      <p className="whint wpad">
        Nothing to look at. Every cell works out and none of them is empty.
      </p>
    );
  return (
    <div className="wpad">
      <ProblemList problems={problems} onOpenItem={onOpenItem} />
    </div>
  );
}

function ProblemList({
  problems,
  onOpenItem,
}: {
  readonly problems: readonly Problem[];
  readonly onOpenItem: (itemId: string) => void;
}) {
  return (
    <ul className="wproblems">
      {problems.map((problem) => (
        <li
          key={`${problem.item.id} ${problem.fieldKey} ${problem.leaf}`}
          className={problem.message === "nothing written yet" ? "soft" : ""}
        >
          <button
            className="wproblemwhere"
            onClick={() => onOpenItem(problem.item.id)}
            title="Open this item"
          >
            {problem.item.name || "unnamed"}.{problem.fieldKey}
            {problem.leaf === "formula" ? "" : `.${problem.leaf}`}
          </button>
          <span className="wproblemwhat">{problem.message}</span>
        </li>
      ))}
    </ul>
  );
}
