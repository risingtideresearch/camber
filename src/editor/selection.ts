// Selection-derived helpers: what a given selection can do (delete / knuckle) and how it reads. Pure
// functions over the model + selection, kept out of the components so the delete/knuckle handlers and the
// SelectionInfo readout share one source of truth.
//
// The selection is WINDOW-LOCAL and must never appear in a command — the document server has no idea what
// this window has selected, and two windows may have selected different things. So the two operations that
// used to reach into the model through a selection now resolve it to a command here, and the caller
// dispatches that.

import type { Model } from "../core/model";
import { isStationEnd } from "../core/hull";
import type { DocumentCommand } from "../core/commands";
import type {
  ModelSelection,
  ModelSelectionTarget,
} from "../core/modelSelection";

// the knuckle-carrying point array for the current selection (a station's section, or the sheer trim), or
// null. Both StationPointCP and TrimCP carry `.k`, so the knuckle field drives either.
export function selArr(
  model: Model,
  selection: ModelSelection,
): readonly { readonly k: number }[] | null {
  if (!selection) return null;
  if (selection.tgt === "station" && selection.si !== undefined)
    return model.stations[selection.si]?.points ?? null;
  if (selection.tgt === "trim") return model.sheerTrim;
  return null;
}

// can the selected point be deleted? Ends are pinned; the plan / trim / section keep a minimum of 3 points;
// the transom is a fixed pair of points.
export function canDelete(
  model: Model,
  s: { tgt: ModelSelectionTarget; idx: number },
): boolean {
  if (s.tgt === "transom") return false;
  if (s.tgt === "plan")
    return (
      model.sheerPlan.length > 3 &&
      s.idx > 0 &&
      s.idx < model.sheerPlan.length - 1
    );
  if (s.tgt === "trim")
    return (
      model.sheerTrim.length > 3 &&
      s.idx > 0 &&
      s.idx < model.sheerTrim.length - 1
    );
  // a station point: the stations are index-aligned, so the count is shared and deleting removes the index
  // from every one of them
  const len = model.stations[0].points.length;
  return len > 3 && s.idx > 0 && s.idx < len - 1;
}

// points whose knuckle (k) can be set: every sheer-trim point, and every interior station point. A station's
// deck point and bottom point are corners by construction — the section curve is cut there — so their k is
// pinned to 1 (see `stationKnuckle`) and the field is disabled on them. The plan / transom points carry no
// knuckle at all.
export function hasKnuckle(
  model: Model,
  s: { tgt: ModelSelectionTarget; idx: number; si?: number },
): boolean {
  if (s.tgt === "trim") return true;
  if (s.tgt !== "station") return false;
  const arr = model.stations[s.si ?? 0]?.points;
  return !!arr && !isStationEnd(arr.length, s.idx);
}

// One editable value of the selection, as the SelectionInfo readout shows it: a coordinate of the selected
// point, or its knuckle. `command` resolves a typed (or scrubbed) value to the command that sets it — a move
// carries both coordinates, so the one not being edited rides along unchanged. A `disabled` field is shown
// but cannot be edited, and `title` says why.
export interface SelectionField {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly command: (v: number) => DocumentCommand | null;
}

// The fields of the current selection — which depend only on WHAT is selected (plan: x y · trim: x z k ·
// transom: x z · station: z n k), so the readout keeps its shape from one point to the next; a value that is
// pinned by construction is disabled rather than dropped. Empty where nothing is selected, or where the
// selection no longer resolves to a point (see SelectionInfo).
export function selectionFields(
  model: Model,
  selection: ModelSelection,
): SelectionField[] {
  if (!selection) return [];
  const { tgt, idx } = selection;
  const knuckle = (k: number, pinned: boolean): SelectionField => ({
    key: "k",
    label: "k",
    value: k,
    min: 0,
    max: 1,
    disabled: pinned,
    title: pinned
      ? "The first and last points of a station are always hard corners"
      : "Knuckle: 0 = smooth · 1 = hard corner",
    command: (v) => knuckleCommand(model, selection, v),
  });
  if (tgt === "plan") {
    const p = model.sheerPlan[idx];
    if (!p) return [];
    return [
      {
        key: "x",
        label: "x",
        value: p.x,
        disabled: idx === 0,
        title:
          idx === 0 ? "The first sheer point is pinned along x" : undefined,
        command: (x) => ({ type: "movePlanPoint", idx, x, y: p.y }),
      },
      {
        key: "y",
        label: "y",
        value: p.y,
        command: (y) => ({ type: "movePlanPoint", idx, x: p.x, y }),
      },
    ];
  }
  if (tgt === "trim") {
    const p = model.sheerTrim[idx];
    if (!p) return [];
    return [
      {
        key: "x",
        label: "x",
        value: p.x,
        command: (x) => ({ type: "moveTrim", idx, x, z: p.z }),
      },
      {
        key: "z",
        label: "z",
        value: p.z,
        command: (z) => ({ type: "moveTrim", idx, x: p.x, z }),
      },
      knuckle(p.k, false),
    ];
  }
  if (tgt === "transom") {
    const p = model.transom[idx];
    if (!p) return [];
    return [
      {
        key: "x",
        label: "x",
        value: p.x,
        command: (x) => ({ type: "moveTransom", idx, x, z: p.z }),
      },
      {
        key: "z",
        label: "z",
        value: p.z,
        command: (z) => ({ type: "moveTransom", idx, x: p.x, z }),
      },
    ];
  }
  const si = selection.si ?? 0;
  const p = model.stations[si]?.points[idx];
  if (!p) return [];
  // a station's deck and bottom points read 1 — they are corners by construction, so the field is pinned
  const pinned = !hasKnuckle(model, selection);
  return [
    {
      key: "z",
      label: "z",
      value: p.z,
      command: (z) => ({ type: "moveStationPoint", si, idx, n: p.n, z }),
    },
    {
      key: "n",
      label: "n",
      value: p.n,
      command: (n) => ({ type: "moveStationPoint", si, idx, n, z: p.z }),
    },
    knuckle(pinned ? 1 : p.k, pinned),
  ];
}

export function labelFor(s: {
  tgt: ModelSelectionTarget;
  idx: number;
  si?: number;
}): string {
  if (s.tgt === "station")
    return `Station ${(s.si ?? 0) + 1} · point ${s.idx + 1}`;
  const name = { plan: "Sheer (plan)", trim: "Sheer trim", transom: "Transom" }[
    s.tgt as "plan" | "trim" | "transom"
  ];
  return `${name} · point ${s.idx + 1}`;
}

// The command that sets the knuckle k of the selected point (a sheer-trim point, or a station point), or null
// where the selection carries no knuckle.
export function knuckleCommand(
  model: Model,
  selection: ModelSelection,
  k: number,
): DocumentCommand | null {
  if (!selection || !selArr(model, selection) || !hasKnuckle(model, selection))
    return null;
  return selection.tgt === "trim"
    ? { type: "setTrimK", idx: selection.idx, k }
    : { type: "setStationK", si: selection.si ?? 0, idx: selection.idx, k };
}

// The command that deletes the selected control point, or null where it may not be deleted. This is where
// one window-local selection becomes one of the three remove commands.
export function deleteCommand(
  model: Model,
  selection: ModelSelection,
): DocumentCommand | null {
  if (!selection || !canDelete(model, selection)) return null;
  if (selection.tgt === "plan")
    return { type: "removePlanPoint", idx: selection.idx };
  if (selection.tgt === "trim")
    return { type: "removeTrimPoint", idx: selection.idx };
  return { type: "removeStationPoint", idx: selection.idx }; // from every station
}
