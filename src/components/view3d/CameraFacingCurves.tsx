import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { HILITE, COL } from "../../core/colors";
import {
  buildLongitudinalCurve,
  ribbonAttributes,
  type CurvCurve3,
} from "../../core/hullGeometry";
import {
  createRibbonMaterial,
  createSharedRibbonCamera,
  updateRibbonCamera,
} from "../../core/ribbonShader";
import type { LinesPlanCurves, TrimPlanCurves } from "../../core/hullLines3d";
import { loa, type Model } from "../../core/model";
import type { Vec3 } from "../../core/math";

// on-screen (CSS-px) HALF-widths of the ribbons below, so they read at a constant screen size regardless of
// zoom / framing — like the old SVG overlay's non-scaling strokes. Matches its stroke weights (curve 2.2,
// comb ~1.2 full; lines-plan bold 1.8, family 1, DWL 1.4 full).
const SHEER_HALF_PX = 1.1,
  COMB_HALF_PX = 0.6,
  LINES_BOLD_HALF_PX = 0.9,
  LINES_FAMILY_HALF_PX = 0.5,
  LINES_DWL_HALF_PX = 0.7,
  LINES_BLACK = "#11181f";
// The selected-station guide is sized in WORLD units instead: it marks a locus ON the hull rather than
// annotating it, so it grows as you zoom into the surface it lies on. Both it and the biases below are
// fractions of the hull's own length — model coordinates are absolute, so a fixed world number would read
// differently on a 5 m hull and a 500 mm one.
const GUIDE_HALF_F = 0.00125,
  GUIDE_BIAS_F = 0.006,
  CURV_BIAS_F = 0.009; // the curvature overlay's nudge clear of the surface it rides

// one ribbon to draw. The polylines are view-independent — the shader does every bit of the widening — so a
// job only changes when the model, the display mode, or the selection does.
interface Job {
  polylines: Vec3[][];
  color: THREE.Color;
  halfWidthPx?: number; // sized on screen (the overlays)…
  halfWidthWorld?: number; // …or in the world (the guide)
  // World units toward the eye. The lines-plan curves take none: they lie exactly on the rendered hull (they
  // are read off its own triangles and edges — hullLines3d.ts) and the hull is pushed back by a polygon
  // offset instead, so nothing has to float. The curvature overlay is not on the surface — it rides its own
  // converged evaluators, and its hairs stand off it by design — so it keeps a bias.
  bias?: number;
}

interface CameraFacingCurvesProps {
  model: Model;
  guideIdx: number | null; // the selected station point's index, or null — draws its amber swept longitudinal
  curvature: CurvCurve3[] | null; // buildCurvature3's output, memoized by the caller
  lines: LinesPlanCurves | null; // buildLinesPlanCurves' output (only in a lines-plan mode), memoized by the caller
  trims: TrimPlanCurves | null; // buildTrimCurves' output — the sheet's three trims, memoized by the caller
}

