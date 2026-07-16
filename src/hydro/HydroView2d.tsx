import { useMemo, useRef, useState } from "react";
import { type Vec3 } from "../core/math";
import { type Mesh, sliceMesh, boundaryEdges } from "../core/mesh";
import { type Flotation, type WeightItem } from "../core/weights";
import "./HydroView2d.css";

// Two 2D drawings of the hull with its computed waterline, from EXACT planar mesh geometry (no binning):
//   • Section — a transverse slice at mid-length (y–z), waterline horizontal.
//   • Profile — a near-centerplane slice (y = ε) for the keel/stem/rocker/transom plus the mesh's open boundary
//     edges (the sheer) for the top; the whole thing is drawn ROTATED into the floated frame so the waterline
//     is a level line (the boat tilts for trim, the water stays flat — the usual way lines are read).
// Placed weights are draggable markers: on the profile a drag sets an item's (x, z); on the section its (y, z).
// The drag is decoupled from the (heavier) flotation solve — the marker follows the cursor from local state
// every frame, while the solve that updates the waterline/attitude is throttled to once per animation frame.
interface HydroView2dProps {
  mesh: Mesh | null;
  flotation: Flotation | null;
  items: WeightItem[];
  onMoveItem: (
    id: string,
    patch: Partial<Pick<WeightItem, "x" | "y" | "z">>,
  ) => void;
}

// maps between body coords (uc = the panel's horizontal body axis, z = depth) and DISPLAY coords (u, v)
interface Proj {
  toXY: (uc: number, z: number) => { u: number; v: number };
  toBody: (u: number, v: number) => { uc: number; z: number };
  wlV: number | null; // display v of the (horizontal) waterline, or null if not floating
}

interface Fit {
  W: number;
  H: number;
  X: (u: number) => number;
  Y: (v: number) => number;
  U: (px: number) => number;
  V: (py: number) => number;
}

function fitBox(
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
  maxPx = 900,
  pad = 26,
): Fit {
  const du = uMax - uMin || 1,
    dv = vMax - vMin || 1,
    s = maxPx / Math.max(du, dv),
    W = du * s + 2 * pad,
    H = dv * s + 2 * pad;
  return {
    W,
    H,
    X: (u) => pad + (u - uMin) * s,
    Y: (v) => H - pad - (v - vMin) * s,
    U: (px) => uMin + (px - pad) / s,
    V: (py) => vMin + (H - pad - py) / s,
  };
}

function bounds3(m: Mesh) {
  const p = m.positions;
  let xMin = Infinity,
    xMax = -Infinity,
    yMin = Infinity,
    yMax = -Infinity,
    zMin = Infinity,
    zMax = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < xMin) xMin = p[i];
    if (p[i] > xMax) xMax = p[i];
    if (p[i + 1] < yMin) yMin = p[i + 1];
    if (p[i + 1] > yMax) yMax = p[i + 1];
    if (p[i + 2] < zMin) zMin = p[i + 2];
    if (p[i + 2] > zMax) zMax = p[i + 2];
  }
  return { xMin, xMax, yMin, yMax, zMin, zMax };
}

const markerR = (mass: number): number =>
  Math.max(6, Math.min(18, 4 + Math.cbrt(Math.max(0, mass))));

// display-space bounds over the projected HULL segments (+ the waterline v). Deliberately excludes the item
// markers so dragging a weight never rescales the view (the zoom stays put). A module-level helper so its
// running-min/max mutation isn't in React render scope.
function projBounds(
  pj: readonly (readonly [number, number, number, number])[],
  wlV: number | null,
): { uMin: number; uMax: number; vMin: number; vMax: number } {
  let uMin = Infinity,
    uMax = -Infinity,
    vMin = Infinity,
    vMax = -Infinity;
  const acc = (u: number, v: number): void => {
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  };
  for (const s of pj) {
    acc(s[0], s[1]);
    acc(s[2], s[3]);
  }
  if (wlV !== null) {
    vMin = Math.min(vMin, wlV);
    vMax = Math.max(vMax, wlV);
  }
  return { uMin, uMax, vMin, vMax };
}

