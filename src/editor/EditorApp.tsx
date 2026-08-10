import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeHullSampling, type HullSampling } from "../core/mesh";
import type { Unit } from "../core/document";
import type { ModelSelection } from "../core/modelSelection";
import type { HullCommand } from "../core/commands";
import { createOwner, isDirty, localStore } from "../core/store";
import {
  StoreContext,
  useHullStore,
  useRuntime,
  useSnapshot,
} from "./hullStore";
import {
  defaultStlSettings,
  parseStl,
  type StlSettings,
  type StlState,
} from "../core/stlImport";
import { getHullBBox } from "../core/hullGeometry";
import { defaultHull } from "../core/hull";
import { buildJson } from "../core/json";
import { getDrag, setDrag } from "../core/drag";
import { viewOf } from "../core/view";
import { getVB } from "./svgCoords";
import { deleteCommand, knuckleCommand } from "./selection";
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
import type { Tool } from "./types";
import { Toolbar } from "./Toolbar";
import { SelectionInfo } from "./SelectionInfo";
import { TrimControls } from "./TrimControls";
import { CurvatureControls } from "./CurvatureControls";
import { PerfControls } from "./PerfControls";
import { PerfPanel } from "./PerfPanel";
import { defaultCurvature } from "../core/comb";
import {
  defaultPerf,
  perfBegin,
  perfEnd,
  perfFrame,
  perfStep,
  setPerfOn,
  PERF_SECTIONS,
  PERF_SAMPLING,
  type PerfSettings,
} from "../core/perf";
import { DesignBar } from "./DesignBar";
import { View3d } from "../components/View3d";
import { PlanView } from "./PlanView";
import { ProfileView } from "./ProfileView";
import { useSvgViewSync } from "./svgViewSync";
import { StationView } from "./StationView";
import { CutStationView } from "./CutStationView";
import { StlControl } from "../components/StlControl";
import { Area, AreaGroup, AreaSeparator } from "polymorph-ui";
import "./EditorApp.css";

// The editor's window owns the hull. In one window that is the whole story; from phase 5 the owner moves into
// a SharedWorker and only this line changes — everything below reads the store through the same interface.
export function EditorApp() {
  const [store] = useState(() => localStore(createOwner()));
  return (
    <StoreContext.Provider value={store}>
      <Editor />
    </StoreContext.Provider>
  );
}

