import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { loa, type Model } from "../../core/model";
import { nominalCameraFraming } from "../../core/hullGeometry";

// The shape of Canvas3DOrbitControls' underlying controls object that this hook needs. The impl class isn't
// part of polymorph-ui's public API (only the <Canvas3DOrbitControls> component is), so this is a minimal
// local view of it — the same `target` / `update()` contract its own README documents.
interface OrbitControlsLike {
  target: THREE.Vector3;
  update(): unknown;
}

// Places the camera once on mount, and again whenever the model's size CLASS jumps (a coarse log2-of-length
// bucket) — deliberately coarse, so ordinary edits (dragging a control point) never cross a doubling and
// never re-fit, leaving the user's live orbit/zoom alone. A real scale change re-fits so a very differently
// sized design still frames sensibly on first paint. EditorApp only ever swaps `model` via a full page
// navigation (so this fires once in practice); InterpolateApp blends `loa` continuously via a slider, which
// is exactly the case this guard is for.
//
// Must be called from a component mounted inside <Canvas3D> (it uses r3f's useThree). Owns both the camera's
// pose and the orbit controls' target directly (rather than going through Canvas3DOrbitControls' `target`
// prop) so there is exactly one place that moves the camera on a re-fit, with no risk of the controls'
// internal spherical state and the camera's position disagreeing between two separate effects.
export function useCameraFraming(model: Model): void {
  const camera = useThree((s) => s.camera);
  const controls = useThree(
    (s) => s.controls,
  ) as unknown as OrbitControlsLike | null;
  const invalidate = useThree((s) => s.invalidate);
  const size = useThree((s) => s.size);

  const sizeClass = Math.round(Math.log2(Math.max(loa(model), 1e-6)));
  const lastClass = useRef<number | null>(null);

  useEffect(() => {
    if (!controls || size.height <= 0) return;
    if (lastClass.current === sizeClass) return;
    lastClass.current = sizeClass;

    const { target, dirToEye, radius } = nominalCameraFraming(model),
      margin = 1.15,
      r = Math.max(radius, 1e-6) * margin,
      centerVec = new THREE.Vector3(...target),
      dirVec = new THREE.Vector3(...dirToEye);

    let distance: number;
    if (camera instanceof THREE.PerspectiveCamera) {
      // solves visibleHeightAt(camera, distance) = 2r (Canvas3DCamera.ts's own formula, so the ortho <-> persp
      // zoom-matching Canvas3DCameras does on a later toggle lines up with this initial framing)
      distance = r / Math.tan(((camera.fov / 2) * Math.PI) / 180);
    } else {
      // an orthographic camera's apparent size comes from `zoom`, not distance — any distance comfortably
      // outside the near plane works, so pick one on the same order as the perspective case
      distance = r * 3;
    }
    camera.position.copy(centerVec).addScaledVector(dirVec, distance);
    if (camera instanceof THREE.OrthographicCamera)
      camera.zoom = size.height / (r * 2);
    camera.far = distance * 4;
    camera.near = camera.far / 10000; // seed only — Canvas3DOrbitControls' autoNear/autoFar immediately correct it
    camera.updateProjectionMatrix();

    controls.target.copy(centerVec);
    controls.update();
    invalidate();
  }, [camera, controls, invalidate, model, sizeClass, size.height]);
}
