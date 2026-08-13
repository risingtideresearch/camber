import { useEffect, useRef, useState, type ReactNode } from "react";
import { SLICE, type SliceMask } from "../core/commands";
import type { HistoryStep, HistoryTimeline } from "../document-store/history";
import {
  useDocumentSnapshot,
  useDocumentStore,
  useDocumentTimeline,
} from "./documentStoreHooks";
import "./HistoryPanel.css";

// The history explorer. It exists only as a detached window, and that is the point: the history is the one
// thing in the editor that is not a view of the hull but a view of the SESSION, and it is most useful beside
// the editor rather than inside it — click a moment here and watch the hull move in the window next door.
//
// The history is a tree, because going back and editing again branches rather than truncating, and this panel
// draws it as one: newest at the top, reading down into the past, with the line carrying the newest work
// running straight down the left and every branch beside it indented above the moment it grew from. Nothing
// an exploration abandoned disappears from the drawing, which is what makes wandering off cheap.
//
// The drawing depends on the tree's shape and nothing else — deliberately, and in particular NOT on where the
// document currently stands. Looking around a history is not editing it, and a tree that rearranged itself as
// you browsed would cost you the map you were reading. Travelling therefore only moves the highlight; the
// order changes when the history does, which is when an edit adds a moment to it.
//
// It reads the shared tree (store.timeline(), answered by the session's authority in the SharedWorker) and
// travels by asking the authority to go to a moment. So it needs no privileges: it cannot install a state,
// only name one, and every other window follows because the jump is an ordinary authoritative transition.

// What a gesture was working on, taken from the slices it touched. The document's own division of the hull is
// also the reader's: "stations" is the section editor, "plan" the sheer, "scalars" the waterline and the rake.
// Each keeps a hue of its own, down the dots and in the pills, so a run of work on one part of the boat reads
// as one colour in the margin — which is the thing worth telling apart at a glance. (Which WINDOW made an edit
// is not: a windowId is a UUID, so one person with a panel detached would read as two strangers.)
type Tool = keyof typeof SLICE;
const TOOL_HUE: Record<Tool, number> = {
  plan: 210,
  trim: 168,
  transom: 272,
  stations: 28,
  scalars: 330,
};
const toolsOf = (touched: SliceMask): Tool[] =>
  (Object.keys(SLICE) as Tool[]).filter(
    (tool) => (touched & SLICE[tool]) !== 0,
  );

// When a moment happened, said the way a person would. This is the loudest thing on a row: browsing your own
// history is remembering, and "4 minutes ago" is how a memory is addressed — the clock time is what you check
// afterwards to be sure, so it goes in the tooltip.
//
// The wording, the plurals, "yesterday", and the reader's language are the browser's business, not this
// panel's. Intl formats a value in a given unit; choosing the unit is all that is left to do, so walk down
// from the largest one that fits.
const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STAMP = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
});
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["second", 1000],
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 604_800_000],
  ["month", 2_629_800_000],
  ["year", 31_557_600_000],
];

const relativeTime = (at: number, now: number): string => {
  const elapsed = Math.max(0, now - at);
  // Just-made work needs no counting. The exact second is noise on an edit you watched happen, and a row that
  // ticked 3, 4, 5 while you read it would draw the eye for nothing — so the first twenty seconds are one
  // steady phrase. (Not Intl's to say, but the panel's locale is pinned to English anyway.)
  if (elapsed < 20_000) return "a few seconds ago";
  let [unit, size] = UNITS[0];
  for (const [candidate, ms] of UNITS)
    if (elapsed >= ms) [unit, size] = [candidate, ms];
  return RELATIVE.format(-Math.floor(elapsed / size), unit);
};

/**
 * A clock. Relative times go stale silently, so the panel re-reads them on its own — often enough that the
 * seconds on a fresh edit are not visibly wrong, and no more often than that.
 */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

// ---------- placing the moments ----------
// The authority publishes the history as moments pointing at each other; a reader needs it as an ordered
// drawing. That is this transformation, and it is kept a plain function over the timeline — no hooks, no
// elements — because the property that matters here is a property of the SHAPE, and this is where it can be
// stated: the placement depends on the tree and NOT on where the document stands.

/** Where the document stands relative to a moment: on it, behind it, or somewhere else entirely. */
type MomentState = "past" | "current" | "other";

interface PlacedMoment {
  readonly kind: "moment";
  readonly step: HistoryStep;
  readonly state: MomentState;
}

/** A line that left a moment and was not followed. It is drawn indented, above the moment it left. */
interface PlacedBranch {
  readonly kind: "branch";
  /** The id of the moment the branch starts with — a stable identity for the group. */
  readonly key: number;
  readonly line: readonly Placed[];
  /**
   * Whether the trunk that runs down PAST this group — from the newest line above it to the fork below it — is
   * part of the active line. It is exactly when the fork's next moment is that trunk rather than a branch, so
   * every group hanging off one fork answers the same way.
   */
  readonly onSpine: boolean;
}

