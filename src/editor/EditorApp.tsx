import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clippedSection,
  createModel,
  forwardLimit,
  L,
  moveSheer,
  moveStationPoint,
  moveTransom,
  moveTrim,
  moveWeightBoundary,
  prepare,
  resetModel,
  setDeckRake,
  setWaterline,
  setX0,
  type Model,
  type Section,
} from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import { buildJson } from "../core/json";
import { clamp } from "../core/math";
import { getDrag, setDrag } from "../core/drag";
import { invD, invN, invWY, invX, invY, invZp } from "../core/view";
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
import { DesignBar } from "./DesignBar";
import { View3d } from "../components/View3d";
import { WeightsView } from "./WeightsView";
import { PlanView } from "./PlanView";
import { ProfileView } from "./ProfileView";
import { SidePanel } from "./SidePanel";
import { CutStationView } from "./CutStationView";
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

  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<ModelSelection>(null);
  const handleSelect = useCallback(
    (sel: ModelSelection) => setSelection(sel),
    [],
  );

  const [name, setName] = useState("");
  const [save, setSave] = useState<SaveView>(INITIAL_SAVE);
  const [saving, setSaving] = useState(false);

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

  // prepare() the model and sample the sections the plan / profile strips draw. Runs during render (before
  // the child views' draw effects) whenever the model changes, so every view sees a prepared model.
  const sections = useMemo<Section[]>(() => {
    prepare(model);
    const NSEC = 80,
      xFwd = forwardLimit(model),
      out: Section[] = [];
    for (let i = 0; i <= NSEC; i++) {
      const x = (xFwd * (1 - Math.cos((Math.PI * i) / NSEC))) / 2;
      out.push(clippedSection(model, x, 18));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, modelVersion]);

  // ---------- window-level drag (2D control points) ----------
  // Drags are begun on the SVG nodes (draw2d's startDrag sets the shared drag + selects); the move is applied
  // here at the window level, mapping the pointer into model space and mutating the selected point. The 3D
  // rotate / zoom drag is handled locally in View3d, so it never reaches this handler.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = getDrag();
      if (!drag || drag.kind === "rot") return;
      const [vx, vy] = getVB(drag, e);
      if (drag.kind === "slider") setX0(model, clamp(invX(vx), 0, L));
      else if (drag.kind === "sheer")
        moveSheer(model, drag.idx!, invX(vx), invY(vy));
      else if (drag.kind === "trim")
        moveTrim(model, drag.idx!, invX(vx), invZp(vy));
      else if (drag.kind === "transom")
        moveTransom(model, drag.idx!, invX(vx), invZp(vy));
      else if (drag.kind === "weight") {
        if (drag.wpart !== "x")
          moveWeightBoundary(model, drag.idx!, drag.bnd!, invWY(vy));
      } else if (drag.kind === "stn")
        moveStationPoint(model, drag.ti!, drag.idx!, invN(vx), invD(vy));
      bumpModel();
    };
    const onUp = () => setDrag(null); // selection persists after a drag, so the point stays editable
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
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
        <TrimControls model={model} onWaterline={onWaterline} onRake={onRake} />
        <DesignBar
          name={name}
          dirty={save.kind === "dirty"}
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
      </div>
      <div className="main">
        {booted && (
          // Resizable layout: three independent columns, each a vertical split of two stacked views —
          // plan / profile, section editor / blend strip, and 3D view / live cut station. Drag any
          // separator to resize. (Replaces the old measured column-fitting layout.)
          <AreaGroup className="areagroup" orientation="horizontal">
            <Area className="area" defaultSize="50%">
              <AreaGroup className="areagroup" orientation="vertical">
                <Area className="area" defaultSize="50%">
                  <PlanView
                    model={model}
                    modelVersion={modelVersion}
                    selection={selection}
                    sections={sections}
                    tool={tool}
                    onSelect={handleSelect}
                    setTool={setTool}
                    bumpModel={bumpModel}
                  />
                </Area>
                <AreaSeparator className="areasep" />
                <Area className="area" defaultSize="50%">
                  <ProfileView
                    model={model}
                    modelVersion={modelVersion}
                    selection={selection}
                    sections={sections}
                    tool={tool}
                    onSelect={handleSelect}
                    setTool={setTool}
                    bumpModel={bumpModel}
                  />
                </Area>
              </AreaGroup>
            </Area>
            <AreaSeparator className="areasep" />
            <Area className="area" defaultSize="25%" minSize="200px">
              <AreaGroup className="areagroup" orientation="vertical">
                <Area className="area" defaultSize="50%">
                  <SidePanel
                    model={model}
                    modelVersion={modelVersion}
                    selection={selection}
                    tool={tool}
                    onSelect={handleSelect}
                    setTool={setTool}
                    bumpModel={bumpModel}
                  />
                </Area>
                <AreaSeparator className="areasep" />
                <Area className="area" defaultSize="50%">
                  <WeightsView
                    model={model}
                    modelVersion={modelVersion}
                    selection={selection}
                    tool={tool}
                    onSelect={handleSelect}
                    setTool={setTool}
                    bumpModel={bumpModel}
                  />
                </Area>
              </AreaGroup>
            </Area>
            <AreaSeparator className="areasep" />
            <Area className="area" defaultSize="25%" minSize="200px">
              <AreaGroup className="areagroup" orientation="vertical">
                <Area className="area" defaultSize="50%">
                  <View3d
                    model={model}
                    modelVersion={modelVersion}
                    selection={selection}
                  />
                </Area>
                <AreaSeparator className="areasep" />
                <Area className="area" defaultSize="50%">
                  <CutStationView
                    model={model}
                    modelVersion={modelVersion}
                    selection={selection}
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
