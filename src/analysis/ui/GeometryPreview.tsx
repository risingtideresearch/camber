import {
  Component,
  lazy,
  Suspense,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DisplayGeometry } from "../projections";
import "./GeometryPreview.css";

const GeometryScene = lazy(() => import("./GeometryScene"));

class WebglBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
function hasWebgl() {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}
/** Visual body-frame coverage only. Never used as a measured section. Positive
 * winding makes one compound nonzero fill the union, even for overlapping faces. */
function Orthographic({
  geometry,
  proposal,
  repairs,
  view,
  waterline,
  keelZ,
  trim = 0,
  calibrated = true,
}: {
  geometry: DisplayGeometry;
  proposal?: DisplayGeometry;
  repairs?: DisplayGeometry;
  view: "Profile" | "Plan" | "Body";
  waterline?: number;
  keelZ?: number;
  trim?: number;
  calibrated?: boolean;
}) {
  const h = view === "Body" ? 1 : 0,
    v = view === "Plan" ? 1 : 2;
  const { min, max } = geometry.bounds;
  const width = Math.max(max[h] - min[h], 1e-6),
    height = Math.max(max[v] - min[v], 1e-6);
  const scale = 900 / Math.max(width, height),
    midX = (min[h] + max[h]) / 2,
    midY = (min[v] + max[v]) / 2;
  const x = (a: number) => 500 + (a - midX) * scale,
    y = (a: number) => 300 - (a - midY) * scale;
  // Fit the SVG aspect ratio to the geometry rather than stretching physical axes.
  const boxHeight = Math.max(260, height * scale + 110);
  const paths = useMemo(() => {
    const path = (g?: DisplayGeometry) => {
      if (!g) return "";
      const parts: string[] = [];
      for (let i = 0; i < g.positions.length; i += 9) {
        const p = [0, 3, 6].map((j) => [
          500 + (g.positions[i + j + h] - midX) * scale,
          300 - (g.positions[i + j + v] - midY) * scale,
        ]);
        const area =
          (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) -
          (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
        if (area < 0) p.reverse();
        parts.push(
          `M${p.map((a) => a.map((n) => n.toFixed(2)).join(",")).join("L")}Z`,
        );
      }
      return parts.join("");
    };
    return [path(geometry), path(proposal), path(repairs)];
  }, [geometry, proposal, repairs, h, v, midX, midY, scale]);
  const datum = (z: number, color: string, label: string) => {
    if (view !== "Profile" || Math.abs(Math.cos(trim)) < 1e-6) return null;
    const a = min[0] - width * 0.025,
      b = max[0] + width * 0.025;
    return (
      <g>
        <line
          x1={x(a)}
          x2={x(b)}
          y1={y((z - a * Math.sin(trim)) / Math.cos(trim))}
          y2={y((z - b * Math.sin(trim)) / Math.cos(trim))}
          stroke={color}
          strokeDasharray="7 5"
          strokeWidth="1.5"
        />
        <text
          x={x(a)}
          y={y((z - a * Math.sin(trim)) / Math.cos(trim)) - 8}
          fill={color}
        >
          {label}
        </text>
      </g>
    );
  };
  return (
    <svg
      className="geometry-ortho"
      role="img"
      aria-label={`${view} hull projection`}
      viewBox={`0 ${300 - boxHeight / 2} 1000 ${boxHeight}`}
    >
      <path d={paths[0]} fill="#80aaa5" fillRule="nonzero" />
      <path
        d={paths[1]}
        fill="#edb977"
        fillOpacity="0.12"
        fillRule="nonzero"
        stroke="#be7826"
        strokeDasharray="5 4"
        strokeWidth="1"
      />
      <path
        d={paths[2]}
        fill="#a067bb"
        fillRule="nonzero"
        stroke="#80569b"
        strokeWidth="1"
      />
      {waterline !== undefined &&
        datum(waterline, "#2586ad", "Reference waterline")}
      {keelZ !== undefined && datum(keelZ, "#7d6f9c", "VCG zero")}
      <text x="50" y={300 + boxHeight / 2 - 12} fill="#617577">
        {["x · forward", "y · transverse", "z · up"][h]} → ·{" "}
        {width.toPrecision(4)} {calibrated ? "m" : "source units"}
      </text>
    </svg>
  );
}
export interface GeometryPreviewProps {
  geometry: DisplayGeometry;
  proposal?: DisplayGeometry;
  repairs?: DisplayGeometry;
  waterline?: number;
  keelZ?: number;
  trim?: number;
  calibrated?: boolean;
}
/** Camera fitting is display-only: it never alters the imported physical setup. */
export function GeometryPreview(props: GeometryPreviewProps) {
  const [webgl] = useState(hasWebgl);
  const [view, setView] = useState<"3D" | "Profile" | "Plan" | "Body">(
    webgl ? "3D" : "Profile",
  );
  const { geometry, proposal, repairs } = props;
  const fallback = <Orthographic {...props} view="Profile" />;
  return (
    <div className="geometry-preview">
      <div
        className="geometry-views"
        role="group"
        aria-label="Hull preview view"
      >
        {(["3D", "Profile", "Plan", "Body"] as const).map((name) => (
          <button
            type="button"
            key={name}
            aria-pressed={view === name}
            disabled={name === "3D" && !webgl}
            onClick={() => setView(name)}
          >
            {name}
          </button>
        ))}
        <span>
          {view === "3D"
            ? "Drag to orbit · scroll to zoom"
            : "Projected surface · not a section"}
        </span>
      </div>
      <div className="geometry-stage">
        {view !== "3D" ? (
          <Orthographic {...props} view={view} />
        ) : (
          <WebglBoundary
            key={geometry.positions.length + JSON.stringify(geometry.bounds)}
            fallback={fallback}
          >
            <Suspense fallback={fallback}>
              <GeometryScene
                geometry={geometry}
                proposal={proposal}
                repairs={repairs}
              />
            </Suspense>
          </WebglBoundary>
        )}
      </div>
      <div className="geometry-caption">
        {props.calibrated === false
          ? "Uncalibrated source geometry · source units"
          : "Body frame · metres"}{" "}
        · x → forward, y transverse, z ↑ up.{" "}
        {proposal && (
          <strong>
            Amber wireframe: numerical volume closure, not a physical deck.{" "}
          </strong>
        )}
        {repairs && (
          <strong>Violet: changed triangles / repair patches. </strong>
        )}
        {!webgl && "WebGL unavailable; using 2D views."}
      </div>
    </div>
  );
}
