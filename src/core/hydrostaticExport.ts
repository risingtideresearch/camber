import { unitScale } from "./json";
import { prepareImmersionSweep } from "./immersionSweep";
import { computeHullSampling, type HullSampling } from "./mesh";
import type { Model } from "./model";
import { heightSpan, stationGeometry } from "./sweep";
import type {
  HydrostaticPointM,
  HydrostaticSample,
  HydrostaticTable,
} from "./hydrostaticTable";

const RAD = Math.PI / 180;
export interface HydrostaticExportOptions {
  heelDeg?: readonly number[];
  trimDeg?: readonly number[];
  immersionSteps?: number;
  numSections?: number;
  girthSteps?: number;
  generatedAt?: string;
  modelId?: string;
}
export type HydrostaticExportProgress = (
  completedRows: number,
  totalRows: number,
) => void;

function angles(values: readonly number[], heel: boolean): number[] {
  if (
    !values.length ||
    values.some(
      (v) =>
        !Number.isFinite(v) ||
        (heel ? v < -180 || v > 180 : v <= -90 || v >= 90),
    )
  )
    throw new Error(
      `Invalid ${heel ? "heel" : "trim"} coordinates for hydrostatic-table v1`,
    );
  return [...new Set(values)].sort((a, b) => a - b);
}
function resolution(
  value: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

// All positions retain the authored hull origin. Only units and the sign of y
// change. K is fixed at x=y=0 and the lowest sampled body-z, never zBWorld or a
// keel height rotated by the design trim.
export function buildHydrostaticTable(
  model: Model,
  options: HydrostaticExportOptions = {},
  progress?: HydrostaticExportProgress,
  suppliedSampling?: HullSampling,
): HydrostaticTable {
  const authoredTrimDeg = model.deckTrim / RAD;
  if (!Number.isFinite(authoredTrimDeg) || Math.abs(authoredTrimDeg) >= 90)
    throw new Error("Design trim must lie strictly between −90° and 90°");
  const heels = angles(
    options.heelDeg ?? Array.from({ length: 73 }, (_, i) => -180 + i * 5),
    true,
  );
  const trims = angles(options.trimDeg ?? [-5, 0, 5, authoredTrimDeg], false);
  const steps = resolution(
    options.immersionSteps ?? 64,
    2,
    512,
    "Immersion steps",
  );
  const sections = resolution(options.numSections ?? 240, 8, 1000, "Sections");
  const girth = resolution(options.girthSteps ?? 10, 2, 64, "Girth steps");
  if (heels.length * trims.length * (steps + 1) > 200000)
    throw new Error(
      "Export grid exceeds 200,000 samples; reduce the requested resolution",
    );
  const sampling =
    suppliedSampling ?? computeHullSampling(model, sections, girth);
  const actualSections = sampling.uParams.length - 1;
  const actualGirth = sampling.R;
  const geom = stationGeometry(model, sampling);
  if (!geom)
    throw new Error(
      "Hull does not provide enough closed sections to export hydrostatics",
    );
  const metres = unitScale(model.unit, "m");
  const point = (x: number, y: number, z: number): HydrostaticPointM => [
    x * metres,
    y === 0 ? 0 : -y * metres,
    z * metres,
  ];
  let bodyKeelZ = Infinity;
  for (const column of geom.cols)
    for (const vertex of column.poly)
      bodyKeelZ = Math.min(bodyKeelZ, vertex[1]);
  const referenceH = -model.waterline;
  const rows: HydrostaticTable["table"]["rows"] = [];
  let referenceState: HydrostaticTable["referenceState"];
  progress?.(0, heels.length * trims.length);
  for (const trimDeg of trims) {
    // Section polygons are body-fixed and independent of attitude; replacing the
    // two rotation coefficients avoids resampling or rotating the stored hull.
    const trim = trimDeg * RAD;
    const attitude = {
      ...geom,
      cosTrim: Math.cos(trim),
      sinTrim: Math.sin(trim),
    };
    const sweepRow = prepareImmersionSweep(attitude);
    for (const heelDeg of heels) {
      const heel = heelDeg * RAD;
      const [bottom, top] = heightSpan(attitude, heel);
      const span = top - bottom;
      if (!Number.isFinite(span) || !(span > 0))
        throw new Error("Invalid hull height span");
      // Pad the extrema to guarantee genuinely dry/full endpoints rather than
      // degenerate polygon cuts subject to cancellation at a tangent plane.
      const lo = bottom - span * 1e-8,
        hi = top + span * 1e-8;
      const offsets = Array.from(
        { length: steps + 1 },
        (_, i) => lo + ((hi - lo) * i) / steps,
      );
      if (
        heelDeg === 0 &&
        trimDeg === authoredTrimDeg &&
        referenceH >= lo &&
        referenceH <= hi
      ) {
        offsets.push(referenceH);
        referenceState = {
          heelDeg,
          trimDeg,
          waterplaneOffsetM: referenceH * metres,
        };
      }
      const sortedOffsets = [...new Set(offsets)].sort((a, b) => a - b);
      const cuts = sweepRow(heel, sortedOffsets);
      const samples: HydrostaticSample[] = [];
      for (const [i, h] of sortedOffsets.entries()) {
        const c = cuts[i];
        if (
          !Number.isFinite(c.vol) ||
          c.vol < 0 ||
          (samples.length &&
            c.vol * metres ** 3 < samples[samples.length - 1].volumeM3)
        )
          throw new Error(
            `Invalid or decreasing volume at heel ${heelDeg}°, trim ${trimDeg}°; check hull geometry`,
          );
        const sample: HydrostaticSample = {
          waterplaneOffsetM: h * metres,
          volumeM3: c.vol * metres ** 3,
          buoyancyCenterM: c.vol > 0 ? point(c.xB, c.yB, c.zB) : null,
        };
        // The current sweep's waterplane is not trustworthy for cap-loaded cuts.
        // Omit it (unknown), not null (physically no free waterplane). xy is not
        // computed by the sweep and must not be invented as zero.
        if (c.vol > 0 && !c.deckDown && c.wp && c.wp.it >= 0 && c.wp.il >= 0) {
          // Sweep centroids are world horizontal X and starboard-positive Y.
          // Invert R = Rx(heel) Ry(-trim) to recover a hull-fixed point on n·r=h.
          const X = c.wp.cx,
            Y = -c.wp.cy;
          const y = Math.cos(heel) * Y + Math.sin(heel) * h;
          const zTrim = -Math.sin(heel) * Y + Math.cos(heel) * h;
          sample.waterplane = {
            areaM2: c.wp.area * metres ** 2,
            centroidM: [
              (Math.cos(trim) * X + Math.sin(trim) * zTrim) * metres,
              y * metres,
              (-Math.sin(trim) * X + Math.cos(trim) * zTrim) * metres,
            ],
            secondMomentsM4: {
              xx: c.wp.il * metres ** 4,
              yy: c.wp.it * metres ** 4,
            },
          };
        }
        if (
          sample.buoyancyCenterM?.some((v) => !Number.isFinite(v)) ||
          !Number.isFinite(sample.volumeM3) ||
          !Number.isFinite(sample.waterplaneOffsetM) ||
          (sample.waterplane &&
            [
              sample.waterplane.areaM2,
              ...sample.waterplane.centroidM,
              ...Object.values(sample.waterplane.secondMomentsM4),
            ].some((v) => !Number.isFinite(v)))
        )
          throw new Error(
            "Non-finite hydrostatic output; check hull geometry and units",
          );
        samples.push(sample);
      }
      rows.push({ heelDeg, trimDeg, samples });
      progress?.(rows.length, heels.length * trims.length);
    }
  }
  const sheerPoints = sampling.hullSheer.flatMap((s) => [
    point(...s.pos),
    point(s.pos[0], -s.pos[1], s.pos[2]),
  ]);
  return {
    format: "hydrostatic-table",
    version: 1,
    name: model.name.trim() || "Untitled hull",
    frame: {
      axes: "x-forward-y-port-z-up",
      originDescription:
        "Authored hull origin: x forward from the aft sheer datum, y on centreline, z at the authored deck datum. Coordinates are not rotated by design trim. K is [0,0,lowest sampled body-z].",
      knReferenceM: [0, 0, bodyKeelZ * metres],
    },
    body: {
      buoyancyEnvelope: "closed-watertight",
      description:
        "Mirrored trimmed hull skin integrated as closed station polygons, with idealized caps from the sheer and transom-ended sections to the centreline and sweep-end closures. Includes no appendages, openings or flooding. The caps are buoyancy assumptions, not an assertion that the authored open hull is watertight.",
    },
    table: { interpolation: "linear", rows },
    ...(referenceState ? { referenceState } : {}),
    ...(sheerPoints.length
      ? {
          immersionMarkers: [
            {
              id: "sheer",
              label: "Sampled port and starboard sheer",
              kind: "deck-edge" as const,
              pointsM: sheerPoints,
            },
          ],
        }
      : {}),
    source: {
      tool: "Camber",
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
      method: `Incremental immersion edge-event sweep of closed station-polygon boundary moments with fanning Jacobian; trapezoidal longitudinal integration; ${actualSections} longitudinal intervals, ${actualGirth} girth substeps per station segment, ${steps} immersion intervals per attitude.`,
      notes: [
        "Volume and centroids use an incremental immersion sweep of closed polygon boundary moments at each attitude; no CrossCurves or loading cache is serialized.",
        "Lengths converted to metres and starboard-positive y reversed to port-positive y. Rotation: Rx(heel) · Ry(-trim).",
        "Waterplane properties omitted for cap-loaded cuts or unmeasurable cuts. The mixed second moment xy is unknown and omitted. Wetted area is omitted because the sweep measures only the skin, not all exterior closure faces.",
        "No convergence assessment has been performed for this export. Refine both hull and table resolution before relying on peaks, stiffness or threshold criteria.",
      ],
    },
    notes: [
      "This is the static response of an idealized closed envelope, including beyond deck-edge immersion; it does not model flooding.",
      "No downflooding markers are supplied. Opening immersion limits are unknown, not absent.",
      "Sheer markers are sampled points, not an exact continuous boundary; referenceState is only a design-waterplane hint.",
      "No loading CG, water density, free-surface correction or stability verdict is included.",
    ],
  };
}

export function buildHydrostaticTableJson(
  model: Model,
  options: HydrostaticExportOptions = {},
): string {
  return JSON.stringify(buildHydrostaticTable(model, options), null, 2);
}
