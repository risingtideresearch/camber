// Branching history for one document session.
//
// The history is a TREE of states, not two stacks. Every gesture hangs a child off wherever the document
// stands, so going back and editing again does not throw away what came after: it starts a second branch
// beside the first, and both stay reachable for as long as the depth cap keeps them. Nothing is ever lost by
// exploring, which is the point — undo stops being a door that closes behind you.
//
// Because a node holds the whole state, travelling to one is a jump, not a walk: however far away a moment is
// in the tree, restoring it is a single transition. The only thing the distance decides is which slices the
// jump touched, which is the union of the edges it crossed.
//
// DocumentHistory owns the tree, the depth cap, and gesture coalescing. It deliberately does not install
// states, increment revisions, validate hulls, or publish snapshots; DocumentStoreServer performs those
// authoritative operations around the transitions returned here.

import {
  describeCommand,
  sameGesture,
  type DocumentCommand,
  type SliceMask,
} from "../core/commands";
import type { HullState } from "../core/hull";

export interface HistoryRecord {
  /** The state the gesture was applied to. Used only to plant the root when the tree is still empty. */
  readonly before: HullState;
  /** The state the gesture produced — what the new node restores. */
  readonly after: HullState;
  readonly touched: SliceMask;
  readonly command: DocumentCommand;
  readonly author: string;
  readonly at?: number;
}

export interface HistoryTransition {
  readonly state: HullState;
  /** Every slice crossed on the way, so one jump bumps the same clocks the equivalent walk would have. */
  readonly touched: SliceMask;
}

// ---------- the tree, described ----------
// What a reader can be told about the history without being handed it. A step names a gesture, says who made
// it and when, and points at its neighbours; the HullState it would restore stays here, because it is large,
// private to the authority, and no use to a reader anyway — travelling to a step is asking the authority to
// go there, not installing a state from outside.

export interface HistoryStep {
  /** Stable identity, in the order the gestures were recorded. Nothing renumbers it. */
  readonly id: number;
  /** The moment this gesture was applied to; `null` at the root, which nothing precedes. */
  readonly parent: number | null;
  /**
   * The moments that grew out of this one, in the order they were made. Travelling never reorders them: a
   * reader's drawing is a function of the tree's shape alone, so looking around does not move it.
   */
  readonly children: readonly number[];
  /** `null` at the root, which is a state rather than a gesture. */
  readonly kind: DocumentCommand["type"] | null;
  /** `describeCommand` of the gesture as it last stood — a coalesced drag reads as its final move. */
  readonly label: string;
  /** The window that made the edit (its windowId), so a tree shows who did what. Empty at the root. */
  readonly author: string;
  readonly at: number;
  readonly touched: SliceMask;
}

export interface HistoryTimeline {
  /** Every kept moment. The order is creation order; a reader builds its own from `parent` / `children`. */
  readonly steps: readonly HistoryStep[];
  /** Where the tree starts, and where the document currently stands. `null` only before the first edit. */
  readonly root: number | null;
  readonly current: number | null;
  /** The cap on kept gestures. */
  readonly depth: number;
  /** Whether the cap has already cost the tree its oldest moments, root included. */
  readonly truncated: boolean;
}

export interface DocumentHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  record(record: HistoryRecord): void;
  undo(): HistoryTransition | null;
  redo(): HistoryTransition | null;
  /** Jump to any kept moment. `null` if the id is unknown — a branch the depth cap has since dropped. */
  travel(id: number): HistoryTransition | null;
  /** A transportable description of the tree. Holds no HullState, so it is cheap to send to a window. */
  timeline(): HistoryTimeline;
  clear(): void;
}

export interface DocumentHistoryOptions {
  readonly depth?: number;
  readonly coalesceMs?: number;
  readonly now?: () => number;
  /** The state the session opened with. Given one, the tree has a root before anything has been edited. */
  readonly initial?: HullState;
  readonly sameGesture?: (
    before: DocumentCommand,
    after: DocumentCommand,
  ) => boolean;
}

// A node is a moment: the whole state as it stood after `command`, plus the slices that command changed
// relative to its parent. Absolute states rather than diffs are what make an arbitrary jump one transition,
// and `touched` is what makes it a correctly-clocked one.
interface Node {
  readonly id: number;
  parent: Node | null;
  /** Creation order, and it stays that way — see HistoryStep.children for why nothing may reorder it. */
  readonly children: Node[];
  /**
   * The child last travelled through, in either direction. This is what `redo` owes an `undo`: the way you
   * came, not the newest branch. It is kept apart from `children` deliberately — where you have been is a
   * property of the visit, not of the history, and it must not disturb how the tree reads.
   */
  resume: Node | null;
  state: HullState;
  touched: SliceMask;
  command: DocumentCommand | null;
  author: string;
  at: number;
}

