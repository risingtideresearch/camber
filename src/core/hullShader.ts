// ---------- the shaded-hull material: GLSL + the "headlight" that follows the camera ----------
//
// Three auto-injects position/normal/modelMatrix/modelViewMatrix/viewMatrix/projectionMatrix/cameraPosition/
// isOrthographic into a ShaderMaterial, so there is no manual attribute/uniform-location bookkeeping the old
// raw-WebGL program needed. Deck rake is NOT part of this shader — it is a rigid rotation baked into the
// scene's own <group> transform (see hullGeometry.ts's header comment), so modelMatrix already carries it and
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
// eye direction so unfair (non-smooth) spots show as kinked lines. The shaded skin stays deliberately close to
// its base colour — the diffuse only swings it between 0.78x and 1.06x, and the highlight is a whisper — so
// the curves and the mesh drawn ON it read as clearly in a shadowed area as in a lit one, and so Smooth sits
// in the same light key as Flat rather than being a much darker mode.
//
// The zebra stripes are antialiased ANALYTICALLY rather than by supersampling: the pattern is a square wave in
// a known coordinate, so a pixel's exact ink coverage is the difference of that wave's antiderivative across
// the pixel's footprint in that coordinate — a handful of ALU ops, exact rather than a 16-tap estimate, and it
// stays right no matter how fast the stripes run. Where they crowd below one pixel (a tight bilge, a nearly
// singular reflection) the coverage rightly averages toward flat grey instead of breaking into moire, so a
// greyed patch reads as "too fine to resolve here — zoom in", not as a surface defect.
//
// The design waterline is NOT shaded here — the hull used to wear darker bottom paint below it, but the view
// now draws it as a real curve on the surface (hullLines3d.ts) in every shading mode, which reads the same
// whichever way the hull is shaded.
//
// V is the direction to the eye, and it is taken per PROJECTION, not per fragment. Under perspective it is the
// ray from the fragment back to `cameraPosition`. Under an orthographic camera every view ray is parallel and
// `cameraPosition` lies on none of them, so V is the camera's own view axis — its world +Z, which is the third
// ROW of viewMatrix (that matrix is the inverse of the camera's rigid world transform, so its rows are the
// camera basis, already unit length). Both `isOrthographic` and `cameraPosition` are three's own auto-injected
// uniforms, so this costs nothing to ask.
//
// Reading the ortho case off `cameraPosition` anyway is only benign while the eye is far away, and it is not:
// Canvas3DOrbitControls dollies the orthographic camera in as it zooms (the projection is invariant to that
// translation, so it moves the clipping planes with the zoom rather than the image). Zoomed in, the eye sits
// on the hull, and a fragment-to-eye V then fans across the whole hemisphere within a few screen pixels —
// which sent the two-sided flip below off across entire regions and painted them a flat, wrong-side shade.
export const HULL_FRAGMENT_SRC = `
precision highp float;
varying vec3 vNormalW;
varying vec3 vWorld;
uniform vec3 uLight, uBase;
uniform float uStripes, uAlpha;
uniform int uZebra;

// The antiderivative of the zebra's square wave, in stripe coordinates where one unit is one dark/light PAIR
// and the pattern is \`fract(u) < 0.5\`: a ramp that rises through half of every period and holds through the
// other half. Differencing it across a pixel's footprint gives that pixel's exact stripe coverage.
float zebraRamp(float u) { return 0.5 * floor(u) + min(fract(u), 0.5); }

void main() {
  vec3 V = isOrthographic
    ? normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]))
    : normalize(cameraPosition - vWorld);
  vec3 N = normalize(vNormalW);
  if (dot(N, V) < 0.0) N = -N; // two-sided
  vec3 Lc = normalize(uLight);
  float diff = dot(N, Lc) * 0.5 + 0.5; diff *= diff; // half-Lambert: the terminator stays soft
  vec3 H = normalize(Lc + V);
  float spec = pow(max(dot(N, H), 0.0), 26.0); // broad, gentle highlight
  if (uZebra == 1) {
    vec3 R = reflect(-V, N);
    vec2 p = vec2(R.y, R.z);
    float k = uStripes / 6.283185307; // stripe coordinate: one unit per dark/light pair
    float u = atan(p.y, p.x) * k;
    // u's footprint in this pixel, by the chain rule on p — d(atan2)/dx = (p.x p'.y - p.y p'.x) / |p|^2 — and
    // NOT by fwidth(u): atan's branch cut at +-pi would read there as an enormous derivative and lay a grey
    // seam down the hull, though the pattern itself crosses it continuously (uStripes is a whole number of
    // periods). |dx| + |dy| is fwidth's own Manhattan estimate of the footprint.
    vec2 dpx = dFdx(p), dpy = dFdy(p);
    float r2 = max(dot(p, p), 1e-12);
    float w = k * (abs(p.x * dpx.y - p.y * dpx.x) + abs(p.x * dpy.y - p.y * dpy.x)) / r2;
    w = max(w, 1e-5); // a pixel narrower than any stripe edge: the difference below degrades to a hard step
    float s = clamp((zebraRamp(u + 0.5 * w) - zebraRamp(u - 0.5 * w)) / w, 0.0, 1.0);
    vec3 col = mix(vec3(0.07, 0.09, 0.15), vec3(0.97, 0.98, 1.0), s) * (0.66 + 0.34 * diff);
    gl_FragColor = vec4(col, uAlpha);
  } else {
    vec3 col = uBase * (0.78 + 0.28 * diff) + vec3(1.0) * spec * 0.12;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), uAlpha);
  }
}`;

export interface HullMaterialOptions {
  base: [number, number, number];
  alpha?: number; // default 1
  zebra?: boolean; // default false
  // push the shaded fill back by a polygon offset (the classic wireframe-over-solid trick), so the curves and
  // wireframe drawn ON this surface — at its own vertex positions — stay crisply superimposed with no
  // z-fighting, from either side
  offset?: boolean; // default false
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
      uStripes: { value: 64.0 },
    },
    polygonOffset: opts.offset ?? false,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
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