function Editor() {
  const store = useHullStore();
  // The hull, assembled. Unlike the mutable model this replaces, its IDENTITY changes exactly when something
  // this window draws has changed — so it is the redraw signal too, and `modelVersion` is gone.
  const model = useRuntime();
  const snapshot = useSnapshot();
  const dirty = isDirty(snapshot);

  // Every edit goes through here, so this is where the performance readout's FRAME starts: the redraw it sets
  // off costs far more than the passes inside it (React's own render and commit, three's reconciliation, the
  // collector), and the frame is what measures the whole of it — see core/perf.
  const run = useCallback(
    (cmd: HullCommand) => {
      perfFrame();
      return store.dispatch(cmd);
    },
    [store],
  );
  // The drag and key handlers subscribe once and then read the latest model from here, rather than re-binding
  // their window listeners on every frame of a drag.
  const modelRef = useRef(model);

  // the views are mounted only once boot has settled the hull, so nothing draws the default hull before a
  // URL design (?id=) finishes loading — the columns are sized by flex/layout, so mounting causes no reflow.
  const [booted, setBooted] = useState(false);

  // the plan and profile strips share one longitudinal zoom / x-pan so they stay lined up
  const planProfileSync = useSvgViewSync();

  const [tool, setTool] = useState<Tool>("select");
  const [curvature, setCurvature] = useState(defaultCurvature);
  const [selection, setSelection] = useState<ModelSelection>(null);
  // "Show knot longitudinals": every station's knots and the loft curve each knot index traces. One switch
  // for all three 2D views (plan, profile, and the section editor, whose card carries the checkbox).
  const [knotLongs, setKnotLongs] = useState(false);
  // Which station the section editor is showing. It lives here, not in the station view, because two views
  // set it: its tab over the section editor, and its own segment in the plan. Clamped on read in case the
  // station it names was removed.
  const [activeStationRaw, setActiveStation] = useState(0);
  const activeStation = Math.min(activeStationRaw, model.stations.length - 1);
  // The performance readout. Its `on` drives the core's recording switch — a module-level flag rather than
  // state, because the draws that report into it are imperative and must not re-render anything — so the
  // toggle is pushed there and a redraw is forced, which is what fills the panel.
  const [perf, setPerf] = useState<PerfSettings>(defaultPerf);
  const [redraws, setRedraws] = useState(0);
  const onPerf = (next: PerfSettings) => {
    if (next.on !== perf.on) {
      setPerfOn(next.on);
      perfFrame();
      setRedraws((v) => v + 1); // no hull changed, so nothing but this will re-run the sampling
    }
    setPerf(next);
  };

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  // The design identity, and the transient "Saving…" / "Saved ✓" that briefly overrides the steady indicator.
  // The steady one is derived, not polled: `revision !== savedRevision` is exact and costs nothing.
  const [designId, setDesignId] = useState<DesignId>(newDesignId);
  const [flash, setFlash] = useState<SaveView | null>(null);
  const save = flash ?? saveView(dirty, designId, name);

  // imported reference STL — session only, never saved. Drawn translucent over the hull in the 3D view.
  const [stl, setStl] = useState<StlState | null>(null);
  const onImportStl = useCallback(async (file: File) => {
    try {
      const geom = parseStl(await file.arrayBuffer());
      const designBox = getHullBBox(modelRef.current); // freeze the current hull bounds; the fit scale is relative to them
      setStl({
        geom,
        designBox,
        settings: defaultStlSettings(geom, designBox),
      });
    } catch (e) {
      alert(
        "Couldn't import STL: " + (e instanceof Error ? e.message : String(e)),
      );
    }
  }, []);
  const onChangeStl = useCallback(
    (patch: Partial<StlSettings>) =>
      setStl((s) => (s ? { ...s, settings: { ...s.settings, ...patch } } : s)),
    [],
  );
  const onRemoveStl = useCallback(() => setStl(null), []);

  // A few values the window-level listeners and the async save read at their latest, kept in refs so those
  // one-time effects never re-subscribe. Written after commit, which is when the handlers can first run.
  const idRef = useRef(designId);
  const selectionRef = useRef(selection);
  const nameRef = useRef(name);
  const dirtyRef = useRef(dirty);
  const savingRef = useRef(false);
  useEffect(() => {
    modelRef.current = model;
    idRef.current = designId;
    selectionRef.current = selection;
    nameRef.current = name;
    dirtyRef.current = dirty;
  }, [model, designId, selection, name, dirty]);

  // Compute the ONE hull sampling every view shares (mesh.ts): the swept sheet and its three trims, sampled at
  // the Performance control's resolution. Runs during render (before the child views' draw effects) whenever
  // the hull or that resolution changes, so every view sees the same lattice — nothing re-sweeps the hull for
  // itself. The 2D strips read its trimmedSections for the outline, the 3D view stitches them into the
  // surface.
  //
  // The model arrives assembled, so there is no "prepare" step to time any more; what the SECTIONS pass now
  // measures is the assembly the store did on this window's behalf, which is zero when only the cut station
  // moved.
  const sampling = useMemo<HullSampling>(() => {
    perfBegin(PERF_SECTIONS);
    perfStep("assemble (derived curves)", () => store.runtime());
    perfEnd(PERF_SECTIONS);
    perfBegin(PERF_SAMPLING);
    const out = computeHullSampling(model, perf.numSections, perf.girthSteps);
    perfEnd(PERF_SAMPLING);
    return out;
    // `redraws` carries no data — it is how the Performance toggle forces one more pass through here, so the
    // panel has something to show when it is switched on without the hull having moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, model, redraws, perf.numSections, perf.girthSteps]);

  // ---------- window-level drag (2D control points) ----------
  // Drags are begun on the SVG nodes (draw2d's startDrag sets the shared drag + selects); the move is applied
  // here at the window level, mapping the pointer into model space and dispatching the matching command. The
  // 3D rotate / zoom drag is handled locally in View3d, so it never reaches this handler.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = getDrag();
      if (!drag) return;
      const [vx, vy] = getVB(drag, e);
      const m = modelRef.current;
      // the view transforms are held against the length captured when the hull was installed (see view.ts),
      // so they do not shift mid-drag: a point tracks the pointer even when the drag is what sets the LOA
      const v = viewOf(m);
      const idx = drag.idx ?? 0;
      // The cut station is SESSION state — shared between windows, but neither undoable nor a change to the
      // document — so it has a dispatch of its own and never reaches the undo stack.
      if (drag.kind === "slider") {
        perfFrame();
        store.dispatchSession({ type: "setX0", x: v.invX(vx) });
        return;
      }
      if (drag.kind === "sheer")
        void run({
          type: "movePlanPoint",
          idx,
          x: v.invX(vx),
          y: v.invY(vy),
        });
      else if (drag.kind === "trim")
        void run({ type: "moveTrim", idx, x: v.invX(vx), z: v.invZp(vy) });
      else if (drag.kind === "transom")
        void run({ type: "moveTransom", idx, x: v.invX(vx), z: v.invZp(vy) });
      // a station handle rides the plan curve: the station's u is the plan point NEAREST the pointer, not
      // the one straight below it. Where the plan turns toward the centerline at the bow, a vertical hit
      // slides far along the curve for a small sideways move (and stops responding at all once the pointer
      // passes the stem); the nearest point keeps the handle under the hand. The plan is drawn at the one
      // isometric scale (view.ts), so nearest in model space is also nearest on screen.
      else if (drag.kind === "stationU")
        void run({
          type: "moveStationU",
          idx,
          u: m.plan.uAtPoint([v.invX(vx), v.invY(vy)]),
        });
      else if (drag.kind === "stn")
        void run({
          type: "moveStationPoint",
          si: drag.si ?? 0,
          idx,
          n: v.invN(vx),
          z: v.invZ(vy),
        });
    };
    const onUp = () => setDrag(null); // selection persists after a drag, so the point stays editable
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [store, run]);

  // ---------- delete the selected point, and undo / redo ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        const cmd = deleteCommand(modelRef.current, selectionRef.current);
        if (!cmd) return;
        e.preventDefault();
        setSelection(null);
        void run(cmd);
        return;
      }
      // Undo is new: there was nothing to undo with before the store, because an edit overwrote the hull in
      // place. A drag is one step — consecutive moves of the same point coalesce in the owner.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        perfFrame();
        setSelection(null);
        if (e.shiftKey) store.redo();
        else store.undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, run]);

  // ---------- boot: load the URL design (if any) once ----------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
  }, [store]);

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
  const onWaterline = (depth: number) =>
    void run({ type: "setWaterline", depth });
  const onRake = (deg: number) => void run({ type: "setDeckRakeDeg", deg });
  // Changing the unit asks which of the two things the user meant: keep the hull the same PHYSICAL size and
  // convert the numbers (2000 mm → 2 m), or keep the numbers and reinterpret them at the new unit's scale
  // (2000 mm → 2000 m). Neither is a safe default, so it is asked rather than assumed.
  const onUnit = (unit: Unit) => {
    if (unit === model.unit) return;
    const rescale = confirm(
      `Change the unit from ${model.unit} to ${unit}.\n\n` +
        `OK — convert the numbers, keeping the hull the same size.\n` +
        `Cancel — keep the numbers, resizing the hull to ${unit}.`,
    );
    void run({ type: "setUnit", unit, rescale });
  };
  const onKnuckle = (k: number) => {
    const cmd = knuckleCommand(model, selection, k);
    if (cmd) void run(cmd);
  };
  const onDelete = () => {
    const cmd = deleteCommand(model, selection);
    if (!cmd) return;
    setSelection(null);
    void run(cmd);
  };
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
    void run({ type: "installHull", state });
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
        <Toolbar tool={tool} onTool={setTool} />
        <SelectionInfo
          model={model}
          selection={selection}
          onKnuckle={onKnuckle}
          onDelete={onDelete}
        />
        <span className="tabsep" />
        <TrimControls
          model={model}
          onWaterline={onWaterline}
          onRake={onRake}
          onUnit={onUnit}
        />
        <CurvatureControls value={curvature} onChange={setCurvature} />
        <PerfControls value={perf} onChange={onPerf} />
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
        <StlControl
          stl={stl}
          onImport={(f) => void onImportStl(f)}
          onChange={onChangeStl}
          onRemove={onRemoveStl}
        />
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
                  <PerfPanel settings={perf} />
                </Area>
                <AreaSeparator className="areasep" />
              </>
            )}
            <Area className="area" defaultSize="50%">
              <AreaGroup className="areagroup" orientation="vertical">
                <Area className="area" defaultSize="50%">
                  <PlanView
                    model={model}
                    selection={selection}
                    sampling={sampling}
                    tool={tool}
                    onSelect={setSelection}
                    setTool={setTool}
                    sync={planProfileSync}
                    curvature={curvature}
                    knotLongs={knotLongs}
                    activeStation={activeStation}
                    onActivateStation={setActiveStation}
                  />
                </Area>
                <AreaSeparator className="areasep" />
                <Area className="area" defaultSize="50%">
                  <ProfileView
                    model={model}
                    selection={selection}
                    sampling={sampling}
                    tool={tool}
                    onSelect={setSelection}
                    setTool={setTool}
                    sync={planProfileSync}
                    curvature={curvature}
                    knotLongs={knotLongs}
                  />
                </Area>
              </AreaGroup>
            </Area>
            <AreaSeparator className="areasep" />
            <Area className="area" defaultSize="25%" minSize="200px">
              <StationView
                model={model}
                selection={selection}
                tool={tool}
                onSelect={setSelection}
                setTool={setTool}
                curvature={curvature}
                knotLongs={knotLongs}
                setKnotLongs={setKnotLongs}
                activeStation={activeStation}
                setActiveStation={setActiveStation}
              />
            </Area>
            <AreaSeparator className="areasep" />
            <Area className="area" defaultSize="25%" minSize="200px">
              <AreaGroup className="areagroup" orientation="vertical">
                <Area className="area" defaultSize="50%">
                  <View3d
                    model={model}
                    selection={selection}
                    sampling={sampling}
                    stl={stl}
                    curvature={curvature}
                  />
                </Area>
                <AreaSeparator className="areasep" />
                <Area className="area" defaultSize="50%">
                  <CutStationView
                    model={model}
                    selection={selection}
                    curvature={curvature}
                  />
                </Area>
              </AreaGroup>
            </Area>
          </AreaGroup>
        )}
      </div>
    </div>
  );
}
