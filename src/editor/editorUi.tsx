/* eslint-disable react-refresh/only-export-components -- the provider and its hook are one binding */
// ---------- everything a window owns for itself ----------
//
// The store split the hull (shared server's, shared) from the window's own state. This is the window's half,
// gathered behind one provider so that a panel is self-sufficient: it reads what it needs from here and from
// the store, and takes no props at all. A detached panel (phase 6) then works by being wrapped in the same
// two providers and nothing else — there is no parent left to hand it anything.
//
// Nothing here is transported or persisted. Selection, tool, curvature, the imported STL, the shared
// plan/profile zoom and the derived hull sampling are per window by design: two windows showing the plan have
// their own selection and their own pan.
//
// The two WINDOW-LEVEL LISTENERS live here for the same reason. A panel cannot work without them — the
// pointer drag that turns a grabbed control point into commands, and the keys that delete the selected point
// or undo — and they are per window, not per panel: a drag begun on a control point continues wherever the
// pointer goes.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { computeHullSampling, type HullSampling } from "../core/mesh";
import { defaultCurvature, type CurvatureSettings } from "../core/comb";
import { getDrag, setDrag } from "../core/drag";
import { getHullBBox } from "../core/hullGeometry";
import {
  defaultPerf,
  perfBegin,
  perfEnd,
  perfFrame,
  setPerfOn,
  PERF_SAMPLING,
  type PerfSettings,
} from "../core/perf";
import {
  defaultStlSettings,
  parseStl,
  type StlSettings,
  type StlState,
} from "../core/stlImport";
import { viewOf } from "../core/view";
import type { ModelSelection } from "../core/modelSelection";
import {
  useDocumentDispatch,
  useDocumentStore,
  useDocumentRuntime,
  useDocumentSnapshot,
} from "./documentStoreHooks";
import { deleteCommand } from "./selection";
import { getVB } from "./svgCoords";
import { useSvgViewSync, type SvgViewSync } from "./svgViewSync";
import type { Tool } from "./types";

export interface EditorUi {
  tool: Tool;
  setTool: (tool: Tool) => void;
  curvature: CurvatureSettings;
  setCurvature: (curvature: CurvatureSettings) => void;
  selection: ModelSelection;
  setSelection: (selection: ModelSelection) => void;
  /** "Show knot longitudinals" — one switch for all three 2D views. */
  knotLongs: boolean;
  setKnotLongs: (v: boolean) => void;
  /**
   * Which station the section editor is on. It is shared rather than the station view's own because two
   * views set it: its tab strip, and the station's segment in the plan. Clamped, in case the station it
   * names has since been removed.
   */
  activeStation: number;
  setActiveStation: (si: number) => void;
  perf: PerfSettings;
  setPerf: (p: PerfSettings) => void;
  /** The one hull sampling every view in this window shares. */
  sampling: HullSampling;
  /** Imported reference STL — session only, never saved. */
  stl: StlState | null;
  importStl: (file: File) => void;
  changeStl: (patch: Partial<StlSettings>) => void;
  removeStl: () => void;
  /** One shared longitudinal zoom / x-pan for the plan and profile strips. */
  planProfileSync: RefObject<SvgViewSync>;
}

const Context = createContext<EditorUi | null>(null);

export function useEditorUi(): EditorUi {
  const ui = useContext(Context);
  if (!ui) throw new Error("useEditorUi needs an EditorUiProvider above it");
  return ui;
}

