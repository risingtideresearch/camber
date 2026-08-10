// ---------- every edit, as a value ----------
//
// One command per user intention, serializable, and a reducer that turns a command plus the hull it applies
// to into a new hull. This is where the edit operations used to live as in-place mutations of a shared
// `Model`; they read almost exactly as they did, because the draft below clones only the branches a command
// touches and lets each body splice and clamp as before.
//
// Two things follow from commands being values. They can cross a `postMessage` boundary, which is what the
// SharedWorker owner will need. And they can be rejected: `applyCommand` returns an outcome rather than
// throwing or half-applying, so a hull that would break its invariants is simply never published — the
// caller sees the refusal and the previous hull is still there, untouched, because nothing was mutated.
//
// ---------- commands are NOT replayable ----------
//
// `applyCommand` takes the runtime `Model`, not bare `HullState`, and two commands genuinely need it:
// `addStation` reads the new station's section off the LOFT of the pre-state, and the two station-point
// commands clamp against `bounds`, which is measured against the session's `viewLen`. The same command
// applied at a different revision therefore produces a different hull. So: no command-log persistence, no
// command-log undo, and no rebase-by-replay. Undo is a snapshot stack (`store.ts`), and the multi-window
// design orders commands through one owner rather than replaying them per window.

import { clamp, lerp } from "./math";
import { UNIT_MM, type Unit } from "./document";
import {
  loa,
  boundsOf,
  U_GAP,
  type HullState,
  type PlanCP,
  type StationCP,
  type StationPointCP,
  type TransomCP,
  type TrimCP,
} from "./hull";
import type { Model } from "./model";
import type { SessionState } from "./runtime";

// ---------- the command set ----------
// Coordinates are MODEL-space: the views map a pointer through their inverse transform before dispatching,
// so nothing here knows about pixels, pan or zoom.

export type HullCommand =
  // the sheer plan
  | { type: "addPlanPoint"; x: number; y: number }
  | { type: "movePlanPoint"; idx: number; x: number; y: number }
  | { type: "removePlanPoint"; idx: number }
  // the sheer trim
  | { type: "addTrimPoint"; x: number; z: number }
  | { type: "moveTrim"; idx: number; x: number; z: number }
  | { type: "removeTrimPoint"; idx: number }
  | { type: "setTrimK"; idx: number; k: number }
  // the transom
  | { type: "moveTransom"; idx: number; x: number; z: number }
  // the stations
  | { type: "addStation"; u: number }
  | { type: "removeStation"; idx: number }
  | { type: "moveStationU"; idx: number; u: number }
  | { type: "setKeelK"; si: number; k: number }
  // a station's section points (index-aligned: an add or a remove hits every station)
  | { type: "addStationPoint"; si: number; n: number; z: number }
  | { type: "moveStationPoint"; si: number; idx: number; n: number; z: number }
  | { type: "removeStationPoint"; idx: number }
  | { type: "setStationK"; si: number; idx: number; k: number }
  // the document's scalars
  | { type: "setWaterline"; depth: number }
  | { type: "setDeckRakeDeg"; deg: number }
  | { type: "setName"; name: string }
  | { type: "setUnit"; unit: Unit; rescale: boolean }
  // a whole hull at once: open, import, revert, reset, or a blend
  | { type: "installHull"; state: HullState };

// Shared between a session's windows, never persisted, never undoable.
export type SessionCommand = { type: "setX0"; x: number };

// ---------- what a command touched ----------
// A bitmask of the slices whose revisions the owner must bump. `assemble` rebuilds a sampler only for the
// slices that moved, so this is what makes a waterline drag cost nothing.
export const SLICE = {
  plan: 1,
  trim: 2,
  transom: 4,
  stations: 8,
  scalars: 16,
} as const;
export const ALL_SLICES = 31;
export type SliceMask = number;

export interface Applied {
  state: HullState;
  touched: SliceMask;
  /** Session values a hull command also moves — only `installHull` and a rescaling `setUnit` do. */
  session?: Partial<SessionState>;
  /** The inserted index for the five adds; `false` where an op declined to do anything. */
  result?: number | boolean;
}
export type Outcome = Applied | { rejected: string };

export const rejected = (o: Outcome): o is { rejected: string } =>
  "rejected" in o;

// ---------- the draft ----------
// Mutable mirrors of the authored types. A command asks for the branches it needs, mutates them exactly as
// the old in-place operations did, and `commit()` rebuilds the state — sharing, by reference, every branch
// that was never asked for. That sharing is not an optimisation detail: it is what lets a reader compare
// slices cheaply, and it is why the mask below is exact rather than conservative.

