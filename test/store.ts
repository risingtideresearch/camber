// The store: the owner's ordering, validation, revisions and history, and the reader over it.
//
// What has to hold, and why each one is a bug that would otherwise reach the user:
//
//   - REVISIONS move for a hull edit and hold still for a session one. If scrubbing the cut station bumped
//     the document's revision, the design would read as unsaved for looking at it.
//   - SLICE revisions bump only where the command said it touched. Under-bumping draws a stale hull;
//     over-bumping rebuilds samplers that did not move, which is the cost this whole scheme exists to avoid.
//   - A REJECTED command changes nothing at all — no revision, no history entry, no publish.
//   - An INVALID hull is never published. The owner validates the candidate and keeps the previous one.
//   - UNDO restores the hull as it was, and a DRAG is one step: consecutive commands of the same gesture
//     within the coalescing window collapse, so undoing after dragging a point does not walk it back pixel by
//     pixel. Commands from a different author never coalesce — that is what phase 5 will need.
//   - DIRTY is `revision !== savedRevision`, and undo/redo move it like any other change.
//   - The READER's `runtime()` is identity-stable while nothing it reads has moved, because that is the
//     contract `useSyncExternalStore` is held to.
//
// Run with `npm run test:store`. Non-zero exit on any failure.

import { createOwner, isDirty, localStore } from "../src/core/store";
import { defaultHull, loa, type HullState } from "../src/core/hull";
import { hullViolations } from "../src/core/invariants";
import { assemble } from "../src/core/runtime";
import { computeHullSampling } from "../src/core/mesh";

let fails = 0;
const ok = (c: boolean, m: string): void => {
  if (!c) {
    console.log("FAIL: " + m);
    fails++;
  } else console.log("  ok: " + m);
};

// A clock the test drives, so the coalescing window is exercised rather than raced against.
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

// ---- a hull edit moves the revision; a session command does not ----
{
  const owner = createOwner();
  const start = owner.snapshot();
  ok(
    start.revision === 0 && start.savedRevision === 0,
    "a fresh owner is at revision 0, and saved",
  );
  ok(!isDirty(start), "a fresh owner is not dirty");

  owner.dispatch({ type: "setWaterline", depth: 123 }, "a");
  const after = owner.snapshot();
  ok(after.revision === 1, "a hull edit bumps the revision");
  ok(after.state.waterline === 123, "and the edit is in the published state");
  ok(isDirty(after), "and the design reads as dirty");
  ok(
    after.sessionRevision === start.sessionRevision,
    "a hull edit leaves the session revision alone",
  );

  owner.dispatchSession({ type: "setX0", x: 100 });
  const scrubbed = owner.snapshot();
  ok(scrubbed.session.x0 === 100, "the cut station moved");
  ok(
    scrubbed.sessionRevision === 1,
    "a session command bumps the session revision",
  );
  ok(
    scrubbed.revision === after.revision,
    "scrubbing the cut station does not touch the document's revision",
  );
  owner.markSaved(scrubbed.revision);
  owner.dispatchSession({ type: "setX0", x: 200 });
  ok(!isDirty(owner.snapshot()), "and never makes a saved design dirty");
  ok(
    owner.snapshot().session.x0 === 200,
    "the cut station is clamped to the hull, not pinned",
  );
  owner.dispatchSession({ type: "setX0", x: 9e9 });
  ok(
    owner.snapshot().session.x0 === loa(owner.snapshot().state),
    "and is clamped to the hull's length",
  );
}

