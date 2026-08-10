import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { CurvatureSettings } from "../../core/comb";
import {
  buildCurvature3,
  buildHullMesh,
  buildStationLines,
  buildTransomMesh,
  WIRE_RGB,
  type CurvCurve3,
  type Mesh,
  type StationLines3,
} from "../../core/hullGeometry";
import {
  createHullMaterial,
  createSharedLightUniform,
  updateHeadlight,
} from "../../core/hullShader";
import {
  buildLinesPlanCurves,
  buildTrimCurves,
  type LinesPlanCurves,
  type TrimPlanCurves,
} from "../../core/hullLines3d";
import type { HullSampling } from "../../core/mesh";
import type { Model } from "../../core/model";
import { selStationIdx, type ModelSelection } from "../../core/modelSelection";
import { perfBegin, perfEnd, perfStep, PERF_MESH } from "../../core/perf";
import type { StlState } from "../../core/stlImport";
import type {
  LineToggles,
  ShadingMode,
  TrimToggles,
} from "../../core/view3dDisplay";
import { CameraFacingCurves } from "./CameraFacingCurves";
import { StlOverlay } from "./StlOverlay";
import { useCameraFraming } from "./useCameraFraming";

function meshToGeometry(m: {
  pos: Float32Array;
  nrm: Float32Array;
}): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(m.nrm, 3));
  return g;
}

// A pale blue skin, light enough that the near-black mesh and the lines plan drawn over it stay legible. It is
// also what Flat paints (unlit — see flatMaterial), so the two shading modes are the same colour by
// construction: the shader's gentle diffuse (hullShader.ts) swings the lit hull only a few percent either side
// of it, and switching shading changes how the form is modelled, not how bright the boat is. The transom keeps
// its own sand tone to read as a separate panel — its LIT face is unchanged by the flatter shading; only its
// shadowed side comes up.
const HULL_BASE: [number, number, number] = [0.64, 0.74, 0.87];
const TRANSOM_BASE: [number, number, number] = [0.74, 0.55, 0.37];

interface SceneProps {
  model: Model;
  selection: ModelSelection;
  shading: ShadingMode; // how the surface is shaded — independent of which curves are drawn on it
  lines: LineToggles; // which curve families to lay over it (a stable object: it is in a rebuild's deps)
  sheet: boolean; // draw all of it on the raw untrimmed sweep (one side, no trims/mirror) instead of the hull
  trims: TrimToggles; // which of the sheet's three trims to draw over it (another stable object)
  leftovers: boolean; // the Lines dropdown's box: also draw the trim runs that fall outside the boat
  showMesh: boolean;
  meshQuads: boolean;
  sampling: HullSampling | null;
  curvature: CurvatureSettings;
  stl?: StlState | null;
}

