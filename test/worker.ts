import {
  createSessionHost,
  type HostClient,
  type SessionHost,
} from "../src/document-store/sessionHost";
import { connectDocumentStore } from "../src/document-store/client";
import type { StoreTransportFactory } from "../src/document-store/transport/transport";
import { defaultHull } from "../src/core/hull";
import { documentViolations } from "../src/core/invariants";
import { buildJson } from "../src/core/json";

let failures = 0;
const check = (condition: unknown, message: string) => {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    failures++;
  }
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function transportFor(host: SessionHost): StoreTransportFactory {
  return (windowId, receive) => {
    const client: HostClient = {
      id: windowId,
      post: (message) =>
        queueMicrotask(() => receive(structuredClone(message))),
    };
    return {
      post: (message) => host.receive(client, structuredClone(message)),
      close: () => host.drop(client),
    };
  };
}

let releaseSave: (() => void) | undefined;
const saveGate = new Promise<void>((resolve) => {
  releaseSave = resolve;
});
const host = createSessionHost({
  instanceId: "worker-one",
  persistence: {
    loadDesign: async () => {
      throw new Error("not used by this test");
    },
    saveDesign: async (request) => {
      await saveGate;
      return {
        currentId: request.currentId ?? "created-row",
        created: request.create,
        weightsStored: true,
      };
    },
  },
});
const a = await connectDocumentStore({
  sessionId: "shared",
  windowId: "a",
  transport: transportFor(host),
});
const b = await connectDocumentStore({
  sessionId: "shared",
  windowId: "b",
  transport: transportFor(host),
});
check(
  a.store.snapshot().meta.initialized && b.store.snapshot().meta.initialized,
  "the host initializes a new session before connecting clients",
);
await b.store.setName("Shared title");
check(
  a.store.snapshot().meta.name === "Shared title",
  "metadata commands publish across windows",
);
await b.store.setName("Test");

await a.store.dispatch({ type: "setWaterline", depth: 222 });
await tick();
check(
  b.store.snapshot().state.hull.waterline === 222,
  "an edit is published to the other window",
);
check(
  b.store.snapshot().revision === 1,
  "both windows observe the shared server revision",
);
check(
  documentViolations(b.store.snapshot().state, "document").length === 0,
  "published snapshots remain valid",
);

const first = a.store.dispatch({ type: "addPlanPoint", x: 800, y: 300 });
const second = a.store.dispatch({ type: "addPlanPoint", x: 900, y: 320 });
const own = await Promise.all([first, second]);
check(
  own.every((out) => !("rejected" in out)),
  "one author's in-flight structural commands both apply",
);

const staleBase = b.store.snapshot().revision;
const intervening = a.store.dispatch({ type: "addTrimPoint", x: 800, z: -100 });
const staleRequest = b.store.dispatch({
  type: "addTrimPoint",
  x: 900,
  z: -120,
});
await intervening;
const stale = await staleRequest;
check(
  "rejected" in stale && stale.rejected.startsWith("stale:"),
  "another author's overlapping structural edit is stale",
);
check(
  b.store.snapshot().revision > staleBase,
  "a stale command does not hide the intervening revision",
);

const savingRevision = a.store.snapshot().revision;
const saving = a.store.save("Test");
await tick();
check(
  b.store.snapshot().meta.saving,
  "save-in-progress is shared with every window",
);
await b.store.dispatch({ type: "setWaterline", depth: 300 });
releaseSave?.();
const saved = await saving;
check(
  saved.revision === savingRevision,
  "the server saves the revision captured before the request",
);
check(
  a.store.snapshot().revision > a.store.snapshot().savedRevision &&
    a.store.snapshot().state.hull.waterline === 300,
  "an edit arriving during save remains dirty",
);

a.store.close?.();
await host.settled();
await b.store.dispatch({ type: "setWaterline", depth: 333 });
check(
  b.store.snapshot().state.hull.waterline === 333,
  "closing one window leaves the shared session editable",
);

// ---------- the history, read over the protocol ----------
const shared = await b.store.timeline();
check(
  shared.steps.some((step) => step.author === "a") &&
    shared.steps.some((step) => step.author === "b"),
  "one window reads the shared history, the other window's gestures included",
);
check(
  shared.steps.every((step) => step.kind === null || step.label.length > 0) &&
    !shared.steps.some((step) => "state" in step),
  "a timeline step describes its gesture and carries no hull",
);
const at333 = shared.current!;
await b.store.undo();
const afterUndo = await b.store.timeline();
check(
  afterUndo.steps.length === shared.steps.length &&
    afterUndo.current ===
      shared.steps.find((step) => step.id === at333)!.parent,
  "undo moves where the document stands without dropping a moment from the tree",
);
check(
  await b.store.travel(at333),
  "a window travels straight to a moment by naming it",
);
check(
  b.store.snapshot().state.hull.waterline === 333 &&
    (await b.store.timeline()).current === at333,
  "the jump is an ordinary authoritative transition, and lands where it was aimed",
);
check(
  !(await b.store.travel(-1)),
  "travelling to a moment the history does not hold is refused",
);

const isolated = await connectDocumentStore({
  sessionId: "isolated",
  windowId: "c",
  transport: transportFor(host),
});
check(
  isolated.store.snapshot().state.hull.waterline !== 333,
  "a different session has an independent server",
);

let loads = 0;
const loadHost = createSessionHost({
  persistence: {
    async loadDesign() {
      loads++;
      return {
        name: "Loaded",
        documentText: buildJson({ ...defaultHull(), waterline: 456 }),
        weightsText: null,
      };
    },
    async saveDesign() {
      throw new Error("not used by this test");
    },
  },
});
const loadedA = await connectDocumentStore({
  sessionId: "loaded",
  windowId: "loaded-a",
  source: { type: "design", designId: "row-loaded" },
  transport: transportFor(loadHost),
});
const loadedB = await connectDocumentStore({
  sessionId: "loaded",
  windowId: "loaded-b",
  source: { type: "design", designId: "row-loaded" },
  transport: transportFor(loadHost),
});
check(
  loads === 1 && loadedB.store.snapshot().state.hull.waterline === 456,
  "the host loads a design once before exposing the session",
);

b.store.close();
isolated.store.close();
loadedA.store.close();
loadedB.store.close();
await host.settled();
if (failures) process.exitCode = 1;
else console.log("\nall passed");
