// Cross-check Camber's Michell implementation against risingtideresearch/michell's STL front-end.
//
// This is intentionally not part of `npm test`: it needs a separately-built reference binary. Run it as:
//
//   npx tsx test/michell-reference.ts /path/to/michell /tmp/camber-michell-comparison

// The script exports representative example hulls as STL, asks the reference solver to ray-cast and loft
// those meshes, then evaluates both solvers at exactly the same speeds. It writes the raw inputs, reference
// import diagnostics, CSV/JSON data, and a compact Markdown report to the output directory.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createModel, prepare } from "../src/core/model";
import { buildJson, loadJsonText, unitScale } from "../src/core/json";
import { buildStl } from "../src/core/stl";
import { computeHullSampling } from "../src/core/mesh";
import { buildTransomMesh } from "../src/core/hullGeometry";
import {
  DEFAULT_SEC_MAX,
  G,
  RHO_SALT,
  gaussLegendre,
  sampleCenterplane,
  sampleForBandwidth,
  thetaCutoff,
  thetaGrid,
  waveResistance,
  type Centerplane,
} from "../src/core/michell";

const referenceBin = resolve(
  process.argv[2] ?? "/tmp/camber-michell-ref-target/release/michell",
);
const outputDir = resolve(process.argv[3] ?? "/tmp/camber-michell-comparison");
const examples = [
  { source: "hull-default.json", name: "hull-default-closed" },
  {
    source: "round-bilge-cruiser.json",
    name: "round-bilge-cruiser-closed",
  },
  { source: "narrow-transom.json", name: "narrow-transom-closed" },
];
const froudes = Array.from({ length: 10 }, (_, i) => 0.15 + 0.05 * i);
const extendedSecMax = 23;

interface ReferencePoint {
  speed: number;
  froude: number;
  rw: number;
  wave_est_rel_error: number;
}

interface ReferenceResult {
  hulls: {
    length: number;
    draft: number;
    displaced_volume: number;
  }[];
  points: ReferencePoint[];
}

interface Row {
  case: string;
  targetFn: number;
  speed: number;
  referenceFn: number;
  camberRw: number;
  camberRwExtended: number;
  referenceRw: number;
  referenceRwDefaultFit: number;
  camberOnReferenceGeometryRw: number;
  camberVsReferencePct: number;
  camberExtendedVsReferencePct: number;
  referenceFitChangePct: number;
  sameGeometryDifferencePct: number;
  camberTailEstimatePct: number;
  camberNodes: number;
  camberExtendedNodes: number;
  camberConverged: boolean;
  referenceEstError: number;
}

interface HullSpline {
  degreeX: number;
  degreeZ: number;
  knotsX: number[];
  knotsZ: number[];
  control: number[][];
}

interface CaseResult {
  name: string;
  stl: string;
  waterlineFileMetres: number;
  camberGeometry: { length: number; draft: number; volume: number };
  referenceGeometry: { length: number; draft: number; volume: number };
  sameGeometryVolume: number;
  rows: Row[];
}

interface ControlRow {
  froude: number;
  camberRw: number;
  referenceRw: number;
  differencePct: number;
}

const runReference = (args: string[]): string =>
  execFileSync(referenceBin, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

const percent = (a: number, b: number): number =>
  (100 * (a - b)) / Math.max(Math.abs(b), 1e-300);

const fmt = (x: number, digits = 3): string =>
  Number.isFinite(x) ? x.toFixed(digits) : "—";

function parseHullSpline(text: string): HullSpline {
  let degreeX = -1,
    degreeZ = -1;
  let knotsX: number[] = [],
    knotsZ: number[] = [];
  const control: number[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const [key, ...values] = raw.trim().split(/\s+/);
    if (key === "degree-x") degreeX = Number(values[0]);
    else if (key === "degree-z") degreeZ = Number(values[0]);
    else if (key === "knots-x") knotsX = values.map(Number);
    else if (key === "knots-z") knotsZ = values.map(Number);
    else if (key === "row") control.push(values.map(Number));
  }
  const nx = knotsX.length - degreeX - 1,
    nz = knotsZ.length - degreeZ - 1;
  if (
    degreeX < 0 ||
    degreeZ < 0 ||
    control.length !== nx ||
    control.some((row) => row.length !== nz)
  ) {
    throw new Error("invalid michell-hull control net");
  }
  return { degreeX, degreeZ, knotsX, knotsZ, control };
}

function findSpan(knots: number[], degree: number, value: number): number {
  const n = knots.length - degree - 2;
  if (value >= knots[n + 1]) return n;
  let lo = degree,
    hi = n + 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (value < knots[mid]) hi = mid;
    else lo = mid;
  }
  return lo;
}