type MutPlan = { x: number; y: number };
type MutTrim = { x: number; z: number; k: number };
type MutTransom = { x: number; z: number };
type MutPoint = { n: number; z: number; k: number };
type MutStation = { u: number; keelK: number; points: MutPoint[] };

interface Draft {
  plan(): MutPlan[];
  trim(): MutTrim[];
  transom(): MutTransom[];
  stations(): MutStation[];
  /** Mark the scalars dirty; they are assigned through `commit`'s patch rather than a mutable branch. */
  scalars(): void;
  commit(
    patch?: Partial<HullState>,
    extra?: Omit<Applied, "state" | "touched">,
  ): Applied;
}

function draft(base: HullState): Draft {
  let plan: MutPlan[] | null = null,
    trim: MutTrim[] | null = null,
    transom: MutTransom[] | null = null,
    stations: MutStation[] | null = null,
    touched = 0;
  return {
    plan() {
      if (!plan) {
        plan = base.sheerPlan.map((p) => ({ ...p }));
        touched |= SLICE.plan;
      }
      return plan;
    },
    trim() {
      if (!trim) {
        trim = base.sheerTrim.map((p) => ({ ...p }));
        touched |= SLICE.trim;
      }
      return trim;
    },
    transom() {
      if (!transom) {
        transom = base.transom.map((p) => ({ ...p }));
        touched |= SLICE.transom;
      }
      return transom;
    },
    stations() {
      if (!stations) {
        stations = base.stations.map((s) => ({
          u: s.u,
          keelK: s.keelK,
          points: s.points.map((p) => ({ ...p })),
        }));
        touched |= SLICE.stations;
      }
      return stations;
    },
    scalars() {
      touched |= SLICE.scalars;
    },
    commit(patch, extra) {
      return {
        state: {
          name: base.name,
          unit: base.unit,
          sheerPlan: (plan ?? base.sheerPlan) as readonly PlanCP[],
          sheerTrim: (trim ?? base.sheerTrim) as readonly TrimCP[],
          transom: (transom ?? base.transom) as readonly TransomCP[],
          stations: (stations ?? base.stations) as readonly StationCP[],
          waterline: base.waterline,
          deckRake: base.deckRake,
          ...patch,
        },
        touched,
        ...extra,
      };
    },
  };
}

// The one spacing rule between neighbouring control points, and it is not a matter of taste: the plan's x(u)
// and the sheer trim's z(x) are both READ as functions of x (bspline.ts inverts the one, pchip.ts differences
// the other), so two points that met would make that reading ambiguous — and the trim's PCHIP would divide by
// their zero spacing. Nothing needs more room than float noise, so this is a hair against the hull's own size:
// a point may be dragged right up against its neighbour, just not through it.
//
// Measured against the hull as it was BEFORE the command, which is what the in-place operations did too.
const hair = (before: Model): number => 1e-6 * (loa(before) || 1);

// The box the station editor is drawn in, and therefore what it clamps its section points to. It is measured
// against the session's `viewLen`, not the live plan — see `Model.viewLen`.
const stationBox = (before: Model) => boundsOf(before.viewLen);

// ---------- the reducer ----------

