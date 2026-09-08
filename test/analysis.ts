// Keep the pre-extraction fixtures intact. Overlay only the intentional transom
// solid/waterplane correction, independently verified by transom-sweep.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultHull, type HullState } from "../src/core/hull";
import {
  assemble,
  defaultSession,
  initialSliceRevs,
} from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";
import { hullMetrics } from "../src/core/hullMetrics";
import {
  hullOutlines,
  sectionOutline,
  verticalSection,
} from "../src/core/pointGeometry";
import { createSliceMeasurer } from "../src/core/sheet/slices";
import { evaluateBook, resultAt } from "../src/core/sheet/evaluate";
import { type WeightBook } from "../src/core/sheet/book";
import { unitScale } from "../src/core/lengthUnits";
import { createCamberComputation } from "../src/analysis/camber/compute";
import {
  createCamberAnalysisClient,
  type AnalysisWorker,
} from "../src/analysis/camber/client";
import type {
  CamberQueryRequest,
  CamberQueryResponse,
} from "../src/analysis/camber/protocol";
import { createHullAnalysis } from "../src/analysis/queries";
import {
  available,
  unavailable,
  type Available,
  type AnalysisContext,
  type HullAnalysis,
  type QueryResult,
} from "../src/analysis/api";
import { toSheet, type SliceMeasurement } from "../src/analysis/geometry";
import {
  conditionFromSheet,
  scaleStability,
} from "../src/analysis/stabilityData";
import {
  createImoChecks,
  criterionVerdict,
  IMO,
} from "../src/analysis/assessment";
import {
  gzCurve,
  gzArea,
  maximumGz,
  limitingKgAt,
} from "../src/analysis/stability";
import { planWeightBook, finishWeightBook } from "../src/analysis/weightBook";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/analysis/baseline.json", import.meta.url),
    "utf8",
  ),
) as {
  numSections: number;
  girthSteps: number;
  book: WeightBook;
  cases: { hull: HullState; expected: Record<string, unknown> }[];
};

const correction = JSON.parse(
  readFileSync(
    new URL("./fixtures/analysis/transom-correction.json", import.meta.url),
    "utf8",
  ),
) as {
  numSections: number;
  girthSteps: number;
  cases: Record<string, unknown>[];
};
assert.equal(correction.numSections, fixture.numSections);
assert.equal(correction.girthSteps, fixture.girthSteps);
assert.equal(correction.cases.length, fixture.cases.length);
for (const [i, test] of fixture.cases.entries()) {
  assert.deepEqual(
    Object.keys(correction.cases[i]).sort(),
    ["metrics", "plane", "limit", "gz", "area", "peak", "outputs"].sort(),
  );
  test.expected = { ...test.expected, ...correction.cases[i] };
}

function close(actual: unknown, expected: unknown, path = "value"): void {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", path);
    assert.ok(
      Math.abs((actual as number) - expected) <=
        1e-10 * Math.max(1, Math.abs(expected)),
      `${path}: ${actual} != ${expected}`,
    );
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, path);
    expected.forEach((value, i) => close(actual[i], value, `${path}[${i}]`));
  } else if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object", path);
    for (const [key, value] of Object.entries(expected))
      close((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
  } else if (
    expected === null &&
    typeof actual === "number" &&
    !Number.isFinite(actual)
  ) {
    // JSON represents non-finite readings as null.
  } else assert.equal(actual, expected, path);
}
const sample = <T>(points: readonly T[]) => ({
  count: points.length,
  samples: points.length
    ? [
        points[0],
        points[Math.floor(points.length / 2)],
        points[points.length - 1],
      ]
    : [],
});
const sampledCut = (cut: SliceMeasurement) => ({
  ...cut,
  curve: sample(cut.curve),
});
function unwrap<T>(result: QueryResult<T>): T {
  assert.equal(result.result.status, "available");
  return (result.result as { value: T }).value;
}
function value<T>(answer: Available<T>): T {
  assert.equal(answer.status, "available");
  return (answer as { value: T }).value;
}
const caps: HullAnalysis["capabilities"] = {
  stability: true,
  measurements: true,
  legacySlices: true,
  pointViews: true,
  arbitraryPlanes: false,
};
const context = (id: string): AnalysisContext => ({
  id,
  fixedTrim: 0,
  referenceWaterline: 0.2,
  weightFrame: "camber-deck-x-world-z",
});
const sourceFor = (hull: HullState, key: string, rev = 0) => ({
  key,
  state: hull,
  session: defaultSession(hull),
  sliceRevs: Object.fromEntries(
    Object.keys(initialSliceRevs()).map((key) => [key, rev]),
  ) as unknown as ReturnType<typeof initialSliceRevs>,
  numSections: fixture.numSections,
  girthSteps: fixture.girthSteps,
});
const compute = createCamberComputation();

