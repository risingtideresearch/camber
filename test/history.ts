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
const a = defaultHull();
const b = { ...a, waterline: 100 };
const c = { ...a, waterline: 200 };
const d = { ...a, deckRake: 0.1 };
const e = { ...a, deckRake: 0.2 };

// ---------- one line of edits: recording, coalescing, undo and redo ----------
const history = createDocumentHistory({
  coalesceMs: 400,
  now: () => time,
  initial: a,
});
check(
  !history.canUndo && !history.canRedo,
  "a planted history stands at the root with nowhere to go",
);

history.record({
  before: a,
  after: b,
  touched: 16,
  command: { type: "setWaterline", depth: 100 },
  author: "a",
});
time += 100;
history.record({
  before: b,
  after: c,
  touched: 16,
  command: { type: "setWaterline", depth: 200 },
  author: "a",
});
check(
  history.timeline().steps.length === 2,
  "one author's continuous gesture coalesces into a single moment",
);
check(
  history.undo()?.state === a,
  "undo restores the state before the gesture",
);
check(history.canRedo, "the moment undo left behind is still there");
check(
  history.redo()?.state === c,
  "redo restores the coalesced gesture's final state",
);

time += 100;
history.record({
  before: c,
  after: b,
  touched: 16,
  command: { type: "setWaterline", depth: 100 },
  author: "b",
});
check(
  history.timeline().steps.length === 3,
  "another window's gesture never disappears into this one's moment",
);
history.undo();

// ---------- going back and editing again: the history branches ----------
history.undo();
check(
  history.timeline().current === history.timeline().root,
  "two undos stand the document at the root",
);
time += 1000;
history.record({
  before: a,
  after: d,
  touched: 8,
  command: { type: "setDeckRakeDeg", deg: 5 },
  author: "a",
});
const branched = history.timeline();
check(
  branched.steps.length === 4,
  "an edit made after going back adds a moment rather than replacing one",
);
const rootStep = branched.steps.find((step) => step.id === branched.root)!;
check(
  rootStep.children.length === 2,
  "both edits made from the root hang off it as branches",
);
check(
  rootStep.parent === null && rootStep.kind === null,
  "the root is a state, not a gesture",
);
check(
  !history.canRedo && history.canUndo,
  "the new branch is a tip, with the root behind it",
);

// ---------- travel: any moment is one jump away, whichever branch it is on ----------
const waterline = branched.steps.find(
  (step) => step.kind === "setWaterline" && step.author === "a",
)!;
const jump = history.travel(waterline.id);
check(jump?.state === c, "travel jumps straight to a moment on another branch");
check(
  jump?.touched === (16 | 8),
  "a jump touches every slice it crossed on the way",
);
check(
  history.timeline().current === waterline.id,
  "the document stands where it travelled to",
);
check(
  history.travel(waterline.id) === null,
  "travelling to where the document already stands is not a transition",
);
check(
  history.travel(9999) === null,
  "travelling to a moment that is not there is refused",
);
history.undo();
check(
  history.redo()?.state === c,
  "redo comes back along the branch last travelled, not the one last made",
);

// The reader's drawing is built from the tree's shape, so wandering around one must not disturb it.
const shapeOf = (): string =>
  history
    .timeline()
    .steps.map((step) => `${step.id}>${step.children.join(",")}`)
    .join(" ");
const beforeWandering = shapeOf();
const otherWindow = branched.steps.find((step) => step.author === "b")!;
const rake = branched.steps.find((step) => step.kind === "setDeckRakeDeg")!;
history.travel(otherWindow.id);
history.travel(rake.id);
history.undo();
history.redo();
check(
  shapeOf() === beforeWandering,
  "travelling reorders nothing: the moments stay in the order they were made",
);
check(
  history.timeline().current === rake.id,
  "and the wandering still ends where it was aimed",
);

// ---------- the depth cap: what a full tree gives up, and in what order ----------
const capped = createDocumentHistory({
  depth: 2,
  coalesceMs: 0,
  now: () => time,
  initial: a,
});
const openedAt = capped.timeline().root!;
time += 1000;
capped.record({
  before: a,
  after: b,
  touched: 1,
  command: { type: "movePlanPoint", idx: 0, x: 1, y: 1 },
  author: "a",
});
const abandoned = capped.timeline().current!;
capped.undo();
time += 1000;
capped.record({
  before: a,
  after: c,
  touched: 1,
  command: { type: "movePlanPoint", idx: 1, x: 1, y: 1 },
  author: "a",
});
time += 1000;
capped.record({
  before: c,
  after: d,
  touched: 1,
  command: { type: "movePlanPoint", idx: 2, x: 1, y: 1 },
  author: "a",
});
check(
  capped.travel(abandoned) === null && capped.timeline().steps.length === 3,
  "a full tree gives up its stalest abandoned tip first",
);
check(
  !capped.timeline().truncated && capped.timeline().root === openedAt,
  "and keeps the line the document is standing on, root included",
);

time += 1000;
capped.record({
  before: d,
  after: e,
  touched: 1,
  command: { type: "movePlanPoint", idx: 3, x: 1, y: 1 },
  author: "a",
});
const trimmed = capped.timeline();
check(
  trimmed.truncated && trimmed.root !== openedAt,
  "with one line left, the cap gives up the oldest state and says the tree is truncated",
);
check(
  trimmed.steps.length === 3 &&
    trimmed.steps.find((step) => step.id === trimmed.root)!.parent === null,
  "the moment after the dropped root becomes the root, with nothing behind it",
);
check(capped.travel(openedAt) === null, "the state it opened with is gone");

// ---------- the timeline: the tree, described, for the history panel ----------
const shape = history.timeline();
check(
  shape.steps.every((step) => !("state" in step)),
  "a step carries no HullState across the worker boundary",
);
check(
  shape.steps
    .filter((step) => step.kind !== null)
    .every((step) => step.label.length > 0),
  "every gesture names itself",
);
check(
  shape.steps.find((step) => step.kind === "movePlanPoint") === undefined &&
    shape.steps.find((step) => step.id === waterline.id)!.label ===
      "Set the waterline",
  "the label is the gesture's own reading, and one history knows nothing of another",
);
check(
  shape.steps.every(
    (step) =>
      step.parent === null ||
      shape.steps
        .find((parent) => parent.id === step.parent)!
        .children.includes(step.id),
  ),
  "parent and children agree, so a reader can rebuild the tree from either",
);

history.clear();
const empty = history.timeline();
check(
  !history.canUndo && !history.canRedo,
  "clear leaves nowhere to go in either direction",
);
check(
  empty.steps.length === 0 && empty.root === null && empty.current === null,
  "clear empties the tree",
);
history.record({
  before: e,
  after: d,
  touched: 8,
  command: { type: "setDeckRakeDeg", deg: 5 },
  author: "a",
});
check(
  history.timeline().steps.length === 2 &&
    history.undo()?.state === e &&
    !history.canUndo,
  "the next edit plants a fresh root from the state it was applied to",
);

if (failures) process.exitCode = 1;
else console.log("\nall passed");
