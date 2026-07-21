// What the 3D view draws, as two independent choices rather than one mutually-exclusive "view mode".
//
// `ShadingMode` picks how the SURFACE is shaded: "flat" = the plain unlit skin the lines plan is drawn over,
// "smooth" = the lit, shaded hull, "zebra" = zebra-striped (a fairness check). `LineToggles` picks which
// CURVES are laid over it — each family independently, whatever the shading is: the surface's own feature
// edges, and the three classic lines-plan families (stations / constant-y cuts / constant-z cuts). The design
// waterline is not a toggle: being the one line the model itself defines, it is always drawn.
//
// Two further toggles live in the view and change what all of the above is drawn ON: `sheet` swaps the
// trimmed, mirrored hull for the raw untrimmed sweep (one side, no trims/mirror), and `showMesh` overlays the
// hull's quad grid as a wireframe, to inspect the mesh itself.

export type ShadingMode = "flat" | "smooth" | "zebra";

export interface LineToggles {
  edges: boolean; // the sheer, the keel / transom cut, and every chine — the surface's own feature edges
  sections: boolean; // transverse stations (columns of the hull's own sampling)
  buttocks: boolean; // constant-y cuts
  waterlines: boolean; // constant-z cuts
}

// what the view starts with: the surface's own edges, which read well under any shading and keep the flat
// skin from opening as a featureless silhouette — but none of the three families, which are the ones
// you go looking for
export const DEFAULT_LINES: LineToggles = {
  edges: true,
  sections: false,
  buttocks: false,
  waterlines: false,
};