// Every 3D guide curve — the selected station's longitudinal, the curvature combs, the lines plan — drawn as
// a thin ribbon facing the camera, because WebGL's own line width is one pixel and not negotiable.
//
// Nothing here is rebuilt per frame any more. The ribbon vertices are static (a curve point, its tangent,
// which side of the ribbon it is) and the widening happens in the vertex shader, so orbiting costs two
// uniform writes instead of re-widening every vertex on the CPU — which, once the lines plan started
// sampling at the full mesh resolution, had become the most expensive thing in the frame. What is left is
// ordinary React: one mesh per job, rebuilt only when the curves themselves change.
export function CameraFacingCurves({
  model,
  guideIdx,
  curvature,
  lines,
  trims,
}: CameraFacingCurvesProps) {
  const invalidate = useThree((s) => s.invalidate);
  // shared by reference with every material below, so one write per frame updates all of them
  const cam = useMemo(() => createSharedRibbonCamera(), []);
  useFrame(({ camera, size }) => updateRibbonCamera(cam, camera, size.height));

  const jobs = useMemo(() => {
    const out: Job[] = [],
      len = Math.max(loa(model), 1e-6);
    if (curvature)
      for (const cc of curvature) {
        if (cc.curve.length < 2) continue;
        const mir = (p: Vec3): Vec3 => [p[0], -p[1], p[2]],
          color = new THREE.Color(cc.rgb[0], cc.rgb[1], cc.rgb[2]),
          bias = CURV_BIAS_F * len,
          curves: Vec3[][] = [cc.curve];
        if (cc.mirror) curves.push(cc.curve.map(mir));
        out.push({
          polylines: curves,
          color,
          halfWidthPx: SHEER_HALF_PX,
          bias,
        });
        if (cc.hairs.length) {
          const comb: Vec3[][] = [cc.env];
          if (cc.mirror) comb.push(cc.env.map(mir));
          for (const [a, b] of cc.hairs) {
            comb.push([a, b]);
            if (cc.mirror) comb.push([mir(a), mir(b)]);
          }
          // same colour as the base curve
          out.push({ polylines: comb, color, halfWidthPx: COMB_HALF_PX, bias });
        }
      }
    if (lines) {
      const black = new THREE.Color(LINES_BLACK);
      if (lines.bold.length)
        out.push({
          polylines: lines.bold,
          color: black,
          halfWidthPx: LINES_BOLD_HALF_PX,
        });
      if (lines.family.length)
        out.push({
          polylines: lines.family,
          color: black,
          halfWidthPx: LINES_FAMILY_HALF_PX,
        });
      if (lines.dwl.length)
        out.push({
          polylines: lines.dwl,
          color: new THREE.Color(COL.wl),
          halfWidthPx: LINES_DWL_HALF_PX,
        });
    }
    // The sheet's trims at the bold feature-edge weight, because on the hull that is exactly what their surviving
    // span IS — the same edge, drawn in the trim's own colour to say which cut made it. The whole marched cut
    // is one black job whichever trims are shown, so it reads as those edges carrying on out over the sheet
    // rather than as a family of its own. Nothing is cut against anything: with both toggles on, the coloured
    // hull edges lie ON the black, and are pushed after them so they win the depth test's ties.
    if (trims) {
      if (trims.sheet.length)
        out.push({
          polylines: trims.sheet,
          color: new THREE.Color(LINES_BLACK),
          halfWidthPx: LINES_BOLD_HALF_PX,
        });
      for (const h of trims.hull)
        if (h.lines.length)
          out.push({
            polylines: h.lines,
            color: new THREE.Color(h.color),
            halfWidthPx: LINES_BOLD_HALF_PX,
          });
    }
    if (guideIdx !== null) {
      const runs = buildLongitudinalCurve(model, guideIdx);
      if (runs.length)
        out.push({
          polylines: runs,
          color: new THREE.Color(HILITE),
          halfWidthWorld: GUIDE_HALF_F * len,
          bias: GUIDE_BIAS_F * len,
        });
    }
    return out;
  }, [model, guideIdx, curvature, lines, trims]);

  const meshes = useMemo(
    () =>
      jobs.map((job) => {
        const a = ribbonAttributes(job.polylines),
          geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(a.position, 3),
        );
        geometry.setAttribute(
          "aTangent",
          new THREE.BufferAttribute(a.tangent, 3),
        );
        geometry.setAttribute("aSide", new THREE.BufferAttribute(a.side, 1));
        geometry.setIndex(new THREE.BufferAttribute(a.index, 1));
        return { geometry, material: createRibbonMaterial(cam, job) };
      }),
    [jobs, cam],
  );

  // dispose the PREVIOUS set whenever it is replaced (and on unmount) — every model edit rebuilds these, so
  // without this their GPU buffers would leak across a session
  useEffect(() => {
    invalidate(); // the new ribbons want a frame to appear in
    return () => {
      for (const m of meshes) {
        m.geometry.dispose();
        m.material.dispose();
      }
    };
  }, [meshes, invalidate]);

  return (
    <group>
      {meshes.map((m, i) => (
        <mesh key={i} geometry={m.geometry} material={m.material} />
      ))}
    </group>
  );
}
