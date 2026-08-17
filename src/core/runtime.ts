// ---------- the runtime model: authored state + session, assembled once ----------
//
// `assemble()` is the one place a `Model` is built. Everything below it — the sweep, the mesh, hydrostatics,
// the 2D strips, the exporters — keeps taking the same `Model` it always took, so this layer costs the
// geometry nothing while it separates three things that used to be one mutable bag:
//
//   AUTHORED (`HullState`)  — the hull itself: persisted, replicated, undoable.
//   SESSION  (`SessionState`) — `x0` and `viewLen`: shared between windows, never written to a document.
//   LOCAL    — nothing yet; window-only values (fairing, camera, selection) arrive with the store.
//
// This replaces `prepare()`, and with it a latent bug class: anything that read `model.loft` without a
// preceding `prepare()` silently computed the wrong hull. An assembled model has no such state — its derived
// curves exist because it exists.
//
// ---------- why revisions, not identity ----------
//
// The samplers are the expensive part, and only one of them is stale after a typical edit: dragging the
// waterline slider changes no curve at all, and moving a trim point leaves the plan curve and the whole loft
// intact. `assemble` therefore rebuilds per SLICE, keyed by integer revisions rather than by object identity.
// Integers are the right key because they survive `structuredClone`: once the server is in a SharedWorker
// (phase 5) every snapshot arrives as fresh objects, and an identity-based cache would rebuild everything on
// every command. Callers with no revisions to offer fall back to state identity, which is exactly right for
// an immutable state that is replaced wholesale.

import { buildDerived, type Derived, type Loft, type Model } from "./model";
import type { PlanCurve } from "./bspline";
import { cloneHull, loa, type HullState } from "./hull";

/** Editor values shared across a session's windows, and never part of a document. */
export interface SessionState {
  readonly x0: number; // the cut-station scrubber's position, in x
  readonly viewLen: number; // the hull length the 2D views lay their panels out against (see Model.viewLen)
}

/**
 * The session a freshly installed hull starts in: the scrubber amidships, and the panels laid out against
 * this hull rather than whichever one it replaced.
 */
export const defaultSession = (state: HullState): SessionState => {
  const len = loa(state);
  return { x0: len / 2, viewLen: len };
};

/**
 * One counter per independently derivable slice of authored state, bumped by whoever writes that slice.
 * `transom` and `scalars` derive no sampler; they are here so a reader can key its own caches — the mesh's
 * transom cut, the hydrostatics — on the same scheme.
 */
export interface SliceRevs {
  readonly plan: number;
  readonly trim: number;
  readonly stations: number;
  readonly transom: number;
  readonly scalars: number;
}

export const initialSliceRevs = (): SliceRevs => ({
  plan: 0,
  trim: 0,
  stations: 0,
  transom: 0,
  scalars: 0,
});

export interface RuntimeLocal {
  /** Owner-provided counters. They survive structuredClone, so they key derived work across a worker. */
  readonly sliceRevs?: SliceRevs;
  /** Stable per-reader identity, so two stores in one window cannot share this module's cache. */
  readonly cacheKey?: object;
}

interface Cached {
  state: HullState;
  revs: SliceRevs | undefined;
  plan: PlanCurve;
  trimZ: (x: number) => number;
  loft: Loft;
  model: Model;
}

// One cache slot PER READER, not one for the module. The server assembles a model of its own to feed the
// reducer, and every window assembles another; with a single slot they evict each other on every command and
// nothing is ever reused. The slot is found by the caller's `cacheKey`, held weakly so a closed window's
// samplers go with it. Callers with no key — the exporters, the preview tools, a one-off blend — share the
// anonymous slot and fall back to state identity, which is right for a hull that is assembled once.
const caches = new WeakMap<object, Cached>();
const ANON = {};

/**
 * Build the runtime model for `state` in `session`.
 *
 * The returned `Model` is complete: its derived curves are current by construction, and nothing may mutate
 * it. Successive calls reuse whichever samplers their slice revision says are still good, and return the
 * previous model outright when nothing at all has moved.
 */
export function assemble(
  state: HullState,
  session: SessionState = defaultSession(state),
  local: RuntimeLocal = {},
): Model {
  const revs = local.sliceRevs;
  const slot = local.cacheKey ?? ANON;
  const last = caches.get(slot);
  // A reader owns one monotonic revision stream. Across worker snapshots the state's identity changes on
  // every command, but an unchanged slice counter still means that slice's sampler is reusable. Without
  // revisions there is nothing to compare but the state itself, which is exactly right for an immutable one.
  const sameSource = !!last && (revs ? !!last.revs : last.state === state);
  const reuse = (slice: keyof SliceRevs): boolean =>
    sameSource && (!revs || last!.revs![slice] === revs[slice]);

  const planSame = reuse("plan"),
    trimSame = reuse("trim"),
    stationsSame = reuse("stations");

  if (
    last &&
    planSame &&
    trimSame &&
    stationsSame &&
    reuse("transom") &&
    reuse("scalars") &&
    last.model.x0 === session.x0 &&
    last.model.viewLen === session.viewLen
  )
    return last.model;

  const derived: Derived = buildDerived(state, {
    plan: planSame ? last!.plan : undefined,
    trimZ: trimSame ? last!.trimZ : undefined,
    loft: stationsSame ? last!.loft : undefined,
  });

  // The authored arrays are copied out rather than aliased: `Model` is still the pre-store editor's mutable
  // shape, and a hull dragged in one window must not reach into the state a document was parsed from.
  const hull = cloneHull(state);
  const model: Model = {
    name: hull.name,
    unit: hull.unit,
    sheerPlan: hull.sheerPlan as Model["sheerPlan"],
    sheerTrim: hull.sheerTrim as Model["sheerTrim"],
    transom: hull.transom as Model["transom"],
    stations: hull.stations as Model["stations"],
    waterline: hull.waterline,
    deckRake: hull.deckRake,
    x0: session.x0,
    viewLen: session.viewLen,
    ...derived,
  };
  caches.set(slot, { state, revs, ...derived, model });
  return model;
}

/** The authored hull inside a runtime model — the way back out to something serializable. */
export const stateOf = (model: Model): HullState =>
  cloneHull({
    name: model.name,
    unit: model.unit,
    sheerPlan: model.sheerPlan,
    sheerTrim: model.sheerTrim,
    transom: model.transom,
    stations: model.stations,
    waterline: model.waterline,
    deckRake: model.deckRake,
  });

/** The session values a runtime model is carrying. */
export const sessionOf = (model: Model): SessionState => ({
  x0: model.x0,
  viewLen: model.viewLen,
});
