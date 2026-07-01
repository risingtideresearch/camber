import { useCallback, useEffect, useRef, useState } from "react";
import type { View3DMode } from "../core/model";
// Type-only import: erased at compile time, so it does NOT pull the imperative core (and thus
// `dom.ts`, which resolves element refs at module-eval) in before the DOM is mounted. The actual
// module is loaded via dynamic import() in the boot effect below, after React commits the markup.
import type { SaveView } from "./editorController";
import { Toolbar } from "./Toolbar";
import { SelectionInfo } from "./SelectionInfo";
import { TrimControls } from "./TrimControls";
import { DesignBar } from "./DesignBar";
import { ThreeDView } from "./ThreeDView";
import { ViewStrips } from "./ViewStrips";
import { SidePanel } from "./SidePanel";
import { CutPanel } from "./CutPanel";
import "./EditorApp.css";

type Controller = typeof import("./editorController");

const INITIAL_SAVE: SaveView = { buttonLabel: "Save", kind: "", text: "" };

export function EditorApp() {
  // React-owned chrome state (mirrors the model; the controller is the bridge that mutates it)
  const [waterline, setWaterline] = useState(150);
  const [rakeDeg, setRakeDeg] = useState(0);
  const [mode, setMode] = useState<View3DMode>("render");
  const [name, setName] = useState("");
  const [save, setSave] = useState<SaveView>(INITIAL_SAVE);
  const [saving, setSaving] = useState(false);

  // The loaded controller and a few values global listeners / the poll need at their latest — kept
  // in refs so those one-time effects can read fresh state without re-subscribing every render.
  const ctrlRef = useRef<Controller | null>(null);
  const bootedRef = useRef(false);
  const nameRef = useRef(name);
  const savingRef = useRef(false); // true while a save request is in flight
  const flashUntilRef = useRef(0); // keep a transient "Saving…" / "Saved ✓" until this timestamp

  // keep nameRef in sync with the latest name so async readers (doSave, the poll) see it fresh
  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  // ---------- boot: mount the imperative core once, after the DOM exists ----------
  useEffect(() => {
    if (bootedRef.current) return; // one-shot: boot()/initInteraction() must not run twice
    bootedRef.current = true;
    let cancelled = false;
    void (async () => {
      const ctrl = await import("./editorController");
      if (cancelled) return;
      ctrlRef.current = ctrl;
      const r = await ctrl.boot();
      if (cancelled) return;
      setWaterline(r.waterline);
      setRakeDeg(r.rakeDeg);
      setMode(r.mode);
      setName(r.name);
      nameRef.current = r.name;
      setSave(ctrl.saveView(r.name));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------- the one save action (stable; reads latest state from refs) ----------
  const doSave = useCallback(async () => {
    const ctrl = ctrlRef.current;
    if (!ctrl || savingRef.current) return;
    savingRef.current = true;
    flashUntilRef.current = 0;
    setSaving(true);
    setSave((v) => ({ ...v, kind: "", text: "Saving…" }));
    try {
      const res = await ctrl.save(nameRef.current);
      if (res) {
        setName(res.name);
        nameRef.current = res.name;
        flashUntilRef.current = Date.now() + 1400; // hold "Saved ✓" before the poll resumes
        setSave({
          buttonLabel: ctrl.saveView(res.name).buttonLabel,
          kind: "saved",
          text: "Saved ✓",
        });
      } else {
        setSave(ctrl.saveView(nameRef.current)); // cancelled (no name given) — back to steady state
      }
    } catch (e) {
      setSave({
        buttonLabel: ctrl.saveView(nameRef.current).buttonLabel,
        kind: "dirty",
        text: "Save failed",
      });
      alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  // ---------- the dirty poll: bridge the window-level drag edits back to the save indicator ----------
  // Drags are handled by interaction.ts at the window level, out of React's reach, so (as in main.ts)
  // we poll a snapshot compare instead of trying to observe every edit.
  useEffect(() => {
    const id = setInterval(() => {
      const ctrl = ctrlRef.current;
      if (!ctrl || savingRef.current || Date.now() < flashUntilRef.current)
        return;
      setSave(ctrl.saveView(nameRef.current));
    }, 300);
    return () => clearInterval(id);
  }, []);

  // ---------- window-level effects: resize, Ctrl/Cmd-S, beforeunload ----------
  useEffect(() => {
    const onResize = () => ctrlRef.current?.handleResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave();
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (ctrlRef.current?.isUnsaved(nameRef.current)) {
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
  }, [doSave]);

  // ---------- keep the document title in sync with the design name ----------
  useEffect(() => {
    document.title = `${name || "Untitled"} — Camber`;
  }, [name]);

  // ---------- handlers ----------
  const onWaterline = (mm: number) => {
    setWaterline(mm);
    ctrlRef.current?.setWaterline(mm);
  };
  const onRake = (deg: number) => {
    setRakeDeg(deg);
    ctrlRef.current?.setDeckRake(deg);
  };
  const onMode = (m: View3DMode) => {
    setMode(m);
    ctrlRef.current?.setView3dMode(m);
  };
  // blanking the title on an existing design restores the saved name (a name is required to save)
  const onNameBlur = () => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const saved = ctrl.savedDesignName();
    if (!nameRef.current.trim() && saved != null) setName(saved);
  };
  const onRevert = () => {
    const snap = ctrlRef.current?.revert();
    if (!snap) return;
    setWaterline(snap.waterline);
    setRakeDeg(snap.rakeDeg);
    setMode(snap.mode);
  };
  const onClose = () => {
    const ctrl = ctrlRef.current;
    if (
      ctrl?.isUnsaved(nameRef.current) &&
      !confirm("Discard unsaved changes and return to the library?")
    )
      return;
    window.location.href = "index.html";
  };

  return (
    <div className="app">
      <div className="appbar">
        <Toolbar />
        <SelectionInfo />
        <span className="tabsep" />
        <TrimControls
          waterline={waterline}
          rakeDeg={rakeDeg}
          onWaterline={onWaterline}
          onRake={onRake}
        />
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
        <div className="leftcol">
          <ThreeDView mode={mode} onMode={onMode} />
          <ViewStrips />
        </div>
        <div className="rightcol">
          <SidePanel />
          <CutPanel />
        </div>
      </div>
    </div>
  );
}
