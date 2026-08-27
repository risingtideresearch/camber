import { FUNCTIONS } from "../core/sheet/formula";
import { HULL_METRICS } from "../core/hullMetrics";
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
        for (const field of ["pos", ...SLICE_VALUE_FIELDS])
          out.push({
            insert: `${other.name}.${row.name}.${field}`,
            kind: "page",
            hint: `${field} on ${other.name}`,
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
