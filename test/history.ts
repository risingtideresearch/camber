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

history.clear();
check(!history.canUndo && !history.canRedo, "clear empties both stacks");

if (failures) process.exitCode = 1;
else console.log("\nall passed");
