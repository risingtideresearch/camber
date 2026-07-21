// ---------- the guide-ribbon material: a polyline widened into a ribbon on the GPU ----------
//
// The vertices handed to this material are static (hullGeometry.ts's `ribbonAttributes`): a curve point, the
// curve's tangent there, and which side of the ribbon the vertex is. Everything view-dependent happens here,
// so a camera move costs two uniform writes instead of rebuilding every ribbon vertex on the CPU.
//
// WIDTH. A ribbon can be sized in CSS pixels (`uHalfPx`), in world units (`uHalfWorld`), or both — they are
// simply added. Screen sizing is what the overlay curves want: they are annotations, and they should read the
// same weight however the hull is framed. The selected-station guide wants world sizing instead, because it
// marks a locus ON the hull and reads as part of it. Under an orthographic camera one world-per-pixel scale
// holds across the whole view; under a perspective one it grows with view depth, so it is computed per vertex
// — which is the part the CPU version could not afford. It took a single scale for the whole frame, measured
// at the orbit target, so the near end of a curve came out visibly fatter than its far end.

import * as THREE from "three";

export const RIBBON_VERTEX_SRC = `
attribute vec3 aTangent;
attribute float aSide;
uniform float uHalfPx;    // half-width in CSS pixels
uniform float uHalfWorld; // half-width in world units (added to the above)
uniform float uBias;      // world units toward the eye, to lift a curve clear of a surface it is not on
uniform float uPxScale;   // world units per CSS pixel: absolute (ortho), or per unit of view depth (persp)
uniform float uPersp;     // 1 for a perspective camera, 0 for an orthographic one
uniform float uNear;      // the camera's near plane, the shallowest depth a width may be scaled by
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 t = normalize((modelViewMatrix * vec4(aTangent, 0.0)).xyz);
  // the direction toward the eye, in view space: the camera sits at the origin looking down −Z, so under
  // perspective that is the ray back to the origin, and under orthographic it is +Z everywhere
  vec3 eye = mix(vec3(0.0, 0.0, 1.0), normalize(-mv.xyz), uPersp);
  // the width axis: ⟂ to both the curve and the eye, so the ribbon keeps its face to the camera
  vec3 w = cross(t, eye);
  if (dot(w, w) < 1e-12) w = cross(t, vec3(0.0, 1.0, 0.0)); // a curve running straight at the eye
  if (dot(w, w) < 1e-12) w = vec3(1.0, 0.0, 0.0);
  // A perspective width scales with the vertex's own view depth. Where a curve runs past the camera that
  // depth reaches zero and turns negative, which would pinch the ribbon to a point and then invert it — and
  // the pinch is visible, because the quad spanning the near plane is clipped rather than dropped. Clamping
  // at the near plane keeps the clipped remnant at the width it should be.
  // (not named "half" — that is a reserved word in GLSL ES)
  float hw = uHalfWorld + uHalfPx * uPxScale * mix(1.0, max(-mv.z, uNear), uPersp);
  mv.xyz += normalize(w) * (aSide * hw) + eye * uBias;
  gl_Position = projectionMatrix * mv;
}`;

// Flat colour, then three's own output-colour-space conversion — the same one its built-in materials append,
// so a colour set here lands on screen exactly as the MeshBasicMaterial these replaced put it there.
export const RIBBON_FRAGMENT_SRC = `
precision highp float;
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
  #include <colorspace_fragment>
}`;

// The camera-derived uniforms, shared BY REFERENCE across every ribbon material (as hullShader's `uLight` is)
// — one write per frame updates every ribbon in the scene.
export interface RibbonCameraUniforms {
  uPxScale: { value: number };
  uPersp: { value: number };
  uNear: { value: number };
}

export const createSharedRibbonCamera = (): RibbonCameraUniforms => ({
  uPxScale: { value: 0 },
  uPersp: { value: 0 },
  uNear: { value: 0 },
});

// Call once per rendered frame. `heightPx` is the canvas height in CSS pixels; the two visible-height
// formulas are the ones Canvas3DCamera.ts uses internally to match the two projections on a toggle.
export function updateRibbonCamera(
  u: RibbonCameraUniforms,
  camera: THREE.Camera,
  heightPx: number,
): void {
  const h = Math.max(heightPx, 1);
  if (camera instanceof THREE.PerspectiveCamera) {
    u.uPersp.value = 1;
    u.uNear.value = camera.near;
    u.uPxScale.value =
      (2 * Math.tan(((camera.fov / 2) * Math.PI) / 180)) / (camera.zoom * h);
  } else if (camera instanceof THREE.OrthographicCamera) {
    u.uPersp.value = 0;
    u.uPxScale.value = (camera.top - camera.bottom) / (camera.zoom * h);
  }
}

export interface RibbonMaterialOptions {
  color: THREE.Color;
  halfWidthPx?: number; // default 0
  halfWidthWorld?: number; // default 0
  bias?: number; // default 0 — world units toward the eye
}

export function createRibbonMaterial(
  cam: RibbonCameraUniforms,
  opts: RibbonMaterialOptions,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: RIBBON_VERTEX_SRC,
    fragmentShader: RIBBON_FRAGMENT_SRC,
    uniforms: {
      uColor: { value: opts.color },
      uHalfPx: { value: opts.halfWidthPx ?? 0 },
      uHalfWorld: { value: opts.halfWidthWorld ?? 0 },
      uBias: { value: opts.bias ?? 0 },
      uPxScale: cam.uPxScale,
      uPersp: cam.uPersp,
      uNear: cam.uNear,
    },
    // the width axis flips with the view, so which face a ribbon shows is not ours to predict
    side: THREE.DoubleSide,
  });
}
