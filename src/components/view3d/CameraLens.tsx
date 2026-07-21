import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

// The shape of Canvas3DOrbitControls' underlying controls object this needs — the same minimal local view
// useCameraFraming takes, and for the same reason: the impl class is not part of polymorph-ui's public API.
interface OrbitControlsLike {
  target: THREE.Vector3;
  update(): unknown;
}

const halfAngle = (fovDeg: number): number =>
  Math.tan(((fovDeg / 2) * Math.PI) / 180);

// The perspective camera's lens, applied as a DOLLY-ZOOM: setting the field of view moves the camera along
// its view axis so the hull keeps exactly the size it had on screen, and only the amount of perspective
// changes.
//
// That dolly is the whole point. Foreshortening depends on nothing but where the eye is relative to the
// hull's size, so a control that only wrote `fov` would leave the eye where it was and every convergence
// with it — the hull would simply grow or shrink in frame, which is a zoom control wearing a lens's name.
// Pulling the camera back as the lens narrows is what turns the number into "how wide the view is".
//
// It also normalizes `zoom` to 1 on the way past. Canvas3DCameras preserves the apparent scale across an
// Ortho/Persp toggle by deriving the incoming camera's `zoom`, which leaves the perspective camera showing
// an EFFECTIVE field of view of 2·atan(tan(fov/2) / zoom) — with the framing carried by `zoom`, the degrees
// in the panel would be a fiction. Carrying it by distance instead makes `fov` the angle actually on screen.
//
// Must be mounted inside <Canvas3D> (it uses r3f's useThree). While the orthographic camera is the active
// one this does nothing: a parallel projection has no field of view to set. The value applies the moment
// perspective comes back, because Canvas3DCameras hands the pose over and this re-runs on the new camera.
export function CameraLens({ fov }: { fov: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree(
    (s) => s.controls,
  ) as unknown as OrbitControlsLike | null;
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera) || !controls) return;
    const dist = camera.position.distanceTo(controls.target);
    if (!(dist > 0)) return;
    // what is held fixed: the world height the viewport spans at the orbit target (Canvas3DCamera.ts's own
    // formula, so this agrees with the zoom-matching done when the projection is toggled)
    const height = (2 * dist * halfAngle(camera.fov)) / camera.zoom;
    camera.fov = fov;
    camera.zoom = 1;
    // the distance at which that height exactly fills the new lens, along the same view axis
    camera.position
      .sub(controls.target)
      .multiplyScalar(height / (2 * halfAngle(fov)) / dist)
      .add(controls.target);
    camera.updateProjectionMatrix();
    controls.update(); // re-derives the controls' spherical state, and autoNear/autoFar, from the new pose
    invalidate();
  }, [camera, controls, fov, invalidate]);

  return null;
}
