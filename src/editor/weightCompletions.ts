import { FUNCTIONS } from "../core/sheet/formula";
import { HULL_METRICS, HULL_POINTS } from "../core/hullMetrics";
import { groupAt, type Sheet, type WeightBook } from "../core/sheet/book";
import { SLICE_VALUE_FIELDS } from "../core/sheet/slices";

// ---------- what a formula can mention, offered as you type ----------
//
// A schedule refers to its neighbours by name, and the names are the user's own — so the only way to know
// what is available is to be told. This builds the list from the very tables the evaluator resolves against,
// which is what keeps it from drifting: a hull measurement that exists is offered, and one that is offered
// exists.
//
// The tricky part is finding the FRAGMENT being completed, because names may contain spaces. Scanning back
// over "name characters" would stop at the first space and never complete `hull sh|`. So the scan instead
// runs back to the nearest thing that certainly is not part of a name — an operator, a bracket, a comma —
// and offers what follows it, trimmed.

export interface Completion {
  readonly insert: string;
  readonly kind: "item" | "page" | "hull" | "function";
  readonly hint: string;
}

const KIND_ORDER: Record<Completion["kind"], number> = {
  item: 0,
  page: 1,
  hull: 2,
  function: 3,
};

/** Everything nameable from `sheet`, in the order the list should prefer to offer it. */
export function completionsFor(
  book: WeightBook,
  sheet: Sheet | null,
): Completion[] {
  const out: Completion[] = [];
  if (sheet)
    sheet.rows.forEach((row, i) => {
      if (!row.name || row.kind === "heading") return;
      if (row.kind === "slice") {
        // The only formula authored on a slice page is another slice's position. Positions may share an
        // authored position, but deliberately cannot depend on measured geometry (see evaluate.ts).
        out.push({
          insert: `${row.name}.pos`,
          kind: "item",
          hint: `position of ${row.name}`,
        });
      } else if (row.kind === "point") {
        // On a points page a bare point name resolves: in a coordinate cell it means the matching
        // coordinate, which is what a derivation is written in. It comes first because that is the form the
        // interesting formula on this page uses — a centre of gravity names each point once, not three times.
        out.push({
          insert: row.name,
          kind: "item",
          hint: `${row.name}, in whichever coordinate this cell is`,
        });
        for (const axis of ["x", "y", "z"] as const)
          out.push({
            insert: `${row.name}.${axis}`,
            kind: "item",
            hint: `${axis} of ${row.name}`,
          });
      } else
        out.push({
          insert: row.name,
          kind: "item",
          hint: groupAt(sheet, i) || "on this page",
        });
    });
  for (const other of book.sheets) {
    if (!other.name || other.id === sheet?.id) continue;
    for (const row of other.rows) {
      if (!row.name || row.kind === "heading") continue;
      if (row.kind === "slice") {
        // A slice has a position of its own — the centroid of what it cuts — so in a coordinate cell it
        // binds like a point does, and an area-weighted centre of several sections is one expression.
        if (sheet?.kind === "points")
          out.push({
            insert: `${other.name}.${row.name}`,
            kind: "page",
            hint: `centroid of ${row.name}, in this cell's coordinate`,
          });
        for (const field of ["pos", ...SLICE_VALUE_FIELDS])
          out.push({
            insert: `${other.name}.${row.name}.${field}`,
            kind: "page",
            hint: `${field} on ${other.name}`,
          });
      } else if (row.kind === "point") {
        // The bare form is offered only where it resolves — a coordinate cell, which is to say a points
        // page. Offering it on a weights page would complete to the evaluator's "write engine.x" refusal.
        if (sheet?.kind === "points")
          out.push({
            insert: `${other.name}.${row.name}`,
            kind: "page",
            hint: `${row.name} on ${other.name}, in this cell's coordinate`,
          });
        for (const axis of ["x", "y", "z"] as const)
          out.push({
            insert: `${other.name}.${row.name}.${axis}`,
            kind: "page",
            hint: `${axis} of ${row.name}, on ${other.name}`,
          });
      } else
        out.push({
          insert: `${other.name}.${row.name}`,
          kind: "page",
          hint: `on ${other.name}`,
        });
    }
  }
  for (const spec of HULL_METRICS)
    out.push({ insert: `HULL.${spec.name}`, kind: "hull", hint: spec.hint });
  for (const spec of HULL_POINTS) {
    // Bare where it resolves — a coordinate cell — and by its leaves everywhere else, the same shape a
    // point row and a slice centroid are offered in.
    if (sheet?.kind === "points")
      out.push({
        insert: `HULL.${spec.name}`,
        kind: "hull",
        hint: `${spec.hint}, in this cell's coordinate`,
      });
    for (const axis of ["x", "y", "z"] as const)
      out.push({
        insert: `HULL.${spec.name}.${axis}`,
        kind: "hull",
        hint: `${axis} of the ${spec.label}`,
      });
  }
  for (const [name, spec] of Object.entries(FUNCTIONS))
    out.push({ insert: `${name}(`, kind: "function", hint: spec.hint });
  return out;
}

/** Where the name being typed starts. −1 when the caret is not in one. */
export function fragmentStart(source: string, caret: number): number {
  let i = caret;
  while (i > 0) {
    const c = source[i - 1];
    // Anything the language uses as punctuation certainly ends a name. A space does not, because names have
    // them — so a fragment may carry trailing spaces, and the filter below trims.
    if ("+-*/^(),%±×−–[]".includes(c)) break;
    i--;
  }
  return i;
}

const score = (candidate: string, query: string): number => {
  const c = candidate.toLowerCase(),
    q = query.toLowerCase();
  if (!q) return 1;
  if (c.startsWith(q)) return 3;
  // A word inside the name starting with the query — `shell` finds `hull shell`.
  if (new RegExp(`(^|[ .])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(c))
    return 2;
  return c.includes(q) ? 1 : 0;
};

export interface Suggest {
  readonly items: readonly Completion[];
  readonly query: string;
  readonly from: number;
}

/** The suggestions for a caret position, best first, or null when there is nothing worth showing. */
export function suggestAt(
  all: readonly Completion[],
  source: string,
  caret: number,
): Suggest | null {
  const from = fragmentStart(source, caret);
  const raw = source.slice(from, caret);
  const query = raw.trimStart();
  // An empty formula offers everything; a fragment that is only spaces offers nothing, or the list would
  // flash open every time a binary operator is typed.
  if (source.trim() && !query) return null;
  const items = all
    .map((item) => ({ item, s: score(item.insert, query) }))
    .filter((entry) => entry.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s ||
        KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
        a.item.insert.length - b.item.insert.length ||
        a.item.insert.localeCompare(b.item.insert),
    )
    .slice(0, 8)
    .map((entry) => entry.item);
  return items.length
    ? { items, query, from: from + (raw.length - query.length) }
    : null;
}
