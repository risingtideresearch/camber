import { Button } from "../components/Button";
import { ButtonGroup } from "../components/ButtonGroup";
import { DetachPanelButton } from "./DetachPanelButton";
import { useDocumentHistory } from "./documentStoreHooks";
import "./HistoryControls.css";

// The history in miniature: step back, step forward again, or open the whole tree in a window of its own.
//
// It is the same three things the history panel is, collapsed to the width of an app bar — which is why the
// panel itself does not carry it. A window either shows the history or offers this; the one window already
// showing it needs neither the buttons (the row below the current moment IS undo, and a click reaches any
// moment, not just the neighbouring one) nor an opener for the window you are standing in.
//
// Both buttons act on the SESSION, not on this window: they take back the last gesture whoever made it, in
// whichever window. That is already how Ctrl/Cmd-Z behaves in every window on the session — the buttons only
// make it visible, and say so in their tooltips, because a bar in a detached panel is an easy place to forget
// that the document is shared.

// The two directions of one axis, so they are drawn as one joined control and carry the arrows every editor
// draws them with rather than their names. (View3d.css sets out when a joined bar is right: a pick-one choice
// is joined, an independent toggle stays a standalone rounded button, because two lit segments would read as
// a broken radio group. These are neither — they are momentary actions with no lit state at all, and joining
// them says the true thing about them, which is that they are one movement taken in either direction.)
//
// The opener stays separate, and keeps its name: it does not move the document, it opens a window.
const UNDO_PATH =
  "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z";
const REDO_PATH =
  "M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.06-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z";

function StepIcon({ d }: { readonly d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function HistoryControls() {
  const { canUndo, canRedo, undo, redo } = useDocumentHistory();
  return (
    <div className="historyctl">
      <ButtonGroup className="undoredo">
        <Button
          onClick={() => void undo()}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo — take back the most recent gesture on this session, whichever window made it (Ctrl/Cmd-Z)"
        >
          <StepIcon d={UNDO_PATH} />
        </Button>
        <Button
          onClick={() => void redo()}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo — go forward again along the branch you last travelled (Ctrl/Cmd-Shift-Z)"
        >
          <StepIcon d={REDO_PATH} />
        </Button>
      </ButtonGroup>
      <DetachPanelButton kind="history" label="History" />
    </div>
  );
}