export function applyCommand(before: Model, cmd: HullCommand): Outcome {
  const d = draft(before);
  switch (cmd.type) {
    // ---- the sheer plan ----
    // Insert a plan control point at x. The plan is a B-spline control polygon, so the new point is placed
    // where the caller asks rather than on the curve — there is no "on the curve" to land on.
    case "addPlanPoint": {
      const cp = d.plan(),
        n = cp.length,
        e = hair(before);
      let k = cp.findIndex((p) => p.x > cmd.x);
      if (k < 0) k = n;
      if (k === 0)
        return { rejected: "the plan's first point is pinned at the transom" };
      const lo = cp[k - 1].x + e,
        hi = k < n ? cp[k].x - e : Infinity;
      if (lo > hi)
        return { rejected: "no room between the neighbouring plan points" };
      cp.splice(k, 0, { x: clamp(cmd.x, lo, hi), y: cmd.y });
      return d.commit(undefined, { result: k });
    }
    // The first plan point is pinned at the transom — it is the hull's origin, not a limit — so it moves only
    // in y; every other point, including the last, follows the pointer in x too, and the last one taken
    // forward simply lengthens the boat. y is free on both sides of the centerline: the plan crosses it to
    // close a tumblehome bow.
    case "movePlanPoint": {
      const cp = d.plan(),
        n = cp.length,
        e = hair(before);
      if (cmd.idx < 0 || cmd.idx >= n)
        return { rejected: "no such plan point" };
      if (cmd.idx > 0)
        cp[cmd.idx].x = clamp(
          cmd.x,
          cp[cmd.idx - 1].x + e,
          cmd.idx < n - 1 ? cp[cmd.idx + 1].x - e : Infinity,
        );
      cp[cmd.idx].y = cmd.y;
      return d.commit();
    }
    // The removes each keep enough structure for the hull to remain well formed: the plan and the trim keep
    // both ends and a minimum of three points.
    case "removePlanPoint": {
      const cp = d.plan();
      if (cp.length <= 3 || cmd.idx <= 0 || cmd.idx >= cp.length - 1)
        return d.commit(undefined, { result: false });
      cp.splice(cmd.idx, 1);
      return d.commit(undefined, { result: true });
    }

    // ---- the sheer trim ----
    // The trim's first point is not pinned to anything, so a click aft of it inserts a new aft end.
    case "addTrimPoint": {
      const cp = d.trim(),
        n = cp.length,
        e = hair(before);
      let k = cp.findIndex((p) => p.x > cmd.x);
      if (k < 0) k = n;
      const lo = k > 0 ? cp[k - 1].x + e : -Infinity,
        hi = k < n ? cp[k].x - e : Infinity;
      if (lo > hi)
        return { rejected: "no room between the neighbouring trim points" };
      cp.splice(k, 0, { x: clamp(cmd.x, lo, hi), z: cmd.z, k: 0 });
      return d.commit(undefined, { result: k });
    }
    // Free in z — above the flat deck as readily as below it — and free in x, both ends included.
    case "moveTrim": {
      const cp = d.trim(),
        n = cp.length,
        e = hair(before);
      if (cmd.idx < 0 || cmd.idx >= n)
        return { rejected: "no such trim point" };
      cp[cmd.idx].x = clamp(
        cmd.x,
        cmd.idx > 0 ? cp[cmd.idx - 1].x + e : -Infinity,
        cmd.idx < n - 1 ? cp[cmd.idx + 1].x - e : Infinity,
      );
      cp[cmd.idx].z = cmd.z;
      return d.commit();
    }
    case "removeTrimPoint": {
      const cp = d.trim();
      if (cp.length <= 3 || cmd.idx <= 0 || cmd.idx >= cp.length - 1)
        return d.commit(undefined, { result: false });
      cp.splice(cmd.idx, 1);
      return d.commit(undefined, { result: true });
    }
    case "setTrimK": {
      const cp = d.trim(),
        p = cp[cmd.idx];
      if (!p) return { rejected: "no such trim point" };
      p.k = clamp(cmd.k, 0, 1);
      return d.commit();
    }

    // ---- the transom ----
    // It goes anywhere in the profile; only the ORDER of its two points is held, because they are read as a
    // line x(z) through two heights and the plane inverts if the top drops below the bottom.
    case "moveTransom": {
      const cp = d.transom(),
        e = hair(before);
      if (!cp[cmd.idx]) return { rejected: "no such transom point" };
      cp[cmd.idx].x = cmd.x;
      cp[cmd.idx].z =
        cmd.idx === 0
          ? Math.max(cmd.z, cp[1].z + e)
          : Math.min(cmd.z, cp[0].z - e);
      return d.commit();
    }

    // ---- the stations ----
    // Insert a station at u. Its points are read off the LOFT there, so the hull is unchanged by the insert —
    // it just gains a handle, exactly where the surface already was. This is the command that makes the set
    // unreplayable: the loft it reads is the one belonging to the pre-state.
    case "addStation": {
      const sts = d.stations(),
        n = sts.length;
      let k = sts.findIndex((s) => s.u > cmd.u);
      if (k < 0) k = n;
      const lo = k > 0 ? sts[k - 1].u + U_GAP : 0,
        hi = k < n ? sts[k].u - U_GAP : 1;
      if (lo > hi)
        return { rejected: "no room between the neighbouring stations" };
      const uu = clamp(cmd.u, lo, hi),
        { pts, ks, keelK } = before.loft.at(uu);
      sts.splice(k, 0, {
        u: uu,
        keelK,
        points: pts.map((p, i) => ({ n: p[0], z: p[1], k: ks[i] })),
      });
      return d.commit(undefined, { result: k });
    }
    // A hull needs at least one station; below that there is no section to sweep at all.
    case "removeStation": {
      const sts = d.stations();
      if (sts.length <= 1 || cmd.idx < 0 || cmd.idx >= sts.length)
        return d.commit(undefined, { result: false });
      sts.splice(cmd.idx, 1);
      return d.commit(undefined, { result: true });
    }
    // Drag a station along the sheer. This is the edit v1 had no way to express: a template had no position,
    // only a weight curve, so "where does this section apply" could only be said indirectly.
    case "moveStationU": {
      const sts = d.stations();
      if (!sts[cmd.idx]) return { rejected: "no such station" };
      const lo = cmd.idx > 0 ? sts[cmd.idx - 1].u + U_GAP : 0,
        hi = cmd.idx < sts.length - 1 ? sts[cmd.idx + 1].u - U_GAP : 1;
      sts[cmd.idx].u = clamp(cmd.u, Math.min(lo, hi), Math.max(lo, hi));
      return d.commit();
    }
    case "setKeelK": {
      const sts = d.stations();
      if (!sts[cmd.si]) return { rejected: "no such station" };
      sts[cmd.si].keelK = clamp(cmd.k, 0, 1);
      return d.commit();
    }

    // ---- a station's section points ----
    // Insert into EVERY station at the same place along each one's own curve, so the stations stay
    // index-aligned — the loft is built across matching indices, so a point that existed in only some of them
    // would have no curve to ride.
    case "addStationPoint": {
      const sts = d.stations();
      if (!sts[cmd.si]) return { rejected: "no such station" };
      const arr = sts[cmd.si].points,
        b = stationBox(before);
      // the segment nearest the click, and how far along it
      let best = 1,
        bt = 0.5,
        bd = Infinity;
      for (let i = 0; i < arr.length - 1; i++) {
        const an = arr[i].n,
          az = arr[i].z,
          vn = arr[i + 1].n - an,
          vz = arr[i + 1].z - az,
          l2 = vn * vn + vz * vz || 1,
          t = clamp(((cmd.n - an) * vn + (cmd.z - az) * vz) / l2, 0, 1),
          dist = Math.hypot(cmd.n - (an + vn * t), cmd.z - (az + vz * t));
        if (dist < bd) {
          bd = dist;
          best = i + 1;
          bt = t;
        }
      }
      sts.forEach((st, j) => {
        const a = st.points[best - 1],
          c = st.points[best];
        if (j === cmd.si)
          st.points.splice(best, 0, {
            n: clamp(cmd.n, b.nMin, b.nMax),
            z: clamp(cmd.z, Math.min(a.z, c.z), Math.max(a.z, c.z)),
            k: 0,
          });
        else
          st.points.splice(best, 0, {
            n: lerp(a.n, c.n, bt),
            z: lerp(a.z, c.z, bt),
            k: lerp(a.k, c.k, bt),
          });
      });
      return d.commit(undefined, { result: best });
    }
    // Drag a section point: n across the section, z down — kept between its neighbours so the section never
    // curls back up on itself.
    case "moveStationPoint": {
      const sts = d.stations();
      if (!sts[cmd.si]?.points[cmd.idx])
        return { rejected: "no such station point" };
      const arr = sts[cmd.si].points,
        b = stationBox(before),
        cp = arr[cmd.idx];
      cp.n = clamp(cmd.n, b.nMin, b.nMax);
      const hi = cmd.idx > 0 ? arr[cmd.idx - 1].z : 0,
        lo = cmd.idx < arr.length - 1 ? arr[cmd.idx + 1].z : b.zMin;
      cp.z = clamp(cmd.z, lo, hi);
      return d.commit();
    }
    // A station's points keep the deck point and the deepest one. The index goes from every station at once.
    case "removeStationPoint": {
      const sts = d.stations(),
        len = sts[0].points.length;
      if (len <= 3 || cmd.idx <= 0 || cmd.idx >= len - 1)
        return d.commit(undefined, { result: false });
      sts.forEach((st) => st.points.splice(cmd.idx, 1));
      return d.commit(undefined, { result: true });
    }
    case "setStationK": {
      const sts = d.stations(),
        p = sts[cmd.si]?.points[cmd.idx];
      if (!p) return { rejected: "no such station point" };
      p.k = clamp(cmd.k, 0, 1);
      return d.commit();
    }

    // ---- the document's scalars ----
    case "setWaterline":
      d.scalars();
      return d.commit({ waterline: cmd.depth });
    case "setDeckRakeDeg":
      d.scalars();
      return d.commit({ deckRake: (cmd.deg * Math.PI) / 180 });
    case "setName":
      d.scalars();
      return d.commit({ name: cmd.name });
    // Change the document's unit. `rescale` keeps the hull the same PHYSICAL size by converting the numbers
    // (2000 mm → 2 m); without it the numbers stand and the hull is reinterpreted at the new unit's size. The
    // cut station is a length too, so a rescale carries it along.
    case "setUnit": {
      d.scalars();
      if (!cmd.rescale || before.unit === cmd.unit)
        return d.commit({ unit: cmd.unit });
      const s = UNIT_MM[before.unit] / UNIT_MM[cmd.unit];
      d.plan().forEach((p) => ((p.x *= s), (p.y *= s)));
      d.trim().forEach((p) => ((p.x *= s), (p.z *= s)));
      d.transom().forEach((p) => ((p.x *= s), (p.z *= s)));
      d.stations().forEach((st) =>
        st.points.forEach((p) => ((p.n *= s), (p.z *= s))),
      );
      return d.commit(
        { unit: cmd.unit, waterline: before.waterline * s },
        { session: { x0: before.x0 * s } },
      );
    }

    // ---- a whole hull ----
    // Open, import, revert, reset, blend. The 2D views are laid out against the hull that is installed, not
    // the one it replaced, and the cut station is brought inside the new boat.
    case "installHull": {
      const len = loa(cmd.state);
      return {
        state: cmd.state,
        touched: ALL_SLICES,
        session: { x0: clamp(before.x0, 0, len), viewLen: len },
      };
    }
  }
}