// ---- slice revisions bump exactly where the command touched ----
{
  const owner = createOwner();
  const before = owner.snapshot().sliceRevs;
  owner.dispatch({ type: "setWaterline", depth: 10 }, "a");
  const afterScalar = owner.snapshot().sliceRevs;
  ok(
    afterScalar.scalars === before.scalars + 1 &&
      afterScalar.plan === before.plan &&
      afterScalar.trim === before.trim &&
      afterScalar.stations === before.stations &&
      afterScalar.transom === before.transom,
    "a waterline edit bumps the scalars slice and nothing else",
  );
  owner.dispatch({ type: "movePlanPoint", idx: 1, x: 1000, y: 900 }, "a");
  const afterPlan = owner.snapshot().sliceRevs;
  ok(
    afterPlan.plan === afterScalar.plan + 1 &&
      afterPlan.stations === afterScalar.stations,
    "a plan drag bumps the plan slice and leaves the stations alone",
  );
}

// ---- a rejected command changes nothing ----
{
  const owner = createOwner();
  const before = owner.snapshot();
  const out = owner.dispatch({ type: "addPlanPoint", x: -1000, y: 0 }, "a");
  ok(
    "rejected" in out,
    "inserting before the pinned first plan point is rejected",
  );
  const after = owner.snapshot();
  ok(after === before, "and the owner did not publish at all");
  ok(after.revision === before.revision, "the revision did not move");
  ok(!after.canUndo, "and nothing went onto the undo stack");
}

// ---- an invalid hull is never published ----
// `installHull` is the one command that carries a whole hull in from outside, so it is the one that can be
// handed something unusable. The owner must keep the hull it had.
{
  const owner = createOwner();
  owner.dispatch({ type: "setName", name: "keep me" }, "a");
  const good = owner.snapshot();
  const broken = {
    ...defaultHull(),
    transom: [
      { x: 100, z: -900 },
      { x: 200, z: -70 }, // the bottom above the top: the transom plane inverts
    ],
  } as HullState;
  ok(
    hullViolations(broken, "document").length > 0,
    "the test's broken hull really is invalid",
  );
  const out = owner.dispatch({ type: "installHull", state: broken }, "a");
  ok("rejected" in out, "installing an invalid hull is rejected");
  ok(owner.snapshot() === good, "and the hull that was there is still there");
  ok(owner.snapshot().state.name === "keep me", "untouched");
}

// ---- undo and redo ----
{
  const c = clock();
  const owner = createOwner({ now: c.now });
  const original = owner.snapshot().state.waterline;

  owner.dispatch({ type: "setWaterline", depth: 1 }, "a");
  c.advance(1000); // past the coalescing window, so the next one is its own step
  owner.dispatch({ type: "setWaterline", depth: 2 }, "a");
  ok(owner.snapshot().state.waterline === 2, "two separate edits landed");
  ok(owner.snapshot().canUndo, "there is something to undo");

  ok(owner.undo(), "undo reports it undid something");
  ok(owner.snapshot().state.waterline === 1, "undo steps back one edit");
  ok(owner.snapshot().canRedo, "and there is now something to redo");
  ok(
    owner.undo() && owner.snapshot().state.waterline === original,
    "undo again reaches the start",
  );
  ok(!owner.undo(), "and stops there");

  ok(
    owner.redo() && owner.snapshot().state.waterline === 1,
    "redo steps forward",
  );
  ok(
    owner.redo() && owner.snapshot().state.waterline === 2,
    "and forward again",
  );
  ok(!owner.redo(), "and stops there");

  // Undo bumps the revision like any other change — the document really did move, so a saved design must
  // read as dirty again afterwards.
  owner.markSaved(owner.snapshot().revision);
  ok(!isDirty(owner.snapshot()), "saved at the current revision");
  owner.undo();
  ok(
    isDirty(owner.snapshot()),
    "undoing after a save makes the design dirty again",
  );

  // A fresh edit clears the redo stack, as it must: the future it pointed at no longer exists.
  c.advance(1000);
  owner.dispatch({ type: "setWaterline", depth: 9 }, "a");
  ok(!owner.snapshot().canRedo, "a new edit clears the redo stack");
}