for (const [i, test] of fixture.cases.entries()) {
  const model = assemble(test.hull),
    sampling = computeHullSampling(
      model,
      fixture.numSections,
      fixture.girthSteps,
    );
  const metrics = hullMetrics(model, sampling)!;
  close(metrics, test.expected.metrics, `case ${i} metrics`);
  const measure = createSliceMeasurer(model, sampling);
  const rawStation = measure("station", 1.5)!;
  const rawPlane = measure("plane", 0.3)!;
  close(sampledCut(rawStation), test.expected.station);
  close(sampledCut(rawPlane), test.expected.plane);
  const outlines = hullOutlines(model, sampling)!;
  close(
    {
      ...outlines,
      profile: {
        upper: sample(outlines.profile.upper),
        lower: sample(outlines.profile.lower),
      },
    },
    test.expected.outlines,
  );
  for (const [key, outline] of [
    ["vertical", verticalSection(sampling, outlines.frame, 1.5)],
    [
      "authoredStation",
      sectionOutline(model, outlines.frame, { k: "at", x: 1.5 }),
    ],
  ] as const) {
    assert.ok(outline);
    close(
      {
        ...outline,
        starboard: sample(outline.starboard),
        port: sample(outline.port),
        trace: sample(outline.trace),
      },
      test.expected[key],
    );
  }

  const source = sourceFor(test.hull, `fixture-${i}`, i);
  const calls: string[] = [];
  const hull = createHullAnalysis(
    { ...context(source.key), fixedTrim: test.hull.deckRake },
    async (kind, input) => {
      calls.push(kind);
      return structuredClone(compute(source, kind, input));
    },
    caps,
  );
  const [a, b] = await Promise.all([hull.measurements(), hull.measurements()]);
  assert.equal(a, b, "two consumers share the same query promise/result");
  assert.deepEqual(
    calls,
    ["measurements"],
    "metrics do not request KN or outlines",
  );
  close(unwrap(a), test.expected.metrics);
  const cuts = unwrap(
    await hull.slices([
      { shape: "station", position: 1.5 },
      { shape: "plane", position: 0.3 },
    ]),
  );
  for (const [n, raw] of [rawStation, rawPlane].entries()) {
    close(value(cuts[n]), {
      ...raw,
      curve: raw.curve.map((p) => toSheet(outlines.frame, p)),
      centroid: toSheet(outlines.frame, raw.centroid),
    });
  }
  assert.equal(
    unwrap(await hull.sectionOutline({ kind: "vertical", x: 1e6 })),
    null,
    "a missing preview cut is available and empty",
  );
  const missing = unwrap(
    await hull.slices([{ shape: "station", position: 1e6 }]),
  );
  assert.equal(
    missing[0].status,
    "unavailable",
    "no fabricated measured area outside the hull",
  );

  const plan = planWeightBook(fixture.book, metrics);
  const weight = finishWeightBook(
    fixture.book,
    metrics,
    plan,
    unwrap(await hull.slices(plan.queries)),
  );
  close(weight.results.outputs, test.expected.outputs, "weight outputs");
  assert.equal(weight.measurementProblems.size, 0);
  const dedupBook = {
    ...fixture.book,
    items: [
      ...fixture.book.items,
      { ...fixture.book.items[2], id: "duplicate", name: "duplicate" },
    ],
  };
  const dedup = planWeightBook(dedupBook, metrics);
  assert.equal(dedup.queries.length, 1);
  assert.equal(
    dedup.bindings.length,
    2,
    "same cut is measured once for distinct fields",
  );
  await hull.slices(dedup.queries);
  const before = calls.length;
  await hull.slices(
    planWeightBook({ ...fixture.book, density: 1 }, metrics).queries,
  );
  assert.equal(
    calls.length,
    before,
    "density/book edits reuse geometry queries",
  );

  const si = unwrap(await hull.stability());
  const metres = unitScale(test.hull.unit, "m");
  const display = scaleStability(si, 1 / metres);
  close(display.limit, test.expected.limit);
  const volume = metrics.dispVol / metres ** 3;
  close(gzCurve(display.curves, volume, 600), test.expected.gz);
  close(gzArea(display.curves, volume, 600, Math.PI / 6), test.expected.area);
  close(maximumGz(display.curves, volume, 600), test.expected.peak);
  close(
    scaleStability(display, metres),
    si,
    "complete SI/display roundtrip, including slopes",
  );

  const checks = createImoChecks(si.curves, si.limit);
  assert.equal(checks.length, 6);
  close(
    checks[0].read(metrics.dispVol, 0.6),
    limitingKgAt(si.limit, metrics.dispVol) - 0.6,
  );
  close(
    checks[1].read(metrics.dispVol, 0.6),
    gzArea(si.curves, metrics.dispVol, 0.6, Math.PI / 6),
  );
  assert.deepEqual(
    checks.map((c) => c.min),
    [0.15, 0.055, 0.09, 0.03, 0.2, 25],
  );
  const displayChecks = createImoChecks(display.curves, display.limit, metres);
  for (const [n, check] of checks.entries()) {
    close(check.read(metrics.dispVol, 0.6), displayChecks[n].read(volume, 600));
    close(
      check.bound(metrics.dispVol),
      displayChecks[n].bound(volume) * metres,
    );
  }
  assert.equal(criterionVerdict(NaN, IMO.gm, null).pass, false);
  assert.deepEqual(criterionVerdict(0.15, IMO.gm, { lo: 0.14, hi: 0.16 }), {
    pass: true,
    straddles: true,
  });
  const linked = conditionFromSheet(weight.results, fixture.book.density, 1)!;
  close(linked.vol, weight.results.outputs.displacement!.v / 1025);
  close(conditionFromSheet(weight.results, 1, 1)!.vol, linked.vol * 1.025);
  const tableOnly = createHullAnalysis(
    context(`table-${i}`),
    async (kind) => {
      assert.equal(
        kind,
        "stability",
        "table-only stability has no geometry dependency",
      );
      return { contextId: `table-${i}`, result: available(si) } as never;
    },
    { ...caps, measurements: false, legacySlices: false, pointViews: false },
  );
  close(
    gzCurve(unwrap(await tableOnly.stability()).curves, linked.vol, linked.kg!),
    gzCurve(si.curves, linked.vol, linked.kg!),
  );
  console.log(
    `  ok: hull/book fixture ${i} with explicit transom correction, queries, SI tables and assessment`,
  );
}

