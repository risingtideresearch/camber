// ---------- the performance readout's measurement registry ----------
//
// The editor redraws EVERYTHING on every model bump: one drag move re-generates each 2D view's curves and
// re-tessellates the hull. So "why is this slow?" is a question about which of those steps costs what, and
// this is what they report into — the app bar's Performance toggle turns recording on and shows the panel
// that reads it.
//
// A PASS is one redraw of one view (or one hull rebuild): `perfBegin` opens it, `perfStep` / `perfAdd` time
// the steps inside it, `perfEnd` closes it and records the pass's own wall time. Steps are keyed by label
// within their pass and stamped with the frame they were last written in, so a step that stops being drawn
// (a comb switched off) drops out of the readout on its own, while one drawn several times in a pass (the
// station editor's ghost curves) sums and reports its call count.
//
// A FRAME is everything ONE EDIT sets off — the wait that is actually felt. That is the passes plus a great
// deal nobody times: React's own render and commit, three's reconciliation of the scene graph, the collector
// running through what the last frame threw away. The passes are only a part of it, and under the dev server
// barely half of one: StrictMode double-invokes every useMemo, so the hull sampling and the 3D rebuild each
// run TWICE per edit. So the frame is measured end to end (`perfFrame`, called where the edit happens) and
// reports the remainder as a step of its own, and every pass is keyed to the frame it ran in — a pass opened
// twice in one frame adds up and says ×2, instead of the second opening quietly replacing the first.
//
// Recording is OFF unless the toggle is on, and every entry point returns immediately when it is: this sits
// in the hot path — sweptSection alone runs hundreds of times per redraw — so it must cost nothing unused.
// That is also why the readout is a snapshot the panel subscribes to rather than React state: the draws are
// imperative and run inside effects, and nothing about measuring them should re-render anything.

export interface PerfSettings {
  on: boolean;
  smooth: boolean; // show each step's running average rather than the last pass's raw time
  sort: boolean; // order each pass's steps slowest-first rather than in draw order
  // The hull-sampling resolution. These used to live in the 3D view's Mesh dropdown, but they set the cost of
  // the ONE sampling every view now shares (`computeHullSampling`), so they belong next to the readout that
  // shows what that costs. numSections is N (columns along the hull); girthSteps is R (longitudinals per
  // station knot — sub-steps per section segment, so a section of S points is (S−1)·R + 1 rows wide).
  numSections: number;
  girthSteps: number;
}
// N and R defaults (256 sections, 16 girth steps — the same resolution the 3D view defaulted to before).
export const PERF_N_DEFAULT = 256;
export const PERF_R_DEFAULT = 16;
export const defaultPerf = (): PerfSettings => ({
  on: false,
  smooth: true,
  sort: false,
  numSections: PERF_N_DEFAULT,
  girthSteps: PERF_R_DEFAULT,
});

// The pass names. Exported where two modules must agree on one: mesh.ts reports sub-steps into two passes it
// does not open — the hull rebuild's (the 3D view opens it) and the shared sampling's (EditorApp does, around
// the one `computeHullSampling` every view reads). Each 2D view names its own on the way in.
// PERF_FRAME is not a pass at all: it is the whole edit, which the panel reads as the total rather than as
// one more part of it.
export const PERF_FRAME = "Frame";
export const PERF_SECTIONS = "Shared sections";
export const PERF_SAMPLING = "Hull sampling";
export const PERF_PLAN = "Plan view";
export const PERF_PROFILE = "Profile view";
export const PERF_CUT = "Cut view";
export const PERF_MESH = "3D view";
export const PERF_STATION = "Station view";

export interface Metric {
  label: string;
  ms: number; // this step's cost in the most recent frame
  avg: number; // its running average over frames (the raw per-frame numbers jitter badly)
  calls: number; // how many times it ran in that frame
  n: number | null; // how many things it produced (null = not counted)
  unit: string; // what `n` counts: "pts", "tris", …
}
export interface PerfGroup {
  title: string;
  ms: number;
  avg: number;
  calls: number; // how many times the pass was opened in that frame — 2 is the finding, not a detail
  metrics: Metric[];
}
export interface PerfSnapshot {
  // The whole edit: the passes below plus everything nobody times. It is also where the panel's frame rate
  // comes from — the reciprocal of this, so the two numbers cannot disagree. While dragging that rate is the
  // real one, since a frame then ends at the edit that follows it; for a lone edit it is what the rate WOULD
  // be at that cost, the frame having stopped at its last pass with nothing waiting on the rest.
  frame: PerfGroup | null;
  groups: PerfGroup[]; // the passes inside it
}

