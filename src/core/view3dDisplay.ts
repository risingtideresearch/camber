// What the 3D view draws, as two independent choices rather than one mutually-exclusive "view mode".
//
// `ShadingMode` picks how the SURFACE is shaded: "flat" = the plain unlit skin the lines plan is drawn over,
// "smooth" = the lit, shaded hull, "zebra" = zebra-striped (a fairness check). `LineToggles` picks which
// CURVES are laid over it — each family independently, whatever the shading is: the surface's own feature
// edges, and the three classic lines-plan families (stations / constant-y cuts / constant-z cuts). The design
// waterline is not a toggle: being the one line the model itself defines, it is always drawn.
//
// Three further toggles live in the view itself rather than in either set. `sheet` swaps the trimmed, mirrored
// hull for the raw untrimmed sweep (one side, no trims/mirror) and `showMesh` overlays the hull's quad grid as
// a wireframe, to inspect the mesh itself. `leftovers` — a box in the Edges button's own dropdown — adds to
// the boat's feature edges the ghost of the edges it has NOT got: the runs of each trim that fall outside it,
// hanging in the space the cut took away. It belongs to Edges, and follows it: it draws nothing while `edges`
// is off, and starts off itself, so the finished hull opens as the finished hull.
//
// `TrimToggles` rides with `sheet` (it is the Sheet button's dropdown) and, unlike the line families, belongs
// to it: everything there is a curve ON the sheet, so putting the sheet away puts the trims away with it — on
// the finished hull the hull form would only re-draw an edge the boat already has, and the sheet form would
// add that plus a sheet that is not there. It is two choices crossed — WHICH FORM of a trim to draw (the curve
// it marches over the whole sheet, the span of it the hull kept, or both — and with both, the sheet form gives
// up that span and draws only the cut-away rest, so the two meet instead of overlapping), and WHICH of the
// three trims to draw it for. That second choice is the one thing here `leftovers` also reads: whichever trims
// are picked are the trims whose leftovers it draws.

export type ShadingMode = "flat" | "smooth" | "zebra";

export interface LineToggles {
  edges: boolean; // the master: the surface's own feature edges — the mesh boundary AND every chine
  // The two kinds of feature edge, each a subtractive box on `edges`: with `edges` off neither shows, and with
  // it on either can be dropped on its own. `meshBoundary` is the outline the surface ends on — sheer, keel,
  // transom cut; `chines` are the creases across its interior. Drop the boundary to read the creases without
  // the silhouette over them, or the chines to see the outline clean.
  meshBoundary: boolean;
  chines: boolean;
  sections: boolean; // transverse stations (columns of the hull's own sampling)
  buttocks: boolean; // constant-y cuts
  waterlines: boolean; // constant-z cuts
}

// what the view starts with: the surface's own edges, boundary and chines both — they read well under any
// shading and keep the flat skin from opening as a featureless silhouette — but none of the three families,
// which are the ones you go looking for
export const DEFAULT_LINES: LineToggles = {
  edges: true,
  meshBoundary: true,
  chines: true,
  sections: false,
  buttocks: false,
  waterlines: false,
};

// the sheet's three trims, and the two forms each can be drawn in
export interface TrimToggles {
  // WHICH FORM, and only while the sheet is up. Either can be shown without the other; with both, the sheet
  // form stands back to the part of the march the hull edge does not draw, so no span is drawn twice.
  sheetCurves: boolean; // each trim marched over the WHOLE sheet, as if it were the only one
  hullCurves: boolean; // the span of it the other two leave standing: the hull's own edge
  // WHICH TRIM either form — and the view's own `leftovers` — is drawn for
  sheer: boolean; // the top cut: z = the sheer trim curve
  centerline: boolean; // the keel cut: y = 0
  transom: boolean; // the aft cut: the raked transom plane
}

// both forms of all three trims, which is the whole story the moment Sheet goes on, with every box there to
// take something away again. Off the sheet none of it is drawn at all — see above.
export const DEFAULT_TRIMS: TrimToggles = {
  sheetCurves: true,
  hullCurves: true,
  sheer: true,
  centerline: true,
  transom: true,
};
