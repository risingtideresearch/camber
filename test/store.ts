import { defaultDocument } from "../src/core/sessionDocument";
import { parseHullState } from "../src/core/json";
import type { SessionMeta } from "../src/core/meta";
import { createLocalDocumentStore } from "../src/document-store/localStore";
import type { PersistenceAdapter } from "../src/document-store/persistence/persistenceAdapter";
import { SaveCoordinator } from "../src/document-store/saveCoordinator";
import { createDocumentStoreServer } from "../src/document-store/server";
import { isDirty, type DocumentSnapshot } from "../src/document-store/snapshot";

let failures = 0;
const check = (condition: unknown, message: string) => {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    failures++;
  }
};

const initializedMeta = (currentId: string | null = null): SessionMeta => {
  const state = defaultDocument();
  return {
    initialized: true,
    name: currentId ? "Test" : "",
    design: {
      currentId,
      savedName: currentId ? "Test" : null,
      savedState: state,
    },
    saving: false,
  };
};

// Revisions, session state, rejection, and publication are server concerns.
{
  const server = createDocumentStoreServer();
  const start = server.snapshot();
  let publications = 0;
  server.subscribe(() => publications++);
  const outcome = server.execute({
    command: { type: "setWaterline", depth: 123 },
    author: "a",
  });
  check(!("rejected" in outcome), "accepts a valid command");
  check(server.snapshot().revision === 1, "an edit bumps document revision");
  check(isDirty(server.snapshot()), "an edit makes the document dirty");
  check(publications === 1, "an accepted edit publishes once");
  server.executeSession({ type: "setX0", x: 100 });
  check(
    server.snapshot().revision === 1 &&
      server.snapshot().sessionRevision === start.sessionRevision + 1,
    "session edits use their own revision",
  );
  check(publications === 2, "a changed session publishes once");

  const before = server.snapshot();
  const rejected = server.execute({
    command: { type: "addPlanPoint", x: -1000, y: 0 },
    author: "a",
  });
  check("rejected" in rejected, "rejects an invalid operation");
  check(
    server.snapshot() === before,
    "rejection publishes and changes nothing",
  );
}

// The server coordinates independently encapsulated history with revisions.
{
  let time = 1000;
  const server = createDocumentStoreServer({
    historyOptions: { now: () => time, coalesceMs: 400 },
  });
  const original = server.snapshot().state.hull.sheerPlan[1].y;
  for (let i = 0; i < 20; i++) {
    server.execute({
      command: {
        type: "movePlanPoint",
        idx: 1,
        x: 1200,
        y: original + i + 1,
      },
      author: "a",
    });
    time += 8;
  }
  check(server.snapshot().canUndo, "accepted edits enter history");
  const revision = server.snapshot().revision;
  check(server.undo("a"), "undo restores the gesture");
  check(
    server.snapshot().state.hull.sheerPlan[1].y === original,
    "a coalesced drag undoes in one step",
  );
  check(
    server.snapshot().revision === revision + 1 && server.snapshot().canRedo,
    "undo is an authoritative revision and enables redo",
  );
  check(server.redo("a"), "redo restores the edited state");
}

// Structural commands reject an overlapping stale edit from another author.
{
  const server = createDocumentStoreServer();
  server.execute({
    command: { type: "addTrimPoint", x: 800, z: -100 },
    author: "a",
    baseRevision: 0,
  });
  const stale = server.execute({
    command: { type: "addTrimPoint", x: 900, z: -120 },
    author: "b",
    baseRevision: 0,
  });
  check(
    "rejected" in stale && stale.rejected.startsWith("stale:"),
    "server rejects a stale overlapping structural command",
  );
}

// Save I/O is coordinated outside the server and captures exactly one revision.
{
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let persistedWaterline = -1;
  const persistence: PersistenceAdapter = {
    loadDesign: async () => {
      throw new Error("not used by this test");
    },
    async saveDesign(request) {
      persistedWaterline = parseHullState(request.document).waterline;
      await gate;
      return {
        currentId: request.currentId ?? "row-1",
        created: request.create,
        weightsStored: true,
      };
    },
  };
  const server = createDocumentStoreServer({ meta: initializedMeta("row-1") });
  const saves = new SaveCoordinator(persistence);
  server.execute({
    command: { type: "setWaterline", depth: 100 },
    author: "a",
  });
  const capturedRevision = server.snapshot().revision;
  const saving = saves.save(server, "Test");
  check(server.snapshot().meta.saving, "beginSave publishes shared save state");
  server.execute({
    command: { type: "setWaterline", depth: 200 },
    author: "b",
  });
  release?.();
  const result = await saving;
  check(
    result.revision === capturedRevision,
    "save marks the captured revision",
  );
  check(persistedWaterline === 100, "persistence receives the captured state");
  check(
    server.snapshot().state.hull.waterline === 200 &&
      isDirty(server.snapshot()),
    "an edit during save remains current and dirty",
  );
  check(!server.snapshot().meta.saving, "save completion clears save state");
}

