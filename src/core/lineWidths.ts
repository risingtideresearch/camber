// ---------- drawn line weights ----------
// The one place the viewers' line weights are set, as FULL stroke widths in CSS pixels. The 2D editors
// (draw2d.ts) use them as SVG stroke widths, which stay a constant screen width under non-scaling-stroke;
// the 3D view (CameraFacingCurves.tsx) halves them into its camera-facing ribbons' half-widths. Both read
// the same tiers, so a curve weighs the same whichever view it is seen in.

export const W_MAIN = 1.5; // the result curves — the hull itself: sections, keel, sheer trim, max beam, transom edge
export const W_SECONDARY = 1.25; // other solid curves, the dashed sheer-plan guide, the knot longitudinals
export const W_GUIDE = 1; // construction lines and trims (mostly dashed), cusp outlines, the 3D design waterline
export const W_COMB = 0.9; // a curvature comb's envelope
export const W_FAINT = 0.75; // control polygons, grids, axes
export const W_HAIR = 0.7; // a curvature comb's hairs

// a station handle while it is the active one — heavier than any curve, so the grabbed line reads at once
export const W_ACTIVE = 2;

// The 3D ribbons' floor. Their fragment shader is a flat colour with no edge feathering, so whatever smoothing
// they get is the canvas's multisampling: below about this a ribbon turns paler, not thinner, and shimmers.
export const W_RIBBON_MIN = 0.8;