// what a pass, or one step of one, cost in the frame it last ran in
interface Tally {
  ms: number;
  avg: number; // folded once, when the frame closes — never per opening
  frame: number; // the frame these tallies are of; older ones are stale and not reported
}
interface Step extends Tally {
  label: string;
  calls: number;
  n: number | null;
  unit: string;
}
interface Pass extends Tally {
  title: string;
  steps: Map<string, Step>;
  opens: number; // how many times the pass was opened in that frame
  t0: number;
}

const groups = new Map<string, Pass>();
let on = false;
let scope: string | null = null; // the pass currently open (only one is ever open — the draws never nest)
let snap: PerfSnapshot = { frame: null, groups: [] };
const listeners = new Set<() => void>();

// ---------- the frame ----------
let frame = 0; // the frame every pass's tallies are keyed to
let frameT0 = NaN; // when the edit that opened the frame now open happened
let frameLast = NaN; // when the last pass in it ended — where a frame with no edit after it stops
let frameOpen = false;
let framePasses = 0; // Σ of the passes closed in the open frame
let settle = 0; // the timer that closes a frame nothing followed
// How long a frame must be quiet to count as finished. It has to clear the gaps WITHIN one edit's redraw —
// React renders the root, and the passive effects that draw the 2D views come in a task of their own some
// tens of ms later — without swallowing the next edit of a drag, which the app cannot get to that quickly if
// it is slow enough to be worth measuring.
const FRAME_SETTLE = 200;
// what the frame's own two steps are called
const F_PASSES = "The passes below",
  F_REST = "React, three.js & the collector";

// A single frame's numbers jitter by a factor of two or more (GC, the JIT warming up, the browser's own
// work), which makes a live readout unreadable. The panel defaults to this running average instead.
const EMA_A = 0.25;
const ema = (a: number, v: number): number =>
  Number.isNaN(a) ? v : a + EMA_A * (v - a);

export const perfOn = (): boolean => on;

export function setPerfOn(v: boolean): void {
  if (v === on) return;
  on = v;
  perfReset(); // a fresh start when it goes on; no stale numbers left behind when it goes off
}

export function perfReset(): void {
  groups.clear();
  scope = null;
  frameOpen = false;
  frameT0 = frameLast = NaN;
  framePasses = 0;
  clearTimeout(settle);
  publish();
}

// ---------- one edit's worth of redraw ----------
// Open a frame. Called where the EDIT happens (EditorApp, on every model bump), not where the drawing starts,
// so the frame covers React's own work on both sides of the passes rather than just the passes.
//
// A frame ends at the NEXT edit. While dragging that is the honest measure, and the one the complaint is
// phrased in: the browser cannot deliver the next pointer move until this redraw has let go of the thread, so
// the interval between two edits IS the period seen on screen, the paint included. An edit with nothing after
// it — a click, a slider, the last move of a drag — has no such bound, so a timer closes it instead, at the
// end of its last pass. That stops short of the commit and the paint that follow, but only in the case where
// nothing is waiting on them.
//
// If a frame ends with no pass in it, nothing is reported: the edit redrew nothing.
export function perfFrame(): void {
  if (!on) return;
  const t = performance.now();
  if (frameOpen) closeFrame(t); // the usual case while dragging: this edit ends the last one's frame
  frame++;
  frameT0 = frameLast = t;
  framePasses = 0;
  frameOpen = true;
  arm();
}

// (Re)arm the close for a frame nothing follows — pushed back by every pass, because one edit's work arrives
// in bursts (React renders the root, then the passive effects that draw the 2D views come in a task of their
// own tens of ms later) and the frame is only over once they stop.
function arm(): void {
  clearTimeout(settle);
  settle = setTimeout(() => {
    if (frameOpen) closeFrame(frameLast);
  }, FRAME_SETTLE) as unknown as number;
}

function closeFrame(end: number): void {
  frameOpen = false;
  clearTimeout(settle);
  if (framePasses > 0) {
    const g = passOf(PERF_FRAME);
    g.frame = frame;
    g.opens = 1;
    g.ms = end - frameT0;
    setStep(g, F_PASSES, framePasses);
    setStep(g, F_REST, Math.max(g.ms - framePasses, 0));
  }
  // one average per frame, over the frame's whole tally — so a pass that ran twice averages the two openings
  // together rather than the running average seeing each of them as a frame of its own
  for (const g of groups.values()) {
    if (g.frame !== frame) continue;
    g.avg = ema(g.avg, g.ms);
    for (const s of g.steps.values())
      if (s.frame === frame) s.avg = ema(s.avg, s.ms);
  }
  publish();
}

function setStep(g: Pass, label: string, ms: number): void {
  const s = stepOf(g, label);
  s.ms = ms;
  s.calls = 1;
  s.unit = "";
}

// performance.now() while recording, 0 otherwise — so a caller can timestamp a block it can't wrap in a
// closure without paying for the clock when the panel is off (the subtraction then yields 0, which the
// gated perfAdd discards anyway)
export const perfMark = (): number => (on ? performance.now() : 0);

