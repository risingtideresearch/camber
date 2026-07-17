// ---------- view transforms: world coordinates → screen (SVG viewBox) coordinates ----------
//
// The drawings are laid out against the hull's own length, not against fixed world numbers: v2 coordinates
// are absolute in a real unit, so a 5 m hull and a 500 mm one are both legitimate and neither can be assumed.
// `makeView(len)` therefore builds the transforms for a hull of length `len` (its LOA) — everything below is
// a proportion of that, which is also how `bounds` in model.ts states the editable domain, so the drawn
// panels and the drag limits agree by construction.
//
// The panel sizes that fall out (lh, ph) depend on len; the ones that don't (STW, STH, the paddings) are
// plain constants.

import { bounds, loa, type Model } from "./model";

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
  // the plan and station domains come from the model's own editable bounds, so a point can never be dragged
  // somewhere the drawing has no room for
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

// the editable bounds for a hull of length `l`, without needing a Model to ask
function boundsOf(l: number): ReturnType<typeof bounds> {
  return bounds({
    sheerPlan: [
      { x: 0, y: 0 },
      { x: l, y: 0 },
    ],
  } as Model);
}

export const viewOf = (model: Model): View => makeView(loa(model));
