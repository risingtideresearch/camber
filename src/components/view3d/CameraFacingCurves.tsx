import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { HILITE, COL, KNOT_LONG, stationColor } from "../../core/colors";
import {
  buildLongitudinalCurve,
  ribbonAttributes,
  ringAttributes,
  type CurvCurve3,
  type StationLines3,
} from "../../core/hullGeometry";
import {
  createRibbonMaterial,
  createRingMaterial,
  createSharedRibbonCamera,
  updateRibbonCamera,
} from "../../core/ribbonShader";
import type { LinesPlanCurves, TrimPlanCurves } from "../../core/hullLines3d";
import { loa, type Model } from "../../core/model";
import type { Vec3 } from "../../core/math";
import {
  perfAdd,
  perfBegin,
  perfEnd,
  perfMark,
  PERF_MESH,
} from "../../core/perf";

// on-screen (CSS-px) HALF-widths of the ribbons below, so they read at a constant screen size regardless of
// zoom / framing — like the old SVG overlay's non-scaling strokes. Matches its stroke weights (curve 2.2,
// comb ~1.2 full; lines-plan bold 1.8, family 1, DWL 1.4 full).
const SHEER_HALF_PX = 1.1,
  COMB_HALF_PX = 0.6,
  LINES_BOLD_HALF_PX = 0.9,
  LINES_FAMILY_HALF_PX = 0.5,
  LINES_DWL_HALF_PX = 0.7,
  KNOT_HALF_PX = 0.7, // half the knot rings' rim stroke…
  KNOT_RADIUS_PX = 2.6, // …and their screen radius — the 2D editors' fixed-size knot dots, read into 3D
  LONGS_HALF_PX = 0.9, // the knot longitudinals — grey, so the bold weight, not the thin family one
  LINES_BLACK = "#11181f";
// The selected-station guide is sized in WORLD units instead: it marks a locus ON the hull rather than
// annotating it, so it grows as you zoom into the surface it lies on. Both it and the biases below are
// fractions of the hull's own length — model coordinates are absolute, so a fixed world number would read
// differently on a 5 m hull and a 500 mm one.
const GUIDE_HALF_F = 0.00125,
  GUIDE_BIAS_F = 0.006,
  CURV_BIAS_F = 0.009, // the curvature overlay's nudge clear of the surface it rides
  // the knot markers' nudge — past the station lines' GUIDE_BIAS_F, so the markers sit on top of the very
  // curves and longitudinals they mark instead of flickering through them
  KNOT_BIAS_F = 0.0075;

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
  stations: StationLines3 | null; // buildStationLines' output — the authored stations' construction lines
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
  stations,
}: CameraFacingCurvesProps) {
  const invalidate = useThree((s) => s.invalidate);
  // shared by reference with every material below, so one write per frame updates all of them
  const cam = useMemo(() => createSharedRibbonCamera(), []);
  useFrame(({ camera, size }) => updateRibbonCamera(cam, camera, size.height));

  // The two builds below are the last of the 3D view's own work, and they run in this child rather than in
  // <Scene>, i.e. after the pass it opened has already closed. They report into it all the same: a pass
  // opened a second time in the same frame adds to it (core/perf), so "3D view" reads as the whole rebuild
  // — the geometry AND the overlay it is drawn under — rather than as whatever part of it Scene happened to
  // hold. Timed with perfMark / perfAdd rather than perfStep because what is being timed is the body of a
  // useMemo, which there is no closure to wrap.
  const jobs = useMemo(() => {
    perfBegin(PERF_MESH);
    const t0 = perfMark();
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
    // The authored stations' construction lines (the knot markers are not ribbons — they are built into
    // ring-marker meshes below). They coincide with the swept sheet only analytically — not with its
    // tessellation, which the polygon offset serves — so each takes the guide's own bias clear of the
    // surface. Curves in the station's 2D accent colour; the longitudinals as one job in the 2D overlay's
    // construction grey.
    if (stations) {
      const bias = GUIDE_BIAS_F * len;
      for (const c of stations.curves)
        out.push({
          polylines: [c.line],
          color: new THREE.Color(stationColor(c.si)),
          halfWidthPx: SHEER_HALF_PX,
          bias,
        });
      if (stations.longs.length)
        out.push({
          polylines: stations.longs,
          color: new THREE.Color(KNOT_LONG),
          halfWidthPx: LONGS_HALF_PX,
          bias,
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
    perfAdd(PERF_MESH, "Overlay ribbons", perfMark() - t0, out.length, "jobs");
    perfEnd(PERF_MESH);
    return out;
  }, [model, guideIdx, curvature, lines, trims, stations]);

  const meshes = useMemo(() => {
    perfBegin(PERF_MESH);
    const t0 = perfMark();
    const out = jobs.map((job) => {
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
    });
    // The knot markers: camera-facing dots at a constant screen radius — the 2D editors' fixed-size knot
    // dots, read into 3D: a white fill under a rim in the station's accent colour. Their own material rather
    // than a ribbon (a ribbon's width is screen-sized but its shape is world geometry, so a ring built of
    // one would turn edge-on with its plane and scale with the zoom). Two meshes per station over ONE
    // annulus geometry: the fill's material collapses the inner rim to the centre (radius = half-width =
    // R/2), which turns the same annulus into a disc — the SVG dot's own construction, the fill reaching the
    // stroke's centreline and the rim straddling it. The rim is pushed after the fill, so it wins the depth
    // test's ties where they overlap.
    if (stations) {
      const bias = KNOT_BIAS_F * Math.max(loa(model), 1e-6);
      for (const k of stations.knots) {
        if (!k.centers.length) continue;
        const a = ringAttributes(k.centers),
          geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(a.position, 3),
        );
        geometry.setAttribute("aAngle", new THREE.BufferAttribute(a.angle, 1));
        geometry.setAttribute("aSide", new THREE.BufferAttribute(a.side, 1));
        geometry.setIndex(new THREE.BufferAttribute(a.index, 1));
        out.push({
          geometry,
          material: createRingMaterial(cam, {
            color: new THREE.Color("#fff"),
            radiusPx: KNOT_RADIUS_PX / 2,
            halfWidthPx: KNOT_RADIUS_PX / 2,
            bias,
          }),
        });
        out.push({
          geometry,
          material: createRingMaterial(cam, {
            color: new THREE.Color(stationColor(k.si)),
            radiusPx: KNOT_RADIUS_PX,
            halfWidthPx: KNOT_HALF_PX,
            bias,
          }),
        });
      }
    }
    perfAdd(
      PERF_MESH,
      "Ribbon buffers",
      perfMark() - t0,
      out.reduce(
        (n, m) => n + (m.geometry.getAttribute("position")?.count ?? 0),
        0,
      ),
      "verts",
    );
    perfEnd(PERF_MESH);
    return out;
  }, [jobs, cam, stations, model]);

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
