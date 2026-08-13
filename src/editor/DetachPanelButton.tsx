import { Button } from "../components/Button";
import { PANELS, openPanelWindow, panelKindFromUrl } from "./externalPanels";
import type { PanelKind } from "./externalPanels";

// Which panel, if any, this whole window IS. Read once: nothing rewrites `panel` in the URL for the life of
// the window (the editor's replaceState only ever touches `id` and `session`).
const THIS_WINDOW = panelKindFromUrl();

// The button a panel carries to open a second copy of ITSELF in a window of its own. It lives on the panel
// rather than in an app bar because that is where the answer to "in a window, this one?" is: the reader is
// already looking at the thing they want more room for, and a bar of "… window" buttons would make them match
// a name to a pane first.
//
// In a detached window the panel already IS the window, so its button disappears rather than reloading it,
// and that window offers no route to the OTHER views of the hull either: a panel is a second look at the
// hull, not a place to navigate from, and a bar of openers in every window is how you end up with four of
// everything.
//
// The history is the exception, and it is one because it is not a view of the hull at all: it is the session's
// own window, there is exactly one of it per session, and opening it twice raises the window already there
// (openPanelWindow names the window). So its opener travels with Undo and Redo in HistoryControls and appears
// in every window but its own — nothing is duplicated by reaching it from wherever you happen to be working.
// `label` is for the one button that sits in the app bar instead of on a panel: the history has no pane of its
// own, so a bare ⧉ there would name nothing. On a panel the glyph alone is enough — the pane under it says
// which view is being opened.
export function DetachPanelButton({
  kind,
  label,
}: {
  readonly kind: PanelKind;
  readonly label?: string;
}) {
  if (THIS_WINDOW === kind) return null;
  const spec = PANELS[kind];
  return (
    <Button
      className="detachbtn"
      title={spec.hint}
      aria-label={`Open ${spec.title} in its own window`}
      onClick={() => openPanelWindow(kind)}
    >
      {label}
      {label && " "}⧉
    </Button>
  );
}
