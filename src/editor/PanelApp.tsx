import { useEffect } from "react";
import { CurvatureControls } from "./CurvatureControls";
import { useDocumentSnapshot } from "./documentStoreHooks";
import { DocumentStoreProvider } from "./DocumentStoreProvider";
import { EditorUiProvider } from "./editorUi";
import { joinedSessionFromUrl } from "./editorSession";
import { PANELS, panelKindFromUrl, type PanelKind } from "./externalPanels";
import { HistoryControls } from "./HistoryControls";
import { HistoryPanel } from "./HistoryPanel";
import { HullView3d } from "./HullView3d";
import { SelectionInfo } from "./SelectionInfo";
import { StationsGrid } from "./StationsGrid";
import { StabilityPanel } from "./StabilityPanel";
import { Toolbar } from "./Toolbar";
import { WeightPanel } from "./weight/WeightPanel";
import "./EditorApp.css";
import "./PanelApp.css";

// A detached panel window: one panel of the editor, on the editor's session, in a window of its own.
//
// This is the payoff of making the panels prop-free (see editorUi). The window is the editor's two providers
// and ONE panel underneath them — no props to thread, no parent to supply them, and no second copy of the
// document, because DocumentStoreProvider joins the session named in the URL rather than starting one.
//
// It is deliberately not a second editor. There is no Save, no Revert, no name field and no beforeunload
// guard: the document belongs to the session, the editor window that owns it does the saving, and a panel
// that prompted "discard unsaved changes?" on close would be lying — closing it discards nothing.

const panelSession = joinedSessionFromUrl();
const panelKind = panelKindFromUrl();

export function PanelApp() {
  if (!panelSession || !panelKind)
    return (
      <div className="app panelblank">
        <p>
          This window shows one panel of a Camber editing session. Open it from
          an editor window — on its own it has no session to show.
        </p>
      </div>
    );
  return (
    <DocumentStoreProvider session={panelSession}>
      <EditorUiProvider>
        <Panel kind={panelKind} />
      </EditorUiProvider>
    </DocumentStoreProvider>
  );
}

function Panel({ kind }: { readonly kind: PanelKind }) {
  const { meta } = useDocumentSnapshot();
  const spec = PANELS[kind];

  // The design's name is shared server state, so a rename in the editor retitles this window too.
  useEffect(() => {
    document.title = `${spec.title} — ${meta.name || "Untitled"} — Camber`;
  }, [spec.title, meta.name]);

  return (
    <div className="app">
      <div className="appbar">
        <span className="panelcap">{spec.title}</span>
        <span className="paneldesign">{meta.name || "Untitled"}</span>
        <PanelControls kind={kind} />
      </div>
      <div className="main">
        {meta.initialized && <PanelBody kind={kind} />}
      </div>
    </div>
  );
}

// The window's one panel. A switch rather than a lookup table, so adding a kind to PanelKind fails to compile
// until this window knows what to draw for it.
function PanelBody({ kind }: { readonly kind: PanelKind }) {
  switch (kind) {
    case "view3d":
      return <HullView3d />;
    case "stations":
      return <StationsGrid />;
    case "history":
      return <HistoryPanel />;
    case "stability":
      return <StabilityPanel />;
    case "weights":
      return <WeightPanel />;
  }
}

// What each panel's bar needs, which is only what the panel itself uses, followed by the session's own
// controls. Each case opens with its own separator, so the kind that needs nothing leaves none dangling after
// the design's name.
//
// HistoryControls goes LAST in every bar, after the controls of the view: undo does not belong to the pane
// under it, and putting it beside the drawing tools would read as one more of them.
function PanelControls({ kind }: { readonly kind: PanelKind }) {
  switch (kind) {
    // The station grid is an EDITOR — points are added and selected in it — so it carries the tool toolbar
    // and the selection readout.
    case "stations":
      return (
        <>
          <span className="tabsep" />
          <Toolbar />
          <SelectionInfo />
          <span className="tabsep" />
          <CurvatureControls />
          <span className="tabsep" />
          <HistoryControls />
        </>
      );
    // The 3D view is a look at the hull: nothing to select, but the combs are drawn on it.
    case "view3d":
      return (
        <>
          <span className="tabsep" />
          <CurvatureControls />
          <span className="tabsep" />
          <HistoryControls />
        </>
      );
    // The history draws no hull, and needs no miniature of itself: the tree IS undo and redo — the row below
    // the current moment is one step back, and a click reaches any moment rather than only the next one.
    case "history":
    case "stability":
    case "weights":
      return null;
  }
}
