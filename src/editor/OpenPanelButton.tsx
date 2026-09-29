import { Button } from "../components/Button";
import { PANELS, openPanelWindow, type PanelKind } from "./externalPanels";
import "./OpenPanelButton.css";

/** Navigation opens/focuses a panel without changing its analysis selection. */
export function OpenPanelButton({
  kind,
  label,
  iconOnly = false,
  weightScreen,
}: {
  readonly kind: PanelKind;
  readonly label?: string;
  readonly iconOnly?: boolean;
  readonly weightScreen?: "sheet" | "loading";
}) {
  const spec = PANELS[kind];
  const caption = label ?? `Open ${spec.title}`;
  return (
    <Button
      className="openpanelbtn"
      title={spec.hint}
      aria-label={`${caption} in a separate window`}
      onClick={() => openPanelWindow(kind, weightScreen)}
    >
      {!iconOnly && <span>{caption}</span>}
      <span aria-hidden="true">⧉</span>
    </Button>
  );
}
