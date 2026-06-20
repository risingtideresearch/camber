// ---------- view transforms: world coordinates → screen (SVG viewBox) coordinates ----------

import { L, NMIN, NMAX, DMAX } from "./model.js";

// shared longitudinal (x) mapping for plan + profile
export const PXpad = 60,
  SX = (1000 - 2 * PXpad) / L;
export const mapX = (x: number): number => PXpad + x * SX;
export const invX = (vx: number): number => (vx - PXpad) / SX;

// profile: z up, flat deck at 0, keel below
export const PH = 300,
  Ptop = 20,
  Pbot = 24,
  ZMIN = -1400,
  ZMAX = 320,
  PZbase = PH - Pbot,
  SZ = (PH - Ptop - Pbot) / (ZMAX - ZMIN);
export const zScreenP = (z: number): number => PZbase - (z - ZMIN) * SZ;
export const invZp = (vy: number): number => ZMIN + (PZbase - vy) / SZ;
export const ZTRIMMIN = -1100; // sheer trim must stay below the deck: z in [ZTRIMMIN,0]

// plan: half-breadth about a centre axis; star = top, port = bottom
export const LH = 300,
  Lcen = LH / 2,
  YMAX = 1100,
  SYP = (LH / 2 - 18) / YMAX;
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

// re-export the domain bounds the views also use
export { NMIN, NMAX, DMAX };