function basisFuns(
  knots: number[],
  degree: number,
  span: number,
  value: number,
): number[] {
  const basis = new Array<number>(degree + 1).fill(0),
    left = new Array<number>(degree + 1).fill(0),
    right = new Array<number>(degree + 1).fill(0);
  basis[0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = value - knots[span + 1 - j];
    right[j] = knots[span + j] - value;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const term = den !== 0 ? basis[r] / den : 0;
      basis[r] = saved + right[r + 1] * term;
      saved = left[j - r] * term;
    }
    basis[j] = saved;
  }
  return basis;
}

function splineValue(hull: HullSpline, x: number, z: number): number {
  const sx = findSpan(hull.knotsX, hull.degreeX, x),
    sz = findSpan(hull.knotsZ, hull.degreeZ, z),
    bx = basisFuns(hull.knotsX, hull.degreeX, sx, x),
    bz = basisFuns(hull.knotsZ, hull.degreeZ, sz, z);
  let y = 0;
  for (let i = 0; i <= hull.degreeX; i++)
    for (let j = 0; j <= hull.degreeZ; j++)
      y +=
        bx[i] *
        bz[j] *
        hull.control[sx - hull.degreeX + i][sz - hull.degreeZ + j];
  return y;
}

const distinct = (values: number[]): number[] =>
  values
    .slice()
    .sort((a, b) => a - b)
    .filter((v, i, a) => i === 0 || v - a[i - 1] > 1e-12);

// Turn the reference solver's exact fitted B-spline into the node-cloud representation accepted by Camber.
// The geometry is then identical; only the two formulations/numerical integrations differ. The x panels are
// speed-sized and the z panels are geometrically graded to resolve exp(-nu*sec^2*z) at the waterline.
function centerplaneFromSpline(
  hull: HullSpline,
  nu: number,
  secMax: number,
): Centerplane {
  const x0 = hull.knotsX[hull.degreeX],
    x1 = hull.knotsX[hull.knotsX.length - hull.degreeX - 1],
    z0 = hull.knotsZ[hull.degreeZ],
    z1 = hull.knotsZ[hull.knotsZ.length - hull.degreeZ - 1];
  const gx = gaussLegendre(3),
    gz = gaussLegendre(6),
    kMax = nu * secMax;
  const xNodes: [number, number][] = [];
  for (const [a, b] of distinct(hull.knotsX)
    .slice(0, -1)
    .map((a, i) => [a, distinct(hull.knotsX)[i + 1]] as [number, number])) {
    if (a < x0 - 1e-12 || b > x1 + 1e-12 || b <= a) continue;
    const cycles = (kMax * (b - a)) / (2 * Math.PI),
      panels = Math.max(1, Math.ceil((6 * cycles) / gx.x.length));
    for (let p = 0; p < panels; p++) {
      const pa = a + ((b - a) * p) / panels,
        pb = a + ((b - a) * (p + 1)) / panels,
        mid = (pa + pb) / 2,
        half = (pb - pa) / 2;
      for (let q = 0; q < gx.x.length; q++)
        xNodes.push([mid + half * gx.x[q], half * gx.w[q]]);
    }
  }
  const grade = Math.max(
    1,
    Math.ceil(Math.log2(Math.max(2, (z1 - z0) * nu * secMax * secMax))),
  );
  const zEdges = distinct([
    ...hull.knotsZ.filter((z) => z >= z0 && z <= z1),
    ...Array.from({ length: grade }, (_, i) => z0 + (z1 - z0) / 2 ** (i + 1)),
  ]);
  const zNodes: [number, number][] = [];
  for (let i = 0; i < zEdges.length - 1; i++) {
    const a = zEdges[i],
      b = zEdges[i + 1],
      mid = (a + b) / 2,
      half = (b - a) / 2;
    for (let q = 0; q < gz.x.length; q++)
      zNodes.push([mid + half * gz.x[q], half * gz.w[q]]);
  }

  const X: number[] = [],
    Z: number[] = [],
    W: number[] = [];
  let volumeHalf = 0,
    beamMax = 0;
  for (const [x, wx] of xNodes)
    for (const [z, wz] of zNodes) {
      const y = splineValue(hull, x, z),
        w = y * wx * wz;
      X.push(x);
      Z.push(-z);
      W.push(w);
      volumeHalf += w;
      beamMax = Math.max(beamMax, 2 * y);
    }
  return {
    X: Float64Array.from(X),
    Z: Float64Array.from(Z),
    W: Float64Array.from(W),
    volumeHalf,
    areaProjected: (x1 - x0) * (z1 - z0),
    draft: z1 - z0,
    xAft: x0,
    xFwd: x1,
    beamMax,
    wettedLength: x1 - x0,
    columns: xNodes.length,
    nodes: X.length,
    jacobianFlips: 0,
    sheerSubmerged: 0,
    fanMaxRatio: 0,
    fanSpread: 0,
    footU: null,
    spanFallbacks: 0,
  };
}

