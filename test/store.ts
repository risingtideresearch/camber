import { defaultHull } from "../src/core/hull";
import { parseHullState } from "../src/core/json";
import type { SessionMeta } from "../src/core/meta";
import { createLocalDocumentStore } from "../src/document-store/localStore";
import type { PersistenceAdapter } from "../src/document-store/persistence/persistenceAdapter";
import { SaveCoordinator } from "../src/document-store/saveCoordinator";
import { createDocumentStoreServer } from "../src/document-store/server";
import { isDirty } from "../src/document-store/snapshot";

let failures = 0;
const check = (condition: unknown, message: string) => {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    failures++;
  }
};

const initializedMeta = (currentId: string | null = null): SessionMeta => {
  const state = defaultHull();
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
  const original = server.snapshot().state.sheerPlan[1].y;
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
    server.snapshot().state.sheerPlan[1].y === original,
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
    server.snapshot().state.waterline === 200 && isDirty(server.snapshot()),
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
    server.completeSave(failed, { currentId: "row-1", created: false });
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
    }),
  };
  const server = createDocumentStoreServer({ meta: initializedMeta("row-1") });
  const store = createLocalDocumentStore(server, { persistence });
  check(store.runtime() === store.runtime(), "runtime identity is stable");
  await store.dispatch({ type: "setWaterline", depth: 321 });
  check(
    store.snapshot().state.waterline === 321,
    "local dispatch updates replica",
  );
  await store.save("Test");
  check(!isDirty(store.snapshot()), "local saves use the coordinator");
  store.close();
}

if (failures) process.exitCode = 1;
else console.log("\nall passed");
