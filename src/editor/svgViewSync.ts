import { useRef, type RefObject } from "react";

// Shared zoom / pan state that keeps several SvgViews aligned. The views holding one controller share a
// single horizontal scale and x-translation (and repaint together on zoom / pan), while each keeps its own
// vertical offset. The plan and profile strips use this so they stay lined up on the longitudinal axis.
//
// s (sx = sy in the zoomable views), tx and the fit baseline are common; each contributing view registers a
// member carrying its own vertical offset, content box, and repaint hooks. A standalone SvgView uses a
// private controller with a single member, so the same code path drives shared and unshared views.
export interface SvgViewSync {
  sx: number;
  sy: number;
  tx: number;
  fit: number; // the base fit scale, so wheel-zoom can clamp relative to it
  w: number; // shared view width (aligned views live in one column, so they share a width)
  fitted: boolean; // an initial fit has been established
  userAdjusted: boolean; // the user has zoomed / panned → stop auto-fitting on resize
  members: Set<SvgMember>;
}

export interface SvgMember {
  cw: number; // content width
  ch: number; // content height
  pad: number;
  h: number; // this view's height in px (0 until it has been measured)
  ty: number; // this view's own vertical offset
  apply: () => void; // rewrite the transform (scale unchanged)
  repaint: () => void; // rewrite the transform and redraw the content
}

// Create a controller. Share the returned ref across SvgViews (via their `sync` prop) to keep them aligned.
// It's mutable state living outside render — effects / handlers read and write `.current`, never render.
export function useSvgViewSync(): RefObject<SvgViewSync> {
  return useRef<SvgViewSync>({
    sx: 1,
    sy: 1,
    tx: 0,
    fit: 1,
    w: 0,
    fitted: false,
    userAdjusted: false,
    members: new Set(),
  });
}

// this member's fit scale for a given (shared) view width: fit content into the area, minus padding
export function memberFit(m: SvgMember, w: number): number {
  return Math.max(
    1e-6,
    Math.min((w - 2 * m.pad) / m.cw, (m.h - 2 * m.pad) / m.ch),
  );
}

// (re)fit the shared view: pick the scale that fits every measured member (the smallest fit, so none
// overflows), center horizontally, center each member vertically, and redraw them all. Used until the user
// zooms / pans; after that the scale is held and resizes only recenter.
export function refit(H: SvgViewSync, w: number, cw: number): void {
  let fit = Infinity;
  for (const m of H.members) if (m.h > 0) fit = Math.min(fit, memberFit(m, w));
  if (!isFinite(fit)) return;
  H.sx = fit;
  H.sy = fit;
  H.fit = fit;
  H.w = w;
  H.tx = (w - fit * cw) / 2;
  H.fitted = true;
  for (const m of H.members)
    if (m.h > 0) {
      m.ty = (m.h - fit * m.ch) / 2;
      m.repaint();
    }
}
