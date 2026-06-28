// ---------- Supabase: cloud storage for hull designs ----------
//
// A thin wrapper over the PostgREST REST endpoint (no @supabase/supabase-js dependency — this app is a
// plain esbuild bundle, and a few fetch() calls keep it that way). The `designs` table holds one row per
// saved HullDocument: { id, name, document (jsonb), created_at }. Access is open (RLS allows the anon role
// to select/insert/update/delete), so the publishable anon key below is safe to ship in the client.

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
}

async function ok(res: Response): Promise<Response> {
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.message ?? "";
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(`Supabase ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res;
}

// list saved designs, newest first (including the document + prebuilt preview)
export async function listDesigns(): Promise<DesignRow[]> {
  const res = await ok(
    await fetch(`${REST}?select=id,name,created_at,document,preview&order=created_at.desc`, { headers }),
  );
  return res.json();
}

// fetch one design's name + full document (the document is returned as the JSON text the editor expects)
export async function getDesign(id: string): Promise<{ name: string; documentText: string }> {
  const res = await ok(
    await fetch(`${REST}?select=name,document&id=eq.${encodeURIComponent(id)}`, { headers }),
  );
  const rows = (await res.json()) as { name: string; document: unknown }[];
  if (!rows.length) throw new Error("design not found");
  return { name: rows[0].name, documentText: JSON.stringify(rows[0].document) };
}

// insert a new design row; returns the new row's id
export async function insertDesign(
  name: string,
  documentJson: string,
  preview: string,
): Promise<string> {
  const res = await ok(
    await fetch(REST, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ name, document: JSON.parse(documentJson), preview }),
    }),
  );
  const rows = (await res.json()) as { id: string }[];
  return rows[0].id;
}

// overwrite an existing design's document + preview (the "Save" of an already-open design)
export async function updateDesign(id: string, documentJson: string, preview: string): Promise<void> {
  await ok(
    await fetch(`${REST}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ document: JSON.parse(documentJson), preview }),
    }),
  );
}

// delete a design by id
export async function deleteDesign(id: string): Promise<void> {
  await ok(
    await fetch(`${REST}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers }),
  );
}