mkdirSync(outputDir, { recursive: true });

const cases: CaseResult[] = [];
const allRows: Row[] = [];

for (const example of examples) {
  const name = example.name;
  const document = readFileSync(resolve("examples", example.source), "utf8");
  const model = createModel();
  loadJsonText(model, document);
  // Turn the example into a double-ended hull. At the aft endpoint the sheer breadth is zero, and the trim
  // plane passes through that point at every depth, leaving no finite transom boundary or transom triangles.
  model.name = name;
  model.sheerPlan[0].y = 0;
  for (const point of model.transom) point.x = model.sheerPlan[0].x;
  prepare(model);
  const mesh = computeHullSampling(model, 80, 6),
    transom = buildTransomMesh(model, mesh);
  if (mesh.hullTransom.length !== 0 || transom.count !== 0) {
    throw new Error(`${name}: closure still produced a transom mesh`);
  }
  const scale = unitScale(model.unit, "m");
  const probe = sampleCenterplane(model, scale);
  if (!probe) throw new Error(`${name}: no wetted hull`);

  const stlPath = resolve(outputDir, `${name}.stl`);
  writeFileSync(stlPath, buildStl(model, name));
  writeFileSync(resolve(outputDir, `${name}.json`), buildJson(model) + "\n");

  // Camber's z axis points upward, while waterline is stored as positive immersion from z=0.
  const waterlineFileMetres = -model.waterline * scale;
  const commonImport = [
    stlPath,
    "--units",
    "mm",
    "--waterline",
    String(waterlineFileMetres),
  ];
  const fineImport = [
    ...commonImport,
    "--samples",
    "241x65",
    "--fit-control",
    "28x16",
  ];

  const info = runReference(["info", ...fineImport]);
  writeFileSync(resolve(outputDir, `${name}.reference-info.txt`), info);
  const fittedHullPath = resolve(outputDir, `${name}.reference.hull`);
  const loftInfo = runReference([
    "loft",
    ...fineImport,
    "--wetted",
    "-o",
    fittedHullPath,
  ]);
  writeFileSync(resolve(outputDir, `${name}.reference-loft.txt`), loftInfo);
  const fittedSpline = parseHullSpline(readFileSync(fittedHullPath, "utf8"));

  const speeds = froudes.map((fn) => fn * Math.sqrt(G * probe.wettedLength));
  const speedRange = `${speeds[0]}:${speeds[speeds.length - 1]}:${speeds[1] - speeds[0]}`;
  const physics = [
    "--speeds",
    speedRange,
    "--rho",
    String(RHO_SALT),
    "--gravity",
    String(G),
    "--rel-tol",
    "1e-7",
    "--json",
  ];
  const reference = JSON.parse(
    runReference(["resistance", ...fineImport, ...physics]),
  ) as ReferenceResult;
  const referenceDefaultFit = JSON.parse(
    runReference(["resistance", ...commonImport, ...physics]),
  ) as ReferenceResult;
  if (
    reference.points.length !== froudes.length ||
    referenceDefaultFit.points.length !== froudes.length
  ) {
    throw new Error(
      `${name}: reference solver returned an unexpected speed count`,
    );
  }

  const rows: Row[] = [];
  for (let i = 0; i < froudes.length; i++) {
    const targetFn = froudes[i];
    const speed = speeds[i];
    const nu = G / (speed * speed);

    const sampled = sampleForBandwidth(model, scale, nu, DEFAULT_SEC_MAX);
    const extended = sampleForBandwidth(
      model,
      scale,
      nu,
      extendedSecMax,
      undefined,
      1_000_000,
    );
    if (!sampled || !extended) throw new Error(`${name}: sampling failed`);

    const cond = { U: speed, rho: RHO_SALT };
    const camber = waveResistance(sampled.cp, cond);
    const extendedGrid = thetaGrid(
      nu,
      extended.cp.wettedLength,
      thetaCutoff(extendedSecMax),
    );
    const camberExtended = waveResistance(extended.cp, cond, extendedGrid);
    const fittedCp = centerplaneFromSpline(fittedSpline, nu, extendedSecMax);
    const camberOnReferenceGeometry = waveResistance(
      fittedCp,
      cond,
      thetaGrid(nu, fittedCp.wettedLength, thetaCutoff(extendedSecMax)),
    );
    const ref = reference.points[i];
    const refDefault = referenceDefaultFit.points[i];
    if (Math.abs(ref.speed - speed) > 1e-10) {
      throw new Error(
        `${name}: reference speed ${ref.speed} != requested ${speed}`,
      );
    }

    rows.push({
      case: name,
      targetFn,
      speed,
      referenceFn: ref.froude,
      camberRw: camber.rw,
      camberRwExtended: camberExtended.rw,
      referenceRw: ref.rw,
      referenceRwDefaultFit: refDefault.rw,
      camberOnReferenceGeometryRw: camberOnReferenceGeometry.rw,
      camberVsReferencePct: percent(camber.rw, ref.rw),
      camberExtendedVsReferencePct: percent(camberExtended.rw, ref.rw),
      referenceFitChangePct: percent(ref.rw, refDefault.rw),
      sameGeometryDifferencePct: percent(camberOnReferenceGeometry.rw, ref.rw),
      camberTailEstimatePct: 100 * camber.tail,
      camberNodes: sampled.cp.nodes,
      camberExtendedNodes: extended.cp.nodes,
      camberConverged: sampled.resolution.converged,
      referenceEstError: ref.wave_est_rel_error,
    });
  }

  const refHull = reference.hulls[0];
  const fittedGeometryCheck = centerplaneFromSpline(
    fittedSpline,
    G / (speeds[speeds.length - 1] * speeds[speeds.length - 1]),
    extendedSecMax,
  );
  const result: CaseResult = {
    name,
    stl: stlPath,
    waterlineFileMetres,
    camberGeometry: {
      length: probe.wettedLength,
      draft: probe.draft,
      volume: 2 * probe.volumeHalf,
    },
    referenceGeometry: {
      length: refHull.length,
      draft: refHull.draft,
      volume: refHull.displaced_volume,
    },
    sameGeometryVolume: 2 * fittedGeometryCheck.volumeHalf,
    rows,
  };
  cases.push(result);
  allRows.push(...rows);
}

