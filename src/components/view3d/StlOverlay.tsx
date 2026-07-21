import { useMemo } from "react";
import * as THREE from "three";
import { createHullMaterial } from "../../core/hullShader";
import { transformStl, type StlState } from "../../core/stlImport";

// magenta — distinct from the blue hull and amber transom
const STL_COLOR: [number, number, number] = [0.85, 0.24, 0.6];

interface StlOverlayProps {
  stl: StlState;
  uLight: { value: THREE.Vector3 };
}

// The imported reference STL, translucent, over the hull: a shaded surface and/or wireframe edges. Both
// passes are depth-TESTED against the opaque hull (so hidden parts are occluded) but not depth-WRITING (so
// the translucent surface reads evenly without self-occlusion artifacts).
export function StlOverlay({ stl, uLight }: StlOverlayProps) {
  const { settings } = stl;

  // rebuild the world-space transform only when what it depends on changes (the file, the axis remap, the
  // scale, or the design box it's fit to) — not on every re-render
  const world = useMemo(
    () => transformStl(stl),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      stl.geom.id,
      settings.axisX,
      settings.axisY,
      settings.axisZ,
      settings.scale,
      stl.designBox,
    ],
  );

  const shadedGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(world.pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(world.nrm, 3));
    return g;
  }, [world]);
  const wireGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(world.lines, 3));
    return g;
  }, [world]);

  const shadedMaterial = useMemo(
    () =>
      createHullMaterial(uLight, {
        base: STL_COLOR,
        transparent: true,
        depthWrite: false,
      }),
    [uLight],
  );
  const wireMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: new THREE.Color(...STL_COLOR),
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  // opacity is a live-adjustable setting, not part of the cached geometry/material identity — a direct
  // uniform / property write during render, the standard r3f way to sync a plain value onto a persistent
  // three.js object
  shadedMaterial.uniforms.uAlpha.value = settings.opacity;
  wireMaterial.opacity = settings.opacity;

  if (!settings.visible || (!settings.shaded && !settings.wireframe))
    return null;
  return (
    <>
      {settings.shaded && (
        <mesh geometry={shadedGeometry} material={shadedMaterial} />
      )}
      {settings.wireframe && (
        <lineSegments geometry={wireGeometry} material={wireMaterial} />
      )}
    </>
  );
}
