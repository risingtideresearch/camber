// ---------- view transforms: world coordinates → screen (SVG viewBox) coordinates ----------

import { L, XFWD, NMIN, NMAX, DMAX } from "./model.js";

// shared longitudinal (x) mapping for plan + profile. SX (px per mm, set by fitting the length L — plus the
// forward trim overhang XFWD — across the 1000-wide panel) is the SINGLE isometric scale: the plan's breadth
// and the profile's depth use it too, so all three drawings are to one scale and read the same proportions as
// the 3D view. The plan and profile panel heights are derived from that scale so the breadth / depth domains
// fill them. The extra XFWD reserves room to the right of x=L for sheer-trim points over the bow overhang.
export const PXpad = 60,
  SX = (1000 - 2 * PXpad) / (L + XFWD);
export const mapX = (x: number): number => PXpad + x * SX;
export const invX = (vx: number): number => (vx - PXpad) / SX;

// profile: z up, flat deck at 0, keel below — same px/mm as x (isometric)
export const Ptop = 20,
  Pbot = 24,
  ZMIN = -1400,
  ZMAX = 320,
  SZ = SX,
  PH = (ZMAX - ZMIN) * SZ + Ptop + Pbot, // height so the z range fits at the isometric scale
  PZbase = PH - Pbot;
export const zScreenP = (z: number): number => PZbase - (z - ZMIN) * SZ;
export const invZp = (vy: number): number => ZMIN + (PZbase - vy) / SZ;
export const ZTRIMMIN = -1100; // sheer trim must stay below the deck: z in [ZTRIMMIN,0]

// plan: a single half-breadth — centerline along the BOTTOM edge, breadth growing upward — at the same
// px/mm as x (isometric). (Previously a full mirrored breadth about a centre axis; now one half fills it.)
export const YMAX = 1100,
  SYP = SX,
  Ppad = 18,
  LH = YMAX * SYP + 2 * Ppad, // height so one half-breadth (0..YMAX) fits at the isometric scale
  Lbase = LH - Ppad; // the centerline, at the bottom of the strip
export const yPlan = (y: number): number => Lbase - y * SYP; // breadth grows up from the centerline
export const invY = (vy: number): number => (Lbase - vy) / SYP;

// station editors (square, equal aspect): n across (inboard), d down
export const STW = 360,
  STH = 360,
  STpad = 26,
  STsc = (STW - 2 * STpad) / (NMAX - NMIN);
export const snX = (n: number): number => STpad + (n - NMIN) * STsc;
export const snY = (d: number): number => STpad + d * STsc;
export const invN = (vx: number): number => (vx - STpad) / STsc + NMIN;
export const invD = (vy: number): number => (vy - STpad) / STsc;

// blend control (vertical): the longitudinal axis runs DOWN the strip — stern (x=0) at the top, bow (x=L)
// at the bottom — and each template's share of the simplex stacks left→right. It owns its own viewBox
// WVW×WVH (set on the SVG in main.ts). wvX maps the hull length to the vertical; wvW maps a cumulative
// weight 0..1 to the horizontal.
export const WVW = 300,
  WVH = 470,
  Wvtop = 18,
  Wvbot = 22,
  Wvpad = 18;
export const wvX = (x: number): number => Wvtop + (x / L) * (WVH - Wvtop - Wvbot);
export const invWvX = (vy: number): number => ((vy - Wvtop) / (WVH - Wvtop - Wvbot)) * L;
export const wvW = (c: number): number => Wvpad + c * (WVW - 2 * Wvpad); // cumulative weight → left→right
export const invWvW = (vx: number): number => (vx - Wvpad) / (WVW - 2 * Wvpad);

// re-export the domain bounds the views also use
export { NMIN, NMAX, DMAX };
