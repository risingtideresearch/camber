import { useEffect, useRef } from "react";
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

// The VERTICAL field of view (what three.js's camera actually takes) whose DIAGONAL is `fov` at this aspect.
// The half-tangents of the three angles form a right triangle: the horizontal one is the vertical one times
// the aspect, so the diagonal's is the vertical's times hypot(1, aspect).
const verticalFov = (fov: number, aspect: number): number =>
  (2 * Math.atan(halfAngle(fov) / Math.hypot(1, aspect)) * 180) / Math.PI;

// The perspective camera's lens, applied as a DOLLY-ZOOM: setting the field of view moves the camera along
// its view axis so the hull keeps exactly the size it had on screen, and only the amount of perspective
// changes.
//
// The number is the DIAGONAL field of view, not three.js's vertical one, and the conversion is redone on
// every resize. A vertical lens is a lens whose width is whatever the window happens to be: widening the
// view simply opens the horizontal angle, so the same slider setting throws far more perspective across a
// wide viewport than a tall one. The diagonal is the widest angle actually on screen, so pinning THAT —
// narrowing the vertical lens as the view widens — keeps the amount of foreshortening the same whatever
// shape the window is.
//
// A resize changes the lens and NOTHING else: the eye stays exactly where the user left it. The dolly below
// is for the slider, where the point is to change the perspective without changing the framing; dragging a
// window edge is not a request to move the camera, and paying for the new lens by sliding the eye along its
// axis while the user is still dragging reads as the hull deforming under the mouse. Only the amount of
// screen it covers changes, which is what a window resize is allowed to do.
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
  const size = useThree((s) => s.size); // re-runs on resize: the vertical lens the diagonal asks for moves with the aspect
  // what the last run applied, so a re-run can tell a resize (same lens, new aspect — set it and leave the
  // pose alone) from an actual lens change or a camera handover (dolly, and normalize `zoom`)
  const applied = useRef<{ camera: THREE.Camera; fov: number } | null>(null);

  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera) || !controls) return;
    if (!(size.width > 0) || !(size.height > 0)) return;
    const vFov = verticalFov(fov, size.width / size.height),
      resized = applied.current?.camera === camera && applied.current.fov === fov;
    applied.current = { camera, fov };

    if (resized) {
      camera.fov = vFov;
      camera.updateProjectionMatrix();
      invalidate();
      return;
    }

    const dist = camera.position.distanceTo(controls.target);
    if (!(dist > 0)) return;
    // what is held fixed: the world height the viewport spans at the orbit target (Canvas3DCamera.ts's own
    // formula, so this agrees with the zoom-matching done when the projection is toggled)
    const height = (2 * dist * halfAngle(camera.fov)) / camera.zoom;
    camera.fov = vFov;
    camera.zoom = 1;
    // the distance at which that height exactly fills the new lens, along the same view axis
    camera.position
      .sub(controls.target)
      .multiplyScalar(height / (2 * halfAngle(vFov)) / dist)
      .add(controls.target);
    camera.updateProjectionMatrix();
    controls.update(); // re-derives the controls' spherical state, and autoNear/autoFar, from the new pose
    invalidate();
  }, [camera, controls, fov, invalidate, size.width, size.height]);

  return null;
}