type Placed = PlacedMoment | PlacedBranch;

/**
 * The whole drawing, newest first: one line of moments reading from the latest change back into the past,
 * with the branches beside it placed above the moment each grew from. Empty until the first timeline arrives.
 */
function placeHistory(timeline: HistoryTimeline | null): readonly Placed[] {
  if (!timeline || timeline.root === null) return [];
  const byId = new Map(timeline.steps.map((step) => [step.id, step]));
  const root = byId.get(timeline.root);
  if (!root) return [];

  // The line the document stands on: the current moment and every moment behind it. It is what the rows are
  // shaded by — the trail leading to where you are — and nothing else. It must not decide the order.
  const spine = new Set<number>();
  for (let at = timeline.current; at !== null && !spine.has(at);) {
    spine.add(at);
    at = byId.get(at)?.parent ?? null;
  }

  // The depth cap can drop a branch between one look and the next, so a child id is not a promise.
  const childrenOf = (step: HistoryStep): HistoryStep[] =>
    step.children
      .map((id) => byId.get(id))
      .filter((child): child is HistoryStep => child !== undefined);

  // How recent the newest moment below a branch is, which is the whole of the ordering rule at a fork. Step
  // ids only ever count up, so the largest id in a subtree dates it.
  const newestBelow = new Map<number, number>();
  const newest = (step: HistoryStep): number => {
    const known = newestBelow.get(step.id);
    if (known !== undefined) return known;
    let max = step.id;
    for (const child of childrenOf(step)) max = Math.max(max, newest(child));
    newestBelow.set(step.id, max);
    return max;
  };

  // A moment is placed AFTER everything that grew out of it, which is what puts the newest work at the top
  // and leaves the session's opening state at the foot of the list.
  const place = (step: HistoryStep): Placed[] => {
    const line: Placed[] = [];
    const children = childrenOf(step);
    if (children.length > 0) {
      // The trunk is the branch carrying the newest work — where the session is going, which is what a
      // reader wants down the left edge. The others hang above this moment, newest first, so recency reads
      // the same way everywhere.
      const byRecency = [...children].sort((a, b) => newest(b) - newest(a));
      // Whether the document's own line leaves this fork by the trunk, which is what the rail running past
      // every group here is carrying. If it leaves by one of the branches instead, that branch's elbow carries
      // it and this rail is a path not taken.
      const trunkOnSpine = spine.has(byRecency[0].id);
      line.push(...place(byRecency[0]));
      for (const child of byRecency.slice(1))
        line.push({
          kind: "branch",
          key: child.id,
          line: place(child),
          onSpine: trunkOnSpine,
        });
    }
    line.push({
      kind: "moment",
      step,
      state:
        step.id === timeline.current
          ? "current"
          : spine.has(step.id)
            ? "past"
            : "other",
    });
    return line;
  };

  return place(root);
}

/**
 * One line of the drawing: the moments in it, the branches that leave it, and the threads down its left.
 *
 * This is the SHAPE and nothing else. A branch is a list within the list, which is what indents it and lets
 * the threads begin and end at the right dots without any of it being counted out in code; a moment's own
 * contents are the caller's business, and arrive as a function because they differ per row.
 */
function BranchingLine({
  line,
  children,
}: {
  readonly line: readonly Placed[];
  readonly children: (moment: PlacedMoment) => ReactNode;
}) {
  return line.map((placed, i) =>
    placed.kind === "branch" ? (
      <li
        className={"historybranchwrap" + (placed.onSpine ? " onspine" : "")}
        key={`branch-${placed.key}`}
      >
        <ol className="historybranch">
          <BranchingLine line={placed.line}>{children}</BranchingLine>
        </ol>
      </li>
    ) : (
      // The ends of a list have nothing beside them, so a thread there stops at the dot rather than dangling
      // past it. Position is all this line knows about its own ends, so it is what says so.
      <MomentRow
        key={placed.step.id}
        moment={placed}
        above={i > 0}
        below={i < line.length - 1}
      >
        {children(placed)}
      </MomentRow>
    ),
  );
}

/**
 * One moment, as a row.
 *
 * Its thread is drawn in two halves, above and below its dot, because the two answer differently — the
 * document's own line reaches the current moment from below and stops there. Which half is SOLID is the same
 * reading as the dots, one row's worth apart:
 *   • below the dot is the link to the moment this one was made from, so it is the active line whenever the
 *     document is standing on this moment or has come through it;
 *   • above the dot is the link on towards a later moment, which the active line only takes if the document
 *     went further — so it is solid on the moments behind the document and not on the one it stands on.
 *
 * The row also brings itself into view when the document arrives on it: a jump can land on a moment far
 * outside the visible part of a long history, and the row that knows it is the current one is the one placed
 * to say so. Having it scroll itself is what keeps the ref where it is used — handed down instead, every line
 * in the drawing would carry something only one row in the whole of it will ever need.
 */
