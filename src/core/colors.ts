// ---------- control-point dots ----------

export const HILITE = "#f59e0b"; // amber "linked" marker (cut station + the 3D guide ribbon)
export const SEL = "#ef4444"; // selected control point red — in the section editors (no red cut slider there)
export const SELB = "#2563eb"; // selected control point blue — in plan/profile, where the red cut slider lives

export function getCSS(v: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}

export const COL = {
  sheer: getCSS("--sheer"),
  keel: getCSS("--keel"),
  aft: getCSS("--aft"),
  fore: getCSS("--fore"),
  station: getCSS("--station"),
  wl: getCSS("--wl"),
  bt: getCSS("--bt"),
  deck: getCSS("--deck"),
  mut: getCSS("--mut"),
};

// per-template accent colors, cycled. Template 0 is the old "aft" blue; later ones fan toward purple/amber.
export const TPL_PALETTE = [
  "#2b6cb0",
  "#7c3aed",
  "#dd6b20",
  "#0f766e",
  "#b45309",
  "#be185d",
  "#0369a1",
];

export function tplColor(i: number): string {
  return TPL_PALETTE[
    ((i % TPL_PALETTE.length) + TPL_PALETTE.length) % TPL_PALETTE.length
  ];
}
