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
//
// `TrimToggles` rides with `sheet` (it is the Sheet button's dropdown) but is independent of it: a trim can be
// drawn whichever surface is up — which is the point of showing them, since what a trim cuts is mostly the
// part of the sheet the finished hull no longer has. It is two choices crossed: WHICH FORM of a trim to draw
// (the curve it marches over the whole sheet, the span of it the hull kept, or both — and with both, the
// sheet form gives up that span and draws only the cut-away rest, so the two meet instead of overlapping),
// and WHICH of the three trims to draw it for.

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

// the sheet's three trims, and the two forms each can be drawn in
export interface TrimToggles {
  // WHICH FORM. Either can be shown without the other; with both, the sheet form stands back to the part of
  // the march the hull edge does not draw, so no span is drawn twice.
  sheetCurves: boolean; // each trim marched over the WHOLE sheet, as if it were the only one
  hullCurves: boolean; // the span of it the other two leave standing: the hull's own edge
  // WHICH TRIM either form is drawn for
  sheer: boolean; // the top cut: z = the sheer trim curve
  centerline: boolean; // the keel cut: y = 0
  transom: boolean; // the aft cut: the raked transom plane
}

// neither form: the trims are an inspection aid for how the three cut each other, not part of the boat. All
// three trims are picked though, so either form drawn shows the whole story at once and the per-trim boxes are
// there to take one away.
export const DEFAULT_TRIMS: TrimToggles = {
  sheetCurves: false,
  hullCurves: false,
  sheer: true,
  centerline: true,
  transom: true,
};
