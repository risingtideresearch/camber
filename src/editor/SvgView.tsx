import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { clamp } from "../core/math";
import { svgPoint } from "./svgCoords";
import {
  refit,
  useSvgViewSync,
  type SvgMember,
  type SvgViewSync,
} from "./svgViewSync";
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
//
// Two or more views are kept aligned by sharing a controller from `useSvgViewSync()` via the `sync` prop:
// they then share one horizontal scale and x-pan (and repaint together on zoom / pan) while each keeps its
// own vertical offset. The plan and profile strips use this so they stay lined up on the longitudinal axis.
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
  // opt in to a shared horizontal scale / x-pan with the other views holding the same controller
  sync?: RefObject<SvgViewSync>;
  className?: string;
}

export function SvgView({
  contentWidth,
  contentHeight,
  draw,
  mode = "zoom",
  padding = 6,
  cursor,
  onBackgroundClick,
  sync,
  className,
}: SvgViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  // the shared (or, without `sync`, this view's private) horizontal transform. It's mutable state living
  // outside render (a ref), so effects / handlers read and write `.current` freely; render never touches it.
  const privateH = useSvgViewSync();
  const hRef = sync ?? privateH;

  // keep the latest callbacks reachable from the effect-bound (wheel / resize) handlers without re-binding.
  // Synced in a layout effect (runs before the passive paint effect below, so paint sees the latest draw).
  const drawRef = useRef(draw);
  const clickRef = useRef(onBackgroundClick);
  // this view's member of the controller (its vertical offset + repaint hooks). Created lazily in the first
  // layout effect below and only ever touched from effects / handlers, so render never reads or mutates it.
  const selfRef = useRef<SvgMember | null>(null);

  useLayoutEffect(() => {
    drawRef.current = draw;
    clickRef.current = onBackgroundClick;
    const H = hRef.current;
    let self = selfRef.current;
    if (!self) {
      self = {
        cw: contentWidth,
        ch: contentHeight,
        pad: padding,
        h: 0,
        ty: 0,
        apply() {
          const g = gRef.current;
          if (g)
            g.setAttribute(
              "transform",
              `matrix(${H.sx} 0 0 ${H.sy} ${H.tx} ${self!.ty})`,
            );
        },
        repaint() {
          const g = gRef.current;
          if (!g || !H.fitted || self!.h === 0) return;
          self!.apply();
          drawRef.current(g, H.sx, H.sy);
        },
      };
      selfRef.current = self;
    }
    // keep the content box current if the props change
    self.cw = contentWidth;
    self.ch = contentHeight;
    self.pad = padding;
  });

  // register this view with the controller while it is mounted. A layout effect (not passive) so it runs
  // before the measure / fit effect below: the fit iterates the members, so this view must already be one.
  useLayoutEffect(() => {
    const H = hRef.current,
      self = selfRef.current;
    if (!self) return;
    H.members.add(self);
    return () => {
      H.members.delete(self);
    };
  }, [hRef]);

  // measure, fit, and keep fitting on resize
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const H = hRef.current,
      self = selfRef.current!;
    const onResize = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return; // hidden (e.g. an inactive template tab) — wait until it's shown
      if (mode === "fill") {
        // stretch to fill (non-uniform); never shared, never zoomed / panned
        self.h = h;
        H.w = w;
        H.sx = w / contentWidth;
        H.sy = h / contentHeight;
        H.tx = 0;
        self.ty = 0;
        H.fit = H.sx;
        H.fitted = true;
        self.repaint();
        return;
      }
      const prevH = self.h;
      self.h = h;
      if (!H.userAdjusted) {
        refit(H, w, contentWidth); // (re)fit every aligned view to the new size
      } else if (prevH === 0) {
        // a sibling (or an earlier interaction) already set the shared zoom — adopt it, just center this
        // view vertically at the shared scale
        self.ty = (h - H.sy * contentHeight) / 2;
        self.repaint();
      } else {
        // keep the user's zoom; hold the same content point centered as the view resizes. The x-shift is
        // shared, so apply it once (the first aligned view to report the new width); the y-shift is per view.
        if (w !== H.w) {
          H.tx += (w - H.w) / 2;
          H.w = w;
        }
        self.ty += (h - prevH) / 2;
        // scale is unchanged, so every aligned view only needs its transform rewritten
        for (const m of H.members) m.apply();
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
  }, [mode, contentWidth, contentHeight, padding, hRef]);

  // redraw when the draw fn (i.e. the model / selection it closes over) changes
  useEffect(() => {
    selfRef.current?.repaint();
  }, [draw]);

  // wheel-zoom toward the cursor — a native non-passive listener so preventDefault() works (zoom mode only)
  useEffect(() => {
    if (mode !== "zoom") return;
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const H = hRef.current,
        self = selfRef.current;
      if (!self || !H.fitted) return;
      const r = svg.getBoundingClientRect();
      const sPrev = H.sx;
      const mx = e.clientX - r.left,
        my = e.clientY - r.top,
        cx = (mx - H.tx) / H.sx,
        cy = (my - self.ty) / H.sy,
        s = clamp(H.sx * Math.exp(-e.deltaY * 0.0015), H.fit * 0.2, H.fit * 40);
      H.sx = s;
      H.sy = s;
      H.tx = mx - cx * s; // keep the content x under the cursor fixed (shared)
      self.ty = my - cy * s; // keep the content y under the cursor fixed (this view only)
      H.userAdjusted = true;
      // scale changed → every aligned view redraws. The view under the cursor anchors on the cursor (above);
      // the others zoom about their own vertical center, so their current vertical framing is preserved.
      for (const m of H.members) {
        if (m !== self) {
          const half = m.h / 2;
          m.ty = half - (s / sPrev) * (half - m.ty);
        }
        m.repaint();
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [mode, hRef]);

  // a press on empty space: drag to pan (zoom mode); if it doesn't move, report a background click. Presses
  // on control points never reach here — their own listeners stopPropagation before this fires.
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const svg = svgRef.current,
      g = gRef.current,
      self = selfRef.current,
      H = hRef.current;
    if (!svg || !g || !self) return;
    const sx0 = e.clientX,
      sy0 = e.clientY,
      tx0 = H.tx,
      ty0 = self.ty;
    let moved = false;
    svg.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx0,
        dy = ev.clientY - sy0;
      if (!moved && Math.hypot(dx, dy) > 3) moved = true;
      if (moved && mode === "zoom") {
        H.tx = tx0 + dx; // x-pan is shared across aligned views
        self.ty = ty0 + dy; // y-pan is this view's own
        H.userAdjusted = true;
        for (const m of H.members) m.apply(); // scale unchanged → transform-only
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
