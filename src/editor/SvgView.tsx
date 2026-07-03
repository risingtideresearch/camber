import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { clamp } from "../core/math";
import { svgPoint } from "./svgCoords";
import "./SvgView.css";

// A pan / zoom-able <svg> shared by every 2D editor view. It fills its container (no fixed aspect ratio) and
// draws into a single content <g> whose transform maps the view's fixed content coordinates → screen pixels.
//
//  • "zoom" mode: the content is fit into the area (uniform, centered), then wheel-zooms toward the cursor and
//     drag-pans on empty space. A press that doesn't move is reported as a background click (add / deselect).
//  • "fill" mode: the content is stretched to fill the whole area (non-uniform) and neither zooms nor pans —
//     used for the weights graph, which should always occupy the whole space.
//
// The scale (sx, sy) is handed to `draw`, which passes it on to the draw2d routines so line widths, control
// points, and the cut triangle can be rendered at a constant screen size regardless of the zoom level.
export type SvgDraw = (g: SVGGElement, sx: number, sy: number) => void;

interface SvgViewProps {
  // the content coordinate box the draw fn draws in (origin at 0, 0)
  contentWidth: number;
  contentHeight: number;
  // (re)draw the content into `g` at the given content→screen scale. Wrap it in useCallback keyed on the
  // model / selection it reads: its identity changing is what triggers a redraw.
  draw: SvgDraw;
  mode?: "zoom" | "fill";
  padding?: number; // screen-px margin kept around the content in "zoom" mode's initial fit
  cursor?: string;
  // a genuine background click (a press that didn't pan), at content coordinates
  onBackgroundClick?: (cx: number, cy: number) => void;
  className?: string;
}

interface ViewState {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  w: number;
  h: number;
  fit: number; // the base fit scale, so wheel-zoom can clamp relative to it
  fitted: boolean;
}

export function SvgView({
  contentWidth,
  contentHeight,
  draw,
  mode = "zoom",
  padding = 6,
  cursor,
  onBackgroundClick,
  className,
}: SvgViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const view = useRef<ViewState>({
    sx: 1,
    sy: 1,
    tx: 0,
    ty: 0,
    w: 0,
    h: 0,
    fit: 1,
    fitted: false,
  });
  // keep the latest callbacks reachable from the effect-bound (wheel / resize) handlers without re-binding.
  // Synced in a layout effect (runs before the passive paint effect below, so paint sees the latest draw).
  const drawRef = useRef(draw);
  const clickRef = useRef(onBackgroundClick);
  useLayoutEffect(() => {
    drawRef.current = draw;
    clickRef.current = onBackgroundClick;
  });

  const applyTransform = useCallback(() => {
    const g = gRef.current,
      v = view.current;
    if (g)
      g.setAttribute(
        "transform",
        `matrix(${v.sx} 0 0 ${v.sy} ${v.tx} ${v.ty})`,
      );
  }, []);

  const paint = useCallback(() => {
    const g = gRef.current,
      v = view.current;
    if (!g || !v.fitted) return;
    applyTransform();
    drawRef.current(g, v.sx, v.sy);
  }, [applyTransform]);

  // measure, fit, and keep fitting on resize
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const fitTo = (w: number, h: number) => {
      const v = view.current;
      if (mode === "fill") {
        v.sx = w / contentWidth;
        v.sy = h / contentHeight;
        v.tx = 0;
        v.ty = 0;
        v.fit = v.sx;
      } else {
        const s = Math.max(
          1e-6,
          Math.min(
            (w - 2 * padding) / contentWidth,
            (h - 2 * padding) / contentHeight,
          ),
        );
        v.sx = s;
        v.sy = s;
        v.fit = s;
        v.tx = (w - s * contentWidth) / 2;
        v.ty = (h - s * contentHeight) / 2;
      }
    };
    const onResize = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return; // hidden (e.g. an inactive template tab) — wait until it's shown
      const v = view.current;
      if (!v.fitted) {
        fitTo(w, h);
        v.w = w;
        v.h = h;
        v.fitted = true;
        paint();
      } else if (mode === "fill") {
        fitTo(w, h); // the fill scale depends on the size, so re-fit and redraw at the new scale
        v.w = w;
        v.h = h;
        paint();
      } else {
        // keep the user's zoom; just hold the same content point at the centre of the (resized) view
        v.tx += (w - v.w) / 2;
        v.ty += (h - v.h) / 2;
        v.w = w;
        v.h = h;
        applyTransform();
      }
    };
    const r = svg.getBoundingClientRect();
    onResize(r.width, r.height);
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      onResize(cr.width, cr.height);
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, [mode, contentWidth, contentHeight, padding, paint, applyTransform]);

  // redraw when the draw fn (i.e. the model / selection it closes over) changes
  useEffect(() => {
    paint();
  }, [draw, paint]);

  // wheel-zoom toward the cursor — a native non-passive listener so preventDefault() works (zoom mode only)
  useEffect(() => {
    if (mode !== "zoom") return;
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      if (!v.fitted) return;
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left,
        my = e.clientY - r.top,
        cx = (mx - v.tx) / v.sx,
        cy = (my - v.ty) / v.sy,
        s = clamp(v.sx * Math.exp(-e.deltaY * 0.0015), v.fit * 0.2, v.fit * 40);
      v.sx = s;
      v.sy = s;
      v.tx = mx - cx * s;
      v.ty = my - cy * s;
      paint();
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [mode, paint]);

  // a press on empty space: drag to pan (zoom mode); if it doesn't move, report a background click. Presses
  // on control points never reach here — their own listeners stopPropagation before this fires.
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const svg = svgRef.current,
      g = gRef.current;
    if (!svg || !g) return;
    const v = view.current,
      sx0 = e.clientX,
      sy0 = e.clientY,
      tx0 = v.tx,
      ty0 = v.ty;
    let moved = false;
    svg.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx0,
        dy = ev.clientY - sy0;
      if (!moved && Math.hypot(dx, dy) > 3) moved = true;
      if (moved && mode === "zoom") {
        v.tx = tx0 + dx;
        v.ty = ty0 + dy;
        applyTransform();
      }
    };
    const up = (ev: PointerEvent) => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      if (!moved) {
        const [cx, cy] = svgPoint(g, ev.clientX, ev.clientY);
        clickRef.current?.(cx, cy);
      }
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
  };

  return (
    <svg
      ref={svgRef}
      className={"svgview" + (className ? " " + className : "")}
      style={{ cursor }}
      onPointerDown={onPointerDown}
    >
      <g ref={gRef} />
    </svg>
  );
}