// Sanity control for the same-geometry bridge: a closed Wigley B-spline has no endpoint/transom ambiguity,
// and both codes should agree. This does not come from a Camber STL; it validates the comparison machinery.
const wigleyPath = resolve(outputDir, "wigley-control.hull");
runReference([
  "wigley",
  "--length",
  "1",
  "--beam",
  "0.2",
  "--draft",
  "0.1",
  "-o",
  wigleyPath,
]);
const wigleySpline = parseHullSpline(readFileSync(wigleyPath, "utf8"));
const wigleySpeeds = froudes.map((fn) => fn * Math.sqrt(G));
const wigleySpeedRange = `${wigleySpeeds[0]}:${wigleySpeeds[wigleySpeeds.length - 1]}:${wigleySpeeds[1] - wigleySpeeds[0]}`;
const wigleyReference = JSON.parse(
  runReference([
    "resistance",
    wigleyPath,
    "--speeds",
    wigleySpeedRange,
    "--rho",
    String(RHO_SALT),
    "--gravity",
    String(G),
    "--rel-tol",
    "1e-7",
    "--json",
  ]),
) as ReferenceResult;
const controlRows: ControlRow[] = froudes.map((froude, i) => {
  const speed = wigleySpeeds[i],
    nu = G / (speed * speed),
    cp = centerplaneFromSpline(wigleySpline, nu, extendedSecMax),
    result = waveResistance(
      cp,
      { U: speed, rho: RHO_SALT },
      thetaGrid(nu, cp.wettedLength, thetaCutoff(extendedSecMax)),
    ),
    referenceRw = wigleyReference.points[i].rw;
  return {
    froude,
    camberRw: result.rw,
    referenceRw,
    differencePct: percent(result.rw, referenceRw),
  };
});

