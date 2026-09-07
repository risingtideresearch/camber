import { useState } from "react";
import { Button } from "../components/Button";
import { PANELS, openPanelWindow, type PanelKind } from "./externalPanels";
import { takePanelsToReopen } from "./panelLifecycle";

// The one-click way back to the window layout the last Close tore down (see panelLifecycle). Closing a
// document closes its detached panels; a user with a 3D view and a weight sheet parked on other monitors
// should not have to rebuild that arrangement by hand for every document they open next.
//
// Consumed at module load, once per editor page: the offer belongs to the page that was loaded right after
// the close. An ignored offer disappears on the next reload rather than sitting in the bar for weeks, and a
// second editor tab opened later gets no stale offer.
const OFFERED = takePanelsToReopen();

// Opening N windows from one click is exactly what pop-up blockers exist to stop: browsers typically spend
// the click's activation on the first window.open and return null for the rest. So the button opens what it
// can, keeps only what was blocked, and stays for another click — each click is a fresh activation, so the
// next window gets through. With no blocker it is one click; with one it is a click per panel; either way it
// vanishes when the layout is back.
export function ReopenPanelsButton() {
  const [kinds, setKinds] = useState<readonly PanelKind[]>(OFFERED);
  if (kinds.length === 0) return null;
  const titles = kinds.map((kind) => PANELS[kind].title);
  const label =
    kinds.length === 1
      ? `Reopen ${titles[0]}`
      : `Reopen ${kinds.length} panels`;
  return (
    <Button
      title={
        `Open the panel windows that were up when the last document closed — ${titles.join(", ")} — ` +
        "on this document. If a pop-up blocker lets only one through, click again for the rest."
      }
      onClick={() => setKinds(kinds.filter((kind) => !openPanelWindow(kind)))}
    >
      {label} ⧉
    </Button>
  );
}
