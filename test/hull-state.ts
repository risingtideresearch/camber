// The authored-state layer: `HullState`, its invariants, and `assemble()`.
//
// This is the safety net the store refactor is done under. What it has to catch, in the order it matters:
//
//   - INVARIANTS mean something. Each check is shown a hull that breaks it and only it, and must report that
//     one. A checker that always returns [] would pass every other test in this file.
//   - The two LEVELS differ where they are supposed to. A document may be laxer than what the editor writes;
//     "document" must accept those hulls and "editor" must not.
//   - The EDIT OPERATIONS keep their end of the bargain. Every one of them is run, and the hull it leaves
//     behind must satisfy the editor level. This is the bank phase 3 will re-run against `applyCommand`.
//   - ASSEMBLE agrees with the legacy mutable path, geometrically and exactly. Until the editor moves onto the
//     store there are two ways to build a model, and a hull that differs between them is a bug that would
//     surface as the 3D view and the exporter disagreeing.
//   - MEMOIZATION rebuilds what changed and reuses what did not — checked by sampler identity, because that
//     is what the cache is for. A waterline drag must rebuild nothing.
//   - ROUND TRIPS through the document format are exact, both from the defaults and from every example hull.
//
// Run with `npm run test:hull` (tsx runs this directly under node). Non-zero exit on any failure.

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  cloneHull,
  defaultHull,
  loa,
  U_GAP,
  type HullState,
} from "../src/core/hull";
import { hullViolations, type InvariantLevel } from "../src/core/invariants";
import {
  assemble,
  defaultSession,
  initialSliceRevs,
  sessionOf,
  stateOf,
  type SliceRevs,
} from "../src/core/runtime";
import {
  addPlanPoint,
  addStation,
  addStationPoint,
  addTrimPoint,
  createModel,
  installHull,
  movePlanPoint,
  moveStationPoint,
  moveStationU,
  moveTransom,
  moveTrim,
  refreshDerived,
  removePlanPoint,
  removeStation,
  removeStationPoint,
  removeTrimPoint,
  sectionAt,
  setDeckRake,
  setKeelK,
  setStationK,
  setTrimK,
  setUnit,
  setWaterline,
  setX0,
  frameAt,
  stationWorld,
  type Model,
} from "../src/core/model";
import { buildJson, parseHullState } from "../src/core/json";
import { examplesDir } from "./paths";
import type { Vec3 } from "../src/core/math";

let fails = 0;
const ok = (c: boolean, m: string): void => {
  if (!c) {
    console.log("FAIL: " + m);
    fails++;
  } else console.log("  ok: " + m);
};

// A violation list is right when it names the thing that is actually wrong, so the assertions match on a
// fragment of the message rather than only counting.
const complains = (
  state: HullState,
  level: InvariantLevel,
  about: string,
  m: string,
): void => {
  const bad = hullViolations(state, level);
  ok(
    bad.some((v) => v.includes(about)),
    `${m} — got ${bad.length ? bad.join("; ") : "no violations"}`,
  );
};

const deepEq = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// A hull's surface as a bag of world points, sampled the way the sweep reads it: the section at each u placed
// by that u's frame. Two hulls that agree here are the same boat.
function surface(model: Model, NU = 24, NV = 12): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= NU; i++) {
    const u = i / NU,
      fr = frameAt(model, u),
      sec = sectionAt(model, u);
    for (let j = 0; j <= NV; j++) {
      const [n, z] = sec.at((sec.vmax * j) / NV);
      out.push(stationWorld(fr, n, z));
    }
  }
  return out;
}
const worstDiff = (a: Vec3[], b: Vec3[]): number => {
  if (a.length !== b.length) return Infinity;
  let w = 0;
  for (let i = 0; i < a.length; i++)
    w = Math.max(
      w,
      Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1], a[i][2] - b[i][2]),
    );
  return w;
};