// Shell measurements survive a dry reference condition; only dependent formula cells fail.
const dry = sourceFor({ ...defaultHull(), waterline: 1e6 }, "dry", 2);
const dryMetrics = unwrap(compute(dry, "measurements", null));
assert.ok(dryMetrics.shellArea > 0);
assert.ok(Number.isNaN(dryMetrics.dispVol));
const dryResults = evaluateBook(fixture.book, dryMetrics);
assert.equal(resultAt(dryResults, "shell", "mass")?.error, null);
assert.ok(dryResults.cells.size > 0);
assert.ok(
  dryResults.outputs.lcg === null || dryResults.outputs.lcg === undefined,
);
const empty = finishWeightBook(
  fixture.book,
  null,
  planWeightBook(fixture.book, null),
  [],
);
assert.ok(
  resultAt(empty.results, "crew", "mass")?.reading,
  "plain weights work without geometry",
);

// Query sharing, cancellation, stale contexts, and retry are pure and deterministic.
let resolvePending!: (result: QueryResult<number>) => void;
let runs = 0;
const deferred = createHullAnalysis(
  context("deferred"),
  async () => {
    runs++;
    return (await new Promise<QueryResult<number>>((resolve) => {
      resolvePending = resolve;
    })) as never;
  },
  caps,
);
const abort = new AbortController();
const cancelled = deferred.measurements({ signal: abort.signal });
const retained = deferred.measurements();
await Promise.resolve();
await Promise.resolve();
abort.abort();
await assert.rejects(cancelled, { name: "AbortError" });
resolvePending({ contextId: "deferred", result: available(42) });
await retained;
assert.equal(
  runs,
  1,
  "cancelling one reader leaves the other's shared work alive",
);
const wrong = createHullAnalysis(
  context("wanted"),
  async () => ({ contextId: "old", result: unavailable("old") }),
  caps,
);
await assert.rejects(wrong.stability(), /another context/);
let attempts = 0;
const retry = createHullAnalysis(
  context("retry"),
  async () => {
    if (++attempts === 1) throw new Error("temporary");
    return { contextId: "retry", result: unavailable("no geometry") };
  },
  caps,
);
await assert.rejects(retry.stability(), /temporary/);
assert.equal((await retry.stability()).result.status, "unavailable");
assert.equal(attempts, 2);

