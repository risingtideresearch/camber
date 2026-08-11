import { useState } from "react";
import { Button } from "../components/Button";
import { SLICE, type SliceMask } from "../core/commands";
import type { HistoryStep } from "../document-store/history";
import {
  useDocumentSnapshot,
  useDocumentStore,
  useDocumentTimeline,
} from "./documentStoreHooks";
import "./HistoryPanel.css";

// The history explorer. It exists only as a detached window, and that is the point: the history is the one
// thing in the editor that is not a view of the hull but a view of the SESSION, and it is most useful beside
// the editor rather than inside it — click a step here and watch the hull move in the window next door.
//
// It reads the shared undo stacks (store.timeline(), answered by the session's authority in the SharedWorker)
// and it travels by the same undo / redo every window already uses. So it needs no privileges: it cannot
// install a state, only ask the authority to walk to one, and every other window follows because the walk is
// an ordinary authoritative transition.
//
// The list is one document order — the applied gestures oldest first, then the undone ones in the order redo
// would put them back — with the current state marked between them. Clicking a row means "make the document
// be as it was after this step", which is a run of undos or redos, counted from where the stacks stand now.

// A gesture's slices, spelled out: which parts of the hull it moved. This is what makes the undo stack legible
// as a record rather than a list of names — "Move sheer point 3 · plan" says why it was cheap to redraw.
const sliceNames = (touched: SliceMask): string =>
  Object.entries(SLICE)
    .filter(([, bit]) => (touched & bit) !== 0)
    .map(([name]) => name)
    .join(" · ");

const clockTime = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

// A window's identity is a UUID, which is unreadable and, more to the point, indistinguishable at a glance
// from the next one. Short it to a handle and give it a hue of its own, so "who did this" is answered by
// colour down the margin of the list rather than by reading eight hex digits per row.
const authorHandle = (author: string): string => author.slice(0, 6);
const authorHue = (author: string): number => {
  let h = 0;
  for (let i = 0; i < author.length; i++)
    h = (h * 31 + author.charCodeAt(i)) % 360;
  return h;
};

export function HistoryPanel() {
  const store = useDocumentStore();
  const snapshot = useDocumentSnapshot();
  const timeline = useDocumentTimeline();
  // One walk at a time. A jump is a run of single-step transitions, and letting a second run start while the
  // first is mid-walk would interleave them into somewhere neither row asked for.
  const [walking, setWalking] = useState(false);

  const done = timeline?.done ?? [];
  const undone = timeline?.undone ?? [];
  const here = done.length; // how many gestures stand applied — the position the document is at

  // Walk to a position, expressed as the number of gestures that should stand applied when we arrive. The
  // authority is asked one step at a time, and a step it refuses ends the walk: that means another window
  // rewrote the history under us, and continuing would be walking a timeline that no longer exists.
  const goTo = async (position: number) => {
    const delta = position - here;
    if (delta === 0 || walking) return;
    setWalking(true);
    // Nothing is done about the other windows' selections: a selection is window-local, so this panel cannot
    // reach one, and a walk can take back the insert that created the selected point. The views that read a
    // selection therefore tolerate its point having gone — see SelectionInfo.
    try {
      for (let i = 0; i < Math.abs(delta); i++) {
        const ok = delta < 0 ? await store.undo() : await store.redo();
        if (!ok) break;
      }
    } finally {
      setWalking(false);
    }
  };

  const saturated = timeline !== null && done.length >= timeline.depth;

  return (
    <div className="card historycard">
      <div className="cap">
        History
        <span className="val">
          {timeline === null
            ? "reading…"
            : `${done.length} applied · ${undone.length} undone · revision ${snapshot.revision}`}
        </span>
      </div>

      <div className="historyacts">
        <Button
          onClick={() => void goTo(here - 1)}
          disabled={!snapshot.canUndo || walking}
          title="Take back the most recent gesture (Ctrl/Cmd-Z in any window on this session)"
        >
          Undo
        </Button>
        <Button
          onClick={() => void goTo(here + 1)}
          disabled={!snapshot.canRedo || walking}
          title="Put back the next undone gesture"
        >
          Redo
        </Button>
        <span className="historyhint">
          {walking ? "walking…" : "click a step to travel to it"}
        </span>
      </div>

      <ol className="historylist">
        {/* The floor of the stack: the state every kept gesture was applied to. It is the session's opening
            state only while the stack has room — at the depth cap the oldest steps have already been dropped,
            and there is no going back past what remains. */}
        <StepRow
          label={saturated ? "Oldest kept state" : "Session start"}
          detail={
            saturated
              ? `older steps beyond the ${timeline.depth}-step limit have been dropped`
              : "the hull this session opened with"
          }
          state={here === 0 ? "current" : "done"}
          disabled={walking}
          onClick={() => void goTo(0)}
        />
        {[...done, ...undone].map((step, i) => (
          <StepRow
            key={step.seq}
            label={step.label}
            detail={`${clockTime(step.at)} · ${sliceNames(step.touched)}`}
            author={step.author}
            self={step.author === store.windowId}
            state={i + 1 === here ? "current" : i < here ? "done" : "undone"}
            kind={step.kind}
            disabled={walking}
            onClick={() => void goTo(i + 1)}
          />
        ))}
      </ol>

      {timeline !== null && done.length === 0 && undone.length === 0 && (
        <p className="historyempty">
          Nothing edited yet. Every window on this session records into this one
          history — edit in one and the gesture shows up here, whoever made it.
        </p>
      )}
    </div>
  );
}

function StepRow({
  label,
  detail,
  author,
  self = false,
  state,
  kind,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly detail: string;
  readonly author?: string;
  readonly self?: boolean;
  readonly state: "done" | "current" | "undone";
  readonly kind?: HistoryStep["kind"];
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <li className={"historystep " + state}>
      <button
        className="historysteprow"
        type="button"
        disabled={disabled || state === "current"}
        title={
          state === "current"
            ? "The document is here"
            : `Travel to this point${kind ? ` (${kind})` : ""}`
        }
        onClick={onClick}
      >
        <span
          className="historydot"
          style={
            author ? { ["--hue" as string]: String(authorHue(author)) } : {}
          }
          aria-hidden="true"
        />
        <span className="historylabel">{label}</span>
        {author && (
          <span
            className={"historyauthor" + (self ? " self" : "")}
            style={{ ["--hue" as string]: String(authorHue(author)) }}
            title={`Made by window ${author}${self ? " — this window" : ""}`}
          >
            {self ? "this window" : authorHandle(author)}
          </span>
        )}
        <span className="historydetail">{detail}</span>
      </button>
    </li>
  );
}
