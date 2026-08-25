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
import type { SessionDocument } from "./sessionDocument";
import {
  isReserved,
  isValidName,
  refValue,
  type WeightBook,
} from "./sheet/book";

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

// ---------- the weight book ----------
//
// Far fewer promises than a hull, because a schedule is text until it is evaluated and a formula that does
// not parse is a per-row ERROR rather than an invalid document — the whole point is that you can leave a
// half-written line in it. What must hold is only what the book's own addressing depends on: ids that are
// unique, names a formula could actually resolve, and outputs that point at something.

export function bookViolations(book: WeightBook): string[] {
  const out: string[] = [];

  if (!finite(book.density) || book.density <= 0)
    out.push("density must be a positive number");

  const sheetIds = new Set<string>();
  const sheetNames = new Set<string>();
  book.sheets.forEach((sheet, i) => {
    if (typeof sheet.id !== "string" || !sheet.id)
      out.push(`sheets[${i}] must carry an id`);
    else if (sheetIds.has(sheet.id))
      out.push(`sheets[${i}] repeats the id ${sheet.id}`);
    else sheetIds.add(sheet.id);

    if (!isValidName(sheet.name))
      out.push(`sheets[${i}] name "${sheet.name}" is not usable in a formula`);
    else if (sheetNames.has(sheet.name))
      out.push(`sheets[${i}] repeats the name ${sheet.name}`);
    else sheetNames.add(sheet.name);

    const rowIds = new Set<string>();
    const rowNames = new Set<string>();
    sheet.rows.forEach((row, j) => {
      if (typeof row.id !== "string" || !row.id)
        out.push(`sheets[${i}].rows[${j}] must carry an id`);
      else if (rowIds.has(row.id))
        out.push(`sheets[${i}].rows[${j}] repeats the id ${row.id}`);
      else rowIds.add(row.id);

      // A heading is not a value and nothing can refer to one, so its text is under no rules at all.
      // An unnamed ITEM is legal too — it is the scratch line a grid would spend a spare column on. A named
      // one has to be resolvable, and has to be the only item on its page answering to that name.
      if (row.name && row.kind !== "heading") {
        if (!isValidName(row.name))
          out.push(
            `sheets[${i}].rows[${j}] name "${row.name}" is not usable in a formula`,
          );
        else if (isReserved(row.name))
          out.push(`sheets[${i}].rows[${j}] takes a reserved name`);
        else if (rowNames.has(row.name))
          out.push(`sheets[${i}].rows[${j}] repeats the name ${row.name}`);
        else rowNames.add(row.name);
      }
    });
  });

  // An output has to name a row that is still here. The remove commands clear them, so a dangling one means
  // a book assembled some other way.
  for (const [key, ref] of Object.entries(book.outputs))
    if (ref && !refValue(book, ref))
      out.push(`outputs.${key} names an item that is not in the book`);

  return out;
}

/** Both parts of what a session authors, checked together. */
export function documentViolations(
  doc: SessionDocument,
  level: InvariantLevel = "editor",
): string[] {
  return [...hullViolations(doc.hull, level), ...bookViolations(doc.weights)];
}

/** Throw on the first violation. Use where an invalid document must never become observable. */
export function assertValidDocument(
  doc: SessionDocument,
  level: InvariantLevel = "editor",
): void {
  const bad = documentViolations(doc, level);
  if (bad.length)
    throw new Error(
      `invalid document (${level}): ${bad[0]}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ""}`,
    );
}
