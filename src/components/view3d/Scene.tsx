import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { CurvatureSettings } from "../../core/comb";
import {
  buildCurvature3,
  buildHullMesh,
  buildTransomMesh,
  WIRE_RGB,
  type CurvCurve3,
  type Mesh,
} from "../../core/hullGeometry";
import {
  createHullMaterial,
  createSharedLightUniform,
  updateHeadlight,
} from "../../core/hullShader";
import {
  buildLinesPlanCurves,
  type LinesPlanCurves,
} from "../../core/hullLines3d";
import type { HullSampling } from "../../core/mesh";
import { loa, type Model } from "../../core/model";
import { selStationIdx, type ModelSelection } from "../../core/modelSelection";
import { perfBegin, perfEnd, perfStep, PERF_MESH } from "../../core/perf";
import type { StlState } from "../../core/stlImport";
import { LINES_MODES, type View3DMode } from "../../core/view3dMode";
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

const HULL_BASE: [number, number, number] = [0.3, 0.5, 0.72];
const TRANSOM_BASE: [number, number, number] = [0.74, 0.55, 0.37];

interface SceneProps {
  model: Model;
  modelVersion: number;
  selection: ModelSelection;
  mode: View3DMode;
  showMesh: boolean;
  meshQuads: boolean;
  sampling: HullSampling | null;
  curvature: CurvatureSettings;
  stl?: StlState | null;
}

export function Scene({
  model,
  modelVersion,
  selection,
  mode,
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

  const hullMaterial = useMemo(
    () => createHullMaterial(uLight, { base: HULL_BASE }),
    [uLight],
  );
  const transomMaterial = useMemo(
    () => createHullMaterial(uLight, { base: TRANSOM_BASE }),
    [uLight],
  );
  // the lines-plan modes' occluder. The curves drawn over it are ON the surface — the very triangles and
  // edges of this mesh (hullLines3d.ts) — so the skin is pushed back by a polygon offset to let them show
  // through, the same wireframe-over-solid trick the Mesh overlay uses below. `factor` is what makes it work
  // where it is needed most: it scales with the polygon's own depth slope, so a face seen nearly edge-on (at
  // the silhouette, where a curve's screen width sweeps the most depth) is pushed back the most.
  const whiteMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    [],
  );
  const wireMaterial = useMemo(
    () => new THREE.LineBasicMaterial({ color: new THREE.Color(...WIRE_RGB) }),
    [],
  );
  useEffect(() => {
    return () => {
      hullMaterial.dispose();
      transomMaterial.dispose();
      whiteMaterial.dispose();
      wireMaterial.dispose();
    };
  }, [hullMaterial, transomMaterial, whiteMaterial, wireMaterial]);

  // live per-model uniforms shared by the hull and transom passes — cheap enough to just re-set on every
  // render (the r3f way to sync a plain value onto a persistent three.js object) rather than tracking exactly
  // which of model.waterline / the hull's length / mode actually changed
  const len = Math.max(loa(model), 1e-6);
  hullMaterial.uniforms.uZebra.value = mode === "zebra" ? 1 : 0;
  hullMaterial.uniforms.uWaterZ.value = -model.waterline;
  hullMaterial.uniforms.uBoot.value = 0.004 * len;
  transomMaterial.uniforms.uWaterZ.value = -model.waterline;
  transomMaterial.uniforms.uBoot.value = 0.004 * len;
  // with the wireframe overlay on, push the shaded fill back by a polygon offset (the classic wireframe-
  // over-solid trick) so the wire — at the identical hull-grid positions — stays crisply superimposed on the
  // skin from either side, with no z-fighting
  hullMaterial.polygonOffset = showMesh;
  hullMaterial.polygonOffsetFactor = 1;
  hullMaterial.polygonOffsetUnits = 1;

  const isLinesMode = LINES_MODES.includes(mode);

  // The hull's own tessellation (the lattice every mode shares — mesh.ts) plus the curvature-comb curves and
  // the lines-plan curves, rebuilt together in one pass whenever the model, the display mode, the Mesh
  // overlay, the shared sampling, or the curvature settings change. Bundled into ONE perfBegin/perfEnd
  // bracket (matching the old orchestration) rather than split across independent useMemos: perf.ts's
  // snapshot only keeps the steps from a group's MOST RECENT pass, so two separate brackets in the same
  // render would silently drop whichever ran first from the Performance panel. Deliberately not keyed on
  // `selection` — the guide ribbon lives independently in CameraFacingCurves, so a selection change alone
  // skips this rebuild for free.
  const {
    hullGeometry,
    transomGeometry,
    wireGeometry,
    curvCache,
    linesPlanCurves,
  } = useMemo(() => {
    perfBegin(PERF_MESH);
    let hullGeometry: THREE.BufferGeometry | null = null,
      transomGeometry: THREE.BufferGeometry | null = null,
      wireGeometry: THREE.BufferGeometry | null = null,
      hullMesh: Mesh | null = null; // the raw triangle soup, kept for the lines-plan curves below
    if (sampling) {
      const trimmed = mode !== "sheet";
      const built = buildHullMesh(
        model,
        sampling,
        trimmed,
        showMesh,
        meshQuads,
      );
      hullMesh = built.hull;
      hullGeometry = meshToGeometry(built.hull);
      if (trimmed) {
        const transomMesh = perfStep(
          "Transom panel",
          () => buildTransomMesh(model, built.transomEdge),
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
    // triangles stitched from them — so they need both, and there is nothing to draw without them
    const linesPlanCurves: LinesPlanCurves | null =
      LINES_MODES.includes(mode) && sampling && hullMesh
        ? perfStep(
            "Lines plan curves",
            () => buildLinesPlanCurves(model, mode, sampling, hullMesh!),
            (c) => c.bold.length + c.family.length + c.dwl.length,
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, modelVersion, sampling, mode, showMesh, meshQuads, curvature]);

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
      {isLinesMode ? (
        <>
          {hullGeometry && (
            <mesh geometry={hullGeometry} material={whiteMaterial} />
          )}
          {transomGeometry && (
            <mesh geometry={transomGeometry} material={whiteMaterial} />
          )}
        </>
      ) : (
        <>
          {hullGeometry && (
            <mesh geometry={hullGeometry} material={hullMaterial} />
          )}
          {transomGeometry && (
            <mesh geometry={transomGeometry} material={transomMaterial} />
          )}
          {showMesh && wireGeometry && (
            <lineSegments geometry={wireGeometry} material={wireMaterial} />
          )}
          {stl && <StlOverlay stl={stl} uLight={uLight} />}
        </>
      )}
      <CameraFacingCurves
        model={model}
        guideIdx={guideIdx}
        curvature={curvCache}
        lines={isLinesMode ? linesPlanCurves : null}
      />
    </group>
  );
}