export function Scene({
  model,
  selection,
  shading,
  lines,
  sheet,
  trims,
  leftovers,
  showMesh,
  meshQuads,
  sampling,
  curvature,
  stl,
}: SceneProps) {
  useCameraFraming(model);

  // one shared "headlight" uniform, updated every rendered frame so the hull, transom, and STL shaded pass
  // all stay lit consistently as the camera orbits (see hullShader.ts)
  const uLight = useMemo(() => createSharedLightUniform(), []);
  useFrame(({ camera }) => updateHeadlight(uLight.value, camera));

  // Every surface material carries the same polygon offset, because every one of them can have curves or the
  // wireframe drawn ON it: those are at the very triangles and edges of this mesh (hullLines3d.ts), so the
  // skin is pushed back to let them show through. `factor` is what makes it work where it is needed most: it
  // scales with the polygon's own depth slope, so a face seen nearly edge-on (at the silhouette, where a
  // curve's screen width sweeps the most depth) is pushed back the most.
  const hullMaterial = useMemo(
    () => createHullMaterial(uLight, { base: HULL_BASE, offset: true }),
    [uLight],
  );
  const transomMaterial = useMemo(
    () => createHullMaterial(uLight, { base: TRANSOM_BASE, offset: true }),
    [uLight],
  );
  // The flat shading mode's unlit skin — the lines plan's classic occluder, and in flat mode the transom's
  // too, so the whole boat reads as one silhouette behind the curves. It paints HULL_BASE itself, i.e. the
  // shaded hull with the lighting taken out, rather than a hex hand-matched to it by eye.
  const flatMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setRGB(...HULL_BASE, THREE.SRGBColorSpace),
        // The hull's ShaderMaterial writes gl_FragColor straight to the framebuffer — three only injects the
        // tone-mapping chunk into materials it generates, not a raw custom shader — so its uBase IS a display
        // colour. This one has to opt out of tone mapping to be read the same way; left on, the same numbers
        // come out visibly paler and greyer than the shaded hull.
        toneMapped: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    [],
  );
  // The mesh is a reading aid over the surface, not part of it: drawn semi-transparent so it tells you where
  // the lattice is without tiling the hull into a black grid, and so the curves crossing it stay dominant.
  // depthWrite stays on — the lines still occlude each other by depth, they just let the skin through.
  const wireMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: new THREE.Color(...WIRE_RGB),
        transparent: true,
        opacity: 0.4,
      }),
    [],
  );
  useEffect(() => {
    return () => {
      hullMaterial.dispose();
      transomMaterial.dispose();
      flatMaterial.dispose();
      wireMaterial.dispose();
    };
  }, [hullMaterial, transomMaterial, flatMaterial, wireMaterial]);

  // a live uniform, cheap enough to just re-set on every render (the r3f way to sync a plain value onto a
  // persistent three.js object) rather than tracking whether the shading mode actually changed
  hullMaterial.uniforms.uZebra.value = shading === "zebra" ? 1 : 0;

  const flat = shading === "flat";

  // The hull's own tessellation (the lattice every shading mode shares — mesh.ts) plus the curvature-comb
  // curves and the lines-plan curves, rebuilt together in one pass whenever the model, the line toggles, the
  // Sheet or Mesh toggle, the shared sampling, or the curvature settings change. One perfBegin/perfEnd
  // bracket for the lot, which is how the rebuild reads: the overlay ribbons in CameraFacingCurves open the
  // same pass again further down the tree and add to it (perf.ts keys a pass's tallies to the FRAME, so
  // reopening one accumulates rather than replacing it). Each bracket names its own part of the pass, so the
  // three of them read as one rebuild in three places rather than as three rebuilds. Deliberately not keyed on
  // `shading` (which changes nothing here — only which material the same geometry is drawn with) nor on
  // `selection` — the guide ribbon lives independently in CameraFacingCurves, so either alone skips this
  // rebuild for free.
  const {
    hullGeometry,
    transomGeometry,
    wireGeometry,
    curvCache,
    linesPlanCurves,
    trimCurves,
    stationLines,
  } = useMemo(() => {
    perfBegin(PERF_MESH, "hull geometry");
    let hullGeometry: THREE.BufferGeometry | null = null,
      transomGeometry: THREE.BufferGeometry | null = null,
      wireGeometry: THREE.BufferGeometry | null = null,
      hullMesh: Mesh | null = null; // the raw triangle soup, kept for the lines-plan curves below
    if (sampling) {
      const trimmed = !sheet;
      const built = buildHullMesh(sampling, trimmed, showMesh, meshQuads);
      hullMesh = built.hull;
      hullGeometry = meshToGeometry(built.hull);
      if (trimmed) {
        const transomMesh = perfStep(
          "Transom panel",
          () => buildTransomMesh(model, sampling),
          (m) => m.count / 3,
          "tris",
        );
        transomGeometry = meshToGeometry(transomMesh);
      }
      wireGeometry = built.wire ? meshToGeometry(built.wire) : null;
    }
    const curvCache: CurvCurve3[] | null = curvature.on
      ? perfStep(
          "Curvature combs",
          () => buildCurvature3(model, curvature),
          (cs) => cs.reduce((n, c) => n + c.hairs.length, 0),
          "hairs",
        )
      : null;
    // the lines-plan curves are read off the geometry just built — the sampling's own columns and the
    // triangles stitched from them — so they need both, and there is nothing to draw without them. The Lines
    // master (`lines.edges`) gates the whole overlay: with it off nothing here is built at all, whatever the
    // individual boxes — feature edges, families, the design waterline — say.
    const linesPlanCurves: LinesPlanCurves | null =
      sampling && hullMesh && lines.edges
        ? perfStep(
            "Lines plan curves",
            () =>
              buildLinesPlanCurves(model, lines, sampling, !sheet, hullMesh!),
            (c) => c.bold.length + c.family.length + c.dwl.length,
            "curves",
          )
        : null;
    // the sheet's own trims: curves the sampling already holds, so this only picks them — it owes nothing to
    // the mesh just built. Drawn on the sheet the Sheet dropdown's own way; off it, only the leftovers the
    // Lines dropdown asks for, which follow the Lines master they belong to — hence `sheet` and `leftovers &&
    // lines.edges` (see view3dDisplay.ts)
    const trimCurves: TrimPlanCurves | null = sampling
      ? perfStep(
          "Trim curves",
          () =>
            buildTrimCurves(trims, sampling, sheet, leftovers && lines.edges),
          (c) =>
            c.sheet.length + c.hull.reduce((n, h) => n + h.lines.length, 0),
          "curves",
        )
      : null;
    // the authored stations' own construction lines (the dropdown's "Stations" group) — built straight from
    // the model, no mesh or sampling needed, and gated by the Lines master like everything else up there
    const stationLines: StationLines3 | null =
      lines.edges &&
      (lines.stationCurves || lines.stationKnots || lines.knotLongs)
        ? perfStep(
            "Station lines",
            () =>
              buildStationLines(model, {
                curves: lines.stationCurves,
                knots: lines.stationKnots,
                longs: lines.knotLongs,
              }),
            (s) => s.curves.length + s.knots.length + s.longs.length,
            "curves",
          )
        : null;
    perfEnd(PERF_MESH);
    return {
      hullGeometry,
      transomGeometry,
      wireGeometry,
      curvCache,
      linesPlanCurves,
      trimCurves,
      stationLines,
    };
  }, [
    model,
    sampling,
    lines,
    sheet,
    trims,
    leftovers,
    showMesh,
    meshQuads,
    curvature,
  ]);

  // dispose the PREVIOUS geometry set whenever it's about to be replaced (or on unmount) — every model edit
  // rebuilds these, so without this the GPU buffers would leak across a session
  useEffect(() => {
    return () => {
      hullGeometry?.dispose();
      transomGeometry?.dispose();
      wireGeometry?.dispose();
    };
  }, [hullGeometry, transomGeometry, wireGeometry]);

  const guideIdx = selStationIdx(model, selection);

  return (
    <group rotation={[0, -model.deckRake, 0]}>
      {/* the shading mode only picks the material: one geometry, drawn unlit, lit, or zebra-striped */}
      {hullGeometry && (
        <mesh
          geometry={hullGeometry}
          material={flat ? flatMaterial : hullMaterial}
        />
      )}
      {transomGeometry && (
        <mesh
          geometry={transomGeometry}
          material={flat ? flatMaterial : transomMaterial}
        />
      )}
      {showMesh && wireGeometry && (
        <lineSegments geometry={wireGeometry} material={wireMaterial} />
      )}
      {stl && <StlOverlay stl={stl} uLight={uLight} />}
      <CameraFacingCurves
        model={model}
        guideIdx={guideIdx}
        curvature={curvCache}
        lines={linesPlanCurves}
        trims={trimCurves}
        stations={stationLines}
      />
    </group>
  );
}