// ---- the default hull is a valid hull ----
{
  const d = defaultHull();
  ok(
    hullViolations(d, "editor").length === 0,
    "the default hull satisfies the editor invariants",
  );
  ok(
    defaultHull() !== d && !Object.is(defaultHull().sheerPlan, d.sheerPlan),
    "defaultHull() shares no branch between calls",
  );
  const c = cloneHull(d);
  ok(
    deepEq(c, d) && c.stations[0].points !== d.stations[0].points,
    "cloneHull is a deep copy",
  );
  ok(loa(d) === 5000, `the default hull is 5000 mm long (got ${loa(d)})`);
}

// ---- each invariant fires on the hull that breaks it, and only where it should ----
{
  // A structured edit of one field, so every case below differs from a valid hull in exactly one way. The
  // deep copy is writable on purpose: breaking an invariant is exactly what the readonly types forbid.
  type Writable<T> = T extends object
    ? { -readonly [K in keyof T]: Writable<T[K]> }
    : T;
  const broken = (f: (h: Writable<HullState>) => void): HullState => {
    const h: Writable<HullState> = JSON.parse(JSON.stringify(defaultHull()));
    f(h);
    return h as HullState;
  };

  complains(
    broken((h) => (h.unit = "furlong" as HullState["unit"])),
    "document",
    "unit must be one of",
    "an unknown unit is caught",
  );
  complains(
    broken((h) => (h.waterline = NaN)),
    "document",
    "waterline must be a finite number",
    "a non-finite waterline is caught",
  );
  complains(
    broken((h) => (h.sheerPlan[2].x = h.sheerPlan[1].x - 1)),
    "document",
    "sheerPlan[2].x must be greater",
    "a plan point out of order is caught",
  );
  complains(
    broken((h) => (h.sheerPlan[3].y = Infinity)),
    "document",
    "sheerPlan[3] must have finite x and y",
    "a non-finite plan coordinate is caught",
  );
  complains(
    broken((h) => (h.sheerTrim[2].x = h.sheerTrim[1].x)),
    "document",
    "sheerTrim[2].x must be greater",
    "two trim points at the same x are caught",
  );
  complains(
    broken((h) => (h.sheerTrim[1].k = 1.5)),
    "document",
    "sheerTrim[1].k must be within",
    "a knuckle outside [0,1] is caught",
  );
  complains(
    broken((h) => (h.transom[1].z = h.transom[0].z + 1)),
    "document",
    "transom[1] (the bottom) must be below",
    "an inverted transom is caught",
  );
  complains(
    broken((h) => h.transom.push({ x: 0, z: -1 })),
    "document",
    "transom must have exactly 2 points",
    "a third transom point is caught",
  );
  complains(
    broken((h) => h.stations[1].points.pop()),
    "document",
    "must have 5 points (every station shares one count)",
    "stations that are not index-aligned are caught",
  );
  complains(
    broken((h) => (h.stations[1].u = h.stations[0].u - 0.1)),
    "document",
    "stations[1].u must be greater",
    "stations out of order in u are caught",
  );
  complains(
    broken((h) => (h.stations[0].keelK = -0.2)),
    "document",
    "stations[0].keelK must be within",
    "a keel crease outside [0,1] is caught",
  );
  complains(
    broken((h) => (h.stations[0].points[3].n = NaN)),
    "document",
    "stations[0].points[3] must have finite n and z",
    "a non-finite station coordinate is caught",
  );

  // ---- where the two levels part company ----
  // A document may carry curves the editor would never reduce to, stations packed tighter than U_GAP, and a
  // section whose points are not ordered downward. All are readable hulls; none is one the editor writes.
  const twoPointPlan = broken((h) => h.sheerPlan.splice(1, 3));
  ok(
    hullViolations(twoPointPlan, "document").length === 0,
    "a 2-point plan is a readable document",
  );
  complains(
    twoPointPlan,
    "editor",
    "sheerPlan must have at least 3",
    "but the editor never reduces the plan below 3 points",
  );

  const twoPointTrim = broken((h) => h.sheerTrim.splice(1, 2));
  ok(
    hullViolations(twoPointTrim, "document").length === 0,
    "a 2-point trim is a readable document",
  );
  complains(
    twoPointTrim,
    "editor",
    "sheerTrim must have at least 3",
    "but the editor never reduces the trim below 3 points",
  );

  const packed = broken((h) => (h.stations[1].u = h.stations[0].u + U_GAP / 2));
  ok(
    hullViolations(packed, "document").length === 0,
    "stations inside U_GAP read as a document",
  );
  complains(
    packed,
    "editor",
    "at least U_GAP beyond",
    "but the editor holds U_GAP between them",
  );

  const curled = broken((h) => (h.stations[0].points[2].z = 100));
  ok(
    hullViolations(curled, "document").length === 0,
    "a curled section reads as a document",
  );
  complains(
    curled,
    "editor",
    "must be at or below points[1].z",
    "but the editor keeps a section ordered downward",
  );
}