// Save captures are tokens: failures release the interlock and stale completions cannot mutate metadata.
{
  const server = createDocumentStoreServer({ meta: initializedMeta("row-1") });
  const failed = server.beginSave("Test");
  server.failSave(failed);
  check(!server.snapshot().meta.saving, "failSave releases the save interlock");
  let staleRejected = false;
  try {
    server.completeSave(failed, {
      currentId: "row-1",
      created: false,
      weightsStored: true,
    });
  } catch {
    staleRejected = true;
  }
  check(staleRejected, "a completed or failed capture cannot complete later");
}

// The local facade has the same asynchronous API and stable runtime as a remote client.
{
  const persistence: PersistenceAdapter = {
    loadDesign: async () => {
      throw new Error("not used by this test");
    },
    saveDesign: async (request) => ({
      currentId: request.currentId ?? "row-1",
      created: request.create,
      weightsStored: true,
    }),
  };
  const server = createDocumentStoreServer({ meta: initializedMeta("row-1") });
  const store = createLocalDocumentStore(server, { persistence });
  check(store.runtime() === store.runtime(), "runtime identity is stable");
  await store.dispatch({ type: "setWaterline", depth: 321 });
  check(
    store.snapshot().state.hull.waterline === 321,
    "local dispatch updates replica",
  );
  await store.save("Test");
  check(!isDirty(store.snapshot()), "local saves use the coordinator");
  store.close();
}

// ---- one session, two documents, one history ----
// The point of putting the weight estimate in the session rather than beside it: hull edits and estimate
// edits go into the SAME tree, in the order they were made, and undo walks back across both without knowing
// or caring which part each moment belonged to. This is what a second history stack could not have given.
{
  let time = 2000;
  const server = createDocumentStoreServer({
    historyOptions: { now: () => time, coalesceMs: 400 },
  });
  const step = (command: Parameters<typeof server.execute>[0]["command"]) => {
    time += 1000; // far enough apart that nothing coalesces
    return server.execute({ command, author: "a" });
  };

  step({ type: "setWaterline", depth: 200 });
  step({ type: "addSheet", id: "p1", name: "Weights", kind: "scalars" });
  step({ type: "addSheetRow", sheet: "p1", id: "r1", after: -1 });
  step({ type: "renameSheetRow", sheet: "p1", row: "r1", name: "hull shell" });
  step({
    type: "setSheetFormula",
    sheet: "p1",
    row: "r1",
    field: "formula",
    formula: "12 ± 2",
  });
  step({ type: "setWaterline", depth: 250 });

  const now = server.snapshot();
  check(
    now.state.hull.waterline === 250 && now.state.weights.sheets.length === 1,
    "the hull and the estimate advance in one document",
  );
  // A row is a union over what its page holds, so reading a formula off one means saying which kind it is.
  const scalarAt = (snapshot: DocumentSnapshot, page: number, row: number) => {
    const found = snapshot.state.weights.sheets[page].rows[row];
    return found.kind === "item" ? found : null;
  };
  check(
    scalarAt(now, 0, 0)?.name === "hull shell" &&
      scalarAt(now, 0, 0)?.formula === "12 ± 2",
    "an estimate edit lands where it was aimed, spaces in the name and all",
  );

  const revs = now.sliceRevs;
  check(
    revs.weights === 4 && revs.scalars === 2,
    "each part's slice clock counts only its own edits",
  );

  server.undo("a"); // the second waterline
  check(
    server.snapshot().state.hull.waterline === 200 &&
      scalarAt(server.snapshot(), 0, 0)?.formula === "12 ± 2",
    "undoing a hull edit leaves the estimate exactly where it was",
  );
  server.undo("a"); // the formula
  check(
    scalarAt(server.snapshot(), 0, 0)?.formula === "" &&
      server.snapshot().state.hull.waterline === 200,
    "undo crosses into the estimate without disturbing the hull",
  );
  server.undo("a"); // the rename
  server.undo("a"); // the row
  server.undo("a"); // the page
  check(
    server.snapshot().state.weights.sheets.length === 0,
    "undo walks the estimate back out of the tree",
  );
  server.undo("a"); // the first waterline
  check(
    server.snapshot().state.hull.waterline !== 200,
    "and on into the hull edits underneath it",
  );

  server.redo("a");
  server.redo("a");
  server.redo("a");
  check(
    server.snapshot().state.hull.waterline === 200 &&
      server.snapshot().state.weights.sheets[0].rows.length === 1,
    "redo comes back across the same boundary",
  );
}

