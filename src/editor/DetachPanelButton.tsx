import { OpenPanelButton } from "./OpenPanelButton";
import { panelKindFromUrl, type PanelKind } from "./externalPanels";

// The panel identity does not change during the lifetime of a window.
const THIS_WINDOW = panelKindFromUrl();

/** Detaching uses the standard panel opener, but hides when already detached. */
export function DetachPanelButton({
  kind,
  label,
}: {
  readonly kind: PanelKind;
  readonly label?: string;
}) {
  if (THIS_WINDOW === kind) return null;
  return <OpenPanelButton kind={kind} label={label} iconOnly={!label} />;
}