// ---- every edit operation leaves an editor-valid hull ----
// The bank is deliberately aimed at the clamps: coordinates far outside the panel, a station dragged onto its
// neighbour, points removed down to the floor. What each op RETURNS is checked where it means something (the
// inserts return an index, or −1 when the segment cannot take a point).
{
  const m = createModel();
  const check = (m: Model, what: string): void => {
    refreshDerived(m);
    const bad = hullViolations(stateOf(m), "editor");
    ok(
      bad.length === 0,
      `${what} leaves an editor-valid hull${bad.length ? ` — ${bad[0]}` : ""}`,
    );
  };
  const L = loa(m);

  ok(addPlanPoint(m, 0.4 * L, 0.2 * L) === 2, "addPlanPoint inserts in order");
  check(m, "addPlanPoint");
  ok(
    addPlanPoint(m, -100, 0) === -1,
    "addPlanPoint refuses to go before the pinned first point",
  );

  ok(addTrimPoint(m, 0.5 * L, -0.02 * L) > 0, "addTrimPoint inserts");
  check(m, "addTrimPoint");
  ok(
    addTrimPoint(m, -0.5 * L, -0.02 * L) === 0,
    "addTrimPoint aft of the first makes a new aft end",
  );
  check(m, "addTrimPoint at a new aft end");

  ok(addStation(m, 0.5) === 1, "addStation inserts between the two ends");
  check(m, "addStation");
  ok(
    addStation(m, 0.5 + U_GAP / 4) >= 0,
    "addStation clamps into the gap it has",
  );
  check(m, "addStation against its neighbour");

  ok(
    addStationPoint(m, 0, 0.05 * L, -0.1 * L) > 0,
    "addStationPoint inserts into every station",
  );
  ok(
    new Set(m.stations.map((s) => s.points.length)).size === 1,
    "addStationPoint keeps the stations index-aligned",
  );
  check(m, "addStationPoint");

  movePlanPoint(m, 0, 9e9, 0.3 * L); // the first point is pinned in x
  ok(
    m.sheerPlan[0].x === 0,
    "movePlanPoint holds the first point at the transom",
  );
  check(m, "movePlanPoint on the pinned point");
  movePlanPoint(m, 2, -9e9, -9e9);
  check(m, "movePlanPoint driven hard past its neighbour");
  // The bow goes forward — that is what lengthens the boat — but not absurdly far: `hair`, the spacing the
  // ordering rules hold, is 1e-6 of the CURRENT length, so a hull dragged to astronomical length grows a hair
  // wider than the real gaps between its trim points and the clamps start pushing points through each other.
  movePlanPoint(m, m.sheerPlan.length - 1, 2 * L, 0);
  check(m, "movePlanPoint taking the bow forward");

  moveTrim(m, 1, -9e9, 9e9);
  check(m, "moveTrim driven hard past its neighbour");
  moveTransom(m, 0, 0.1 * L, -9e9); // the top pushed below the bottom
  check(m, "moveTransom with the top pushed below the bottom");
  moveTransom(m, 1, 0.1 * L, 9e9);
  check(m, "moveTransom with the bottom pushed above the top");

  moveStationU(m, 1, 9e9);
  check(m, "moveStationU dragged past its neighbour");
  moveStationU(m, 1, -9e9);
  check(m, "moveStationU dragged the other way");

  moveStationPoint(m, 0, 2, 9e9, 9e9);
  check(m, "moveStationPoint driven up and inboard");
  moveStationPoint(m, 0, 2, -9e9, -9e9);
  check(m, "moveStationPoint driven down and outboard");

  setKeelK(m, 0, 5);
  ok(m.stations[0].keelK === 1, "setKeelK clamps to 1");
  setStationK(m, 0, 1, -5);
  ok(m.stations[0].points[1].k === 0, "setStationK clamps to 0");
  setTrimK(m, 1, 0.5);
  setWaterline(m, 0.03 * L);
  setDeckRake(m, 3);
  setX0(m, 9e9);
  ok(m.x0 === loa(m), "setX0 clamps to the hull's length");
  check(m, "the scalar setters");

  const before = loa(m);
  setUnit(m, "m", true);
  ok(
    Math.abs(loa(m) - before / 1000) < 1e-9,
    "setUnit with rescale keeps the physical size",
  );
  check(m, "setUnit with rescale");
  setUnit(m, "mm", true);

  removeStationPoint(m, 1);
  check(m, "removeStationPoint");
  removePlanPoint(m, 1);
  check(m, "removePlanPoint");
  removeTrimPoint(m, 1);
  check(m, "removeTrimPoint");
  removeStation(m, 1);
  check(m, "removeStation");

  // the floors: each remove refuses once it would break the hull's minimum
  while (m.sheerPlan.length > 3) removePlanPoint(m, 1);
  removePlanPoint(m, 1);
  ok(m.sheerPlan.length === 3, "removePlanPoint stops at 3 points");
  while (m.sheerTrim.length > 3) removeTrimPoint(m, 1);
  removeTrimPoint(m, 1);
  ok(m.sheerTrim.length === 3, "removeTrimPoint stops at 3 points");
  while (m.stations.length > 1) removeStation(m, 0);
  removeStation(m, 0);
  ok(m.stations.length === 1, "removeStation stops at 1 station");
  while (m.stations[0].points.length > 3) removeStationPoint(m, 1);
  removeStationPoint(m, 1);
  ok(m.stations[0].points.length === 3, "removeStationPoint stops at 3 points");
  check(m, "the hull reduced to its floors");
}

