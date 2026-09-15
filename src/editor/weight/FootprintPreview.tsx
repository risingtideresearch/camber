import { useState, type PointerEvent, type ReactNode } from "react";
import type { FootprintMeasurement } from "../../core/sheet/footprints";
import type { RawSliceMeasurement } from "../../core/sheet/slices";
import { geometryValue } from "../../core/sheet/sectionMeasures";
import type { Vec3 } from "../../core/math";
import { sig } from "./weightFormat";
import {
  nearestSample,
  samplePath,
  type FootprintView,
  type Projection,
} from "./footprintPlots";

export function FootprintPreview({
  measurement,
  equivalentCount,
}: {
  readonly measurement: FootprintMeasurement | undefined;
  readonly equivalentCount: ReactNode;
}) {
  if (!measurement) return null;
  return (
    <MeasurePreview
      samples={measurement.samples}
      equivalentCount={equivalentCount}
      footprint
    />
  );
}

export function CutPreview({
  measurement,
}: {
  readonly measurement: RawSliceMeasurement | undefined;
}) {
  if (!measurement) return null;
  return <MeasurePreview samples={[measurement]} footprint={false} />;
}

/** The same disclosure glyph and gutter as the field and explorer, with native
 * button keyboard behavior instead of browser-dependent details markers. */
function Disclosure({
  label,
  initiallyOpen = false,
  children,
}: {
  label: string;
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <section className="wpreviewdisclosure">
      <button
        type="button"
        className="wpreviewtoggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="wexptwist" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span>{label}</span>
      </button>
      {open && children}
    </section>
  );
}

const VIEWS: readonly { value: FootprintView; label: string; unit: string }[] =
  [
    { value: "area", label: "Area", unit: "m²" },
    { value: "closedLength", label: "Closed length", unit: "m" },
    { value: "openLength", label: "Open length", unit: "m" },
  ];

/** The profile provides context and selects a sample; the section keeps a stable
 * scale and shows that sample using the selected geometric measure. */
