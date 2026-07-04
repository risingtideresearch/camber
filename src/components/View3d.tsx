import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDraw3dParams,
  draw3d,
  type Draw3dParams,
  type View3DMode,
} from "../core/draw3d";
import type { Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import { clamp } from "../core/math";
import { Button } from "./Button";
import "./View3d.css";

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
  title?: string; // optional label overlaid top-left of the canvas (e.g. "Blended Hull")
}

export function View3d({ model, modelVersion, selection, title }: View3dProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paramsRef = useRef<Draw3dParams>(createDraw3dParams());
  // the display mode is React-owned; the rebuild effect copies it into paramsRef before each draw, so
  // paramsRef's own view3dMode is always overwritten and its initial value is irrelevant.
  const [mode, setMode] = useState<View3DMode>("render");

  // latest selection for the ref-reading redraws (rotate / zoom / resize) so they need not re-subscribe
  const selRef = useRef(selection);
  useEffect(() => {
    selRef.current = selection;
  }, [selection]);

  // redraw the GL only (no mesh rebuild) — for rotation, zoom, and resize
  const redrawGL = useCallback(() => {
    const cv = canvasRef.current;
    if (cv) draw3d(cv, model, selRef.current, paramsRef.current, false);
  }, [model]);

  // rebuild + redraw whenever the model, the selection, or the display mode changes
  useEffect(() => {
    paramsRef.current.view3dMode = mode;
    const cv = canvasRef.current;
    if (cv) draw3d(cv, model, selection, paramsRef.current, true);
  }, [model, modelVersion, selection, mode]);

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
        id="cv3d"
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <svg id="lines3d" className="lines3d" style={{ display: "none" }} />
      {title && <div className="view3dtitle">{title}</div>}
      <div className="view3dctl">
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
  );
}
