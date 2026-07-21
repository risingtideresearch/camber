import { useMemo, useState } from "react";
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
import { type View3DMode } from "../core/view3dMode";
import { Button } from "./Button";
import { Dropdown } from "./Dropdown";
import { Scene } from "./view3d/Scene";
import "./View3d.css";

// a stable "all off" default for hosts (e.g. the interpolation app) that don't drive the curvature overlay —
// a module constant so it keeps the same identity across renders and never triggers a needless rebuild
const CURVATURE_OFF = defaultCurvature();

// the average of the app's old sky-gradient backdrop — a solid colour, since the 3D canvas now fully covers
// the view (Canvas3D paints its own scene background rather than letting a CSS gradient show through)
const CANVAS_BG = "#e6ecf3";

// The 3D viewport: a Canvas3D (polymorph-ui / react-three-fiber) with its built-in orbit navigation and
// perspective/orthographic toggle. It owns the display mode / Sheet / Mesh-overlay / perspective toggles
// (nothing upstream needs them) and hands the model / selection / sampling / curvature down to <Scene>, which
// builds and renders the actual hull geometry. There is no SVG overlay any more — every mode, including the
// body/buttocks/waterline "lines plan" modes, is real 3D geometry sharing the one Canvas3D camera, so
// switching modes never moves the camera.
//
// The mode picks HOW the surface is drawn; the Sheet toggle picks WHICH surface — the trimmed, mirrored hull
// or the raw swept sheet it is cut from — so the two compose: the lines plan and the zebra stripes can be
// inspected on the untrimmed sheet as readily as on the finished hull.
const MODES: { mode: View3DMode; label: string; title: string }[] = [
  { mode: "render", label: "Render", title: "Shaded hull" },
  { mode: "body", label: "Body", title: "Lines plan — body (stations)" },
  {
    mode: "buttocks",
    label: "Buttocks",
    title: "Lines plan — buttocks (constant-y cuts)",
  },
  {
    mode: "waterline",
    label: "Waterline",
    title: "Lines plan — waterlines (constant-z cuts)",
  },
  { mode: "zebra", label: "Zebra", title: "Zebra-stripe fairness check" },
];

interface View3dProps {
  model: Model;
  modelVersion: number;
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
}

export function View3d({
  model,
  modelVersion,
  selection,
  sampling,
  curvature = CURVATURE_OFF,
  stl,
  title,
}: View3dProps) {
  const [mode, setMode] = useState<View3DMode>("render");
  const [sheet, setSheet] = useState(false); // draw the mode on the untrimmed sweep instead of the hull
  const [showMesh, setShowMesh] = useState(false); // overlay the quad-grid wireframe on the shaded GL modes
  const [meshQuads, setMeshQuads] = useState(true); // wire as quads (default) or the raw shaded triangles
  const [meshMenu, setMeshMenu] = useState(false); // the Mesh overlay dropdown open state
  const [orthographic, setOrthographic] = useState(true); // matches the view's historical ortho-only behaviour

  // the sampling to tessellate: the one passed in, or a default-resolution fallback computed here for hosts
  // that don't supply one (the interpolation app). Only computed when no sampling is given.
  const fallback = useMemo(
    () =>
      sampling
        ? null
        : computeHullSampling(model, PERF_N_DEFAULT, PERF_R_DEFAULT),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sampling, model, modelVersion],
  );
  const effSampling = sampling ?? fallback;

  return (
    <div className="top3d">
      <Canvas3D orthographic={orthographic} background={CANVAS_BG}>
        <Canvas3DOrbitControls autoFar autoNear />
        <Canvas3DAxesGizmo />
        <Scene
          model={model}
          modelVersion={modelVersion}
          selection={selection}
          mode={mode}
          sheet={sheet}
          showMesh={showMesh}
          meshQuads={meshQuads}
          sampling={effSampling}
          curvature={curvature}
          stl={stl}
        />
      </Canvas3D>
      {title && <div className="view3dtitle">{title}</div>}
      <div className="view3dctl">
        <Button
          active={!orthographic}
          title={
            orthographic ? "Switch to perspective" : "Switch to orthographic"
          }
          onClick={() => setOrthographic((o) => !o)}
        >
          {orthographic ? "Ortho" : "Persp"}
        </Button>
        <Dropdown
          label="Mesh"
          active={showMesh}
          onToggle={() => setShowMesh((v) => !v)}
          open={meshMenu}
          onOpenChange={setMeshMenu}
          title="Overlay the hull's quad grid as a wireframe (works in the shaded modes, Render and Zebra). Its resolution is set by the Performance control's hull-sampling sliders."
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
        <Button
          active={sheet}
          title="Draw the current mode on the raw untrimmed sweep (one side, no trims or mirror) instead of the finished hull"
          onClick={() => setSheet((v) => !v)}
        >
          Sheet
        </Button>
        <div className="view3dmodes">
          {MODES.map((m) => (
            <Button
              key={m.mode}
              active={mode === m.mode}
              title={m.title}
              onClick={() => setMode(m.mode)}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
