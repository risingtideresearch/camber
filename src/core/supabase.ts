// ---------- Supabase: cloud storage for hull designs ----------
//
// A thin wrapper over the PostgREST REST endpoint (no @supabase/supabase-js dependency — a few fetch()
// calls keep this app a small, dependency-light bundle). The `designs` table holds one row per
// saved HullDocument: { id, name, document (jsonb), weights (jsonb, nullable), created_at }. Access is open
// (RLS allows the anon role to select/insert/update/delete), so the publishable anon key below is safe to
// ship in the client.
//
// `weights` is the WEIGHT SHEET, in a column of its own. It is deliberately not folded into `document`:
// that column is read straight back out by the library view and the export path as a `HullDocument`, and it
// has to keep being exactly that. A row saved before the column existed reads as null, which parses to an
// empty sheet — so the migration is one nullable column and nothing else:
//
//     alter table designs add column weights jsonb;
//
// ---------- and the app works before that migration is run ----------
//
// PostgREST refuses the whole request when a column it is asked for is not there, so naming `weights` in a
// select would otherwise stop EVERY design from opening on a database that has not been migrated — a hull
// editor broken by a feature nobody had used yet. So the column is treated as optional: the first request
// that meets a "no such column" refusal records the fact and retries without it, and everything afterwards
// skips it. The hull always loads and always saves; only the weight sheet is unavailable, which is exactly
// the amount of function the missing column actually costs.
//
// The state is per page load, so applying the migration later needs no more than a refresh.

const SUPABASE_URL = "https://kegzmvbbuxjkzkkaeiuz.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtlZ3ptdmJidXhqa3pra2FlaXV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MTM3ODksImV4cCI6MjA5ODE4OTc4OX0.hgtwX_1FRVzRZaDIX3hR1ei8H6CGeEDBYuTyyMFf7tY";

const REST = `${SUPABASE_URL}/rest/v1/designs`;
const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

// a saved design row. `document` is the full HullDocument (used by the file view for export); `preview` is a
// prebuilt 3/4 wireframe SVG string (built at save time, shown on the card). Both ride along in the list.
export interface DesignRow {
  id: string;
  name: string;
  created_at: string;
  document: unknown;
  preview: string | null;
  weights?: unknown;
}

/** A refusal from PostgREST, with its own error code kept so a caller can tell one cause from another. */
export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function ok(res: Response): Promise<Response> {
  if (!res.ok) {
    let detail = "",
      code = "";
    try {
      const body = await res.json();
      detail = body?.message ?? "";
      code = body?.code ?? "";
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new SupabaseError(
      `Supabase ${res.status}${detail ? `: ${detail}` : ""}`,
      res.status,
      code,
    );
  }
  return res;
}

// ---------- the optional weights column ----------

type ColumnState = "unknown" | "present" | "absent";
let weightsColumn: ColumnState = "unknown";

/** Whether the database has the weights column, as far as anything has managed to find out. */
export const weightsColumnState = (): ColumnState => weightsColumn;

/**
 * Is this refusal "there is no such column"?
 *
 * PostgREST says it two different ways: `42703` is Postgres itself refusing a select, and `PGRST204` is
 * PostgREST refusing to write a key its schema cache does not know. Both are matched against the column name
 * too, so an unrelated failure that happens to carry one of those codes is not mistaken for this one.
 */
const isMissingWeights = (error: unknown): boolean =>
  error instanceof SupabaseError &&
  (error.code === "42703" || error.code === "PGRST204") &&
  /weights/i.test(error.message);

/**
 * Run `attempt` with the weights column, and again without it if the database says there is no such column.
 * `attempt` is told which of the two it is doing, so it can shape its own request.
 */
async function withOptionalWeights<T>(
  attempt: (withWeights: boolean) => Promise<T>,
): Promise<T> {
  if (weightsColumn === "absent") return attempt(false);
  try {
    const result = await attempt(true);
    weightsColumn = "present";
    return result;
  } catch (error) {
    if (!isMissingWeights(error)) throw error;
    weightsColumn = "absent";
    console.warn(
      "camber: the designs table has no `weights` column, so weight sheets cannot be stored. " +
        "Run:  alter table designs add column weights jsonb;",
    );
    return attempt(false);
  }
}

// list saved designs, newest first (including the document + prebuilt preview)
export async function listDesigns(): Promise<DesignRow[]> {
  const res = await ok(
    await fetch(
      `${REST}?select=id,name,created_at,document,preview&order=created_at.desc`,
      { headers },
    ),
  );
  return res.json();
}

// fetch one design's name, full document and weight sheet (both returned as the JSON text the editor expects)
export async function getDesign(id: string): Promise<{
  name: string;
  documentText: string;
  weightsText: string | null;
}> {
  return withOptionalWeights(async (withWeights) => {
    const select = withWeights ? "name,document,weights" : "name,document";
    const res = await ok(
      await fetch(`${REST}?select=${select}&id=eq.${encodeURIComponent(id)}`, {
        headers,
      }),
    );
    const rows = (await res.json()) as {
      name: string;
      document: unknown;
      weights?: unknown;
    }[];
    if (!rows.length) throw new Error("design not found");
    return {
      name: rows[0].name,
      documentText: JSON.stringify(rows[0].document),
      // An absent column, an absent key and a stored null all mean the same thing to the reader: no sheet,
      // which `parseSheet` turns into an empty one.
      weightsText:
        rows[0].weights == null ? null : JSON.stringify(rows[0].weights),
    };
  });
}

// insert a new design row; returns the new row's id
export async function insertDesign(
  name: string,
  documentJson: string,
  preview: string,
  weightsJson: string | null = null,
): Promise<{ id: string; weightsStored: boolean }> {
  return withOptionalWeights(async (withWeights) => {
    const res = await ok(
      await fetch(REST, {
        method: "POST",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          name,
          document: JSON.parse(documentJson),
          preview,
          ...(withWeights
            ? { weights: weightsJson === null ? null : JSON.parse(weightsJson) }
            : {}),
        }),
      }),
    );
    const rows = (await res.json()) as { id: string }[];
    // Nothing to store is stored: a design with no estimate loses nothing to a missing column.
    return {
      id: rows[0].id,
      weightsStored: withWeights || weightsJson === null,
    };
  });
}

// overwrite an existing design's document + preview (the "Save" of an already-open design)
export async function updateDesign(
  id: string,
  documentJson: string,
  preview: string,
  weightsJson: string | null = null,
): Promise<{ weightsStored: boolean }> {
  return withOptionalWeights(async (withWeights) => {
    const res = await ok(
      await fetch(`${REST}?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          document: JSON.parse(documentJson),
          preview,
          ...(withWeights
            ? { weights: weightsJson === null ? null : JSON.parse(weightsJson) }
            : {}),
        }),
      }),
    );
    // a filter matching zero rows (design deleted elsewhere) still returns 2xx — detect it via the returned rows
    const rows = (await res.json()) as { id: string }[];
    if (!rows.length) throw new Error("design no longer exists");
    return { weightsStored: withWeights || weightsJson === null };
  });
}

// delete a design by id
export async function deleteDesign(id: string): Promise<void> {
  await ok(
    await fetch(`${REST}?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
    }),
  );
}
