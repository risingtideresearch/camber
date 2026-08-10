import {
  createSessionHost,
  type HostClient,
  type SessionHost,
} from "../src/core/sessionHost";
import {
  connectHullStore,
  type TransportFactory,
} from "../src/core/workerStore";
import { hullViolations } from "../src/core/invariants";

let failures = 0;
const check = (condition: unknown, message: string) => {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    failures++;
  }
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function transportFor(host: SessionHost): TransportFactory {
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

const host = createSessionHost({ instanceId: "worker-one" });
const a = await connectHullStore({
  sessionId: "shared",
  windowId: "a",
  transport: transportFor(host),
});
const b = await connectHullStore({
  sessionId: "shared",
  windowId: "b",
  transport: transportFor(host),
});
check(a.fresh && b.fresh, "two windows connect to one fresh session");

await a.store.dispatch({ type: "setWaterline", depth: 222 });
await tick();
check(
  b.store.snapshot().state.waterline === 222,
  "an edit is published to the other window",
);
check(
  b.store.snapshot().revision === 1,
  "both windows observe the owner's revision",
);
check(
  hullViolations(b.store.snapshot().state, "document").length === 0,
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

a.store.close?.();
await host.settled();
await b.store.dispatch({ type: "setWaterline", depth: 333 });
check(
  b.store.snapshot().state.waterline === 333,
  "closing one window leaves the shared session editable",
);

const isolated = await connectHullStore({
  sessionId: "isolated",
  windowId: "c",
  transport: transportFor(host),
});
check(
  isolated.store.snapshot().state.waterline !== 333,
  "a different session has an independent owner",
);

b.store.close?.();
isolated.store.close?.();
await host.settled();
if (failures) process.exitCode = 1;
else console.log("\nall passed");
