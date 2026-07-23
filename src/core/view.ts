// ---------- view transforms: world coordinates → screen (SVG viewBox) coordinates ----------
//
// The drawings are laid out against a hull length, not against fixed world numbers: v2 coordinates are
// absolute in a real unit, so a 5 m hull and a 500 mm one are both legitimate and neither can be assumed.
// `makeView(len)` therefore builds the transforms for a hull of length `len` — everything below is a
// proportion of that, which is also how `boundsOf` in model.ts sizes the panels, so the transforms and the
// panels agree by construction.
//
// That length is `model.viewLen`, CAPTURED when the hull was installed, not the live LOA. Control points are
// dragged freely, the last of them redefining the LOA as it goes; reading the live length here would rescale
// and re-centre every strip on each pointer move, which is the one thing a drag must not do. A hull edited
// past the panel it was fitted to just draws outside it, until the user pans or zooms out.
//
// The panel sizes that fall out (lh, ph) depend on len; the ones that don't (STW, STH, the paddings) are
// plain constants.

import { boundsOf, type Model } from "./model";

// ---------- len-independent constants ----------
export const PXpad = 60; // x padding, in viewBox units, at each end of the 1000-wide strips
export const Ptop = 20,
  Pbot = 24;
export const Ppad = 18;
export const STW = 360, // the station editor is square, at its own fit-to-content scale
  STH = 360,
  STpad = 26;

// The profile strip's z window, as a fraction of the hull's length: enough room below the deck for the keel
// and a little air above it. (v1 had these as absolute world numbers against its fixed L = 1000.)
const ZMIN_F = -0.35,
  ZMAX_F = 0.08;

export interface View {
  len: number;
  // shared longitudinal (x) mapping for plan + profile. sx (viewBox units per model unit, from fitting the
  // hull's length across the 1000-wide panel) is the SINGLE isometric scale: the plan's breadth and the
  // profile's depth use it too, so all three drawings are to one scale and read the same proportions as the
  // 3D view.
  sx: number;
  mapX: (x: number) => number;
  invX: (vx: number) => number;
  // profile: z up, flat deck at 0, keel below — same units per model unit as x (isometric)
  zMin: number;
  zMax: number;
  ph: number; // panel height, so the z range fits at the isometric scale
  zScreenP: (z: number) => number;
  invZp: (vy: number) => number;
  pzBase: number;
  // plan: a single half-breadth, growing upward at the same scale as x. The strip reserves a band BELOW the
  // centerline (down to bounds.yMin) so the sheer plan can be drawn crossing y = 0 — which is how a hull is
  // closed at the bow now that there is no separate overhang: the plan is simply dragged past the centerline.
  lh: number;
  lbase: number; // screen y of the centerline (y = 0)
  yPlan: (y: number) => number;
  invY: (vy: number) => number;
  // station editor: n across (inboard), z down
  stsc: number;
  snX: (n: number) => number;
  snY: (z: number) => number;
  invN: (vx: number) => number;
  invZ: (vy: number) => number;
}

export function makeView(len: number): View {
  const l = len > 0 ? len : 1;
  const sx = (1000 - 2 * PXpad) / l;
  const zMin = ZMIN_F * l,
    zMax = ZMAX_F * l,
    ph = (zMax - zMin) * sx + Ptop + Pbot,
    pzBase = ph - Pbot;
  // the plan strip's height and the station editor's box come from the same panel sizes model.ts states
  const b = boundsOf(l),
    lh = (b.yMax - b.yMin) * sx + 2 * Ppad,
    lbase = Ppad + b.yMax * sx;
  const stsc = (STW - 2 * STpad) / (b.nMax - b.nMin);
  return {
    len: l,
    sx,
    mapX: (x) => PXpad + x * sx,
    invX: (vx) => (vx - PXpad) / sx,
    zMin,
    zMax,
    ph,
    pzBase,
    zScreenP: (z) => pzBase - (z - zMin) * sx,
    invZp: (vy) => zMin + (pzBase - vy) / sx,
    lh,
    lbase,
    yPlan: (y) => lbase - y * sx,
    invY: (vy) => (lbase - vy) / sx,
    stsc,
    snX: (n) => STpad + (n - b.nMin) * stsc,
    snY: (z) => STpad + -z * stsc, // z is ≤ 0 and grows downward on screen
    invN: (vx) => (vx - STpad) / stsc + b.nMin,
    invZ: (vy) => -((vy - STpad) / stsc),
  };
}

export const viewOf = (model: Model): View => makeView(model.viewLen);