/** Session commands never touch the hull, so they have a reducer of their own. */
export function applySessionCommand(
  before: Model,
  session: SessionState,
  cmd: SessionCommand,
): SessionState {
  switch (cmd.type) {
    case "setX0":
      return { ...session, x0: clamp(cmd.x, 0, loa(before)) };
  }
}

// A station point and a trim point both carry a knuckle, and the selection may name either. Resolving the
// selection to a command is the CALLER's job — the selection is window-local and must never appear in a
// command — so these two are the shapes it resolves to.
export type KnuckleTarget =
  { tgt: "trim"; idx: number } | { tgt: "station"; si: number; idx: number };

export const setKnuckleCommand = (
  target: KnuckleTarget,
  k: number,
): HullCommand =>
  target.tgt === "trim"
    ? { type: "setTrimK", idx: target.idx, k }
    : { type: "setStationK", si: target.si, idx: target.idx, k };

// The five commands whose result is an inserted index. Consecutive drags coalesce in the undo stack; these
// never do, because each one is a distinct structural change.
export const isInsert = (cmd: HullCommand): boolean =>
  cmd.type === "addPlanPoint" ||
  cmd.type === "addTrimPoint" ||
  cmd.type === "addStation" ||
  cmd.type === "addStationPoint";

/** Structural commands are meaningful only against the collection indices they were composed from. */
export function requiresCurrentBase(cmd: HullCommand): boolean {
  return (
    cmd.type === "addPlanPoint" ||
    cmd.type === "removePlanPoint" ||
    cmd.type === "addTrimPoint" ||
    cmd.type === "removeTrimPoint" ||
    cmd.type === "addStation" ||
    cmd.type === "removeStation" ||
    cmd.type === "addStationPoint" ||
    cmd.type === "removeStationPoint" ||
    cmd.type === "installHull"
  );
}

