import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { SliceMeasurement } from "../../core/sheet/slices";

export interface SliceOverlayEntry {
  readonly id: string;
  readonly measurement: SliceMeasurement;
}

export interface SliceOverlayState {
  readonly entries: readonly SliceOverlayEntry[];
  readonly activeId: string | null;
}

const ACTIVE = new THREE.Color("#e4572e");
const INACTIVE = new THREE.Color("#2b78c5");

/** Hull-section curves and lightly filled cuts, already expressed in the model coordinates used by Scene. */
export function SliceOverlay({
  overlay,
  markerSize,
}: {
  readonly overlay: SliceOverlayState;
  readonly markerSize: number;
}) {
  const group = useMemo(() => {
    const root = new THREE.Group();
    for (const entry of overlay.entries) {
      const { curve, centroid } = entry.measurement;
      if (curve.length < 2) continue;
      const active = entry.id === overlay.activeId;
      const color = active ? ACTIVE : INACTIVE;

      const lineGeometry = new THREE.BufferGeometry().setFromPoints(
        curve.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      );
      const lineMaterial = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: active ? 1 : 0.58,
        depthTest: true,
      });
      const line = new THREE.LineLoop(lineGeometry, lineMaterial);
      line.renderOrder = 4;
      root.add(line);

      // A triangle fan is only a display surface: the reported area comes from the geometry backend, never
      // from these triangles. The low opacity keeps a mildly concave section useful even if fan triangles
      // overlap locally.
      const positions: number[] = [];
      for (let i = 0; i < curve.length; i++) {
        const a = curve[i],
          b = curve[(i + 1) % curve.length];
        positions.push(...centroid, ...a, ...b);
      }
      const fillGeometry = new THREE.BufferGeometry();
      fillGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      const fillMaterial = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: active ? 0.18 : 0.07,
        depthWrite: false,
      });
      const fill = new THREE.Mesh(fillGeometry, fillMaterial);
      fill.renderOrder = 3;
      root.add(fill);

      const markerGeometry = new THREE.SphereGeometry(
        markerSize * (active ? 1 : 0.72),
        12,
        8,
      );
      const markerMaterial = new THREE.MeshBasicMaterial({ color });
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.set(...centroid);
      marker.renderOrder = 5;
      root.add(marker);
    }
    return root;
  }, [overlay, markerSize]);

  useEffect(
    () => () => {
      group.traverse((object) => {
        if (!(object instanceof THREE.Mesh || object instanceof THREE.Line))
          return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) material.dispose();
      });
    },
    [group],
  );

  return <primitive object={group} />;
}
