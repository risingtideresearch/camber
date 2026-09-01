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
  isFieldKind,
  isReserved,
  isSliceShape,
  isValidFacetValue,
  isValidName,
  type WeightBook,
} from "./sheet/book";
import { isOutputName } from "./sheet/outputs";

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
// not parse is a per-cell ERROR rather than an invalid document — the whole point is that you can leave a
// half-written line in it. What must hold is only what the book's own addressing depends on: ids that are
// unique, names a formula could actually resolve, and fields that are one of the kinds there are.
//
// Note what is NOT here. Nothing checks that facets are consistent, that two items agree on a field key, or
// that anything is filed at all. Those are matters of tidiness, not of validity — a half-organised book is a
// normal book — and the Fields tab and the Problems view are where they belong. The one rule facets do have
// is that a value has to be something a tree can split on.

export function bookViolations(book: WeightBook): string[] {
  const out: string[] = [];

  if (!finite(book.density) || book.density <= 0)
    out.push("density must be a positive number");

  const itemIds = new Set<string>();
  const itemNames = new Set<string>();
  book.items.forEach((item, i) => {
    if (typeof item.id !== "string" || !item.id)
      out.push(`items[${i}] must carry an id`);
    else if (itemIds.has(item.id))
      out.push(`items[${i}] repeats the id ${item.id}`);
    else itemIds.add(item.id);

    // An unnamed item is legal — it is the scratch line a grid would spend a spare column on. A named one
    // has to be resolvable, and has to be the only item answering to that name: item names are the book's
    // one global namespace, which is what lets a formula address a thing without naming where it is filed.
    if (item.name) {
      if (!isValidName(item.name))
        out.push(`items[${i}] name "${item.name}" is not usable in a formula`);
      else if (isReserved(item.name))
        out.push(`items[${i}] takes a reserved name`);
      else if (itemNames.has(item.name))
        out.push(`items[${i}] repeats the name ${item.name}`);
      else itemNames.add(item.name);
    }

    for (const [key, value] of Object.entries(item.facets)) {
      if (!isValidName(key))
        out.push(`items[${i}] has an unusable facet "${key}"`);
      if (!isValidFacetValue(value))
        out.push(`items[${i}].${key} is not a usable facet value`);
    }

    // Field keys are unique WITHIN the item and nowhere else, which the object already guarantees — so what
    // is left to check is only that each one could be written in a formula, and that the field is one of the
    // kinds that exist.
    for (const [key, field] of Object.entries(item.fields)) {
      if (!isValidName(key))
        out.push(`items[${i}].${key} is not a name a formula can use`);
      if (!isFieldKind(field.k))
        out.push(`items[${i}].${key} has an unknown kind "${field.k}"`);
      else if (field.k === "cut" && !isSliceShape(field.shape))
        out.push(`items[${i}].${key} cuts with an unknown "${field.shape}"`);
    }
  });

  for (const name of Object.keys(book.outputs))
    if (!isOutputName(name))
      out.push(`"${name}" is not one of the book's answers`);

  const viewIds = new Set<string>();
  book.views.forEach((view, i) => {
    if (typeof view.id !== "string" || !view.id)
      out.push(`views[${i}] must carry an id`);
    else if (viewIds.has(view.id))
      out.push(`views[${i}] repeats the id ${view.id}`);
    else viewIds.add(view.id);
    // A view scoped to an item that has gone shows nothing, which is a view worth deleting rather than a
    // document worth refusing — so this is the only thing said about a scope.
    if (view.scope.k === "item" && !itemIds.has(view.scope.item))
      out.push(`views[${i}] is scoped to an item that is not here`);
  });

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
