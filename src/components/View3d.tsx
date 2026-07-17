import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createDraw3dParams,
  draw3d,
  type Draw3dParams,
  type View3DMode,
} from "../core/draw3d";
import type { Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import type { StlState } from "../core/stlImport";
import { computeHullSampling, type HullSampling } from "../core/mesh";
import { PERF_N_DEFAULT, PERF_R_DEFAULT } from "../core/perf";
import { defaultCurvature, type CurvatureSettings } from "../core/comb";
import { clamp } from "../core/math";
import { Button } from "./Button";
import { Dropdown } from "./Dropdown";
import "./View3d.css";

// a stable "all off" default for hosts (e.g. the interpolation app) that don't drive the curvature overlay —
// a module constant so it keeps the same identity across renders and never triggers a needless rebuild
const CURVATURE_OFF = defaultCurvature();

// The 3D viewport. It OWNS its draw3dParams (rotation / zoom / display mode) — nothing upstream needs them —
// and drives the WebGL canvas + the lines-plan SVG overlay imperatively via draw3d(), reacting to `model` /
// `selection` from above. Drag-rotate and scroll-zoom mutate the local params and redraw only the GL (the
// cached mesh is reused); a model change rebuilds the mesh.
const MODES: { mode: View3DMode; label: string; title: string }[] = [
  { mode: "render", label: "Render", title: "Shaded hull" },
  { mode: "body", label: "Body", title: "Lines plan — body (stations)" },
  {
    mode: "buttocks",
    label: "Buttocks",
    title: "Lines plan — buttocks (constant-y cuts)",
  },
  {
    mode: "waterline",
    label: "Waterline",
    title: "Lines plan — waterlines (constant-z cuts)",
  },
  { mode: "zebra", label: "Zebra", title: "Zebra-stripe fairness check" },
  { mode: "sheet", label: "Sheet", title: "Untrimmed swept sheet (one side)" },
];

interface View3dProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  stl?: StlState | null; // optional imported reference mesh, drawn translucent over the hull
  // the shared hull sampling the surface is built from. EditorApp computes it once (at the Performance
  // resolution) and passes it in; hosts that don't (the interpolation app) omit it and get a default-
  // resolution sampling computed here, so the 3D view always has a lattice to tessellate.
  sampling?: HullSampling;
  // the editor-wide curvature-comb overlay (owned by EditorApp's Curvature control); omitted by hosts that
  // don't drive it (the interpolation app), where it defaults to all-off
  curvature?: CurvatureSettings;
  title?: string; // optional label overlaid top-left of the canvas (e.g. "Blended Hull")
}

