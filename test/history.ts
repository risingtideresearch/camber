import { defaultHull } from "../src/core/hull";
import { createDocumentHistory } from "../src/document-store/history";

let failures = 0;
const check = (condition: unknown, message: string) => {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    failures++;
  }
};

let time = 1000;
const history = createDocumentHistory({
  depth: 2,
  coalesceMs: 400,
  now: () => time,
});
const a = defaultHull();
const b = { ...a, waterline: 100 };
const c = { ...a, waterline: 200 };
const d = { ...a, deckRake: 0.1 };

history.record({
  before: a,
  touched: 16,
  command: { type: "setWaterline", depth: 100 },
  author: "a",
});
time += 100;
history.record({
  before: b,
  touched: 16,
  command: { type: "setWaterline", depth: 200 },
  author: "a",
});
check(history.canUndo && !history.canRedo, "records an undo entry");
const coalesced = history.undo(c);
check(coalesced?.state === a, "coalesces one author's continuous gesture");
check(history.canRedo, "undo creates a redo entry");
check(history.redo(a)?.state === c, "redo restores the state current at undo");

history.undo(c);
time += 1000;
history.record({
  before: a,
  touched: 16,
  command: { type: "setDeckRakeDeg", deg: 5 },
  author: "a",
});
check(!history.canRedo, "a fresh edit clears redo");

time += 1000;
history.record({
  before: d,
  touched: 16,
  command: { type: "setWaterline", depth: 300 },
  author: "b",
});
time += 100;
history.record({
  before: c,
  touched: 16,
  command: { type: "setWaterline", depth: 400 },
  author: "a",
});
check(history.undo(c)?.state === c, "different authors never coalesce");
check(history.undo(c)?.state === d, "history retains the preceding entry");
check(history.undo(c) === null, "depth drops the oldest entry");

// ---------- the timeline: both stacks, described, for the history panel ----------
history.clear();
time += 1000;
history.record({
  before: a,
  touched: 16,
  command: { type: "setWaterline", depth: 500 },
  author: "a",
});
time += 1000;
history.record({
  before: b,
  touched: 1,
  command: { type: "movePlanPoint", idx: 2, x: 1, y: 2 },
  author: "b",
});
const full = history.timeline();
check(
  full.done.map((s) => s.label).join(" | ") ===
    "Set the waterline | Move sheer point 3",
  "the timeline names the gestures, oldest first",
);
check(
  full.done[0].author === "a" && full.done[1].author === "b",
  "each step keeps the window that made it",
);
check(
  full.done[1].touched === 1 && full.done[1].kind === "movePlanPoint",
  "a step carries its command kind and touched slices",
);
check(
  full.undone.length === 0 && full.depth === 2,
  "an untravelled timeline has nothing undone, and reports the depth cap",
);
check(
  !("state" in full.done[0]),
  "a step carries no HullState across the worker boundary",
);

const seqs = full.done.map((s) => s.seq);
history.undo(c);
const walked = history.timeline();
check(
  walked.done.length === 1 && walked.undone.length === 1,
  "an undo moves a step from done to undone",
);
check(
  walked.undone[0].seq === seqs[1] && walked.done[0].seq === seqs[0],
  "a step's identity survives moving between the stacks",
);
history.undo(c);
check(
  history
    .timeline()
    .undone.map((s) => s.seq)
    .join() === seqs.join(),
  "undone reads in the order redo would put the steps back",
);

history.clear();
check(!history.canUndo && !history.canRedo, "clear empties both stacks");
const empty = history.timeline();
check(
  empty.done.length === 0 && empty.undone.length === 0,
  "clear empties the timeline too",
);

if (failures) process.exitCode = 1;
else console.log("\nall passed");