export function perfBegin(group: string): void {
  if (!on) return;
  // a redraw nobody announced — a zoom, a display toggle, the first paint — is a frame of its own
  if (!frameOpen) perfFrame();
  const g = passOf(group);
  if (g.frame !== frame) {
    // the first opening of this frame starts the pass's tallies over; a second one adds to them
    g.frame = frame;
    g.ms = 0;
    g.opens = 0;
  }
  g.t0 = performance.now();
  scope = group;
}

export function perfEnd(group: string): void {
  if (!on) return;
  const g = groups.get(group);
  if (!g) return;
  frameLast = performance.now();
  const ms = frameLast - g.t0;
  g.ms += ms;
  g.opens++;
  framePasses += ms;
  scope = null;
  arm(); // the frame reaches at least this far; if nothing follows, it ends here
}

// Time one step of the pass that is currently open, and report what it produced. `count` defaults to the
// length of an array result, which is what most of the 2D curve builders return — the point count the
// readout wants. A no-op outside a pass, so a helper carrying one of these is free to be called anywhere.
export function perfStep<T>(
  label: string,
  fn: () => T,
  count?: (r: T) => number | null,
  unit = "pts",
): T {
  if (!on || !scope) return fn();
  const t = performance.now(),
    r = fn(),
    ms = performance.now() - t;
  write(
    scope,
    label,
    ms,
    count ? count(r) : Array.isArray(r) ? r.length : null,
    unit,
  );
  return r;
}

// Add to a step of `group`'s pass — but only while that pass is the open one. This is for shared geometry
// instrumented where it is defined rather than where it is called: sweptSection runs both inside the hull
// rebuild (where its phases ARE the mesh's sub-steps) and inside the 2D passes (where the step that called
// it is already being timed, so counting it again would double-count against that pass's own total).
export function perfAdd(
  group: string,
  label: string,
  ms: number,
  n: number | null = null,
  unit = "pts",
): void {
  if (!perfRecording(group)) return;
  write(group, label, ms, n, unit);
}

// Would a `perfAdd` to `group` be kept — is its pass the open one? The same gate, exposed for the caller whose
// COUNTS cost something to work out: the hull sampling's sub-steps walk what they just built to count its
// points, and that walk must not run when nothing would record it (everything else hands perfAdd a `.length`).
export const perfRecording = (group: string): boolean => on && scope === group;

function write(
  group: string,
  label: string,
  ms: number,
  n: number | null,
  unit: string,
): void {
  const s = stepOf(passOf(group), label);
  s.ms += ms;
  s.calls++;
  if (n !== null) s.n = (s.n ?? 0) + n;
  s.unit = unit;
}

const newTally = (): Tally => ({ ms: 0, avg: NaN, frame: -1 });

function passOf(title: string): Pass {
  let g = groups.get(title);
  if (!g) {
    g = { ...newTally(), title, steps: new Map(), opens: 0, t0: 0 };
    groups.set(title, g);
  }
  return g;
}

function stepOf(g: Pass, label: string): Step {
  let s = g.steps.get(label);
  if (!s) {
    s = { ...newTally(), label, calls: 0, n: null, unit: "" };
    g.steps.set(label, s);
  }
  // the first write of a frame starts the step's tallies over; the running average survives, which is the
  // whole point of keeping the step object across frames
  if (s.frame !== frame) {
    s.frame = frame;
    s.ms = 0;
    s.calls = 0;
    s.n = null;
  }
  return s;
}

export const perfSnapshot = (): PerfSnapshot => snap;

export function perfSubscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// One update per frame, when the frame closes: every view ends its own pass, and the panel should re-render
// once for all of them rather than once each. The snapshot is rebuilt only here, so `perfSnapshot` can hand
// the same object back on every render until there is genuinely something new (useSyncExternalStore requires
// exactly that).
function publish(): void {
  snap = build();
  for (const l of listeners) l();
}

function build(): PerfSnapshot {
  const out: PerfGroup[] = [];
  let frameGroup: PerfGroup | null = null;
  for (const g of groups.values()) {
    const metrics: Metric[] = [];
    // the group's own last frame, not the current one: a view that has stopped redrawing (a station editor
    // whose tab was closed) keeps its last numbers rather than emptying out
    for (const s of g.steps.values())
      if (s.frame === g.frame)
        metrics.push({
          label: s.label,
          ms: s.ms,
          avg: s.avg,
          calls: s.calls,
          n: s.n,
          unit: s.unit,
        });
    const view = {
      title: g.title,
      ms: g.ms,
      avg: g.avg,
      calls: g.opens,
      metrics,
    };
    if (g.title === PERF_FRAME) frameGroup = view;
    else out.push(view);
  }
  return { frame: frameGroup, groups: out };
}
