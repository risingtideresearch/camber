import { useCallback, useEffect, useRef, useState } from "react";
import { isDirty } from "../document-store/snapshot";
import {
  useDocumentDispatch,
  useDocumentSave,
  useDocumentSnapshot,
} from "./documentStoreHooks";
import { DocumentStoreProvider } from "./DocumentStoreProvider";
import { sessionDescriptorFromUrl } from "./editorSession";
import { EditorUiProvider, useEditorUi } from "./editorUi";
import { isUnsaved, revertTo, saveView, type SaveView } from "./save";
import { Toolbar } from "./Toolbar";
import { SelectionInfo } from "./SelectionInfo";
import { TrimControls } from "./TrimControls";
import { CurvatureControls } from "./CurvatureControls";
import { PerfControls } from "./PerfControls";
import { HistoryControls } from "./HistoryControls";
import { PerfPanel } from "./PerfPanel";
import { DesignBar } from "./DesignBar";
import { HullView3d } from "./HullView3d";
import { PlanView } from "./PlanView";
import { ProfileView } from "./ProfileView";
import { StationView } from "./StationView";
import { CutStationView } from "./CutStationView";
import { StlControl } from "../components/StlControl";
import { DetachPanelButton } from "./DetachPanelButton";
import { Area, AreaGroup, AreaSeparator } from "polymorph-ui";
import "./EditorApp.css";

const editorSession = sessionDescriptorFromUrl();

/**
 * Say once, per window, that the weight sheet has nowhere to be stored.
 *
 * Once rather than per save: it is a property of the database, so it will be true of every save until someone
 * runs the migration, and a dialog on each one would be nagging about something the user may not be able to
 * fix from here. The save button keeps saying it in the meantime.
 */
let warnedAboutWeights = false;
function warnOnceAboutWeights(): void {
  if (warnedAboutWeights) return;
  warnedAboutWeights = true;
  alert(
    "The hull was saved, but the weight estimate was not: this database has no `weights` column.\n\n" +
      "Run this once, then save again:\n\n" +
      "    alter table designs add column weights jsonb;",
  );
}

export function EditorApp() {
  return (
    <DocumentStoreProvider session={editorSession}>
      <EditorUiProvider>
        <Editor />
      </EditorUiProvider>
    </DocumentStoreProvider>
  );
}

