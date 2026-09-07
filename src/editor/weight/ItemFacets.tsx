// ---------- how an item is filed ----------
//
// Facets are the only thing on an item card no formula can mention, and that is deliberate: filing is what a
// user must stay free to change, so it must never appear in an address. Editing one here does the same thing
// dragging the item onto a node in the explorer does — one `setFacet` — because they are the same statement.
//
// ---------- a path is edited one level at a time ----------
//
// A facet VALUE is a path — `structure/hull/shell` — and that path is the tree the explorer draws. Typed
// into a single box it is a piece of syntax nobody is told about: the separator is invisible until it is
// already correct, and nothing says what the levels below `structure` are called in this book, so a second
// spelling of a branch that exists is the easiest mistake to make and the hardest to see afterwards.
//
// So a value is rendered as its segments, each its own cell, with `/` drawn between them and `+` at the end.
// Extending a path is then a visible act rather than a remembered character, and each cell offers the
// segments already in use at ITS level under ITS parent (`facetChildren`), which is what stops `hull` and
// `hulls` becoming two branches. A cell still accepts a sub-path outright — `hull/shell` in one box commits
// as two levels — because someone who knows the shape should not have to click through it.
//
// ---------- nothing half-filed is written ----------
//
// A facet key with no value does not exist: `setFacet` with an empty value REMOVES the key, which is the one
// shape "not filed" has. So a facet being created, and a level being added, live as a DRAFT here — an empty
// cell that has the caret — and reach the book only when they have something to say. Abandoning one leaves
// no trace, and the item is never briefly filed under a placeholder that would have shown up in the tree.

import { Fragment, useId, useState } from "react";
import type { DocumentCommand } from "../../core/commands";
import {
  facetChildren,
  facetKeys,
  facetSegments,
  isValidName,
  tidyFacetValue,
  tidyName,
  type Item,
  type WeightBook,
} from "../../core/sheet/book";
import { Field } from "./weightFields";

/** The one empty cell that may be open: which facet it belongs to, and which level it would become. */
interface Draft {
  readonly key: string;
  readonly depth: number;
}

