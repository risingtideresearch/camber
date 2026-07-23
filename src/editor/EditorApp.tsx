import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createModel,
  loa,
  movePlanPoint,
  moveStationPoint,
  moveStationU,
  moveTransom,
  moveTrim,
  prepare,
  resetModel,
  setDeckRake,
  setUnit,
  setWaterline,
  setX0,
  type Model,
} from "../core/model";
import { computeHullSampling, type HullSampling } from "../core/mesh";
import type { Unit } from "../core/document";
import type { ModelSelection } from "../core/modelSelection";
import {
  defaultStlSettings,
  parseStl,
  type StlSettings,
  type StlState,
} from "../core/stlImport";
import { getHullBBox } from "../core/hullGeometry";
import { buildJson } from "../core/json";
import { clamp } from "../core/math";
import { getDrag, setDrag } from "../core/drag";
import { viewOf } from "../core/view";
import { getVB } from "./svgCoords";
import { deleteSelected, setKnuckle } from "./selection";
import {
  isUnsaved,
  newDesignId,
  openDesign,
  revert,
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
  perfStep,
  setPerfOn,
  PERF_SECTIONS,
  type PerfSettings,
} from "../core/perf";
import { DesignBar } from "./DesignBar";
import { View3d } from "../components/View3d";
import { PlanView } from "./PlanView";
import { ProfileView } from "./ProfileView";
import { useSvgViewSync } from "./svgViewSync";
import { SidePanel } from "./SidePanel";
import { CutStationView } from "./CutStationView";
import { StlControl } from "../components/StlControl";
import { Area, AreaGroup, AreaSeparator } from "polymorph-ui";
import "./EditorApp.css";

const INITIAL_SAVE: SaveView = { buttonLabel: "Save", kind: "", text: "" };

