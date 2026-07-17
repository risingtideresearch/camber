// ---------- the performance readout's measurement registry ----------
//
// The editor redraws EVERYTHING on every model bump: one drag move re-generates each 2D view's curves and
// re-tessellates the hull. So "why is this slow?" is a question about which of those steps costs what, and
// this is what they report into — the app bar's Performance toggle turns recording on and shows the panel
// that reads it.
//
// A PASS is one redraw of one view (or one hull rebuild): `perfBegin` opens it, `perfStep` / `perfAdd` time
// the steps inside it, `perfEnd` closes it and records the pass's own wall time. Steps are keyed by label
// within their pass and stamped with the pass they were last written in, so a step that stops being drawn
// (a comb switched off) drops out of the readout on its own, while one drawn several times in a pass (the
// station editor's ghost curves) sums and reports its call count.
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

// The pass names. Exported where two modules must agree on one: mesh.ts reports the hull's sub-steps into
// the 3D view's pass, which draw3d opens. Each 2D view names its own on the way in.
export const PERF_SECTIONS = "Shared sections";
export const PERF_PLAN = "Plan view";
export const PERF_PROFILE = "Profile view";
export const PERF_CUT = "Cut station";
export const PERF_MESH = "3D view";
// every mounted station editor redraws on every bump, not just the visible tab, so they get a pass each —
// that they all cost is the sort of thing this panel exists to show
export const perfStation = (si: number): string => `Station editor ${si + 1}`;

export interface Metric {
  label: string;
  ms: number; // this step's cost in the most recent pass
  avg: number; // its running average over passes (the raw per-frame numbers jitter badly)
  calls: number; // how many times it ran in that pass
  n: number | null; // how many things it produced (null = not counted)
  unit: string; // what `n` counts: "pts", "tris", …
}
export interface PerfGroup {
  title: string;
  ms: number;
  avg: number;
  metrics: Metric[];
}

interface Step {
  label: string;
  ms: number;
  avg: number;
  calls: number;
  n: number | null;
  unit: string;
  pass: number; // the pass this step was last written in; older ones are stale and not reported
}
interface Pass {
  title: string;
  steps: Map<string, Step>;
  pass: number;
  t0: number;
  ms: number;
  avg: number;
}

const groups = new Map<string, Pass>();
let on = false;
let scope: string | null = null; // the pass currently open (only one is ever open — the draws never nest)
let snap: PerfGroup[] = [];
const listeners = new Set<() => void>();
let queued = false;

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
  publish();
}

// performance.now() while recording, 0 otherwise — so a caller can timestamp a block it can't wrap in a
// closure without paying for the clock when the panel is off (the subtraction then yields 0, which the
// gated perfAdd discards anyway)
export const perfMark = (): number => (on ? performance.now() : 0);

export function perfBegin(group: string): void {
  if (!on) return;
  const g = passOf(group);
  g.pass++;
  g.t0 = performance.now();
  scope = group;
}

export function perfEnd(group: string): void {
  if (!on) return;
  const g = groups.get(group);
  if (!g) return;
  g.ms = performance.now() - g.t0;
  g.avg = ema(g.avg, g.ms);
  for (const s of g.steps.values())
    if (s.pass === g.pass) s.avg = ema(s.avg, s.ms);
  scope = null;
  publish();
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
  if (!on || scope !== group) return;
  write(group, label, ms, n, unit);
}

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

function passOf(title: string): Pass {
  let g = groups.get(title);
  if (!g) {
    g = { title, steps: new Map(), pass: 0, t0: 0, ms: 0, avg: NaN };
    groups.set(title, g);
  }
  return g;
}

function stepOf(g: Pass, label: string): Step {
  let s = g.steps.get(label);
  if (!s) {
    s = { label, ms: 0, avg: NaN, calls: 0, n: null, unit: "", pass: -1 };
    g.steps.set(label, s);
  }
  // the first write of a pass starts the step's tallies over; the running average survives, which is the
  // whole point of keeping the step object across passes
  if (s.pass !== g.pass) {
    s.pass = g.pass;
    s.ms = 0;
    s.calls = 0;
    s.n = null;
  }
  return s;
}

export const perfSnapshot = (): PerfGroup[] => snap;

export function perfSubscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Coalesce a frame's passes into one update: every view ends its own pass, and the panel should re-render
// once for all of them rather than once each. The snapshot is rebuilt only here, so `perfSnapshot` can hand
// the same array back on every render until there is genuinely something new (useSyncExternalStore requires
// exactly that).
function publish(): void {
  if (queued) return;
  queued = true;
  const flush = (): void => {
    queued = false;
    snap = build();
    for (const l of listeners) l();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else flush();
}

function build(): PerfGroup[] {
  const out: PerfGroup[] = [];
  for (const g of groups.values()) {
    const metrics: Metric[] = [];
    for (const s of g.steps.values())
      if (s.pass === g.pass)
        metrics.push({
          label: s.label,
          ms: s.ms,
          avg: s.avg,
          calls: s.calls,
          n: s.n,
          unit: s.unit,
        });
    out.push({ title: g.title, ms: g.ms, avg: g.avg, metrics });
  }
  return out;
}
