import { useCallback, useEffect, useRef, useState } from "react";
import { isDirty, type HullStore } from "../core/store";
import { connectHullStore } from "../core/workerStore";
import { StoreContext, useHullStore, useSnapshot } from "./hullStore";
import { EditorUiProvider, useEditorUi } from "./editorUi";
import { defaultHull } from "../core/hull";
import { buildJson } from "../core/json";
import {
  isUnsaved,
  newDesignId,
  openDesign,
  openedName,
  revertTo,
  saveDesign,
  saveView,
  type DesignId,
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

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  // The design identity, and the transient "Saving…" / "Saved ✓" that briefly overrides the steady indicator.
  // The steady one is derived, not polled: `revision !== savedRevision` is exact and costs nothing.
  const [designId, setDesignId] = useState<DesignId>(newDesignId);
  const [flash, setFlash] = useState<SaveView | null>(null);
  const save = flash ?? saveView(dirty, designId, name);

  // A few values the window listeners and the async save read at their latest, kept in refs so those one-time
  // effects never re-subscribe. Written after commit, which is when the handlers can first run.
  const idRef = useRef(designId);
  const nameRef = useRef(name);
  const dirtyRef = useRef(dirty);
  const savingRef = useRef(false);
  useEffect(() => {
    idRef.current = designId;
    nameRef.current = name;
    dirtyRef.current = dirty;
  }, [designId, name, dirty]);

  // ---------- boot: load the URL design (if any) once ----------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // An already-live session is authoritative. A second window must not overwrite its hull with the
      // backend's last saved document.
      if (!fresh) {
        const rowId = new URLSearchParams(window.location.search).get("id");
        if (rowId) {
          try {
            // Load only the backend identity here. The worker's live hull remains authoritative.
            const opened = await openDesign(rowId);
            if (cancelled) return;
            setDesignId({
              currentId: rowId,
              savedName: opened.name,
              savedDocument: opened.document,
            });
            setName(openedName(opened.name, opened.version));
          } catch (e) {
            console.error("recover design identity failed:", e);
          }
        }
        if (cancelled) return;
        setSelection(null);
        setBooted(true);
        return;
      }
      const rowId = new URLSearchParams(window.location.search).get("id");
      let id: DesignId = { ...newDesignId(), savedDocument: "" };
      if (rowId) {
        try {
          const opened = await openDesign(rowId);
          if (cancelled) return;
          await store.dispatch({ type: "installHull", state: opened.state });
          // The identity keeps the row's OWN name: an older document opens under a converted title, which
          // differs from it, so the editor starts out a fork — saving writes a new v2 row and leaves the
          // original untouched. For an up-to-date document the two are the same and Save overwrites.
          const title = openedName(opened.name, opened.version);
          id = {
            currentId: rowId,
            savedName: opened.name,
            savedDocument: opened.document,
          };
          setName(title);
        } catch (e) {
          if (cancelled) return; // a cleaned-up run must not clobber a newer run's load
          console.error("open design failed:", e);
          alert(
            "Couldn't open that design: " +
              (e instanceof Error ? e.message : String(e)),
          );
          // discard any partial load; fall back to a clean default hull
          await store.dispatch({ type: "installHull", state: defaultHull() });
          id = { ...newDesignId(), savedDocument: "" };
        }
      }
      if (cancelled) return;
      // Whatever was installed is what "saved" means from here: the boot's own load must not read as an edit.
      id.savedDocument ||= buildJson(store.runtime());
      store.markSaved(store.snapshot().revision);
      setDesignId(id);
      setSelection(null);
      setBooted(true); // now mount the views and let them draw the settled hull
    })();
    return () => {
      cancelled = true;
    };
  }, [store, setSelection, fresh]);

  // ---------- the one save action (stable; reads latest state from refs) ----------
  const doSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFlash({ buttonLabel: "Save", kind: "", text: "Saving…" });
    // The revision the document is written AT. `saveDesign` builds the JSON synchronously before its first
    // await, so nothing can be edited in between — but the marking happens after, so it has to be captured.
    const at = store.snapshot().revision;
    try {
      const res = await saveDesign(
        store.runtime(),
        idRef.current,
        nameRef.current,
      );
      if (res) {
        setDesignId(res.id);
        setName(res.name);
        store.markSaved(at);
        setFlash({ buttonLabel: "Save", kind: "saved", text: "Saved ✓" });
        window.setTimeout(() => setFlash(null), 1400); // hold "Saved ✓" before the steady view returns
      } else {
        setFlash(null); // cancelled — back to steady state
      }
    } catch (e) {
      setFlash({ buttonLabel: "Save", kind: "dirty", text: "Save failed" });
      alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [store, setSaving, setFlash, setDesignId, setName]);

  // ---------- Ctrl/Cmd-S + beforeunload ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave();
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isUnsaved(dirtyRef.current, idRef.current, nameRef.current))
        e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [doSave]);

  // ---------- keep the document title in sync with the design name ----------
  useEffect(() => {
    document.title = `${name || "Untitled"} — Camber`;
  }, [name]);

  // ---------- handlers ----------
  // blanking the title on an existing design restores the saved name (a name is required to save)
  const onNameBlur = () => {
    const saved = idRef.current.savedName;
    if (!nameRef.current.trim() && saved != null) setName(saved);
  };
  // Revert is one `installHull`, which means it is itself undoable — a slip of the hand is recoverable now.
  const onRevert = () => {
    const state = revertTo(dirty, designId);
    if (!state) return;
    setSelection(null);
    void store.dispatch({ type: "installHull", state });
  };
  const onClose = () => {
    if (
      isUnsaved(dirty, designId, name) &&
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
          name={name}
          saveKind={save.kind}
          saveText={save.text}
          saveLabel={save.buttonLabel}
          saving={saving}
          onName={setName}
          onNameBlur={onNameBlur}
          onSave={() => void doSave()}
          onRevert={onRevert}
          onClose={onClose}
        />
        <span className="tabsep" />
        <StlControl />
      </div>
      <div className="main">
        {booted && (
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
