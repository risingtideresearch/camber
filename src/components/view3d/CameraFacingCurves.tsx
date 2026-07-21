import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { HILITE, COL } from "../../core/colors";
import {
  buildLongitudinalMesh,
  ribbonMesh,
  type CurvCurve3,
} from "../../core/hullGeometry";
import type { LinesPlanCurves } from "../../core/hullLines3d";
import { loa, type Model } from "../../core/model";
import type { Vec3 } from "../../core/math";
import { perfAdd, PERF_MESH } from "../../core/perf";

// on-screen (CSS-px) HALF-widths of the ribbons below, so they read at a constant screen size regardless of
// zoom / framing — like the old SVG overlay's non-scaling strokes. Matches its stroke weights (curve 2.2,
// comb ~1.2 full; lines-plan bold 1.8, family 1, DWL 1.4 full).
const SHEER_HALF_PX = 1.1,
  COMB_HALF_PX = 0.6,
  LINES_BOLD_HALF_PX = 0.9,
  LINES_FAMILY_HALF_PX = 0.5,
  LINES_DWL_HALF_PX = 0.7,
  LINES_BLACK = "#11181f";
const ORIGIN = new THREE.Vector3();

// one flat-shaded ribbon to draw: its polylines (view-independent — the whole point of memoizing `jobs`
// below), its colour, and its on-screen half-width.
interface Job {
  polylines: Vec3[][];
  color: THREE.Color;
  halfWidthPx: number;
  // Does the polyline already lie exactly on the rendered hull (the lines-plan curves, which are read off
  // the very triangles and edges the GPU rasterizes)? Then it gets NO nudge toward the eye — a bias big
  // enough to clear the surface everywhere is also big enough to float a curve visibly off it, and to let a
  // curve on the far side leak through a near-tangent silhouette. Those stay put and the hull is pushed
  // back by a polygon offset instead (Scene.tsx). The curvature overlay is not on the surface (it rides its
  // own converged evaluators, and its hairs stand off it), so it keeps the bias.
  onSurface?: boolean;
}

// a persistent Mesh + growable BufferGeometry per job slot, reused frame to frame rather than reallocated —
// replacing a geometry's position attribute every frame (instead of writing into it) would orphan a fresh
// GPU buffer every frame with nothing to ever free it
interface Slot {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
}

// three's BufferAttribute.count is array.length / itemSize (3 here); computeBoundingSphere loops over that
// count reading whole (x,y,z) triples, so a capacity that isn't a multiple of 3 leaves a fractional last
// "vertex" whose y/z read past the array's end (undefined), poisoning the bounding-sphere math into NaN —
// round every candidate size up to a multiple of 3.
const roundToVec3 = (n: number): number => Math.ceil(n / 3) * 3;

