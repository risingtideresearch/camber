// the 3D view's mutually-exclusive display mode: "render" = shaded trimmed hull; "body" / "buttocks" /
// "waterline" = the lines plan (3D ribbon curves) with that non-chine family; "zebra" = zebra-striped hull
// (fairness check).
// "body" / "buttocks" / "waterline" are the three lines-plan modes: same drawing, differing only in which
// non-chine line family is drawn (stations / constant-y cuts / constant-z cuts). render / zebra are the
// shaded modes. Independently of the mode, two toggles change what the mode is drawn ON: `sheet` swaps the
// trimmed, mirrored hull for the raw untrimmed sweep (one side, no trims/mirror), and `showMesh` overlays the
// hull's quad grid as a wireframe on the shaded modes, to inspect the mesh itself.

export type View3DMode = "render" | "body" | "buttocks" | "waterline" | "zebra";

export const LINES_MODES: View3DMode[] = ["body", "buttocks", "waterline"];