const csvHeader = [
  "case",
  "target_fn",
  "speed_m_s",
  "reference_fn",
  "camber_rw_sec8_n",
  "camber_rw_sec23_n",
  "reference_rw_n",
  "reference_rw_default_fit_n",
  "camber_on_reference_geometry_rw_n",
  "camber_sec8_vs_reference_pct",
  "camber_sec23_vs_reference_pct",
  "reference_fine_vs_default_fit_pct",
  "same_geometry_difference_pct",
  "camber_tail_estimate_pct",
  "camber_nodes_sec8",
  "camber_nodes_sec23",
  "camber_converged_sec8",
  "reference_est_rel_error",
];
const csvRows = allRows.map((r) =>
  [
    r.case,
    r.targetFn,
    r.speed,
    r.referenceFn,
    r.camberRw,
    r.camberRwExtended,
    r.referenceRw,
    r.referenceRwDefaultFit,
    r.camberOnReferenceGeometryRw,
    r.camberVsReferencePct,
    r.camberExtendedVsReferencePct,
    r.referenceFitChangePct,
    r.sameGeometryDifferencePct,
    r.camberTailEstimatePct,
    r.camberNodes,
    r.camberExtendedNodes,
    r.camberConverged,
    r.referenceEstError,
  ].join(","),
);
writeFileSync(
  resolve(outputDir, "comparison.csv"),
  [csvHeader.join(","), ...csvRows].join("\n") + "\n",
);
writeFileSync(
  resolve(outputDir, "comparison.json"),
  JSON.stringify(
    {
      referenceBinary: referenceBin,
      referenceCommit: execFileSync(
        "git",
        ["-C", "/Users/stevegenoud/workbench/michell", "rev-parse", "HEAD"],
        { encoding: "utf8" },
      ).trim(),
      density: RHO_SALT,
      gravity: G,
      defaultSecMax: DEFAULT_SEC_MAX,
      extendedSecMax,
      cases,
      controlRows,
    },
    null,
    2,
  ) + "\n",
);