// ---- assemble() agrees with the legacy mutable path ----
{
  const legacy = createModel(); // createModel → resetModel → refreshDerived, the pre-store path
  const built = assemble(defaultHull(), sessionOf(legacy));
  ok(
    worstDiff(surface(legacy), surface(built)) === 0,
    "assemble(defaultHull()) is exactly the model resetModel() builds",
  );
  ok(
    deepEq(stateOf(legacy), defaultHull()),
    "the legacy model's authored state IS the default hull",
  );
  ok(
    deepEq(sessionOf(legacy), defaultSession(defaultHull())),
    "the legacy model's session IS the default session",
  );

  // and on a real hull, edited: install authored state into a mutable model, and assemble the same state
  const state = parseHullState(
    readFileSync(
      join(
        examplesDir(),
        readdirSync(examplesDir()).filter((f) => f.endsWith(".json"))[0],
      ),
      "utf8",
    ),
  );
  const installed = createModel();
  installHull(installed, state);
  ok(
    worstDiff(
      surface(installed),
      surface(assemble(state, sessionOf(installed))),
    ) === 0,
    "the two paths agree on an example hull too",
  );

  // stateOf is a copy, not a window onto the model
  const snap = stateOf(installed);
  movePlanPoint(installed, 1, 0, 9e9);
  ok(!deepEq(snap, stateOf(installed)), "stateOf() hands back a detached copy");
}