/** Snapshot-based branching document history. It owns tree policy, but never mutates or publishes state. */
export function createDocumentHistory(
  options: DocumentHistoryOptions = {},
): DocumentHistory {
  const depth = options.depth ?? 200;
  const coalesceMs = options.coalesceMs ?? 400;
  const now = options.now ?? Date.now;
  const gesturesEqual = options.sameGesture ?? sameGesture;
  // Keyed by id because that is how a window asks to travel: a reader holds ids, never nodes.
  const nodes = new Map<number, Node>();
  let nextId = 1;
  let root: Node | null = null;
  let current: Node | null = null;
  let truncated = false;

  const plant = (state: HullState): void => {
    root = {
      id: nextId++,
      parent: null,
      children: [],
      resume: null,
      state,
      touched: 0,
      command: null,
      author: "",
      at: now(),
    };
    nodes.set(root.id, root);
    current = root;
  };

  if (options.initial) plant(options.initial);

  // Remember the way we came, so `redo` can retrace it. Nothing about the tree's shape changes: an edge is
  // noted as travelled, and the moments stay in the order they were made.
  const remember = (child: Node): void => {
    if (child.parent) child.parent.resume = child;
  };

  // The cap counts gestures, so the tree may hold one more node than that: the state they were applied to.
  const prune = (): void => {
    while (nodes.size > depth + 1 && root && current) {
      // Give up the stalest tip first — the end of a branch nobody has come back to is what a reader misses
      // least. Where the document stands is never a candidate, so a jump always still has somewhere to land.
      let victim: Node | null = null;
      for (const node of nodes.values())
        if (
          node.children.length === 0 &&
          node !== current &&
          node !== root &&
          (!victim || node.at < victim.at)
        )
          victim = node;
      if (victim) {
        if (victim.parent) {
          victim.parent.children.splice(
            victim.parent.children.indexOf(victim),
            1,
          );
          if (victim.parent.resume === victim) victim.parent.resume = null;
        }
        nodes.delete(victim.id);
        continue;
      }
      // Nothing but a single line left, with the document at the end of it. The only thing still to give up
      // is the oldest state, so the tree loses its root and the moment after it becomes the new one.
      if (root.children.length !== 1) break;
      const next = root.children[0];
      nodes.delete(root.id);
      next.parent = null;
      root = next;
      truncated = true;
    }
  };

  const step = (node: Node): HistoryStep => ({
    id: node.id,
    parent: node.parent?.id ?? null,
    children: node.children.map((child) => child.id),
    kind: node.command?.type ?? null,
    label: node.command ? describeCommand(node.command) : "Session start",
    author: node.author,
    at: node.at,
    touched: node.touched,
  });

  const travel = (id: number): HistoryTransition | null => {
    const target = nodes.get(id);
    if (!target || !current || target === current) return null;
    // Two moments' paths meet at their nearest common ancestor: up from here to the meeting point, then down
    // the other side. Crossing an edge in either direction changes the same slices, so the union over the
    // whole journey is what the jump touched.
    const behind = new Set<Node>();
    for (let node: Node | null = current; node; node = node.parent)
      behind.add(node);
    const down: Node[] = [];
    let meet: Node | null = target;
    while (meet && !behind.has(meet)) {
      down.push(meet);
      meet = meet.parent;
    }
    if (!meet) return null;
    let touched: SliceMask = 0;
    for (let node: Node | null = current; node && node !== meet;) {
      touched |= node.touched;
      remember(node);
      node = node.parent;
    }
    for (const node of down) {
      touched |= node.touched;
      remember(node);
    }
    current = target;
    return { state: target.state, touched };
  };

  return {
    get canUndo() {
      return current?.parent != null;
    },
    get canRedo() {
      return (current?.children.length ?? 0) > 0;
    },
    record(record) {
      const at = record.at ?? now();
      if (!current) plant(record.before);
      const here = current!;
      // A pointer drag emits many commands. They coalesce into the moment the document stands on only when
      // gesture identity, author, and timing all agree — so another window's edit can never disappear into
      // this window's step — and never when that moment already has children, because it is then a branch
      // point shared with the branches hanging off it and cannot be rewritten under them.
      if (
        here.children.length === 0 &&
        here.command &&
        here.author === record.author &&
        at - here.at < coalesceMs &&
        gesturesEqual(here.command, record.command)
      ) {
        here.state = record.after;
        here.touched |= record.touched;
        here.command = record.command;
        here.at = at;
        return;
      }
      // The new moment simply joins the ones already here. An edit made after going back therefore branches
      // rather than truncating: whatever hung off this point still hangs off it.
      const child: Node = {
        id: nextId++,
        parent: here,
        children: [],
        resume: null,
        state: record.after,
        touched: record.touched,
        command: record.command,
        author: record.author,
        at,
      };
      here.children.push(child);
      here.resume = child;
      nodes.set(child.id, child);
      current = child;
      prune();
    },
    undo() {
      return current?.parent ? travel(current.parent.id) : null;
    },
    redo() {
      // Back the way we came. With nothing remembered — a branch travelled away from and since dropped —
      // the newest moment forward from here is the best answer left.
      if (!current) return null;
      const next =
        current.resume ?? current.children[current.children.length - 1];
      return next ? travel(next.id) : null;
    },
    travel,
    timeline: () => ({
      steps: [...nodes.values()].map(step),
      root: root?.id ?? null,
      current: current?.id ?? null,
      depth,
      truncated,
    }),
    clear() {
      nodes.clear();
      root = null;
      current = null;
      truncated = false;
    },
  };
}