// ---- a drag is one undo step ----
{
  const c = clock();
  const owner = createOwner({ now: c.now });
  const startY = owner.snapshot().state.sheerPlan[1].y;

  // 60 frames of one drag, well inside the coalescing window
  for (let i = 0; i < 60; i++) {
    owner.dispatch({ type: "movePlanPoint", idx: 1, x: 1200, y: 500 + i }, "a");
    c.advance(8);
  }
  ok(
    owner.snapshot().state.sheerPlan[1].y === 559,
    "the drag's last frame is where the point ended up",
  );
  owner.undo();
  ok(
    owner.snapshot().state.sheerPlan[1].y === startY,
    "one undo puts it back where the drag began",
  );

  // A different point is a different gesture, even back to back.
  c.advance(1000);
  owner.dispatch({ type: "movePlanPoint", idx: 1, x: 1200, y: 800 }, "a");
  owner.dispatch({ type: "movePlanPoint", idx: 2, x: 2200, y: 800 }, "a");
  owner.undo();
  ok(
    owner.snapshot().state.sheerPlan[1].y === 800,
    "dragging a second point is its own undo step",
  );

  // Pausing longer than the window starts a new step, so two deliberate nudges are two.
  c.advance(1000);
  owner.dispatch({ type: "setWaterline", depth: 10 }, "a");
  c.advance(1000);
  owner.dispatch({ type: "setWaterline", depth: 20 }, "a");
  owner.undo();
  ok(
    owner.snapshot().state.waterline === 10,
    "a pause between two edits keeps them apart",
  );
}

// ---- the shared sampling's cache key is honest ----
// The editor memoizes the one hull sampling every view shares on the four AUTHORED-GEOMETRY slice revisions,
// leaving the waterline, the deck rake and the cut station deliberately out of the dependencies. That is only
// sound while `computeHullSampling` really does read nothing else — and it is the most expensive thing in the
// editor, duplicated by every window, so a stray read added to mesh.ts later would be costly and silent. This
// is the guard: change only the values the key ignores, and the sampling must come out identical.
{
  const base = defaultHull();
  const sample = (
    state: HullState,
    session?: { x0: number; viewLen: number },
  ) =>
    JSON.stringify(
      computeHullSampling(assemble(state, session, { cacheKey: {} }), 8, 2),
    );

  const reference = sample(base);
  ok(reference.length > 1000, "the sampling produced something to compare");
  ok(
    sample({ ...base, waterline: base.waterline * 3 }) === reference,
    "moving the waterline does not change the hull sampling",
  );
  ok(
    sample({ ...base, deckRake: 0.15 }) === reference,
    "raking the deck does not change the hull sampling",
  );
  ok(
    sample(base, { x0: 10, viewLen: loa(base) }) === reference,
    "scrubbing the cut station does not change the hull sampling",
  );
  ok(
    sample({ ...base, name: "renamed" }) === reference,
    "renaming the design does not change the hull sampling",
  );
  // And the controls: things the key DOES watch must change it. Note a station's `keelK` would NOT — it is
  // authored, lofted and round-tripped, but the mesh does not read it yet (honouring it means deforming the
  // section near the centerline, which lands as its own change), so it is no use as a canary here.
  ok(
    sample({
      ...base,
      stations: base.stations.map((st, i) =>
        i === 0
          ? {
              ...st,
              points: st.points.map((q, j) =>
                j === 2 ? { ...q, n: q.n * 1.4 } : q,
              ),
            }
          : st,
      ),
    }) !== reference,
    "but moving a station point does",
  );
  ok(
    sample({
      ...base,
      sheerTrim: base.sheerTrim.map((q, i) =>
        i === 1 ? { ...q, z: q.z - 200 } : q,
      ),
    }) !== reference,
    "and so does moving the sheer trim",
  );
}