/** The slices another author must have changed before a structural command is stale. */
export function commandSlices(cmd: HullCommand): SliceMask {
  switch (cmd.type) {
    case "addPlanPoint":
    case "movePlanPoint":
    case "removePlanPoint":
      return SLICE.plan;
    case "addTrimPoint":
    case "moveTrim":
    case "removeTrimPoint":
    case "setTrimK":
      return SLICE.trim;
    case "moveTransom":
      return SLICE.transom;
    case "addStation":
    case "removeStation":
    case "moveStationU":
    case "setKeelK":
    case "addStationPoint":
    case "moveStationPoint":
    case "removeStationPoint":
    case "setStationK":
      return SLICE.stations;
    case "setWaterline":
    case "setDeckRakeDeg":
    case "setName":
      return SLICE.scalars;
    case "setUnit":
    case "installHull":
      return ALL_SLICES;
  }
}

// Two commands coalesce into one undo step when they are the same continuous gesture: the same kind of move
// against the same target. Only the moves qualify — an add or a remove is its own step, and so is every
// scalar the user typed rather than dragged.
export function sameGesture(a: HullCommand, b: HullCommand): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "movePlanPoint":
    case "moveTrim":
    case "moveTransom":
    case "moveStationU":
      return a.idx === (b as typeof a).idx;
    case "moveStationPoint":
      return a.si === (b as typeof a).si && a.idx === (b as typeof a).idx;
    case "setTrimK":
    case "setStationK":
    case "setKeelK":
    case "setWaterline":
    case "setDeckRakeDeg":
    case "setName":
      return true; // a slider or a text field, held down or typed into
    default:
      return false;
  }
}

// Re-exported so a caller building a command need not also import the authored types.
export type { StationPointCP };
