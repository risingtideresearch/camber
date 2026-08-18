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
// Window-only panels are the exception: History travels with Undo and Redo, and Stability is opened from the
// main editor. `label` is for these app-bar buttons, which have no pane underneath to name them; on a panel the
// glyph alone is enough because the pane says which view is being opened. openPanelWindow names every window,
// so opening the same kind twice raises it rather than duplicating it.
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