export function EditorApp() {
  // The one hull model: a stable, mutable object (many core functions mutate it in place). It is never
  // replaced, so reactivity is driven by `modelVersion` — bumped after every edit to trigger a redraw.
  const [model] = useState<Model>(() => {
    const m = createModel();
    resetModel(m);
    return m;
  });
  const [modelVersion, setModelVersion] = useState(0);
  const bumpModel = useCallback(() => setModelVersion((v) => v + 1), []);
  // the views are mounted only once boot has settled the model, so nothing draws the default hull before a
  // URL design (?id=) finishes loading — the columns are sized by flex/layout, so mounting causes no reflow.
  const [booted, setBooted] = useState(false);

  // the plan and profile strips share one longitudinal zoom / x-pan so they stay lined up
  const planProfileSync = useSvgViewSync();

  const [tool, setTool] = useState<Tool>("select");
  const [curvature, setCurvature] = useState(defaultCurvature);
  const [selection, setSelection] = useState<ModelSelection>(null);
  // The performance readout. Its `on` drives the core's recording switch — a module-level flag rather than
  // state, because the draws that report into it are imperative and must not re-render anything — so the
  // toggle is pushed there and the views are bumped to redraw, which is what fills the panel.
  const [perf, setPerf] = useState<PerfSettings>(defaultPerf);
  const onPerf = (next: PerfSettings) => {
    if (next.on !== perf.on) {
      setPerfOn(next.on);
      bumpModel();
    }
    setPerf(next);
  };

  const [name, setName] = useState("");
  const [save, setSave] = useState<SaveView>(INITIAL_SAVE);
  const [saving, setSaving] = useState(false);

  // imported reference STL — session only, never saved. Drawn translucent over the hull in the 3D view.
  const [stl, setStl] = useState<StlState | null>(null);
  const onImportStl = useCallback(
    async (file: File) => {
      try {
        const geom = parseStl(await file.arrayBuffer());
        const designBox = getHullBBox(model); // freeze the current hull bounds; the fit scale is relative to them
        setStl({
          geom,
          designBox,
          settings: defaultStlSettings(geom, designBox),
        });
      } catch (e) {
        alert(
          "Couldn't import STL: " +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    },
    [model],
  );
  const onChangeStl = useCallback(
    (patch: Partial<StlSettings>) =>
      setStl((s) => (s ? { ...s, settings: { ...s.settings, ...patch } } : s)),
    [],
  );
  const onRemoveStl = useCallback(() => setStl(null), []);

  // The design identity (which row is open, its saved name, the last-saved JSON) and a few values the
  // window-level listeners / the poll read at their latest — kept in refs so those one-time effects and async
  // handlers see fresh state without re-subscribing every render.
  const idRef = useRef<DesignId>(newDesignId());
  const selectionRef = useRef(selection);
  const nameRef = useRef(name);
  const savingRef = useRef(false);
  const flashUntilRef = useRef(0); // hold a transient "Saving…" / "Saved ✓" until this timestamp
  // keep the refs the window listeners / async handlers read in sync with the latest state
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  // prepare() the model, then compute the ONE hull sampling every view shares (mesh.ts): the swept sheet and
  // its three trims, sampled at the Performance control's resolution. Runs during render (before the child
  // views' draw effects) whenever the model or that resolution changes, so every view sees a prepared model
  // and the same lattice — nothing re-sweeps the hull for itself. The 2D strips read its trimmedSections for
  // the outline, the 3D view stitches them into the surface.
  const sampling = useMemo<HullSampling>(() => {
    perfBegin(PERF_SECTIONS);
    perfStep("prepare (derived curves)", () => prepare(model));
    const out = perfStep(
      "Hull sampling",
      () => computeHullSampling(model, perf.numSections, perf.girthSteps),
      (s) => s.columns.reduce((n, c) => n + c.pts.length, 0),
    );
    perfEnd(PERF_SECTIONS);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, modelVersion, perf.numSections, perf.girthSteps]);

  // ---------- window-level drag (2D control points) ----------
  // Drags are begun on the SVG nodes (draw2d's startDrag sets the shared drag + selects); the move is applied
  // here at the window level, mapping the pointer into model space and mutating the selected point. The 3D
  // rotate / zoom drag is handled locally in View3d, so it never reaches this handler.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = getDrag();
      if (!drag) return;
      const [vx, vy] = getVB(drag, e);
      // the view transforms are held against the length captured when the hull was installed (see view.ts),
      // so they do not shift mid-drag: a point tracks the pointer even when the drag is what sets the LOA
      const v = viewOf(model);
      if (drag.kind === "slider")
        setX0(model, clamp(v.invX(vx), 0, loa(model)));
      else if (drag.kind === "sheer")
        movePlanPoint(model, drag.idx!, v.invX(vx), v.invY(vy));
      else if (drag.kind === "trim")
        moveTrim(model, drag.idx!, v.invX(vx), v.invZp(vy));
      else if (drag.kind === "transom")
        moveTransom(model, drag.idx!, v.invX(vx), v.invZp(vy));
      // a station handle rides the plan curve: the pointer's x picks the station's u by inverting the
      // plan's monotone x(u), which is the same inversion the cut scrubber uses
      else if (drag.kind === "stationU")
        moveStationU(model, drag.idx!, model.plan.uAtX(v.invX(vx)));
      else if (drag.kind === "stn")
        moveStationPoint(model, drag.si!, drag.idx!, v.invN(vx), v.invZ(vy));
      bumpModel();
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
  }, [model, bumpModel]);

  // ---------- delete the selected point with Delete / Backspace ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const sel = selectionRef.current;
      if (sel) {
        e.preventDefault();
        if (deleteSelected(model, sel)) {
          setSelection(null);
          bumpModel();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [model, bumpModel]);

  // ---------- boot: load the URL design (if any) once, after the model is created ----------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rowId = new URLSearchParams(window.location.search).get("id");
      if (rowId) {
        try {
          const nm = await openDesign(model, rowId);
          if (cancelled) return;
          idRef.current = {
            currentId: rowId,
            savedName: nm,
            savedSnapshot: buildJson(model),
          };
          setName(nm);
          nameRef.current = nm;
        } catch (e) {
          if (cancelled) return; // a cleaned-up run must not clobber a newer run's load
          console.error("open design failed:", e);
          alert(
            "Couldn't open that design: " +
              (e instanceof Error ? e.message : String(e)),
          );
          resetModel(model); // discard any partial load; fall back to a clean default hull
          idRef.current = { ...newDesignId(), savedSnapshot: buildJson(model) };
        }
      } else {
        idRef.current = { ...newDesignId(), savedSnapshot: buildJson(model) };
      }
      if (cancelled) return;
      setSelection(null);
      bumpModel();
      setSave(saveView(model, idRef.current, nameRef.current));
      setBooted(true); // now mount the views and let them draw the settled model
    })();
    return () => {
      cancelled = true;
    };
  }, [model, bumpModel]);

  // ---------- the one save action (stable; reads latest state from refs) ----------
  const doSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    flashUntilRef.current = 0;
    setSaving(true);
    setSave((v) => ({ ...v, kind: "", text: "Saving…" }));
    try {
      const res = await saveDesign(model, idRef.current, nameRef.current);
      if (res) {
        idRef.current = res.id;
        setName(res.name);
        nameRef.current = res.name;
        flashUntilRef.current = Date.now() + 1400; // hold "Saved ✓" before the poll resumes
        setSave({
          buttonLabel: saveView(model, res.id, res.name).buttonLabel,
          kind: "saved",
          text: "Saved ✓",
        });
      } else {
        setSave(saveView(model, idRef.current, nameRef.current)); // cancelled — back to steady state
      }
    } catch (e) {
      setSave({
        buttonLabel: saveView(model, idRef.current, nameRef.current)
          .buttonLabel,
        kind: "dirty",
        text: "Save failed",
      });
      alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [model]);

  // ---------- the dirty poll: refresh the save indicator (skips no-op updates to avoid re-renders) ----------
  useEffect(() => {
    const iv = setInterval(() => {
      if (savingRef.current || Date.now() < flashUntilRef.current) return;
      setSave((prev) => {
        const next = saveView(model, idRef.current, nameRef.current);
        return prev.buttonLabel === next.buttonLabel &&
          prev.kind === next.kind &&
          prev.text === next.text
          ? prev
          : next;
      });
    }, 300);
    return () => clearInterval(iv);
  }, [model]);

  // ---------- Ctrl/Cmd-S + beforeunload ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave();
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isUnsaved(model, idRef.current, nameRef.current)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [doSave, model]);

  // ---------- keep the document title in sync with the design name ----------
  useEffect(() => {
    document.title = `${name || "Untitled"} — Camber`;
  }, [name]);

  // ---------- handlers ----------
  const onWaterline = (mm: number) => {
    setWaterline(model, mm);
    bumpModel();
  };
  const onRake = (deg: number) => {
    setDeckRake(model, deg);
    bumpModel();
  };
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
    setUnit(model, unit, rescale);
    bumpModel();
  };
  const onKnuckle = (k: number) => {
    if (setKnuckle(model, selection, k)) bumpModel();
  };
  const onDelete = () => {
    if (deleteSelected(model, selection)) {
      setSelection(null);
      bumpModel();
    }
  };
  // blanking the title on an existing design restores the saved name (a name is required to save)
  const onNameBlur = () => {
    const saved = idRef.current.savedName;
    if (!nameRef.current.trim() && saved != null) setName(saved);
  };
  const onRevert = () => {
    if (revert(model, idRef.current)) {
      setSelection(null);
      bumpModel();
    }
  };
  const onClose = () => {
    if (
      isUnsaved(model, idRef.current, nameRef.current) &&
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
                    modelVersion={modelVersion}
                    selection={selection}
                    sampling={sampling}
                    tool={tool}
                    onSelect={setSelection}
                    setTool={setTool}
                    bumpModel={bumpModel}
                    sync={planProfileSync}
                    curvature={curvature}
                  />
                </Area>
                <AreaSeparator className="areasep" />
                <Area className="area" defaultSize="50%">
                  <ProfileView
                    model={model}
                    modelVersion={modelVersion}
                    selection={selection}
                    sampling={sampling}
                    tool={tool}
                    onSelect={setSelection}
                    setTool={setTool}
                    bumpModel={bumpModel}
                    sync={planProfileSync}
                    curvature={curvature}
                  />
                </Area>
              </AreaGroup>
            </Area>
            <AreaSeparator className="areasep" />
            <Area className="area" defaultSize="25%" minSize="200px">
              <SidePanel
                model={model}
                modelVersion={modelVersion}
                selection={selection}
                tool={tool}
                onSelect={setSelection}
                setTool={setTool}
                bumpModel={bumpModel}
                curvature={curvature}
              />
            </Area>
            <AreaSeparator className="areasep" />
            <Area className="area" defaultSize="25%" minSize="200px">
              <AreaGroup className="areagroup" orientation="vertical">
                <Area className="area" defaultSize="50%">
                  <View3d
                    model={model}
                    modelVersion={modelVersion}
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
                    modelVersion={modelVersion}
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
