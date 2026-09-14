// Fixed measurements of the confirmed envelope and explicitly selected physical shell.
// No stations, sheer or deck datum are inferred from a bounding box or a surface name.
import { V, type Vec3 } from "../../core/math";
import type { HullMetrics } from "../hullMetrics";
import { meshImmersion } from "./immersion";
import type { PreparedMesh } from "./prepare";
import type { MeshAnalysisSetup } from "./setup";
import { bounds } from "./spatial";

export function weightPoint(setup: MeshAnalysisSetup, p: Vec3): Vec3 {
  const c = Math.cos(setup.fixedTrim),
    s = Math.sin(setup.fixedTrim);
  return [p[0] * c - p[2] * s, p[1], p[0] * s + p[2] * c - setup.keelZ];
}

export function meshMeasurements(
  mesh: PreparedMesh,
  setup: MeshAnalysisSetup,
): HullMetrics {
  const unavailable: Record<string, string> = {};
  const missing = (names: string[], reason: string) => {
    for (const name of names) unavailable[name] = reason;
    return NaN;
  };
  const extent = bounds(mesh.vertices.map((p) => weightPoint(setup, p)));
  const selected = new Set(setup.shellScope?.surfaces ?? []);
  const present = new Set(
    mesh.sources.flatMap((s) => (s.kind === "physical" ? [s.surface] : [])),
  );
  const shellReason = !setup.shellScope
    ? "Confirm the physical shell surface scope; total STL area is not Camber skin area"
    : [...selected].some((s) => !present.has(s))
      ? "The confirmed shell scope names a surface absent from this mesh"
      : null;
  let area = 0;
  const first: Vec3 = [0, 0, 0];
  if (!shellReason)
    mesh.faces.forEach((face, i) => {
      const source = mesh.sources[i];
      if (source.kind !== "physical" || !selected.has(source.surface)) return;
      const [a, b, c] = face.map((j) => weightPoint(setup, mesh.vertices[j]));
      const da = Math.hypot(...V.cross(V.sub(b, a), V.sub(c, a))) / 2;
      area += da;
      for (let j = 0; j < 3; j++) first[j] += (da * (a[j] + b[j] + c[j])) / 3;
    });
  if (shellReason || !area)
    missing(
      ["SHELL_AREA", "SHELL_LCG", "SHELL_VCG", "SHELL_CG", "WSA"],
      shellReason ?? "Selected shell has no area",
    );
  const c = Math.cos(setup.fixedTrim),
    s = Math.sin(setup.fixedTrim);
  const waterplane = (z: number) => ({
    origin: V.scale([s, 0, c], z),
    u: [c, 0, -s] as Vec3,
    v: [0, 1, 0] as Vec3,
  });
  let reference = null;
  if (
    setup.referenceWaterlineZ !== undefined &&
    (mesh.report.closed || mesh.report.openHydrostatics)
  )
    try {
      reference = meshImmersion(
        mesh,
        waterplane(setup.referenceWaterlineZ),
        true,
      );
    } catch {
      // Open-rim hydrostatics intentionally end when the reference waterplane
      // reaches any sheer vertex. Surface-only measurements remain valid.
    }
  const wp =
    reference?.waterplane?.status === "available"
      ? reference.waterplane.value
      : null;
  const validVolume = !!reference && reference.vol > mesh.report.tolerance ** 3;
  const cb =
    validVolume && reference!.centroid
      ? weightPoint(setup, reference!.centroid)
      : null;
  const aw =
    wp?.measurements.area.status === "available"
      ? wp.measurements.area.value
      : NaN;
  const moments =
    wp?.measurements.moments.status === "available"
      ? wp.measurements.moments.value
      : null;
  const wpPoints = wp?.regions.flatMap((r) => r.outer.points) ?? [];
  const waterBounds = wpPoints.length
    ? bounds(wpPoints.map((p) => [p[0], p[1], 0]))
    : null;
  const lwl = waterBounds ? waterBounds.max[0] - waterBounds.min[0] : NaN;
  const bwl = waterBounds ? waterBounds.max[1] - waterBounds.min[1] : NaN;
  const draft = validVolume
    ? Math.max(0, setup.referenceWaterlineZ! - (extent.min[2] + setup.keelZ))
    : NaN;
  const bmt = validVolume && moments ? moments.uu / reference!.vol : NaN;
  const full = mesh.report.closed
    ? meshImmersion(mesh, waterplane(extent.max[2] + setup.keelZ + 1)).vol
    : missing(
        ["HULL_VOL"],
        mesh.report.openHydrostatics
          ? "An open-rim hull has no sealed full volume"
          : "A confirmed closed buoyancy envelope is required",
      );
  missing(
    ["WATERLINE"],
    "HULL.WATERLINE is legacy Camber depth below the deck datum; STL setup specifies upright waterline height instead",
  );
  missing(
    ["AM", "AMAX", "CP", "CM", "DEADRISE", "HALF_ENTRANCE"],
    "This authored-station hull measurement has no defined STL equivalent",
  );
  const metrics: HullMetrics = {
    unavailable,
    provenance: {
      method:
        mesh.report.closed || mesh.report.openHydrostatics
          ? "validated triangle envelope; exact triangle surface moments"
          : "physical surface moments; buoyancy envelope not available",
      shellScope: setup.shellScope?.label ?? "Unconfirmed",
      positions:
        "Upright Cartesian weight frame; x from the confirmed origin, z above the KG datum",
      envelope:
        (mesh.report.openHydrostatics
          ? "Validated open sheer; hydrostatics stop at first rim immersion; no cap faces"
          : mesh.sources.some(
                (s) => s.kind === "synthetic" && s.purpose !== "repair",
              )
            ? "Synthetic sheer closure; hypothetical after edge immersion"
            : mesh.report.closed
              ? "Closed physical envelope; sheer and flooding unknown"
              : "Physical surface only; buoyancy envelope not available") +
        (mesh.report.repair
          ? "; bounded repairs applied; synthetic patches excluded from shell weight"
          : ""),
    },
    loa: extent.max[0] - extent.min[0],
    lwl,
    bwl,
    draft,
    waterline: NaN,
    deckRakeDeg: (setup.fixedTrim * 180) / Math.PI,
    dispVol: validVolume ? reference!.vol : NaN,
    wsa:
      !shellReason && area && reference
        ? [...selected].reduce(
            (a, name) => a + (reference.wettedBySurface[name] ?? 0),
            0,
          )
        : NaN,
    waterplaneArea: aw,
    midshipArea: NaN,
    maxSectionArea: NaN,
    lcb: cb?.[0] ?? NaN,
    lcf:
      wp?.measurements.centroid.status === "available"
        ? wp.measurements.centroid.value[0]
        : NaN,
    kb: cb?.[2] ?? NaN,
    bmt,
    kmt: cb ? cb[2] + bmt : NaN,
    cb: validVolume ? reference!.vol / (lwl * bwl * draft) : NaN,
    cp: NaN,
    cm: NaN,
    cw: aw / (lwl * bwl),
    deadrise: NaN,
    halfEntrance: NaN,
    shellArea: !shellReason && area ? area : NaN,
    hullVol: full,
    shellLcg: !shellReason && area ? first[0] / area : NaN,
    shellTcg: !shellReason && area ? first[1] / area : NaN,
    shellVcg: !shellReason && area ? first[2] / area : NaN,
  };
  // Every missing catalogue leaf has a local reason, even at an unsupported waterplane.
  const referenceReason =
    reference?.waterplane?.status === "unavailable"
      ? reference.waterplane.reason
      : "No supported reference-waterline measurement at this height";
  for (const [name, value] of [
    ["LWL", lwl],
    ["BWL", bwl],
    ["DRAFT", draft],
    ["DISP_VOL", metrics.dispVol],
    ["WSA", metrics.wsa],
    ["AW", aw],
    ["LCB", metrics.lcb],
    ["LCF", metrics.lcf],
    ["KB", metrics.kb],
    ["BMT", bmt],
    ["KMT", metrics.kmt],
    ["CB", metrics.cb],
    ["CW", metrics.cw],
  ] as const)
    if (!Number.isFinite(value) && !unavailable[name])
      unavailable[name] = referenceReason;
  return metrics;
}
