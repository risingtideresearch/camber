// ---------- the shaded-hull material: GLSL + the "headlight" that follows the camera ----------
//
// Three auto-injects position/normal/modelMatrix/modelViewMatrix/viewMatrix/projectionMatrix/cameraPosition
// into a ShaderMaterial, so there is no manual attribute/uniform-location bookkeeping the old raw-WebGL
// program needed. Deck rake is NOT part of this shader — it is a rigid rotation baked into the scene's own
// <group> transform (see hullGeometry.ts's header comment), so modelMatrix already carries it and
// mat3(modelMatrix) is exact for normals (rotation only, no scale — no inverse-transpose needed).

import * as THREE from "three";

export const HULL_VERTEX_SRC = `
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorld = worldPosition.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}`;

// Per-pixel half-Lambert diffuse + a broad, soft specular; a "zebra" mode bands the surface by the reflected
// eye direction so unfair (non-smooth) spots show as kinked lines; below the design waterline the hull wears
// bottom paint (a darker body, softened by a boot-top smoothstep band so the paint line doesn't alias). V is
// the TRUE per-fragment view direction (three's built-in `cameraPosition` uniform, free) rather than the old
// single camera-basis constant — that was an orthographic-only approximation; this is simpler and more
// correct now that the camera can be a close-up perspective view.
export const HULL_FRAGMENT_SRC = `
precision highp float;
varying vec3 vNormalW;
varying vec3 vWorld;
uniform vec3 uLight, uBase;
uniform float uStripes, uAlpha, uWaterZ, uPaint, uBoot;
uniform int uZebra;
void main() {
  vec3 N = normalize(vNormalW), V = normalize(cameraPosition - vWorld);
  if (dot(N, V) < 0.0) N = -N; // two-sided
  vec3 Lc = normalize(uLight);
  float diff = dot(N, Lc) * 0.5 + 0.5; diff *= diff; // half-Lambert: the terminator stays soft
  vec3 H = normalize(Lc + V);
  float spec = pow(max(dot(N, H), 0.0), 26.0); // broad, gentle highlight
  if (uZebra == 1) {
    vec3 R = reflect(-V, N);
    float band = sin(atan(R.z, R.y) * uStripes);
    float s = smoothstep(-0.14, 0.14, band);
    vec3 col = mix(vec3(0.07, 0.09, 0.15), vec3(0.97, 0.98, 1.0), s) * (0.66 + 0.34 * diff);
    gl_FragColor = vec4(col, uAlpha);
  } else {
    float sub = (1.0 - smoothstep(uWaterZ - uBoot, uWaterZ + uBoot, vWorld.z)) * uPaint;
    vec3 body = uBase * 0.34 + uBase * diff * 0.80;
    body = mix(body, uBase * (0.14 + 0.34 * diff), sub);
    vec3 col = body + vec3(1.0) * spec * 0.40;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), uAlpha);
  }
}`;

export interface HullMaterialOptions {
  base: [number, number, number];
  alpha?: number; // default 1
  zebra?: boolean; // default false
  paint?: boolean; // default true — bottom paint below the design waterline
  waterZ?: number; // -model.waterline; irrelevant when paint is false
  boot?: number; // the boot-top's soft band, in world units; irrelevant when paint is false
  transparent?: boolean; // default false
  depthWrite?: boolean; // default true
}

// One shared `uLight` uniform (by reference) across every hull-shaded material — the hull, the transom, and
// the STL overlay's shaded pass all read the SAME light direction, updated once per frame by
// `updateHeadlight`, so they stay lit consistently as the camera orbits.
export function createSharedLightUniform(): { value: THREE.Vector3 } {
  return { value: new THREE.Vector3(0, 0, 1) };
}

export function createHullMaterial(
  uLight: { value: THREE.Vector3 },
  opts: HullMaterialOptions,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: HULL_VERTEX_SRC,
    fragmentShader: HULL_FRAGMENT_SRC,
    uniforms: {
      uLight,
      uBase: { value: new THREE.Vector3(...opts.base) },
      uAlpha: { value: opts.alpha ?? 1.0 },
      uZebra: { value: opts.zebra ? 1 : 0 },
      uPaint: { value: opts.paint === false ? 0.0 : 1.0 },
      uWaterZ: { value: opts.waterZ ?? 0 },
      uBoot: { value: opts.boot ?? 0 },
      uStripes: { value: 11.0 },
    },
    // buildHullMesh's mirrored port-half triangles are wound opposite starboard's by design (positions and
    // normals both negated) — three's default back-face culling would silently drop half the hull without
    // this, exactly as the old program was two-sided for the same reason.
    side: THREE.DoubleSide,
    transparent: opts.transparent ?? false,
    depthWrite: opts.depthWrite ?? true,
  });
}

// The camera's local +Z axis in world space (three's cameras look down local −Z, so +Z points back toward
// the eye) gives a "headlight" direction relative to the live camera pose — call once per rendered frame,
// replacing the old fixed yaw/pitch camera-basis computation. EYE / SIDE set how grazing the light is: a very
// grazing light is maximally sensitive to tiny normal tilts, so it would amplify sub-degree faceting noise in
// the swept mesh into false puckering; keeping a solid off-axis component preserves the form read while
// easing the grazing enough to quiet that meshing noise.
const _right = new THREE.Vector3(),
  _up = new THREE.Vector3(),
  _eye = new THREE.Vector3();
export function updateHeadlight(
  uLight: THREE.Vector3,
  camera: THREE.Camera,
): void {
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  _eye.set(0, 0, 1).applyQuaternion(camera.quaternion);
  const EYE = 0.72,
    SIDE = 0.62;
  uLight
    .set(
      EYE * _eye.x - SIDE * _right.x - SIDE * _up.x,
      EYE * _eye.y - SIDE * _right.y - SIDE * _up.y,
      EYE * _eye.z - SIDE * _right.z - SIDE * _up.z,
    )
    .normalize();
}