function ensureCapacity(
  geometry: THREE.BufferGeometry,
  floatsNeeded: number,
): Float32Array {
  const existing = geometry.getAttribute("position") as
    THREE.BufferAttribute | undefined;
  if (existing && existing.array.length >= floatsNeeded)
    return existing.array as Float32Array;
  const grown = new Float32Array(
    roundToVec3(
      Math.max(floatsNeeded, (existing?.array.length ?? 0) * 2, 1024),
    ),
  );
  const attr = new THREE.BufferAttribute(grown, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", attr);
  return grown;
}

function writeRibbon(
  geometry: THREE.BufferGeometry,
  m: { pos: Float32Array; count: number },
): void {
  const arr = ensureCapacity(geometry, m.pos.length);
  arr.set(m.pos);
  (geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate =
    true;
  geometry.setDrawRange(0, m.count);
  geometry.computeBoundingSphere();
}

const _viewDir = new THREE.Vector3();
function viewDirOf(camera: THREE.Camera): Vec3 {
  _viewDir.set(0, 0, 1).applyQuaternion(camera.quaternion); // the camera's local +Z, toward the eye
  return [_viewDir.x, _viewDir.y, _viewDir.z];
}

// CSS pixels of screen height per world unit at `target`'s depth — the small inverse of the
// visibleHeightAt/zoomForVisibleHeight formulas Canvas3DCamera.ts uses internally to match projections on an
// ortho/perspective toggle. Ribbon half-widths are divided by this so they stay a constant SCREEN size.
function pixelsPerWorldUnit(
  camera: THREE.Camera,
  target: THREE.Vector3,
  heightPx: number,
): number {
  const dist = camera.position.distanceTo(target);
  const visibleHeight =
    camera instanceof THREE.PerspectiveCamera
      ? (2 * dist * Math.tan(((camera.fov / 2) * Math.PI) / 180)) / camera.zoom
      : camera instanceof THREE.OrthographicCamera
        ? (camera.top - camera.bottom) / camera.zoom
        : dist; // an unexpected camera type — fall back to something that at least scales with distance
  return heightPx / Math.max(visibleHeight, 1e-6);
}

interface CameraFacingCurvesProps {
  model: Model;
  guideIdx: number | null; // the selected station point's index, or null — draws its amber swept longitudinal
  curvature: CurvCurve3[] | null; // buildCurvature3's output, memoized by the caller
  lines: LinesPlanCurves | null; // buildLinesPlanCurves' output (only in a lines-plan mode), memoized by the caller
}

// The one place the 3D view still rebuilds geometry every rendered frame: `ribbonMesh`'s width axis and
// eye-bias depend on the live view direction, so the selected-station guide, the curvature-comb overlay, and
// the lines-plan curves all need re-widening whenever the camera moves — the direct equivalent of the old
// imperative code's "rebuild every redrawGL()". It's cheaper than before: the underlying POLYLINES are
// memoized (`jobs`, below) and only the ribbon widths / eye-bias offsets are redone here, imperatively, with
// no React re-render. The guide is the one exception — `buildLongitudinalMesh` bakes its own cheap N=160 loft
// sample together with the ribbon widening, and re-running that small loop every frame is simpler than
// splitting it.
export function CameraFacingCurves({
  model,
  guideIdx,
  curvature,
  lines,
}: CameraFacingCurvesProps) {
  const groupRef = useRef<THREE.Group>(null);
  const slotsRef = useRef<Slot[]>([]);
  const invalidate = useThree((s) => s.invalidate);

  // dispose whatever is left in the pool on full unmount — the reconciliation effect below only disposes
  // slots as the pool SHRINKS, which never fires if the whole component unmounts with slots still allocated
  useEffect(() => {
    return () => {
      for (const s of slotsRef.current) {
        s.geometry.dispose();
        s.material.dispose();
      }
      slotsRef.current = [];
    };
  }, []);

  const jobs = useMemo(() => {
    const out: Job[] = [];
    if (curvature)
      for (const cc of curvature) {
        if (cc.curve.length < 2) continue;
        const mir = (p: Vec3): Vec3 => [p[0], -p[1], p[2]],
          color = new THREE.Color(cc.rgb[0], cc.rgb[1], cc.rgb[2]),
          curves: Vec3[][] = [cc.curve];
        if (cc.mirror) curves.push(cc.curve.map(mir));
        out.push({ polylines: curves, color, halfWidthPx: SHEER_HALF_PX });
        if (cc.hairs.length) {
          const comb: Vec3[][] = [cc.env];
          if (cc.mirror) comb.push(cc.env.map(mir));
          for (const [a, b] of cc.hairs) {
            comb.push([a, b]);
            if (cc.mirror) comb.push([mir(a), mir(b)]);
          }
          out.push({ polylines: comb, color, halfWidthPx: COMB_HALF_PX }); // same colour as the base curve
        }
      }
    if (lines) {
      const black = new THREE.Color(LINES_BLACK);
      if (lines.bold.length)
        out.push({
          polylines: lines.bold,
          color: black,
          halfWidthPx: LINES_BOLD_HALF_PX,
          onSurface: true,
        });
      if (lines.family.length)
        out.push({
          polylines: lines.family,
          color: black,
          halfWidthPx: LINES_FAMILY_HALF_PX,
          onSurface: true,
        });
      if (lines.dwl.length)
        out.push({
          polylines: lines.dwl,
          color: new THREE.Color(COL.wl),
          halfWidthPx: LINES_DWL_HALF_PX,
          onSurface: true,
        });
    }
    return out;
  }, [curvature, lines]);

  // reconcile the persistent Mesh pool with `jobs` (+ a trailing guide slot, present only while a station
  // point is selected) whenever the SET of jobs changes — not every frame. New slots start with empty
  // geometry; the useFrame below fills them in on the very next rendered frame (which the invalidate() here
  // schedules), so there is no stale-empty flash.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const wantGuide = guideIdx !== null,
      wantCount = jobs.length + (wantGuide ? 1 : 0),
      slots = slotsRef.current;
    while (slots.length > wantCount) {
      const s = slots.pop()!;
      group.remove(s.mesh);
      s.geometry.dispose();
      s.material.dispose();
    }
    while (slots.length < wantCount) {
      const geometry = new THREE.BufferGeometry(),
        // double-sided: ribbonMesh's triangle winding faces the view direction it was built with, which
        // isn't necessarily three's front-face convention, and (unlike the old raw-WebGL program, which
        // never enabled face culling) three's default material culls back faces
        material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
        mesh = new THREE.Mesh(geometry, material);
      group.add(mesh);
      slots.push({ mesh, geometry, material });
    }
    jobs.forEach((job, i) => slots[i].material.color.copy(job.color));
    if (wantGuide) slots[jobs.length].material.color.set(HILITE);
    invalidate();
  }, [jobs, guideIdx, invalidate]);

  useFrame(({ camera, size, controls }) => {
    const slots = slotsRef.current;
    if (!slots.length) return;
    const t0 = performance.now(),
      view = viewDirOf(camera),
      target =
        (controls as unknown as { target?: THREE.Vector3 } | null)?.target ??
        ORIGIN,
      pxToWorld = 1 / pixelsPerWorldUnit(camera, target, size.height),
      bias = 0.009 * Math.max(loa(model), 1e-6);
    jobs.forEach((job, i) => {
      writeRibbon(
        slots[i].geometry,
        ribbonMesh(
          job.polylines,
          view,
          job.halfWidthPx * pxToWorld,
          job.onSurface ? 0 : bias,
        ),
      );
    });
    if (guideIdx !== null)
      writeRibbon(
        slots[jobs.length].geometry,
        buildLongitudinalMesh(model, guideIdx, view),
      );
    perfAdd(PERF_MESH, "Camera-facing ribbons", performance.now() - t0);
  });

  return <group ref={groupRef} />;
}