// Deferred queries snapshot their inputs/context, rather than caching a different future request.
const mutableContext = { ...context("immutable") };
const mutableQuery = { kind: "vertical" as const, x: 1 };
const immutable = createHullAnalysis(
  mutableContext,
  async (kind, input) => {
    assert.equal(kind, "sectionOutline");
    assert.deepEqual(input, { kind: "vertical", x: 1 });
    return { contextId: "immutable", result: available(null) } as never;
  },
  caps,
);
const captured = immutable.sectionOutline(mutableQuery);
mutableContext.id = "changed";
mutableQuery.x = 2;
await captured;
assert.equal(immutable.context.id, "immutable");

// Exercise the transport lifecycle without browser globals or replacing numerical tests with mocks.
class FakeWorker implements AnalysisWorker {
  onmessage: AnalysisWorker["onmessage"] = null;
  onerror: AnalysisWorker["onerror"] = null;
  sent: CamberQueryRequest[] = [];
  terminated = false;
  postMessage(request: CamberQueryRequest) {
    this.sent.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  answer(request: CamberQueryRequest, error?: string) {
    const data: CamberQueryResponse = {
      id: request.id,
      contextId: request.source.key,
      ...(error ? { error } : { result: unavailable("test") }),
    };
    this.onmessage?.({ data } as MessageEvent<CamberQueryResponse>);
  }
}
const worker = new FakeWorker();
let workers = 0;
const client = createCamberAnalysisClient(() => {
  workers++;
  return worker;
});
const one = sourceFor(defaultHull(), "one");
const two = { ...one, key: "two" };
client.activate(one.key);
const oldFlight = client.runner(one)("stability", null);
const oldQueued = client.runner(one)("measurements", null);
const rejected = assert.rejects(oldQueued, { name: "AbortError" });
client.activate(two.key);
await rejected;
const newMetrics = client.runner(two)("measurements", null);
const newCuts = client.runner(two)("slices", []);
assert.equal(worker.sent.length, 1);
worker.answer(worker.sent[0]);
await oldFlight;
assert.equal(worker.sent[1].kind, "measurements");
worker.answer(worker.sent[1]);
await newMetrics;
assert.equal(worker.sent[2].kind, "slices");
worker.answer(worker.sent[2]);
await newCuts;
assert.equal(workers, 1, "independent queries share one worker");
const failure = client.runner(two)("outlines", null);
worker.answer(worker.sent[3], "query failed");
await assert.rejects(failure, /query failed/);
const closing = client.runner(two)("stability", null);
const closed = assert.rejects(closing, { name: "AbortError" });
client.dispose();
await closed;
assert.equal(worker.terminated, true);
await assert.rejects(client.runner(one)("stability", null), {
  name: "AbortError",
});
console.log(
  "  ok: independent availability, query sharing/cancellation, context replacement, worker errors and disposal",
);

// Check the transitive local import graph, not just the panels' immediate imports.
// A seemingly innocent metric catalogue import used to pull in the entire hull engine.
const forbidden =
  /\/src\/(editor|document-store|worker)\/|\/src\/analysis\/(camber|mesh)\/|\/src\/core\/(model|mesh|sweep|hydro|hull|hullMetrics|stability|pointGeometry|commands|json|sheet\/slices)\.ts$/;
const seen = new Set<string>();
function checkBoundary(url: URL): void {
  assert.ok(
    !forbidden.test(url.pathname),
    `shared feature imports ${url.pathname}`,
  );
  if (seen.has(url.href)) return;
  seen.add(url.href);
  const source = readFileSync(url, "utf8");
  for (const match of source.matchAll(
    /(?:from\s+|import\s*)["'](\.[^"']+)["']/g,
  )) {
    const imported = new URL(match[1], url);
    if (imported.pathname.endsWith(".css")) continue;
    let resolved: URL | null = null;
    for (const suffix of [".ts", ".tsx", ""]) {
      const candidate = new URL(imported.href + suffix);
      try {
        readFileSync(candidate);
        resolved = candidate;
        break;
      } catch {
        /* try another source extension */
      }
    }
    assert.ok(resolved, `unresolved shared import ${imported.href}`);
    checkBoundary(resolved);
  }
}
checkBoundary(
  new URL("../src/analysis/ui/StabilityPanel.tsx", import.meta.url),
);
checkBoundary(
  new URL("../src/analysis/ui/weight/WeightPanel.tsx", import.meta.url),
);
console.log(
  "  ok: shared panel/formula imports are transitively independent of Camber and editor state",
);
