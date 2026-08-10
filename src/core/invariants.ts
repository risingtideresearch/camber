// ---------- what a hull promises, checked ----------
//
// Two different promises, and confusing them is how a loader ends up rejecting a file it could perfectly well
// have drawn:
//
//   "document" — what must hold for the hull to be READABLE and drawable at all. Every curve has enough
//   points to be a curve, the two sequences read as functions of x are ordered, the transom plane does not
//   invert, and the loft has index-aligned stations to interpolate across. A file that fails this cannot be
//   opened.
//
//   "editor" — what the EDIT OPERATIONS additionally guarantee about a hull they produced. The remove
//   operations keep a floor of control points, `moveStationU` holds `U_GAP` between stations, and
//   `moveStationPoint` keeps a section's points ordered downward. A hull read from disk may sit outside these
//   and still be a fine hull; only what the editor itself writes has to satisfy them.
//
// These are the safety net the store refactor is done under: `assemble()` derives geometry from authored
// state, and the check says the authored state it derived from was one the editor could actually have made.

import { UNITS } from "./document";
import {
  MIN_PLAN_CP,
  MIN_STATION_PTS,
  MIN_TRIM_CP,
  U_GAP,
  type HullState,
} from "./hull";

export type InvariantLevel = "document" | "editor";

const finite = (v: unknown): boolean => typeof v === "number" && isFinite(v);
const unit01 = (v: unknown): boolean =>
  finite(v) && (v as number) >= 0 && (v as number) <= 1;

/**
 * Every way `state` breaks its promises at `level`, as readable sentences. An empty array is a valid hull.
 * Checks are ordered structure-first, so a caller reporting only the first violation reports the useful one.
 */
export function hullViolations(
  state: HullState,
  level: InvariantLevel = "editor",
): string[] {
  const out: string[] = [];
  const editing = level === "editor";

  // ---- identity and scalars ----
  if (typeof state.name !== "string") out.push("name must be a string");
  if (!UNITS.includes(state.unit))
    out.push(`unit must be one of ${UNITS.join(", ")}`);
  // The waterline is documented as a depth below the deck datum, but nothing in the parser or the editor
  // clamps it, so a negative one is a hull drawn with its waterline above the deck — odd, not invalid.
  if (!finite(state.waterline)) out.push("waterline must be a finite number");
  if (!finite(state.deckRake)) out.push("deckRake must be a finite number");

  // ---- the sheer plan: a control polygon read as a function of x ----
  const plan = state.sheerPlan;
  const planMin = editing ? MIN_PLAN_CP : 2;
  if (plan.length < planMin)
    out.push(`sheerPlan must have at least ${planMin} control points`);
  plan.forEach((p, i) => {
    if (!finite(p.x) || !finite(p.y))
      out.push(`sheerPlan[${i}] must have finite x and y`);
  });
  for (let i = 1; i < plan.length; i++)
    if (!(plan[i].x > plan[i - 1].x))
      out.push(`sheerPlan[${i}].x must be greater than sheerPlan[${i - 1}].x`);

  // ---- the sheer trim: a monotone-x PCHIP, so the same ordering rule ----
  const trim = state.sheerTrim;
  const trimMin = editing ? MIN_TRIM_CP : 2;
  if (trim.length < trimMin)
    out.push(`sheerTrim must have at least ${trimMin} control points`);
  trim.forEach((p, i) => {
    if (!finite(p.x) || !finite(p.z))
      out.push(`sheerTrim[${i}] must have finite x and z`);
    if (!unit01(p.k)) out.push(`sheerTrim[${i}].k must be within [0, 1]`);
  });
  for (let i = 1; i < trim.length; i++)
    if (!(trim[i].x > trim[i - 1].x))
      out.push(`sheerTrim[${i}].x must be greater than sheerTrim[${i - 1}].x`);

  // ---- the transom: two profile points read as a line x(z), which inverts if they cross ----
  const transom = state.transom;
  if (transom.length !== 2)
    out.push("transom must have exactly 2 points (top and bottom)");
  else {
    transom.forEach((p, i) => {
      if (!finite(p.x) || !finite(p.z))
        out.push(`transom[${i}] must have finite x and z`);
    });
    if (!(transom[1].z < transom[0].z))
      out.push("transom[1] (the bottom) must be below transom[0] (the top)");
  }

  // ---- the stations: index-aligned, ordered in u, and the loft's knots ----
  const sts = state.stations;
  if (sts.length < 1) out.push("stations must have at least 1 station");
  const ptMin = editing ? MIN_STATION_PTS : 2;
  const shared = sts[0]?.points.length;
  sts.forEach((st, j) => {
    if (!unit01(st.u)) out.push(`stations[${j}].u must be within [0, 1]`);
    if (!unit01(st.keelK))
      out.push(`stations[${j}].keelK must be within [0, 1]`);
    if (st.points.length < ptMin)
      out.push(`stations[${j}].points must have at least ${ptMin} points`);
    // Point i of every station is one longitudinal curve, so a point present in only some of them would have
    // no curve to ride: the counts are not merely tidy, they are what makes the loft definable.
    if (st.points.length !== shared)
      out.push(
        `stations[${j}].points must have ${shared} points (every station shares one count)`,
      );
    st.points.forEach((p, i) => {
      if (!finite(p.n) || !finite(p.z))
        out.push(`stations[${j}].points[${i}] must have finite n and z`);
      if (!unit01(p.k))
        out.push(`stations[${j}].points[${i}].k must be within [0, 1]`);
    });
    // A section is drawn from the deck down, and `moveStationPoint` clamps each point between its two
    // neighbours to keep it that way; a section that curled back up would fold the swept sheet.
    if (editing) {
      if (st.points.length > 0 && !(st.points[0].z <= 0))
        out.push(`stations[${j}].points[0].z must be at or below the deck`);
      for (let i = 1; i < st.points.length; i++)
        if (!(st.points[i].z <= st.points[i - 1].z))
          out.push(
            `stations[${j}].points[${i}].z must be at or below points[${i - 1}].z`,
          );
    }
  });
  for (let j = 1; j < sts.length; j++) {
    if (!(sts[j].u > sts[j - 1].u))
      out.push(`stations[${j}].u must be greater than stations[${j - 1}].u`);
    // U_GAP is what the edit operations hold, and only to a float's tolerance — a station dragged hard
    // against its neighbour lands exactly on the gap.
    else if (editing && sts[j].u - sts[j - 1].u < U_GAP * (1 - 1e-9))
      out.push(
        `stations[${j}].u must be at least U_GAP beyond stations[${j - 1}].u`,
      );
  }

  return out;
}

/** Throw on the first violation. Use where an invalid hull must never become observable. */
export function assertValidHull(
  state: HullState,
  level: InvariantLevel = "editor",
): void {
  const bad = hullViolations(state, level);
  if (bad.length)
    throw new Error(
      `invalid hull (${level}): ${bad[0]}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ""}`,
    );
}