// ---- the contract `useSyncExternalStore` holds a store to ----
// React calls `getSnapshot` during render AND again after every notification, and re-renders whenever the
// result differs by identity. A getter that allocated a fresh value each call would loop forever, and a
// `subscribe` whose identity changed every render would re-subscribe on every commit. Neither failure shows
// up in a unit test of the owner — only here, at the shape the hook requires.
{
  const owner = createOwner();
  const store = localStore(owner);
  ok(
    store.subscribe === store.subscribe && store.snapshot === store.snapshot,
    "subscribe and snapshot are stable function identities",
  );
  ok(store.snapshot() === store.snapshot(), "snapshot() is idempotent");
  ok(store.runtime() === store.runtime(), "runtime() is idempotent");
  // and stays idempotent after a session-only change, which publishes but rebuilds no curve
  store.dispatchSession({ type: "setX0", x: 250 });
  ok(
    store.snapshot() === store.snapshot() &&
      store.runtime() === store.runtime(),
    "both stay idempotent after a session command",
  );
}

// ---- two authors never coalesce ----
// One owner orders every window's commands. Two windows nudging the same point must stay two undo steps, or
// undoing in one window would silently take back the other's edit too.
{
  const c = clock();
  const owner = createOwner({ now: c.now });
  owner.dispatch(
    { type: "movePlanPoint", idx: 1, x: 1200, y: 100 },
    "window-a",
  );
  c.advance(8);
  owner.dispatch(
    { type: "movePlanPoint", idx: 1, x: 1200, y: 200 },
    "window-b",
  );
  owner.undo();
  ok(
    owner.snapshot().state.sheerPlan[1].y === 100,
    "the second window's move undoes on its own",
  );
}

// ---- the reader ----
{
  const owner = createOwner();
  const store = localStore(owner);

  let notified = 0;
  const stop = store.subscribe(() => notified++);

  const first = store.runtime();
  ok(
    store.runtime() === first,
    "runtime() is identity-stable while nothing has changed",
  );

  const out = await store.dispatch({ type: "setWaterline", depth: 42 });
  ok(!("rejected" in out), "the reader's dispatch reached the owner");
  ok(notified === 1, "and the reader was notified once");
  ok(store.snapshot().state.waterline === 42, "the reader sees the new hull");
  ok(store.runtime() !== first, "and a new model comes back");
  ok(store.runtime().waterline === 42, "carrying the edit");

  // Moving the cut station is session-only, but the model still has to carry it — the cut view draws x0.
  store.dispatchSession({ type: "setX0", x: 321 });
  ok(
    store.runtime().x0 === 321,
    "a session command reaches the assembled model",
  );

  // The samplers survive both: neither a scalar edit nor a session move rebuilds a curve.
  const before = store.runtime();
  await store.dispatch({ type: "setWaterline", depth: 43 });
  const after = store.runtime();
  ok(
    after.plan === before.plan &&
      after.trimZ === before.trimZ &&
      after.loft === before.loft,
    "a scalar edit through the store rebuilds no sampler",
  );

  stop();
  await store.dispatch({ type: "setWaterline", depth: 44 });
  ok(notified === 3, "unsubscribing stops the notifications");

  // dispatch is a Promise even here, where the owner answered synchronously. That is the point: the call
  // sites are already written the way workerStore will need them.
  ok(
    store.dispatch({ type: "setWaterline", depth: 45 }) instanceof Promise,
    "dispatch is asynchronous from day one",
  );
}

// ---- two readers over one owner ----
// This is the multi-window case, in miniature: two readers, each with its own sampler cache, both current.
{
  const owner = createOwner();
  const a = localStore(owner, "a"),
    b = localStore(owner, "b");
  await a.dispatch({ type: "movePlanPoint", idx: 1, x: 1400, y: 700 });
  ok(
    b.snapshot().revision === a.snapshot().revision,
    "both readers see one revision",
  );
  ok(
    b.runtime().sheerPlan[1].y === 700,
    "the second reader sees the first's edit",
  );
  ok(
    a.runtime() !== b.runtime(),
    "but each reader assembles its own model, on its own cache",
  );
  ok(
    a.runtime().plan !== b.runtime().plan,
    "so one reader's samplers are never handed to the other",
  );
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