// ---- memoization: rebuild the slice that moved, reuse the ones that did not ----
{
  const key = {}; // a reader's stable cache identity
  const state = defaultHull();
  let revs: SliceRevs = initialSliceRevs();
  const session = defaultSession(state);
  const first = assemble(state, session, { sliceRevs: revs, cacheKey: key });

  ok(
    assemble(state, session, { sliceRevs: revs, cacheKey: key }) === first,
    "nothing moved → the very same model comes back",
  );

  // a scalar edit (the waterline slider): no sampler is stale, so none is rebuilt
  const scalars = assemble(
    { ...state, waterline: state.waterline + 1 },
    session,
    { sliceRevs: (revs = { ...revs, scalars: 1 }), cacheKey: key },
  );
  ok(scalars !== first, "a scalar edit publishes a new model");
  ok(
    scalars.plan === first.plan &&
      scalars.trimZ === first.trimZ &&
      scalars.loft === first.loft,
    "a waterline edit rebuilds no sampler at all",
  );

  // a trim edit: the trim graph is rebuilt, the plan curve and the loft are not
  const trim = assemble(
    {
      ...state,
      sheerTrim: state.sheerTrim.map((p, i) =>
        i === 1 ? { ...p, z: p.z - 10 } : p,
      ),
    },
    session,
    { sliceRevs: (revs = { ...revs, trim: 1 }), cacheKey: key },
  );
  ok(trim.trimZ !== scalars.trimZ, "a trim edit rebuilds the trim graph");
  ok(
    trim.plan === first.plan && trim.loft === first.loft,
    "a trim edit leaves the plan curve and the loft alone",
  );

  // a station edit: the loft is rebuilt, the other two are not
  const stations = assemble(
    {
      ...state,
      stations: state.stations.map((s, i) =>
        i === 0 ? { ...s, keelK: 0.5 } : s,
      ),
    },
    session,
    { sliceRevs: (revs = { ...revs, stations: 1 }), cacheKey: key },
  );
  ok(stations.loft !== trim.loft, "a station edit rebuilds the loft");
  ok(
    stations.plan === first.plan,
    "a station edit leaves the plan curve alone",
  );

  // moving the cut station is session-only: it publishes a new model and rebuilds nothing
  const moved = assemble(
    state,
    { ...session, x0: session.x0 + 100 },
    {
      sliceRevs: revs,
      cacheKey: key,
    },
  );
  ok(moved.x0 === session.x0 + 100, "the session's x0 reaches the model");
  ok(
    moved.plan === stations.plan &&
      moved.trimZ === stations.trimZ &&
      moved.loft === stations.loft,
    "moving the cut station rebuilds no sampler",
  );

  // a different reader must not read this one's cache, even at the same revisions
  const other = assemble(state, session, { sliceRevs: revs, cacheKey: {} });
  ok(
    other.plan !== moved.plan,
    "a second reader does not inherit the first's samplers",
  );
}

// ---- document round trips ----
{
  const d = defaultHull();
  ok(
    deepEq(parseHullState(buildJson(d)), d),
    "the default hull round-trips through the document format",
  );

  const dir = examplesDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let worst = "";
  for (const f of files) {
    const once = parseHullState(readFileSync(join(dir, f), "utf8"));
    if (!deepEq(parseHullState(buildJson(once)), once)) worst = f;
    if (hullViolations(once, "document").length) worst = `${f} (invalid)`;
  }
  ok(files.length > 0, `found ${files.length} example hulls`);
  ok(
    worst === "",
    `every example hull round-trips and reads as a valid document${worst ? ` — ${worst}` : ""}`,
  );
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