export function ItemFacets({
  book,
  item,
  send,
}: {
  readonly book: WeightBook;
  readonly item: Item;
  readonly send: (command: DocumentCommand) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const file = (key: string, segments: readonly string[]) => {
    send({
      type: "setFacet",
      item: item.id,
      key,
      value: segments.join("/"),
    });
    setDraft(null);
  };
  const entries = Object.entries(item.facets);
  // A key being filed for the FIRST time is not on the item yet — it is only the draft — so it is drawn
  // beside the real ones rather than written to the book as something with no value.
  const fresh = draft && !(draft.key in item.facets) ? draft.key : null;
  return (
    <div className="wfacets">
      {entries.map(([key, value]) => (
        <FacetPath
          key={key}
          book={book}
          facetKey={key}
          segments={facetSegments(value)}
          draftAt={draft?.key === key ? draft.depth : null}
          onDraft={(depth) => setDraft({ key, depth })}
          onCloseDraft={() => setDraft(null)}
          onFile={(segments) => file(key, segments)}
          onUnfile={() => file(key, [])}
        />
      ))}
      {fresh && (
        <FacetPath
          key={fresh}
          book={book}
          facetKey={fresh}
          segments={[]}
          draftAt={0}
          onDraft={(depth) => setDraft({ key: fresh, depth })}
          onCloseDraft={() => setDraft(null)}
          onFile={(segments) => file(fresh, segments)}
          // Nothing has been written yet, so dropping it is only forgetting the draft.
          onUnfile={() => setDraft(null)}
        />
      )}
      <AddFacet
        book={book}
        item={item}
        // Naming a facet the item already has extends that path rather than opening a second chip for it:
        // one key files an item once, so there is only ever the end of its path to type into.
        onAdd={(key) => {
          const filed = item.facets[key];
          setDraft({ key, depth: filed ? facetSegments(filed).length : 0 });
        }}
      />
    </div>
  );
}

/**
 * One facet: its key, the segments of its path, and the two things that can be done to the whole of it.
 *
 * Editing a segment edits THAT LEVEL and keeps what is under it, the way renaming a folder keeps what is in
 * it. Clearing one deletes the level and lifts the rest up a step; unfiling entirely is the `×`, which is a
 * different statement and so is a different control.
 */
function FacetPath({
  book,
  facetKey,
  segments,
  draftAt,
  onDraft,
  onCloseDraft,
  onFile,
  onUnfile,
}: {
  readonly book: WeightBook;
  readonly facetKey: string;
  readonly segments: readonly string[];
  readonly draftAt: number | null;
  readonly onDraft: (depth: number) => void;
  readonly onCloseDraft: () => void;
  readonly onFile: (segments: readonly string[]) => void;
  readonly onUnfile: () => void;
}) {
  const path = segments.join("/");
  // A segment commits as a value in its own right, so `hull/shell` typed into one cell becomes two levels
  // and an emptied cell becomes none.
  const commit = (depth: number, text: string) => {
    const tidied = tidyFacetValue(text);
    const inserted = tidied ? tidied.split("/") : [];
    onFile([
      ...segments.slice(0, depth),
      ...inserted,
      ...segments.slice(depth + 1),
    ]);
  };
  return (
    <span className="wfacet">
      <span
        className="wfacetkey"
        title={`Filed under ${facetKey}${path ? `: ${path}` : ""}`}
      >
        {facetKey}
      </span>
      {segments.map((segment, depth) => (
        <Fragment key={depth}>
          {depth > 0 && <Separator />}
          <Segment
            book={book}
            facetKey={facetKey}
            parent={segments.slice(0, depth).join("/")}
            value={segment}
            onCommit={(text) => commit(depth, text)}
          />
        </Fragment>
      ))}
      {draftAt === segments.length ? (
        <>
          {segments.length > 0 && <Separator />}
          <Segment
            book={book}
            facetKey={facetKey}
            parent={path}
            value=""
            autoFocus
            onCommit={(text) => commit(segments.length, text)}
            onDone={onCloseDraft}
          />
        </>
      ) : (
        <button
          type="button"
          className="wfacetdeeper"
          aria-label={`Add a level under ${path || facetKey}`}
          title={
            path
              ? `File this more precisely — a level under ${path}`
              : `Give ${facetKey} a value`
          }
          onClick={() => onDraft(segments.length)}
        >
          +
        </button>
      )}
      <button
        type="button"
        className="wfacetdrop"
        aria-label={`Unfile from ${facetKey}`}
        title={`Stop filing this item under ${facetKey}`}
        onClick={onUnfile}
      >
        ×
      </button>
    </span>
  );
}

const Separator = () => (
  <span className="wfacetsep" aria-hidden="true">
    /
  </span>
);

/**
 * One level of a path.
 *
 * The suggestions are the siblings this level could have — everything already filed one step under the same
 * parent — so the common case is picking a branch that exists rather than spelling it again.
 */
function Segment({
  book,
  facetKey,
  parent,
  value,
  autoFocus = false,
  onCommit,
  onDone,
}: {
  readonly book: WeightBook;
  readonly facetKey: string;
  readonly parent: string;
  readonly value: string;
  readonly autoFocus?: boolean;
  readonly onCommit: (value: string) => void;
  readonly onDone?: () => void;
}) {
  const listId = useId();
  const siblings = facetChildren(book, facetKey, parent).filter(
    (candidate) => candidate !== value,
  );
  return (
    <>
      <Field
        value={value}
        placeholder="level"
        className="wfacetvalue"
        ariaLabel={
          parent
            ? `The level under ${parent}, in ${facetKey}`
            : `What ${facetKey} files this item under`
        }
        title="One level of the path. Empty removes it; a `/` makes two."
        list={siblings.length ? listId : undefined}
        // As wide as what it holds, so a path reads as a path rather than as a row of equal boxes.
        size={Math.max(value.length + 1, 6)}
        autoFocus={autoFocus}
        onCommit={onCommit}
        onDone={onDone}
      />
      {siblings.length > 0 && (
        <datalist id={listId}>
          {siblings.map((candidate) => (
            <option key={candidate} value={candidate} />
          ))}
        </datalist>
      )}
    </>
  );
}

/**
 * Filing under a facet the item does not have yet.
 *
 * The keys already in the book are offered, because a second facet is nearly always one another item already
 * uses — and a book where `system` and `System` both existed would draw two trees over the same items.
 */
function AddFacet({
  book,
  item,
  onAdd,
}: {
  readonly book: WeightBook;
  readonly item: Item;
  readonly onAdd: (key: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const listId = useId();
  const known = facetKeys(book).filter((key) => !(key in item.facets));
  return (
    <span className="wfacetadd">
      <input
        list={listId}
        value={typed}
        placeholder="+ file under…"
        spellCheck={false}
        aria-label="A facet to file this item under"
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const key = tidyName(typed);
          // A key nothing could be filed under is not worth opening a cell for; `setFacet` would refuse it
          // afterwards anyway, and by then whatever was typed beside it would be gone.
          if (!isValidName(key)) return;
          setTyped("");
          // The value is typed into the cell this opens, not guessed at here.
          onAdd(key);
        }}
      />
      <datalist id={listId}>
        {known.map((candidate) => (
          <option key={candidate} value={candidate} />
        ))}
      </datalist>
    </span>
  );
}
