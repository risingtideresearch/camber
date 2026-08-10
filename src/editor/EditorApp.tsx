import { useCallback, useEffect, useRef, useState } from "react";
import { isDirty, type HullStore } from "../core/store";
import { connectHullStore } from "../core/workerStore";
import { StoreContext, useHullStore, useSnapshot } from "./hullStore";
import { EditorUiProvider, useEditorUi } from "./editorUi";
import { defaultHull } from "../core/hull";
import {
  isUnsaved,
  openDesign,
  openedName,
  revertTo,
  saveView,
  type SaveView,
} from "./save";
import { Toolbar } from "./Toolbar";
import { SelectionInfo } from "./SelectionInfo";
import { TrimControls } from "./TrimControls";
import { CurvatureControls } from "./CurvatureControls";
import { PerfControls } from "./PerfControls";
import { PerfPanel } from "./PerfPanel";
import { DesignBar } from "./DesignBar";
import { HullView3d } from "./HullView3d";
import { PlanView } from "./PlanView";
import { ProfileView } from "./ProfileView";
import { StationView } from "./StationView";
import { CutStationView } from "./CutStationView";
import { StlControl } from "../components/StlControl";
import { Area, AreaGroup, AreaSeparator } from "polymorph-ui";
import "./EditorApp.css";

// The editor's window owns the hull, and wraps everything below it in the two providers a panel needs: the
// STORE (the hull, shared with every other window from phase 5) and the window's own UI state. Every panel
// under them takes no props at all — which is the point, because in phase 6 a panel moves into a window of
// its own, where there is no parent left to hand it anything.
const sessionFromUrl = (): string => {
  const url = new URL(window.location.href);
  const explicit = url.searchParams.get("session");
  if (explicit) return explicit;
  const design = url.searchParams.get("id");
  const session = design
    ? `design:${design}`
    : `scratch:${crypto.randomUUID()}`;
  url.searchParams.set("session", session);
  history.replaceState(null, "", url);
  return session;
};

export function EditorApp() {
  const [connection, setConnection] = useState<{
    store: HullStore;
    fresh: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let store: HullStore | undefined;
    void connectHullStore({ sessionId: sessionFromUrl() }).then(
      (connected) => {
        store = connected.store;
        if (active) setConnection({ store, fresh: connected.fresh });
        else store.close?.();
      },
      (reason) =>
        active &&
        setError(reason instanceof Error ? reason.message : String(reason)),
    );
    const unload = () => store?.close?.();
    window.addEventListener("pagehide", unload);
    return () => {
      active = false;
      window.removeEventListener("pagehide", unload);
      store?.close?.();
    };
  }, []);
  if (error)
    return (
      <div className="app">Could not connect to the hull owner: {error}</div>
    );
  if (!connection) return <div className="app" />;
  return (
    <StoreContext.Provider value={connection.store}>
      <EditorUiProvider>
        <Editor fresh={connection.fresh} />
      </EditorUiProvider>
    </StoreContext.Provider>
  );
}

function Editor({ fresh }: { fresh: boolean }) {
  const store = useHullStore();
  const snapshot = useSnapshot();
  const dirty = isDirty(snapshot);
  const { perf, setSelection } = useEditorUi();

  // the views are mounted only once boot has settled the hull, so nothing draws the default hull before a
  // URL design (?id=) finishes loading — the columns are sized by flex/layout, so mounting causes no reflow.
  const [booted, setBooted] = useState(false);

  const { meta } = snapshot;
  // "Saving…" / "Saved ✓" briefly overrides the steady indicator, which is derived from shared owner state.
  const [flash, setFlash] = useState<SaveView | null>(null);
  const save = flash ?? saveView(dirty, meta);

  // Window-level listeners read the latest shared save state without being reinstalled after every publish.
  const metaRef = useRef(meta);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    metaRef.current = meta;
    dirtyRef.current = dirty;
  }, [meta, dirty]);

  // ---------- boot: load the URL design (if any) once ----------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // An already-live session carries both its hull and backend identity. A second window only mounts it.
      if (!fresh) {
        setSelection(null);
        setBooted(true);
        return;
      }
      const rowId = new URLSearchParams(window.location.search).get("id");
      if (rowId) {
        try {
          const opened = await openDesign(rowId);
          if (cancelled) return;
          await store.dispatch({ type: "installHull", state: opened.state });
          // The identity keeps the row's OWN name: an older document opens under a converted title, which
          // differs from it, so the editor starts out a fork — saving writes a new v2 row and leaves the
          // original untouched. For an up-to-date document the two are the same and Save overwrites.
          const title = openedName(opened.name, opened.version);
          await store.dispatchMeta({
            type: "initializeDesign",
            currentId: rowId,
            savedName: opened.name,
            name: title,
            savedState: opened.state,
          });
        } catch (e) {
          if (cancelled) return; // a cleaned-up run must not clobber a newer run's load
          console.error("open design failed:", e);
          alert(
            "Couldn't open that design: " +
              (e instanceof Error ? e.message : String(e)),
          );
          // discard any partial load; fall back to a clean default hull
          await store.dispatch({ type: "installHull", state: defaultHull() });
          await store.dispatchMeta({
            type: "initializeDesign",
            currentId: null,
            savedName: null,
            name: "",
            savedState: store.snapshot().state,
          });
        }
      } else {
        await store.dispatchMeta({
          type: "initializeDesign",
          currentId: null,
          savedName: null,
          name: "",
          savedState: store.snapshot().state,
        });
      }
      if (cancelled) return;
      setSelection(null);
      setBooted(true); // now mount the views and let them draw the settled hull
    })();
    return () => {
      cancelled = true;
    };
  }, [store, setSelection, fresh]);

  // ---------- save: browser prompts; the owner captures, serializes, builds, and writes ----------
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
      const result = await store.save(name);
      if (result.created) {
        const url = new URL(window.location.href);
        url.searchParams.set("id", result.currentId);
        history.replaceState(null, "", url);
      }
      setFlash({ buttonLabel: "Save", kind: "saved", text: "Saved ✓" });
      window.setTimeout(() => setFlash(null), 1400);
    } catch (e) {
      setFlash({ buttonLabel: "Save", kind: "dirty", text: "Save failed" });
      alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [store, setFlash]);

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

  // ---------- keep this window's title and backend URL in sync with shared owner identity ----------
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
    if (!current.name.trim() && saved != null)
      void store.dispatchMeta({ type: "setName", name: saved });
  };
  // Revert is one `installHull`, which means it is itself undoable — a slip of the hand is recoverable now.
  const onRevert = () => {
    const state = revertTo(dirty, meta);
    if (!state) return;
    setSelection(null);
    void store.dispatch({ type: "installHull", state });
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
        <DesignBar
          name={meta.name}
          saveKind={save.kind}
          saveText={save.text}
          saveLabel={save.buttonLabel}
          saving={meta.saving}
          onName={(name) => void store.dispatchMeta({ type: "setName", name })}
          onNameBlur={onNameBlur}
          onSave={() => void doSave()}
          onRevert={onRevert}
          onClose={onClose}
        />
        <span className="tabsep" />
        <StlControl />
      </div>
      <div className="main">
        {booted && meta.initialized && (
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
