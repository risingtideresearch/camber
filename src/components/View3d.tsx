import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDraw3dParams,
  draw3d,
  MESH_M_DEFAULT,
  MESH_N_DEFAULT,
  type Draw3dParams,
  type View3DMode,
} from "../core/draw3d";
import type { Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import type { StlState } from "../core/stlImport";
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
  // the editor-wide curvature-comb overlay (owned by EditorApp's Curvature control); omitted by hosts that
  // don't drive it (the interpolation app), where it defaults to all-off
  curvature?: CurvatureSettings;
  title?: string; // optional label overlaid top-left of the canvas (e.g. "Blended Hull")
}

export function View3d({
  model,
  modelVersion,
  selection,
  curvature = CURVATURE_OFF,
  stl,
  title,
}: View3dProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null); // the lines-plan overlay, owned by this instance (no global id lookup)
  const paramsRef = useRef<Draw3dParams>(createDraw3dParams());
  // the display mode, the Mesh-overlay toggle, the quads/triangles wire choice, and the mesh resolution (M/N)
  // are React-owned; the rebuild effect copies them into paramsRef before each draw, so paramsRef's own
  // view3dMode / showMesh / meshQuads / meshM / meshN are always overwritten and their initial values are irrelevant.
  const [mode, setMode] = useState<View3DMode>("render");
  const [showMesh, setShowMesh] = useState(false); // overlay the quad-grid wireframe on the shaded GL modes
  const [meshQuads, setMeshQuads] = useState(true); // wire as quads (default) or the raw shaded triangles
  const [meshM, setMeshM] = useState(MESH_M_DEFAULT); // longitudinals per half-section (girth res.)
  const [meshN, setMeshN] = useState(MESH_N_DEFAULT); // sections along the length (station res.)
  const [meshMenu, setMeshMenu] = useState(false); // the mesh-resolution dropdown open state

  // latest selection / STL for the ref-reading redraws (rotate / zoom / resize) so they need not re-subscribe
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

  // rebuild + redraw whenever the model, the selection, the display mode, the Mesh overlay, the mesh
  // resolution (M/N), or the STL changes
  // rebuild + redraw whenever the model, the selection, the display mode, or the sheer toggle changes
  useEffect(() => {
    const p = paramsRef.current;
    p.view3dMode = mode;
    p.showMesh = showMesh;
    p.meshQuads = meshQuads;
    p.meshM = meshM;
    p.meshN = meshN;
    p.curvature = curvature;
    const cv = canvasRef.current;
    if (cv) draw3d(cv, svgRef.current, model, selection, p, true, stl);
  }, [
    model,
    modelVersion,
    selection,
    mode,
    showMesh,
    meshQuads,
    meshM,
    meshN,
    stl,
    curvature,
  ]);

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
          title="Overlay the hull's quad grid as a wireframe (works in Render, Zebra, and Sheet)"
          menuLabel="Mesh resolution"
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
          <label
            className="dd-row"
            title="Number of longitudinal lines per half-section (girth resolution)"
          >
            <span className="dd-name">Num longitudinals</span>
            <input
              type="range"
              min={4}
              max={128}
              step={4}
              value={meshM}
              onChange={(e) => setMeshM(+e.target.value)}
            />
            <span className="dd-val">{meshM}</span>
          </label>
          <label
            className="dd-row"
            title="Number of sampled sections along the length (station resolution)"
          >
            <span className="dd-name">Num sections</span>
            <input
              type="range"
              min={8}
              max={512}
              step={8}
              value={meshN}
              onChange={(e) => setMeshN(+e.target.value)}
            />
            <span className="dd-val">{meshN}</span>
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
