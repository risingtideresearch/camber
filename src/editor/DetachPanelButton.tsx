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
// It is therefore the ONLY way a panel window is opened, and the editor is the only window that opens one:
// in a detached window the panel already IS the window, so its button disappears rather than reloading it,
// and the window offers no route to the other panel either — a panel is a second look at the hull, not a
// place to navigate from.
export function DetachPanelButton({ kind }: { readonly kind: PanelKind }) {
  if (THIS_WINDOW === kind) return null;
  const spec = PANELS[kind];
  return (
    <Button
      className="detachbtn"
      title={spec.hint}
      aria-label={`Open ${spec.title} in its own window`}
      onClick={() => openPanelWindow(kind)}
    >
      ⧉
    </Button>
  );
}