function Panel({
  title,
  segs,
  uAxis,
  proj,
  centerlineZ,
  items,
  onDragMove,
  onDragEnd,
}: {
  title: string;
  segs: [Vec3, Vec3][];
  uAxis: 0 | 1; // which body coord is the panel's horizontal axis (0 = x profile, 1 = y section)
  proj: Proj;
  centerlineZ: [number, number] | null; // body z of the centerline top/bottom to draw (section only)
  items: WeightItem[];
  onDragMove: (
    id: string,
    patch: Partial<Pick<WeightItem, "x" | "y" | "z">>,
  ) => void;
  onDragEnd: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragId = useRef<string | null>(null);
  if (segs.length === 0)
    return <div className="hv-panel hv-empty">{title}: no geometry</div>;

  // project all geometry to display coords, tracking bounds (include waterline + markers)
  const pj = segs.map(([a, b]) => {
    const p1 = proj.toXY(a[uAxis], a[2]),
      p2 = proj.toXY(b[uAxis], b[2]);
    return [p1.u, p1.v, p2.u, p2.v] as const;
  });
  const mk = items.map((it) => {
    const q = proj.toXY(uAxis === 0 ? it.x : it.y, it.z);
    return { it, u: q.u, v: q.v };
  });
  const { uMin, uMax, vMin, vMax } = projBounds(pj, proj.wlV);
  const f = fitBox(uMin, uMax, vMin, vMax);
  const cl = centerlineZ
    ? [proj.toXY(0, centerlineZ[0]), proj.toXY(0, centerlineZ[1])]
    : null;
  const wlY = proj.wlV !== null ? f.Y(proj.wlV) : null;

  const toBody = (e: React.PointerEvent): { uc: number; z: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const q = pt.matrixTransform(ctm.inverse());
    return proj.toBody(f.U(q.x), f.V(q.y));
  };
  const down = (id: string) => (e: React.PointerEvent) => {
    dragId.current = id;
    (e.target as Element).setPointerCapture(e.pointerId);
    e.stopPropagation();
  };
  const move = (id: string) => (e: React.PointerEvent) => {
    if (dragId.current !== id) return;
    const d = toBody(e);
    if (d)
      onDragMove(id, uAxis === 0 ? { x: d.uc, z: d.z } : { y: d.uc, z: d.z });
  };
  const up = (e: React.PointerEvent) => {
    dragId.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
    onDragEnd();
  };

  return (
    <div className="hv-panel">
      <div className="hv-cap">{title}</div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${f.W.toFixed(0)} ${f.H.toFixed(0)}`}
        className="hv-svg"
      >
        {wlY !== null && (
          <rect
            className="hv-water"
            x={0}
            y={wlY}
            width={f.W}
            height={Math.max(0, f.H - wlY)}
          />
        )}
        {cl && (
          <line
            x1={f.X(cl[0].u)}
            y1={f.Y(cl[0].v)}
            x2={f.X(cl[1].u)}
            y2={f.Y(cl[1].v)}
            className="hv-cl"
          />
        )}
        {pj.map(([u1, v1, u2, v2], i) => (
          <line
            key={i}
            x1={f.X(u1)}
            y1={f.Y(v1)}
            x2={f.X(u2)}
            y2={f.Y(v2)}
            className="hv-sec"
          />
        ))}
        {wlY !== null && (
          <line x1={0} y1={wlY} x2={f.W} y2={wlY} className="hv-wl" />
        )}
        {mk.map(({ it, u, v }) => {
          const cx = f.X(u),
            cy = f.Y(v),
            r = markerR(it.mass);
          return (
            <g key={it.id} className="hv-mark">
              <circle
                cx={cx}
                cy={cy}
                r={r}
                onPointerDown={down(it.id)}
                onPointerMove={move(it.id)}
                onPointerUp={up}
              >
                <title>{`${it.name} — ${it.mass} kg`}</title>
              </circle>
              <text x={cx} y={cy - r - 3} className="hv-mark-label">
                {it.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function HydroView2d({
  mesh,
  flotation,
  items,
  onMoveItem,
}: HydroView2dProps) {
  const wet = flotation && flotation.ok ? flotation : null;

  // live drag override + rAF-throttled commit, so the marker tracks the cursor smoothly while the heavier
  // flotation solve (which the parent re-runs on commit) fires at most once per frame
  const [dragItem, setDragItem] = useState<WeightItem | null>(null);
  const raf = useRef<number | null>(null);
  const pending = useRef<{ id: string; patch: Partial<WeightItem> } | null>(
    null,
  );
  const commit = (): void => {
    raf.current = null;
    const p = pending.current;
    if (p) {
      onMoveItem(p.id, p.patch);
      pending.current = null;
    }
  };
  const onDragMove = (
    id: string,
    patch: Partial<Pick<WeightItem, "x" | "y" | "z">>,
  ): void => {
    setDragItem((d) => ({
      ...(d && d.id === id ? d : items.find((i) => i.id === id))!,
      ...patch,
    }));
    pending.current = { id, patch };
    if (raf.current === null) raf.current = requestAnimationFrame(commit);
  };
  const onDragEnd = (): void => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    if (pending.current) {
      onMoveItem(pending.current.id, pending.current.patch);
      pending.current = null;
    }
    setDragItem(null);
  };
  const effItems = dragItem
    ? items.map((it) => (it.id === dragItem.id ? dragItem : it))
    : items;

  const geom = useMemo(() => {
    if (!mesh || mesh.count === 0) return null;
    const b = bounds3(mesh),
      eps = Math.max(1e-4, 0.01 * (b.yMax - b.yMin)),
      xMid = (b.xMin + b.xMax) / 2;
    return {
      b,
      profile: [...sliceMesh(mesh, 1, eps), ...boundaryEdges(mesh)],
      section: sliceMesh(mesh, 0, xMid),
    };
  }, [mesh]);

  if (!geom)
    return (
      <div className="hydroviews">
        <div className="hv-panel hv-empty">No hull loaded</div>
        <div className="hv-panel hv-empty">No hull loaded</div>
      </div>
    );

  // profile projection: rotate body (x, z) into the floated frame (trim about y); waterline level at v = 0
  const ct = wet ? Math.cos(wet.attitude.trim) : 1,
    st = wet ? Math.sin(wet.attitude.trim) : 0,
    sink = wet ? wet.attitude.sink : 0;
  const profileProj: Proj = {
    toXY: (x, z) => ({ u: x * ct + z * st, v: -x * st + z * ct - sink }),
    toBody: (u, v) => ({
      uc: u * ct - (v + sink) * st,
      z: u * st + (v + sink) * ct,
    }),
    wlV: wet ? 0 : null,
  };
  // section projection: rotate body (y, z) into the floated frame — heel by the static list so an off-center
  // weight visibly heels the hull, with trim folded into the station depth (z1). Waterline level at v = 0.
  const xMid = (geom.b.xMin + geom.b.xMax) / 2,
    phi = wet ? (wet.heelDeg * Math.PI) / 180 : 0,
    cP = Math.cos(phi),
    sP = Math.sin(phi);
  const z1Of = (z: number): number => -xMid * st + z * ct;
  const sectionProj: Proj = {
    toXY: (y, z) => {
      const z1 = z1Of(z);
      return { u: y * cP - z1 * sP, v: y * sP + z1 * cP - sink };
    },
    toBody: (u, v) => {
      const y = u * cP + (v + sink) * sP,
        z1 = -u * sP + (v + sink) * cP;
      return { uc: y, z: (z1 + xMid * st) / (ct || 1) };
    },
    wlV: wet ? 0 : null,
  };

  return (
    <div className="hydroviews">
      <Panel
        title={
          wet
            ? `Profile · draft ${wet.hydro.draft.toFixed(2)} m · trim ${wet.trimDeg.toFixed(1)}°`
            : "Profile"
        }
        segs={geom.profile}
        uAxis={0}
        proj={profileProj}
        centerlineZ={null}
        items={effItems}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      />
      <Panel
        title="Midship section · drag weights to place"
        segs={geom.section}
        uAxis={1}
        proj={sectionProj}
        centerlineZ={[geom.b.zMax, geom.b.zMin]}
        items={effItems}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      />
    </div>
  );
}