export function EditorUiProvider({ children }: { children: ReactNode }) {
  const store = useDocumentStore();
  const snapshot = useDocumentSnapshot();
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();

  const [tool, setTool] = useState<Tool>("select");
  const [curvature, setCurvature] = useState(defaultCurvature);
  const [selection, setSelection] = useState<ModelSelection>(null);
  const [knotLongs, setKnotLongs] = useState(false);
  const [activeStationRaw, setActiveStation] = useState(0);
  const activeStation = Math.min(activeStationRaw, model.stations.length - 1);
  const [stl, setStl] = useState<StlState | null>(null);
  const planProfileSync = useSvgViewSync();

  // The performance readout. Its `on` drives the core's recording switch — a module-level flag rather than
  // state, because the draws that report into it are imperative and must not re-render anything — so the
  // toggle is pushed there and one redraw is forced, which is what fills the panel.
  const [perf, setPerfState] = useState<PerfSettings>(defaultPerf);
  const [redraws, setRedraws] = useState(0);
  const setPerf = useCallback(
    (next: PerfSettings) => {
      setPerfState((prev) => {
        if (next.on !== prev.on) {
          setPerfOn(next.on);
          perfFrame();
          setRedraws((v) => v + 1); // no hull moved, so nothing else will re-run the sampling
        }
        return next;
      });
    },
    [setPerfState, setRedraws],
  );

  // The window listeners read these at their latest without re-subscribing, so a drag does not re-bind a
  // pointermove handler on every frame.
  const modelRef = useRef(model);
  const selectionRef = useRef(selection);
  useEffect(() => {
    modelRef.current = model;
    selectionRef.current = selection;
  }, [model, selection]);

  // ---------- the one hull sampling every view shares ----------
  // The swept sheet and its three trims (mesh.ts), sampled at the Performance control's resolution. Computed
  // during render, before the child views' draw effects, so every view sees the same lattice and nothing
  // re-sweeps the hull for itself. The 2D strips read its trimmed sections for the outline; the 3D view
  // stitches them into the surface.
  //
  // Keyed on the four AUTHORED-GEOMETRY slice revisions, not on the model's identity. `computeHullSampling`
  // reads the plan curve, the trim graph, the transom and the loft, and nothing else — so the waterline, the
  // deck rake and the cut station are deliberately absent from the dependencies. Keying on the model would
  // rebuild the whole sampling for every frame of a waterline drag or a cut-station scrub, which is the most
  // expensive thing in the editor and the thing every extra window would duplicate.
  const { plan, trim, transom, stations } = snapshot.sliceRevs;
  const sampling = useMemo<HullSampling>(() => {
    perfBegin(PERF_SAMPLING);
    const out = computeHullSampling(model, perf.numSections, perf.girthSteps);
    perfEnd(PERF_SAMPLING);
    return out;
    // `model` is read but intentionally not a dependency: the slice revisions above say when its geometry
    // changed, and `redraws` is how the Performance toggle forces one more pass with nothing having moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    plan,
    trim,
    transom,
    stations,
    redraws,
    perf.numSections,
    perf.girthSteps,
  ]);

  // ---------- window-level drag (2D control points) ----------
  // Drags are begun on the SVG nodes (draw2d's startDrag sets the shared drag + selects); the move is applied
  // here at the window level, mapping the pointer into model space and dispatching the matching command. The
  // 3D rotate / zoom drag is handled inside View3d, so it never reaches this handler.
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
        void dispatch({
          type: "movePlanPoint",
          idx,
          x: v.invX(vx),
          y: v.invY(vy),
        });
      else if (drag.kind === "trim")
        void dispatch({ type: "moveTrim", idx, x: v.invX(vx), z: v.invZp(vy) });
      else if (drag.kind === "transom")
        void dispatch({
          type: "moveTransom",
          idx,
          x: v.invX(vx),
          z: v.invZp(vy),
        });
      // a station handle rides the plan curve: the station's u is the plan point NEAREST the pointer, not
      // the one straight below it. Where the plan turns toward the centerline at the bow, a vertical hit
      // slides far along the curve for a small sideways move (and stops responding at all once the pointer
      // passes the stem); the nearest point keeps the handle under the hand. The plan is drawn at the one
      // isometric scale (view.ts), so nearest in model space is also nearest on screen.
      else if (drag.kind === "stationU")
        void dispatch({
          type: "moveStationU",
          idx,
          u: m.plan.uAtPoint([v.invX(vx), v.invY(vy)]),
        });
      else if (drag.kind === "stn")
        void dispatch({
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
  }, [store, dispatch]);

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
        void dispatch(cmd);
        return;
      }
      // Undo is new with the store: before it, an edit overwrote the hull in place and there was nothing to
      // step back to. A drag is one step — consecutive moves of the same point coalesce in the server.
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
  }, [store, dispatch, setSelection]);

  const importStl = useCallback(
    (file: File) => {
      void (async () => {
        try {
          const geom = parseStl(await file.arrayBuffer());
          // freeze the current hull bounds; the fit scale is relative to them
          const designBox = getHullBBox(modelRef.current);
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
      })();
    },
    [setStl],
  );
  const changeStl = useCallback(
    (patch: Partial<StlSettings>) =>
      setStl((s) => (s ? { ...s, settings: { ...s.settings, ...patch } } : s)),
    [setStl],
  );
  const removeStl = useCallback(() => setStl(null), [setStl]);

  const value: EditorUi = {
    tool,
    setTool,
    curvature,
    setCurvature,
    selection,
    setSelection,
    knotLongs,
    setKnotLongs,
    activeStation,
    setActiveStation,
    perf,
    setPerf,
    sampling,
    stl,
    importStl,
    changeStl,
    removeStl,
    planProfileSync,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