// An estimate edit that breaks the book's own invariants is refused the way an invalid hull is: the reducer
// or the validator says no, and nothing is published.
{
  const server = createDocumentStoreServer();
  const run = (command: Parameters<typeof server.execute>[0]["command"]) =>
    server.execute({ command, author: "a" });
  run({ type: "addSheet", id: "p1", name: "Weights", kind: "scalars" });
  run({ type: "addSheetRow", sheet: "p1", id: "r1", after: -1 });
  run({ type: "renameSheetRow", sheet: "p1", row: "r1", name: "hull shell" });
  run({ type: "addSheetRow", sheet: "p1", id: "r2", after: 0 });
  const before = server.snapshot();
  const clash = run({
    type: "renameSheetRow",
    sheet: "p1",
    row: "r2",
    name: "hull shell",
  });
  check("rejected" in clash, "two items on a page may not answer to one name");
  check(
    server.snapshot() === before,
    "a refused estimate edit publishes nothing",
  );

  const bad = run({
    type: "renameSheetRow",
    sheet: "p1",
    row: "r2",
    name: "2 fast",
  });
  check("rejected" in bad, "a name a formula could not use is refused");

  // The same name on two PAGES is fine — it is the same item answering a different question.
  run({ type: "addSheet", id: "p2", name: "VCG", kind: "scalars" });
  run({ type: "addSheetRow", sheet: "p2", id: "r3", after: -1 });
  const across = run({
    type: "renameSheetRow",
    sheet: "p2",
    row: "r3",
    name: "hull shell",
  });
  check(
    !("rejected" in across),
    "…while the same name on another page is exactly what pages are for",
  );
}

// ---------- a database that has never heard of the weights column ----------
//
// PostgREST refuses the whole request when a column it is asked for is not there, so naming `weights` in a
// select would stop EVERY design from opening on a database that predates the feature — a hull editor broken
// by a feature nobody had used yet. `supabase.ts` treats the column as optional: the first refusal is
// recorded and the request retried without it. These drive that logic through a fake `fetch`, because the
// only other way to exercise it is to un-migrate a real database.
{
  const real = globalThis.fetch;
  const calls: { url: string; body: unknown }[] = [];
  // Flipped partway through, so both halves are covered: a migrated database first, then the same code
  // meeting a database that has never had the column.
  let hasColumn = true;

  const respond = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const asksForWeights =
      url.includes("weights") || (body !== null && "weights" in body);
    if (asksForWeights && !hasColumn)
      return respond(400, {
        code: url.includes("select=") ? "42703" : "PGRST204",
        message: "column designs.weights does not exist",
      });
    if (init?.method === "POST") return respond(201, [{ id: "new-row" }]);
    if (init?.method === "PATCH") return respond(200, [{ id: "row-1" }]);
    return respond(200, [
      {
        name: "Loaded",
        document: { version: 2 },
        weights: hasColumn ? { version: 1, rows: [] } : undefined,
      },
    ]);
  }) as typeof fetch;

  try {
    const { getDesign, insertDesign, updateDesign, weightsColumnState } =
      await import("../src/core/supabase");

    // ---- a migrated database: one request, and the sheet comes back ----
    const migrated = await getDesign("row-1");
    check(
      calls.length === 1 && calls[0].url.includes("weights"),
      "a migrated database is read in one request",
    );
    check(
      migrated.weightsText !== null && weightsColumnState() === "present",
      "the sheet comes back, and the column is noted as present",
    );

    // ---- and now the same code against one that has never had the column ----
    hasColumn = false;
    calls.length = 0;
    const loaded = await getDesign("row-1");
    check(
      loaded.name === "Loaded" && loaded.weightsText === null,
      "a design still opens on a database with no weights column",
    );
    check(
      calls.length === 2 &&
        calls[0].url.includes("weights") &&
        !calls[1].url.includes("weights"),
      "the refusal is met by retrying the same read without the column",
    );
    check(
      weightsColumnState() === "absent",
      "and the absence is remembered rather than rediscovered per request",
    );

    calls.length = 0;
    const created = await insertDesign("A", "{}", "", '{"rows":[]}');
    check(created.id === "new-row", "a new design is still created");
    check(
      created.weightsStored === false,
      "…but says its weight sheet did not go with it, rather than losing it quietly",
    );
    check(
      calls.length === 1 &&
        !(calls[0].body as Record<string, unknown>)?.weights,
      "and having learned the column is absent, it no longer asks for it",
    );

    const updated = await updateDesign("row-1", "{}", "", null);
    check(
      updated.weightsStored === true,
      "a design with no sheet loses nothing to the missing column, so its save is clean",
    );
  } finally {
    globalThis.fetch = real;
  }
}

if (failures) process.exitCode = 1;
else console.log("\nall passed");