function MeasurePreview({
  samples,
  footprint,
  equivalentCount,
}: {
  samples: readonly RawSliceMeasurement[];
  footprint: boolean;
  equivalentCount?: ReactNode;
}) {
  const [view, setView] = useState<FootprintView>("area");
  const [picked, setPicked] = useState(Math.floor(samples.length / 2));
  const [hover, setHover] = useState<number | null>(null);
  const active = Math.min(hover ?? picked, Math.max(0, samples.length - 1));
  const sample = samples[active];
  const points = samples.flatMap((s) => s.sheetContours.flat());
  if (!points.length || !sample)
    return (
      <p className="whint">No contours at the preview section positions.</p>
    );
  const spec = VIEWS.find((v) => v.value === view)!;
  let centroid: Vec3 | null = null;
  try {
    centroid = ["x", "y", "z"].map((axis) =>
      geometryValue(sample.measures, `${view}Cg.${axis}`),
    ) as Vec3;
  } catch {
    /* A zero measure has no centroid. */
  }
  const fit = (axes: readonly [number, number]): Projection => {
    const lo = axes.map((axis) => Math.min(...points.map((p) => p[axis])));
    const hi = axes.map((axis) => Math.max(...points.map((p) => p[axis])));
    const scale = Math.min(
      268 / Math.max(hi[0] - lo[0], 0.01),
      144 / Math.max(hi[1] - lo[1], 0.01),
    );
    return (p) => [
      150 + (p[axes[0]] - (lo[0] + hi[0]) / 2) * scale,
      92 - (p[axes[1]] - (lo[1] + hi[1]) / 2) * scale,
    ];
  };
  const profile = fit([0, 2]),
    section = fit([1, 2]);
  const hit = (event: PointerEvent<SVGSVGElement>) => {
    // Inverse SVG transform accounts for aspect-ratio letterboxing and resizing.
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return null;
    const p = event.currentTarget.createSVGPoint();
    p.x = event.clientX;
    p.y = event.clientY;
    const local = p.matrixTransform(matrix.inverse());
    return nearestSample(samples, [local.x, local.y], profile, active);
  };
  const draw = (at: Projection, isProfile: boolean) => (
    <svg
      viewBox="0 0 300 184"
      role="img"
      aria-label={`${isProfile ? "Profile x/z" : "Section y/z"}, ${spec.label}, ${footprint ? `preview section ${active + 1} of ${samples.length}` : "cut"}`}
      className={`wpreviewplot ${view}${isProfile && footprint ? " interactive" : ""}`}
      onPointerMove={
        isProfile && footprint ? (event) => setHover(hit(event)) : undefined
      }
      onPointerLeave={isProfile ? () => setHover(null) : undefined}
      onPointerDown={
        isProfile && footprint
          ? (event) => {
              const index = hit(event);
              if (index !== null) setPicked(index);
            }
          : undefined
      }
    >
      {samples.map(
        (s, i) =>
          i !== active && (
            <path
              key={i}
              className="wpreviewcontext"
              d={samplePath(s, view, at)}
              fillRule="evenodd"
            />
          ),
      )}
      <path
        className="wpreviewactive"
        d={samplePath(sample, view, at)}
        fillRule="evenodd"
      />
      {centroid && (
        <g
          className="wpreviewcentroid"
          transform={`translate(${at(centroid).join(",")})`}
        >
          <circle r="4" />
          <path d="M-7,0H7 M0,-7V7" />
          <title>{`${footprint ? `Preview section ${active + 1}` : "Cut"} ${spec.label.toLowerCase()} centroid: ${centroid.map((v) => sig(v)).join(", ")} m`}</title>
        </g>
      )}
    </svg>
  );
  return (
    <div className="wfootprintpreview">
      <Disclosure
        label={footprint ? "footprint preview" : "Cut preview"}
        initiallyOpen={footprint}
      >
        {footprint && (
          <>
            <div className="wpreviewcount">
              <span>Equivalent count</span>
              {equivalentCount}
            </div>
            <p className="whint">
              {samples.length} preview sections · visualization only. The
              equivalent count scales estimated totals, not the number of
              preview sections.
            </p>
          </>
        )}
        <div className="wpreviewmodes" role="group" aria-label="Geometry view">
          {VIEWS.map((mode) => (
            <button
              type="button"
              key={mode.value}
              aria-pressed={view === mode.value}
              onClick={() => setView(mode.value)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="wfootprintprojections">
          <figure>
            {draw(profile, true)}
            <figcaption>Profile · x / z</figcaption>
          </figure>
          <figure>
            {draw(section, false)}
            <figcaption>
              Section · y / z ·{" "}
              {footprint ? `preview section ${active + 1}` : "cut"}
            </figcaption>
          </figure>
        </div>
        <div className="wpreviewsample">
          {footprint && (
            <label>
              Preview section {active + 1} / {samples.length}
              <input
                type="range"
                aria-label="Preview section"
                min={1}
                max={samples.length}
                value={active + 1}
                onChange={(event) => {
                  setHover(null);
                  setPicked(Number(event.target.value) - 1);
                }}
              />
            </label>
          )}
          <span>
            {spec.label}:{" "}
            <strong>
              {sig(sample.measures[view].amount)} {spec.unit}
            </strong>
          </span>
        </div>
        <p className="whint">
          {view === "area"
            ? "Filled section area"
            : view === "closedLength"
              ? "Complete boundary, including closure"
              : "Hull-skin intersections only — no closing edges"}
          . The marker is this {footprint ? "preview section’s" : "cut’s"}{" "}
          {spec.label.toLowerCase()} centroid.
        </p>
        {footprint && (
          <>
            <p className="whint">
              Hover the profile to inspect a preview section; click to keep it
              selected, or use the preview section slider. These sections
              illustrate the region, not individual member positions.
            </p>
            <Disclosure label="Preview section measurements">
              <table>
                <thead>
                  <tr>
                    <th>Preview section</th>
                    <th>Area · m²</th>
                    <th>Open length · m</th>
                    <th>Closed length · m</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.map((s, i) => (
                    <tr key={i} className={i === active ? "on" : ""}>
                      <td>
                        <button
                          type="button"
                          aria-label={`Select preview section ${i + 1}`}
                          aria-pressed={i === active}
                          onClick={() => {
                            setHover(null);
                            setPicked(i);
                          }}
                        >
                          {i + 1}
                        </button>
                      </td>
                      <td>{sig(s.area)}</td>
                      <td>{sig(s.openPerimeter)}</td>
                      <td>{sig(s.closedPerimeter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Disclosure>
          </>
        )}
      </Disclosure>
    </div>
  );
}
