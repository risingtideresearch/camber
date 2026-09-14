// Mounted only when a user can use the 3D view. Camera fitting is visual only;
// the input geometry remains in its confirmed physical body frame.
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { DoubleSide } from "three";
import type { DisplayGeometry } from "../projections";
import type { Vec3 } from "../../core/math";
function Surface({
  geometry,
  color,
  overlay = false,
  wireframe = false,
  opacity = 1,
}: {
  geometry: DisplayGeometry;
  color: string;
  overlay?: boolean;
  wireframe?: boolean;
  opacity?: number;
}) {
  return (
    <mesh>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[geometry.positions, 3]}
        />
      </bufferGeometry>
      <meshStandardMaterial
        color={color}
        side={DoubleSide}
        flatShading
        polygonOffset={overlay}
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-1}
        wireframe={wireframe}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity === 1}
      />
    </mesh>
  );
}
export default function GeometryScene({
  geometry,
  proposal,
  repairs,
}: {
  geometry: DisplayGeometry;
  proposal?: DisplayGeometry;
  repairs?: DisplayGeometry;
}) {
  const center = geometry.bounds.min.map(
    (v, i) => (v + geometry.bounds.max[i]) / 2,
  ) as Vec3;
  const size = Math.max(
    1e-6,
    Math.hypot(
      ...geometry.bounds.max.map((v, i) => v - geometry.bounds.min[i]),
    ),
  );
  return (
    <Canvas
      camera={{
        position: [size, -size, size * 0.6],
        up: [0, 0, 1],
        near: size / 1000,
        far: size * 100,
      }}
    >
      <ambientLight intensity={1.6} />
      <directionalLight position={[size, -size, size]} intensity={2.5} />
      <group position={center.map((v) => -v) as Vec3}>
        <Surface geometry={geometry} color="#80aaa5" />
        {proposal && (
          <Surface
            geometry={proposal}
            color="#be7826"
            wireframe
            opacity={0.65}
            overlay
          />
        )}
        {repairs && <Surface geometry={repairs} color="#a067bb" overlay />}
        <axesHelper args={[size / 4]} />
      </group>
      <OrbitControls />
    </Canvas>
  );
}