const report: string[] = [
  "# Camber / risingtideresearch-michell comparison",
  "",
  `Reference binary: \`${referenceBin}\``,
  "",
  `Matched conditions: rho ${RHO_SALT} kg/m^3, g ${G} m/s^2, identical speeds at target Camber Fn 0.15-0.60.`,
  "Each case is a double-ended derivative of the named Camber example: aft sheer breadth zero, trim plane at that endpoint, and an asserted-empty transom mesh.",
  "The reference reads Camber's exported STL in millimetres and uses a 241x65 ray grid lofted to a 28x16 B-spline control net.",
  `Camber is reported both at its default sec(theta) <= ${DEFAULT_SEC_MAX} cutoff and an extended sec(theta) <= ${extendedSecMax} cutoff.`,
  "",
];

for (const c of cases) {
  const worstDefault = c.rows.reduce((a, b) =>
    Math.abs(a.camberVsReferencePct) > Math.abs(b.camberVsReferencePct) ? a : b,
  );
  const worstExtended = c.rows.reduce((a, b) =>
    Math.abs(a.camberExtendedVsReferencePct) >
    Math.abs(b.camberExtendedVsReferencePct)
      ? a
      : b,
  );
  report.push(
    `## ${c.name}`,
    "",
    `Geometry (Camber -> reference loft): L ${fmt(c.camberGeometry.length)} -> ${fmt(c.referenceGeometry.length)} m; ` +
      `T ${fmt(c.camberGeometry.draft)} -> ${fmt(c.referenceGeometry.draft)} m; ` +
      `volume ${fmt(c.camberGeometry.volume, 5)} -> ${fmt(c.referenceGeometry.volume, 5)} m^3.`,
    `Same-geometry bridge volume: ${fmt(c.sameGeometryVolume, 5)} m^3 ` +
      `(${fmt(percent(c.sameGeometryVolume, c.referenceGeometry.volume), 4)}% vs reference).`,
    "",
    `Worst default-cutoff difference: ${fmt(worstDefault.camberVsReferencePct, 1)}% at Fn ${fmt(worstDefault.targetFn, 2)}. ` +
      `Worst extended-cutoff difference: ${fmt(worstExtended.camberExtendedVsReferencePct, 1)}% at Fn ${fmt(worstExtended.targetFn, 2)}.`,
    "",
    "| Fn | Camber sec 8 (N) | Camber sec 23 (N) | reference (N) | sec 8 delta | sec 23 delta | same-geometry delta |",
    "|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const r of c.rows) {
    report.push(
      `| ${fmt(r.targetFn, 2)} | ${fmt(r.camberRw, 2)} | ${fmt(r.camberRwExtended, 2)} | ${fmt(r.referenceRw, 2)} | ` +
        `${fmt(r.camberVsReferencePct, 1)}% | ${fmt(r.camberExtendedVsReferencePct, 1)}% | ${fmt(r.sameGeometryDifferencePct, 1)}% |`,
    );
  }
  report.push("");
  const worstSameGeometry = c.rows.reduce((a, b) =>
    Math.abs(a.sameGeometryDifferencePct) >
    Math.abs(b.sameGeometryDifferencePct)
      ? a
      : b,
  );
  report.push(
    `On the reference solver's own fitted B-spline geometry, Camber's compact-support form differs by up to ` +
      `${fmt(worstSameGeometry.sameGeometryDifferencePct, 1)}% (Fn ${fmt(worstSameGeometry.targetFn, 2)}).`,
    "",
  );
}

const worstControl = controlRows.reduce((a, b) =>
  Math.abs(a.differencePct) > Math.abs(b.differencePct) ? a : b,
);
report.push(
  "## Closed-hull control",
  "",
  `On the reference project's exact Wigley B-spline, the same-geometry bridge agrees to within ` +
    `${fmt(Math.abs(worstControl.differencePct), 4)}% over Fn 0.15-0.60.`,
  "",
);

report.push(
  "## Geometry caveat",
  "",
  "These are derived double-ended variants rather than the original example hulls. The raw STL comparison still includes " +
    "the reference solver's ray-casting and B-spline loft error; the same-geometry column removes that import difference.",
  "",
);
writeFileSync(resolve(outputDir, "README.md"), report.join("\n"));

console.log(report.join("\n"));
