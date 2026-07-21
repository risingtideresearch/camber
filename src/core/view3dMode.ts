// the 3D view's mutually-exclusive display mode: "render" = shaded trimmed hull; "body" / "buttocks" /
// "waterline" = the lines plan (3D ribbon curves) with that non-chine family; "zebra" = zebra-striped trimmed
// hull (fairness check); "sheet" = the untrimmed shaded sweep (one side, no trims/mirror).
// "body" / "buttocks" / "waterline" are the three lines-plan modes: same drawing, differing only in which
// non-chine line family is drawn (stations / constant-y cuts / constant-z cuts). render / zebra / sheet are
// the shaded modes. Independently of the mode, `showMesh` overlays the hull's quad grid as a wireframe on any
// shaded mode, to inspect the mesh itself.

export type View3DMode =
  "render" | "body" | "buttocks" | "waterline" | "zebra" | "sheet";

export const LINES_MODES: View3DMode[] = ["body", "buttocks", "waterline"];
