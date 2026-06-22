// ---------- view transforms: world coordinates → screen (SVG viewBox) coordinates ----------

import { L, NMIN, NMAX, DMAX } from "./model.js";

// shared longitudinal (x) mapping for plan + profile. SX (px per mm, set by fitting the length L across
// the 1000-wide panel) is the SINGLE isometric scale: the plan's breadth and the profile's depth use it
// too, so all three drawings are to one scale and read the same proportions as the 3D view. The plan and
// profile panel heights are derived from that scale so the breadth / depth domains fill them.
export const PXpad = 60,
  SX = (1000 - 2 * PXpad) / L;
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

// plan: half-breadth about a centre axis; star = top, port = bottom — same px/mm as x (isometric)
export const YMAX = 1100,
  SYP = SX,
  Ppad = 18,
  LH = 2 * YMAX * SYP + 2 * Ppad, // height so the full breadth (±YMAX) fits at the isometric scale
  Lcen = LH / 2;
export const yStar = (y: number): number => Lcen - y * SYP;
export const yPort = (y: number): number => Lcen + y * SYP;
export const invY = (vy: number): number => (Lcen - vy) / SYP;

// station editors (square, equal aspect): n across (inboard), d down
export const STW = 360,
  STH = 360,
  STpad = 26,
  STsc = (STW - 2 * STpad) / (NMAX - NMIN);
export const snX = (n: number): number => STpad + (n - NMIN) * STsc;
export const snY = (d: number): number => STpad + d * STsc;
export const invN = (vx: number): number => (vx - STpad) / STsc + NMIN;
export const invD = (vy: number): number => (vy - STpad) / STsc;

// weight-curve editor (longitudinal x across — shared mapX — stacked weight 0..1 up)
export const WH = 176,
  Wtop = 16,
  Wbot = 20;
export const wY = (w: number): number => WH - Wbot - w * (WH - Wtop - Wbot); // w ∈ [0,1]; 0 at the bottom
export const invW = (vy: number): number => (WH - Wbot - vy) / (WH - Wtop - Wbot);

// re-export the domain bounds the views also use
export { NMIN, NMAX, DMAX };
