import { useMemo, useState, type ReactNode } from "react";
import {
  Canvas3D,
  Canvas3DAxesGizmo,
  Canvas3DOrbitControls,
} from "polymorph-ui";
import type { Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import type { StlState } from "../core/stlImport";
import { computeHullSampling, type HullSampling } from "../core/mesh";
import { PERF_N_DEFAULT, PERF_R_DEFAULT } from "../core/perf";
import { defaultCurvature, type CurvatureSettings } from "../core/comb";
import {
  DEFAULT_LINES,
  DEFAULT_TRIMS,
  type LineToggles,
  type ShadingMode,
  type TrimToggles,
} from "../core/view3dDisplay";
import { Button } from "./Button";
import { ButtonGroup } from "./ButtonGroup";
import { Dropdown } from "./Dropdown";
import { CameraLens } from "./view3d/CameraLens";
import { Scene } from "./view3d/Scene";
import type { SliceOverlayState } from "./view3d/SliceOverlay";
import "./View3d.css";

// a stable "all off" default for hosts (e.g. the interpolation app) that don't drive the curvature overlay —
// a module constant so it keeps the same identity across renders and never triggers a needless rebuild
const CURVATURE_OFF = defaultCurvature();

// the average of the app's old sky-gradient backdrop — a solid colour, since the 3D canvas now fully covers
// the view (Canvas3D paints its own scene background rather than letting a CSS gradient show through)
const CANVAS_BG = "#e6ecf3";

// The 3D viewport: a Canvas3D (polymorph-ui / react-three-fiber) with its built-in orbit navigation and
// perspective/orthographic toggle. It owns the display controls (shading, line families, Sheet, Mesh overlay,
// perspective — nothing upstream needs them) and hands the model / selection / sampling / curvature down to
// <Scene>, which builds and renders the actual hull geometry. There is no SVG overlay any more — everything,
// the lines plan included, is real 3D geometry sharing the one Canvas3D camera, so changing what is displayed
// never moves the camera.
//
// Nothing here is mutually exclusive except the shading: the lines are independent boxes in the Lines button's
// dropdown that compose with any shading, and the Sheet toggle picks WHICH surface all of it is drawn on — the
// trimmed, mirrored hull or the raw swept sheet it is cut from — so a lines plan or the zebra stripes can be
// inspected on the untrimmed sheet as readily as on the finished hull. The Sheet button's dropdown carries the
// three trim curves (they are what cuts the sheet down to the hull), and they belong to it: they are curves on
// the sheet, so they go when it does. The one part of a cut still worth seeing on the finished hull is the run
// of it that falls OUTSIDE the boat, and that hangs off the Lines button instead — it is an edge the hull has
// not got, which is the one thing the Lines toggle cannot draw for itself.
const SHADINGS: { shading: ShadingMode; label: string; title: string }[] = [
  {
    shading: "flat",
    label: "Flat",
    title: "Plain unlit skin — the lines plan's classic backdrop",
  },
  { shading: "smooth", label: "Smooth", title: "Shaded hull" },
  {
    shading: "zebra",
    label: "Zebra",
    title: "Zebra-stripe fairness check",
  },
];

// The perspective lens the view opens with, in degrees of DIAGONAL field of
// view, and the range the slider offers. Diagonal rather than three.js's own
// vertical angle so that the amount of perspective is the same whatever shape
// the window is — see CameraLens, which converts to the vertical lens the
// camera takes and redoes it on every resize. We use a narrow lens by default
// (50°), similar to photographing a boat with a mild telephoto lens. For
// generic CAD purposes, a wider 60-70° might be a good default, but a hull is a
// long object usually looked at end-on, where a wide one throws the far end
// away and bends the sheer.
const DEFAULT_FOV = 50;
const FOV_RANGE: [number, number] = [1, 120];

// The Sheet button's dropdown: the three cuts that make the sheet into the hull, each drawable in two forms.
// The SHEET form is the curve the trim marches over the whole sheet as if it were the only one, in the bold
// black — the cut itself, running on past the boat wherever another trim got there first. The HULL form is the
// span of it the other two leave standing, which is the boat's own edge, in that trim's 2D colour. Either can
// be shown without the other, and with BOTH shown the black gives up the span the colour has: it draws only
// what was cut away, taking over from the colour at the corner where the trim left the boat.
//
// Both forms are the sheet's own and go when it does: on the finished hull the one would re-draw an edge the
// boat already has, and the other would add that plus a sheet that is not there. The part still worth seeing
// off the sheet is the leftover, and that is not this dropdown's — it is the Lines button's own box.
const TRIM_FORMS: { key: keyof TrimToggles; label: string; title: string }[] = [
  {
    key: "sheetCurves",
    label: "Show sheet trim curves",
    title:
      "Each trim marched across the whole sheet as if it were the only one, drawn black — the cut itself, carrying on past the boat. With the hull form shown too, only the part carrying on past it",
  },
  {
    key: "hullCurves",
    label: "Show hull trim curves",
    title:
      "The span of each trim the other two leave standing — the hull's own edge, in that trim's 2D colour",
  },
];

const TRIMS: { key: keyof TrimToggles; label: string; title: string }[] = [
  {
    key: "sheer",
    label: "Sheer trim",
    title: "The top cut: where the sheer trim curve crosses the sheet",
  },
  {
    key: "centerline",
    label: "Centerline trim",
    title: "The keel cut: where the sheet crosses y = 0",
  },
  {
    key: "transom",
    label: "Transom trim",
    title: "The aft cut: where the transom plane crosses the sheet",
  },
];

// the three classic lines-plan families, each a checkbox in the Lines dropdown. The design waterline and the
// two feature-edge boxes live in that dropdown too, but are spelled out inline rather than in this list.
const FAMILIES: { key: keyof LineToggles; label: string; title: string }[] = [
  { key: "sections", label: "Sections", title: "Transverse stations" },
  { key: "buttocks", label: "Buttocks", title: "Buttocks (constant-y cuts)" },
  {
    key: "waterlines",
    label: "Waterlines",
    title: "Waterlines: a family of constant-z cuts spread over the sheet",
  },
];

// the Lines dropdown's "Stations" group: the AUTHORED stations' own construction geometry, as against the
// sampled Sections family above
const STATIONS: { key: keyof LineToggles; label: string; title: string }[] = [
  {
    key: "stationCurves",
    label: "Station curves",
    title:
      "Each authored station's full section curve, in its station's accent colour — the 2D section editor's fan, embedded in 3D",
  },
  {
    key: "stationKnots",
    label: "Station knots",
    title:
      "Each authored station's knots (its control points), as small white dots ringed in the station's accent colour",
  },
  {
    key: "knotLongs",
    label: "Knot longitudinals",
    title:
      "The loft curve each knot index traces along the hull — the u-interpolation a section at any position is read from — drawn in grey",
  },
];

interface View3dProps {
  model: Model;
  selection: ModelSelection;
  stl?: StlState | null; // optional imported reference mesh, drawn translucent over the hull
  // the shared hull sampling the surface is built from. EditorApp computes it once (at the Performance
  // resolution) and passes it in; hosts that don't (the interpolation app) omit it and get a default-
  // resolution sampling computed here, so the 3D view always has a lattice to tessellate.
  sampling?: HullSampling;
  // the editor-wide curvature-comb overlay (owned by EditorApp's Curvature control); omitted by hosts that
  // don't drive it (the interpolation app), where it defaults to all-off
  curvature?: CurvatureSettings;
  title?: string; // optional label overlaid top-left of the canvas (e.g. "Blended Hull")
  // host-supplied controls, placed ahead of the view's own in the overlay bar. The view owns everything that
  // changes what is DRAWN and nothing else, so a control about the pane itself — the editor's "open this in
  // its own window" button — comes from the host and stays out of here.
  actions?: ReactNode;
  /** Optional authored hull cuts, measured by the weights panel and drawn in the same model frame. */
  sliceOverlay?: SliceOverlayState | null;
}

export function View3d({
  model,
  selection,
  sampling,
  curvature = CURVATURE_OFF,
  stl,
  title,
  actions,
  sliceOverlay,
}: View3dProps) {
  const [shading, setShading] = useState<ShadingMode>("smooth");
  // one object rather than four useStates: <Scene> keys a rebuild on it, so its identity has to change only
  // when a toggle actually does
  const [lines, setLines] = useState<LineToggles>(DEFAULT_LINES);
  const [sheet, setSheet] = useState(false); // draw everything on the untrimmed sweep instead of the hull
  const [trims, setTrims] = useState<TrimToggles>(DEFAULT_TRIMS); // which of the sheet's cuts to draw
  const [sheetMenu, setSheetMenu] = useState(false); // the Sheet dropdown open state
  const [leftovers, setLeftovers] = useState(false); // draw the trims' off-the-boat runs alongside the edges
  const [linesMenu, setLinesMenu] = useState(false); // the Lines dropdown open state
  const [showMesh, setShowMesh] = useState(false); // overlay the quad-grid wireframe
  const [meshQuads, setMeshQuads] = useState(true); // wire as quads (default) or the raw shaded triangles
  const [meshMenu, setMeshMenu] = useState(false); // the Mesh overlay dropdown open state
  const [orthographic, setOrthographic] = useState(true); // matches the view's historical ortho-only behaviour
  const [projMenu, setProjMenu] = useState(false); // the projection dropdown open state
  const [fov, setFov] = useState(DEFAULT_FOV); // the perspective lens, in degrees; ignored while ortho

  // the sampling to tessellate: the one passed in, or a default-resolution fallback computed here for hosts
  // that don't supply one (the interpolation app). Only computed when no sampling is given.
  const fallback = useMemo(
    () =>
      sampling
        ? null
        : computeHullSampling(model, PERF_N_DEFAULT, PERF_R_DEFAULT),

    [sampling, model],
  );
  const effSampling = sampling ?? fallback;

  return (
    <div className="top3d">
      <Canvas3D orthographic={orthographic} background={CANVAS_BG}>
        <Canvas3DOrbitControls autoFar autoNear />
        <Canvas3DAxesGizmo />
        <CameraLens fov={fov} />
        <Scene
          model={model}
          selection={selection}
          shading={shading}
          lines={lines}
          sheet={sheet}
          trims={trims}
          leftovers={leftovers}
          showMesh={showMesh}
          meshQuads={meshQuads}
          sampling={effSampling}
          curvature={curvature}
          stl={stl}
          sliceOverlay={sliceOverlay}
        />
      </Canvas3D>
      {title && <div className="view3dtitle">{title}</div>}
      <div className="view3dctl">
        {actions}
        <Dropdown
          label={orthographic ? "Ortho" : "Persp"}
          active={!orthographic}
          onToggle={() => setOrthographic((o) => !o)}
          open={projMenu}
          onOpenChange={setProjMenu}
          title={
            orthographic ? "Switch to perspective" : "Switch to orthographic"
          }
          menuLabel="Projection options"
        >
          <label
            className="dd-row"
            title="The perspective camera's field of view, measured across the diagonal."
          >
            <span className="dd-name">Field of view</span>
            <input
              type="range"
              min={FOV_RANGE[0]}
              max={FOV_RANGE[1]}
              step={1}
              value={fov}
              onChange={(e) => setFov(+e.target.value)}
            />
            <span className="dd-val">{fov}°</span>
          </label>
        </Dropdown>
        <Dropdown
          label="Mesh"
          active={showMesh}
          onToggle={() => setShowMesh((v) => !v)}
          open={meshMenu}
          onOpenChange={setMeshMenu}
          title="Overlay the hull's quad grid as a wireframe, whatever else is displayed. Its resolution is set by the Performance control's hull-sampling sliders."
          menuLabel="Mesh overlay"
        >
          <label
            className="dd-row dd-check"
            title="Wireframe as the hull's quad grid; unchecked shows the raw triangles the shaded hull renders"
          >
            <input
              type="checkbox"
              checked={meshQuads}
              onChange={(e) => setMeshQuads(e.target.checked)}
            />
            <span className="dd-name">As quads</span>
          </label>
        </Dropdown>
        <Dropdown
          label="Sheet"
          active={sheet}
          onToggle={() => setSheet((v) => !v)}
          open={sheetMenu}
          onOpenChange={setSheetMenu}
          title="Draw everything on the raw untrimmed sweep (one side, no trims or mirror) instead of the finished hull"
          menuLabel="Sheet trims"
        >
          <div className="dd-section">
            <div className="dd-group">Trim curves</div>
            {TRIM_FORMS.map((t) => (
              <label key={t.key} className="dd-row dd-check" title={t.title}>
                <input
                  type="checkbox"
                  checked={trims[t.key]}
                  onChange={(e) =>
                    setTrims((s) => ({ ...s, [t.key]: e.target.checked }))
                  }
                />
                <span className="dd-name">{t.label}</span>
              </label>
            ))}
          </div>
          <div className="dd-section">
            <div className="dd-group">Which trims</div>
            {TRIMS.map((t) => (
              <label key={t.key} className="dd-row dd-check" title={t.title}>
                <input
                  type="checkbox"
                  checked={trims[t.key]}
                  onChange={(e) =>
                    setTrims((s) => ({ ...s, [t.key]: e.target.checked }))
                  }
                />
                <span className="dd-name">{t.label}</span>
              </label>
            ))}
          </div>
        </Dropdown>
        <Dropdown
          label="Lines"
          active={lines.edges}
          onToggle={() => setLines((s) => ({ ...s, edges: !s.edges }))}
          open={linesMenu}
          onOpenChange={setLinesMenu}
          title="Every line drawn over the surface: its own feature edges (boundary and chines), the classic lines-plan families, and the design waterline. The whole set shows or hides together — with this off, none of the boxes below draws, however it is checked."
          menuLabel="Line options"
          align="right"
        >
          <div className="dd-section">
            <div className="dd-group">Feature edges</div>
            <label
              className="dd-row dd-check"
              title="The mesh boundary: the outline the surface ends on — sheer, keel, and the transom (its aft cut plus the top edge that closes the panel across the breadth). Uncheck to keep the chines but drop the outline drawn over them"
            >
              <input
                type="checkbox"
                checked={lines.meshBoundary}
                onChange={(e) =>
                  setLines((s) => ({ ...s, meshBoundary: e.target.checked }))
                }
              />
              <span className="dd-name">Mesh boundary</span>
            </label>
            <label
              className="dd-row dd-check"
              title="The chines: the creases across the surface's interior, as against the mesh boundary that outlines it. Uncheck to drop them and keep the outline"
            >
              <input
                type="checkbox"
                checked={lines.chines}
                onChange={(e) =>
                  setLines((s) => ({ ...s, chines: e.target.checked }))
                }
              />
              <span className="dd-name">Chines</span>
            </label>
            <label
              className="dd-row dd-check"
              title="Also draw the leftovers of the three trims: the runs of each cut that fall outside the boat, in the bold feature-edge black. Which trims they are drawn for is the Sheet dropdown's choice. Needs Lines on"
            >
              <input
                type="checkbox"
                checked={leftovers}
                onChange={(e) => setLeftovers(e.target.checked)}
              />
              <span className="dd-name">Trim curves leftovers</span>
            </label>
          </div>
          <div className="dd-section">
            <div className="dd-group">Lines plan</div>
            {FAMILIES.map((l) => (
              <label key={l.key} className="dd-row dd-check" title={l.title}>
                <input
                  type="checkbox"
                  checked={lines[l.key]}
                  onChange={(e) =>
                    setLines((s) => ({ ...s, [l.key]: e.target.checked }))
                  }
                />
                <span className="dd-name">{l.label}</span>
              </label>
            ))}
            <label
              className="dd-row dd-check"
              title="The design waterline: the one waterline the model itself defines, drawn in blue (distinct from the Waterlines family above)"
            >
              <input
                type="checkbox"
                checked={lines.dwl}
                onChange={(e) =>
                  setLines((s) => ({ ...s, dwl: e.target.checked }))
                }
              />
              <span className="dd-name">Waterline</span>
            </label>
          </div>
          <div className="dd-section">
            <div className="dd-group">Stations</div>
            {STATIONS.map((l) => (
              <label key={l.key} className="dd-row dd-check" title={l.title}>
                <input
                  type="checkbox"
                  checked={lines[l.key]}
                  onChange={(e) =>
                    setLines((s) => ({ ...s, [l.key]: e.target.checked }))
                  }
                />
                <span className="dd-name">{l.label}</span>
              </label>
            ))}
          </div>
        </Dropdown>
        {/* Only the shading is a pick-one choice, so only it is joined into one bar — every independent
            toggle beside it (Sheet, the line families, the Mesh dropdown) stays a standalone rounded
            control, because two lit segments in a joined bar read as a broken radio group. */}
        <ButtonGroup>
          {SHADINGS.map((s) => (
            <Button
              key={s.shading}
              active={shading === s.shading}
              title={s.title}
              onClick={() => setShading(s.shading)}
            >
              {s.label}
            </Button>
          ))}
        </ButtonGroup>
      </div>
    </div>
  );
}