export function View3d({
  model,
  modelVersion,
  selection,
  sampling,
  curvature = CURVATURE_OFF,
  stl,
  title,
}: View3dProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null); // the lines-plan overlay, owned by this instance (no global id lookup)
  const paramsRef = useRef<Draw3dParams>(createDraw3dParams());
  // the display mode, the Mesh-overlay toggle, and the quads/triangles wire choice are React-owned; the
  // rebuild effect copies them into paramsRef before each draw, so paramsRef's own view3dMode / showMesh /
  // meshQuads are always overwritten and their initial values are irrelevant.
  const [mode, setMode] = useState<View3DMode>("render");
  const [showMesh, setShowMesh] = useState(false); // overlay the quad-grid wireframe on the shaded GL modes
  const [meshQuads, setMeshQuads] = useState(true); // wire as quads (default) or the raw shaded triangles
  const [meshMenu, setMeshMenu] = useState(false); // the Mesh overlay dropdown open state

  // the sampling to tessellate: the one passed in, or a default-resolution fallback computed here for hosts
  // that don't supply one (the interpolation app). Only computed when no sampling is given.
  const fallback = useMemo(
    () =>
      sampling
        ? null
        : computeHullSampling(model, PERF_N_DEFAULT, PERF_R_DEFAULT),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sampling, model, modelVersion],
  );
  const effSampling = sampling ?? fallback;

  // latest model / selection / STL for the ref-reading redraws (rotate / zoom / resize / selection) so they
  // need not re-subscribe
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  const selRef = useRef(selection);
  useEffect(() => {
    selRef.current = selection;
  }, [selection]);
  const stlRef = useRef(stl);
  useEffect(() => {
    stlRef.current = stl;
  }, [stl]);

  // redraw the GL only (no mesh rebuild) — for rotation, zoom, and resize
  const redrawGL = useCallback(() => {
    const cv = canvasRef.current;
    if (cv)
      draw3d(
        cv,
        svgRef.current,
        model,
        selRef.current,
        paramsRef.current,
        false,
        stlRef.current,
      );
  }, [model]);

  // rebuild + redraw whenever the model, the display mode, the Mesh overlay, the shared hull sampling, the
  // curvature overlay, or the STL changes — everything the cached hull tessellation depends on
  useEffect(() => {
    const p = paramsRef.current;
    p.view3dMode = mode;
    p.showMesh = showMesh;
    p.meshQuads = meshQuads;
    p.sampling = effSampling;
    p.curvature = curvature;
    const cv = canvasRef.current;
    if (cv) draw3d(cv, svgRef.current, model, selRef.current, p, true, stl);
  }, [
    model,
    modelVersion,
    mode,
    showMesh,
    meshQuads,
    effSampling,
    stl,
    curvature,
  ]);

  // a selection change only moves the amber guide overlay, which is re-derived on every draw — redraw the
  // cached mesh (rebuild=false) instead of re-tessellating the hull
  useEffect(() => {
    const cv = canvasRef.current;
    if (cv)
      draw3d(
        cv,
        svgRef.current,
        modelRef.current,
        selection,
        paramsRef.current,
        false,
        stlRef.current,
      );
  }, [selection]);

  // scroll-wheel zoom — a native non-passive listener so preventDefault() works (React's onWheel is passive)
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = paramsRef.current;
      p.zoom = clamp(p.zoom * Math.exp(-e.deltaY * 0.0015), 0.3, 8);
      redrawGL();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [redrawGL]);

  // redraw the cached-mesh canvas at its new size when the viewport is resized
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => redrawGL());
    ro.observe(cv);
    return () => ro.disconnect();
  }, [redrawGL]);

  // drag-rotate via pointer capture on the canvas (no window listeners needed)
  const rotRef = useRef<{
    px: number;
    py: number;
    yaw0: number;
    pitch0: number;
  } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = paramsRef.current;
    rotRef.current = {
      px: e.clientX,
      py: e.clientY,
      yaw0: p.rot.yaw,
      pitch0: p.rot.pitch,
    };
    canvasRef.current?.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = rotRef.current;
    if (!r) return;
    const p = paramsRef.current;
    p.rot.yaw = r.yaw0 + (e.clientX - r.px) * 0.008;
    p.rot.pitch = clamp(r.pitch0 + (e.clientY - r.py) * 0.008, -1.45, 1.45);
    redrawGL();
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    rotRef.current = null;
    canvasRef.current?.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="top3d">
      <canvas
        className="cv3d"
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <svg ref={svgRef} className="lines3d" style={{ display: "none" }} />
      {title && <div className="view3dtitle">{title}</div>}
      <div className="view3dctl">
        <Dropdown
          label="Mesh"
          active={showMesh}
          onToggle={() => setShowMesh((v) => !v)}
          open={meshMenu}
          onOpenChange={setMeshMenu}
          title="Overlay the hull's quad grid as a wireframe (works in Render, Zebra, and Sheet). Its resolution is set by the Performance control's hull-sampling sliders."
          menuLabel="Mesh overlay"
        >
          <label
            className="dd-row dd-check"
            title="Wireframe as the hull's quad grid; unchecked shows the raw triangles the shaded hull renders"
          >
            <input
              type="checkbox"
              checked={meshQuads}
              onChange={(e) => setMeshQuads(e.target.checked)}
            />
            <span className="dd-name">As quads</span>
          </label>
        </Dropdown>
        <div className="view3dmodes">
          {MODES.map((m) => (
            <Button
              key={m.mode}
              active={mode === m.mode}
              title={m.title}
              onClick={() => setMode(m.mode)}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