function MomentRow({
  moment,
  above,
  below,
  children,
}: {
  readonly moment: PlacedMoment;
  /** Whether a moment is drawn immediately above / below this one, and so whether that half of the thread. */
  readonly above: boolean;
  readonly below: boolean;
  readonly children: ReactNode;
}) {
  const row = useRef<HTMLLIElement>(null);
  const current = moment.state === "current";
  useEffect(() => {
    if (current) row.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <li ref={row} className={"historystep " + moment.state}>
      {above && (
        <span
          className={
            "historythread up" + (moment.state === "past" ? " onspine" : "")
          }
          aria-hidden="true"
        />
      )}
      {below && (
        <span
          className={
            "historythread down" + (moment.state === "other" ? "" : " onspine")
          }
          aria-hidden="true"
        />
      )}
      {children}
    </li>
  );
}

export function HistoryPanel() {
  const store = useDocumentStore();
  const snapshot = useDocumentSnapshot();
  const timeline = useDocumentTimeline();
  const now = useNow(5_000);
  // One jump at a time. A second request sent while the first is in flight would land the document wherever
  // the two happened to settle, which is neither of the moments the reader clicked.
  const [jumping, setJumping] = useState(false);

  const jumpTo = async (id: number) => {
    if (jumping) return;
    setJumping(true);
    // Nothing is done about the other windows' selections: a selection is window-local, so this panel cannot
    // reach one, and a jump can take back the insert that created the selected point. The views that read a
    // selection therefore tolerate its point having gone — see SelectionInfo.
    try {
      await store.travel(id);
    } finally {
      setJumping(false);
    }
  };

  const steps = timeline?.steps ?? [];
  const edits = Math.max(0, steps.length - 1);
  const tips = steps.filter((step) => step.children.length === 0).length;

  return (
    <div className="card historycard">
      <div className="cap">
        History
        <span className="val">
          {timeline === null
            ? "reading…"
            : `${edits} ${edits === 1 ? "edit" : "edits"} · ${tips} ${
                tips === 1 ? "branch" : "branches"
              } · revision ${snapshot.revision}`}
        </span>
      </div>

      {/* No Undo or Redo here: in this window they would be a weaker copy of the drawing below them. The row
          under the current moment IS one step back, the row above is one forward, and a click reaches any
          moment at all — including one on a branch, which no pair of buttons can say. Every OTHER window
          carries them instead (HistoryControls), and Ctrl/Cmd-Z still works in this one. */}
      <div className="historyacts">
        <span className="historyhint">
          {jumping ? "travelling…" : "click a moment to jump to it"}
        </span>
      </div>

      {/* Where every moment goes is decided in placeHistory, and how the lines and threads are drawn in
          BranchingLine. All that is left for the panel is what one moment says. */}
      <ol className="historylist">
        <BranchingLine line={placeHistory(timeline)}>
          {({ step, state }) => (
            <StepRow
              step={step}
              state={state}
              root={step.parent === null}
              truncated={timeline?.truncated ?? false}
              now={now}
              disabled={jumping}
              onClick={() => void jumpTo(step.id)}
            />
          )}
        </BranchingLine>
      </ol>

      {timeline !== null && edits === 0 && (
        <p className="historyempty">
          Nothing edited yet. Every window on this session records into this one
          history — edit in one and the gesture shows up here, whoever made it.
          Go back and edit again and the history branches rather than forgetting
          what came after.
        </p>
      )}
    </div>
  );
}

function StepRow({
  step,
  state,
  root,
  truncated,
  now,
  disabled,
  onClick,
}: {
  readonly step: HistoryStep;
  readonly state: MomentState;
  readonly root: boolean;
  readonly truncated: boolean;
  readonly now: number;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const tools = toolsOf(step.touched);
  // The root is the state everything else was built on. Normally that is where the session opened; once the
  // depth cap has started dropping moments it is only the oldest one still kept, and saying so matters —
  // there is no going back past it.
  const what =
    root && truncated
      ? `${step.label} — the oldest moment still kept`
      : step.label;

  return (
    <button
      className="historysteprow"
      type="button"
      disabled={disabled || state === "current"}
      title={
        state === "current"
          ? `The document is here — ${STAMP.format(step.at)}`
          : `Jump to this moment — ${STAMP.format(step.at)}${step.kind ? ` (${step.kind})` : ""}`
      }
      onClick={onClick}
    >
      <span
        className={"historydot" + (tools.length === 0 ? " plain" : "")}
        style={
          tools.length
            ? { ["--hue" as string]: String(TOOL_HUE[tools[0]]) }
            : {}
        }
        aria-hidden="true"
      />
      <span className="historywhen">{relativeTime(step.at, now)}</span>
      <span className="historytools">
        {tools.map((tool) => (
          <span
            key={tool}
            className="historytool"
            style={{ ["--hue" as string]: String(TOOL_HUE[tool]) }}
            title={`This gesture changed the ${tool} of the hull`}
          >
            {tool}
          </span>
        ))}
      </span>
      <span className="historywhat">{what}</span>
    </button>
  );
}
