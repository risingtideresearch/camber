// ---------- what a session authors ----------
//
// A session used to author exactly one thing, so the store carried a `HullState` and called it "the state".
// It now authors two: the hull, and the weight sheet that estimates what the hull will displace. They are
// SIBLINGS rather than one inside the other, and the split is load-bearing in both directions:
//
//   • The sheet is not part of the hull DOCUMENT. `json.ts` and `document.ts` describe a hull and nothing
//     else, and five consumers depend on that — export, import, the library, `promote.ts` and `blend.ts`.
//     A `HullDocument` that sometimes carried a weight schedule would make every one of them answer an
//     awkward question (what is the blend of two weight sheets?). It is persisted BESIDE the document, in
//     its own column, and `buildJson` still writes a pure hull.
//
//   • The sheet is very much part of the SESSION. It wants undo, the history tree, and the same replication
//     across a session's windows that the hull gets. Re-implementing those beside the store would be the
//     real mistake, so it joins the state the store already replicates rather than living outside it.
//
// The store below this is written against `SessionDocument`, not `HullState`. Nothing in `core/` that works
// on hulls learns that sheets exist: `hull.ts`, `model.ts`, `hydro.ts`, `sweep.ts` and `stability.ts` are
// untouched by this file, and a hull command is still interpreted against a hull.
//
// The next thing that wants session-scoped, undoable, replicated state — a materials library, build costs,
// a notes pane — is a field here and a command family, not another round of this.

import { cloneHull, defaultHull, type HullState } from "./hull";
import { cloneBook, emptyBook, type WeightBook } from "./sheet/book";

export interface SessionDocument {
  readonly hull: HullState;
  /** The weight estimate: pages of named rows. See `sheet/book.ts`. */
  readonly weights: WeightBook;
}

export const defaultDocument = (): SessionDocument => ({
  hull: defaultHull(),
  weights: emptyBook(),
});

export const cloneDocument = (doc: SessionDocument): SessionDocument => ({
  hull: cloneHull(doc.hull),
  weights: cloneBook(doc.weights),
});

/** A document around an already-built hull, for the paths that load or blend one and have no sheet. */
export const documentOf = (
  hull: HullState,
  weights: WeightBook = emptyBook(),
): SessionDocument => ({ hull, weights });