function Editor() {
  const snapshot = useDocumentSnapshot();
  const dispatch = useDocumentDispatch();
  const { saveDocument, setDocumentName } = useDocumentSave();
  const dirty = isDirty(snapshot);
  const { perf, setSelection } = useEditorUi();

  const { meta } = snapshot;
  // "Saving…" / "Saved ✓" briefly overrides the steady indicator, which is derived from shared server state.
  const [flash, setFlash] = useState<SaveView | null>(null);
  const save = flash ?? saveView(dirty, meta);

  // Window-level listeners read the latest shared save state without being reinstalled after every publish.
  const metaRef = useRef(meta);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    metaRef.current = meta;
    dirtyRef.current = dirty;
  }, [meta, dirty]);

  // ---------- save: browser prompts; the store server captures and the persistence coordinator writes ----------

  const doSave = useCallback(async () => {
    const current = metaRef.current;
    if (current.saving) return;
    let name = current.name.trim();
    if (current.design.currentId === null && !name) {
      name = prompt("Name this design:", "")?.trim() ?? "";
      if (!name) return;
    }
    setFlash({ buttonLabel: "Save", kind: "", text: "Saving…" });
    try {
      const result = await saveDocument(name);
      if (result.created) {
        const url = new URL(window.location.href);
        url.searchParams.set("id", result.currentId);
        history.replaceState(null, "", url);
      }
      // A save that could not store the weight sheet is not a clean save, and must not read as one: the hull
      // is safely written but the estimate is not, and the only fix is a migration the user has to run.
      if (!result.weightsStored) {
        setFlash({
          buttonLabel: "Save",
          kind: "dirty",
          text: "Saved — without weights",
        });
        warnOnceAboutWeights();
      } else {
        setFlash({ buttonLabel: "Save", kind: "saved", text: "Saved ✓" });
        window.setTimeout(() => setFlash(null), 1400);
      }
    } catch (e) {
      setFlash({ buttonLabel: "Save", kind: "dirty", text: "Save failed" });
      alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [saveDocument, setFlash]);

  // ---------- Ctrl/Cmd-S + beforeunload ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave();
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isUnsaved(dirtyRef.current, metaRef.current)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [doSave]);

  // ---------- keep this window's title and backend URL in sync with shared server identity ----------
  useEffect(() => {
    document.title = `${meta.name || "Untitled"} — Camber`;
  }, [meta.name]);
  useEffect(() => {
    const id = meta.design.currentId;
    if (!id) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("id") === id) return;
    url.searchParams.set("id", id);
    history.replaceState(null, "", url);
  }, [meta.design.currentId]);

  // ---------- handlers ----------
  // blanking the title on an existing design restores the saved name (a name is required to save)
  const onNameBlur = () => {
    const current = metaRef.current;
    const saved = current.design.savedName;
    if (!current.name.trim() && saved != null) void setDocumentName(saved);
  };
  // Revert is `installHull` plus `installSheet`, which means it is itself undoable — a slip of the hand is
  // recoverable now. Both parts go back: reverting the hull and leaving a half-typed weight sheet standing
  // would not be a revert.
  const onRevert = () => {
    const saved = revertTo(dirty, meta);
    if (!saved) return;
    setSelection(null);
    void dispatch({ type: "installHull", state: saved.hull });
    void dispatch({ type: "installSheet", book: saved.weights });
  };
  const onClose = () => {
    if (
      isUnsaved(dirty, meta) &&
      !confirm("Discard unsaved changes and return to the library?")
    )
      return;
    window.location.href = "library.html";
  };

  return (
    <div className="app">
      <div className="appbar">
        <Toolbar />
        <SelectionInfo />
        <span className="tabsep" />
        <TrimControls />
        <CurvatureControls />
        <PerfControls />
        {/* Undo, Redo, and the opener for the whole history. They come after the separator because they are
            not controls of any view in this window: they act on the session, which is also why the history
            has no pane here to hang a ⧉ off — it is a window and nothing else. */}
        <span className="tabsep" />
        <HistoryControls />
        <DesignBar
          name={meta.name}
          saveKind={save.kind}
          saveText={save.text}
          saveLabel={save.buttonLabel}
          saving={meta.saving}
          onName={(name) => void setDocumentName(name)}
          onNameBlur={onNameBlur}
          onSave={() => void doSave()}
          onRevert={onRevert}
          onClose={onClose}
        />
        <span className="tabsep" />
        <DetachPanelButton kind="stability" label="Stability" />
        <DetachPanelButton kind="weights" label="Weights" />
        <StlControl />
      </div>
      <div className="main">
        {meta.initialized && (
          // Resizable layout: three independent columns — plan / profile, the section editor, and the 3D
          // view / live cut station. Drag any separator to resize. (The middle column used to be split with
          // the blend-weights strip below the section editor; v2 has no blend, so the section editor takes
          // the column: a station's position along the hull is now its own handle on the plan curve.)
          <AreaGroup className="areagroup" orientation="horizontal">
            {/* The performance readout takes a column of its own rather than floating over a view: its
                numbers are read WHILE dragging something in another view, so it must not cover one. The
                column exists only while the toggle is on, and the other columns' sizes are relative, so
                they simply give up a proportional share of the width to it and take it back afterwards. */}
            {perf.on && (
              <>
                <Area className="area" defaultSize="22%" minSize="240px">
                  <PerfPanel />
                </Area>
                <AreaSeparator className="areasep" />
              </>
            )}
            <Area className="area" defaultSize="50%">
              <AreaGroup className="areagroup" orientation="vertical">
                <Area className="area" defaultSize="50%">
                  <PlanView />
                </Area>
                <AreaSeparator className="areasep" />
                <Area className="area" defaultSize="50%">
                  <ProfileView />
                </Area>
              </AreaGroup>
            </Area>
            <AreaSeparator className="areasep" />
            <Area className="area" defaultSize="25%" minSize="200px">
              <StationView />
            </Area>
            <AreaSeparator className="areasep" />
            <Area className="area" defaultSize="25%" minSize="200px">
              <AreaGroup className="areagroup" orientation="vertical">
                <Area className="area" defaultSize="50%">
                  <HullView3d />
                </Area>
                <AreaSeparator className="areasep" />
                <Area className="area" defaultSize="50%">
                  <CutStationView />
                </Area>
              </AreaGroup>
            </Area>
          </AreaGroup>
        )}
      </div>
    </div>
  );
}
