// ---------- the item explorer ----------
//
// NOT a view. It shows the whole book whatever the active view is scoped to, because its job is orientation:
// what is here, where it is filed, and what is broken. A view answers "what am I working in"; this answers
// "what is there".
//
// ---------- one tree, all the way down ----------
//
// Facet path → item → field. Three kinds of node and one tree, because they are three levels of the same
// question and splitting them across tabs would make you hold the join in your head. A field is a leaf: it
// has nothing under it, and clicking one opens the item with the caret in that cell.
//
// The tree survives having nothing to build itself from. With no facets in the book at all, `by:` reads
// "flat" and every item is listed at the top level — an explorer that hid the whole book until someone filed
// something would be at its least useful exactly when it was most needed.
//
// ---------- filing and ordering happen here ----------
//
// Dragging an item onto a facet node sets that facet — one `setFacet` command, recording what was meant.
// Dropping between item rows reorders the book (and refiles when that boundary is in another visible group);
// dropping between field rows reorders that item's fields. The insertion line distinguishes these ordering
// gestures from a highlighted facet node, which remains a drop ON a classification.
//
// ---------- counts, not totals ----------
//
// A facet node says how many items are under it and nothing more. A subtotal would need aggregation, which
// this refactor deliberately does without — and a number on screen that no formula can name would be exactly
// the visual hack the heading rows were.

import { useState } from "react";
import type { DocumentCommand } from "../../core/commands";
import {
  facetKeys,
  fieldMoved,
  primaryFacet,
  type Item,
  type WeightBook,
} from "../../core/sheet/book";
import {
  groupHasProblem,
  groupItems,
  type Group,
} from "../../core/sheet/views";

export interface NewItemFiling {
  readonly key: string;
  readonly value: string;
}

export interface ExplorerProps {
  readonly book: WeightBook;
  /** Items with something wrong in them, for the markers. */
  readonly flagged: ReadonlySet<string>;
  readonly activeItem: string | null;
  readonly onOpenItem: (itemId: string) => void;
  readonly onOpenField: (itemId: string, fieldKey: string) => void;
  readonly onOpenFacet: (key: string, value: string) => void;
  /** Make an item, optionally already filed under the group the user chose it from. */
  readonly onAddItem: (filing?: NewItemFiling) => void;
  readonly send: (command: DocumentCommand) => void;
}

/** The `by:` option that groups by nothing — every item at the top, in the book's own order. */
const FLAT = "";
const ITEM_DRAG = "application/x-camber-weight-item";
const FIELD_DRAG = "application/x-camber-weight-field";

type Dragged =
  | { readonly k: "item"; readonly id: string }
  | { readonly k: "field"; readonly item: string; readonly key: string };
type DropMark = {
  readonly k: "item" | "field";
  readonly id: string;
  readonly side: "before" | "after";
};

/** Final array index for dropping `source` on one side of `target`. */
const dropIndex = (
  source: number,
  target: number,
  side: "before" | "after",
): number => target + (side === "after" ? 1 : 0) - (source < target ? 1 : 0);

export function Explorer({
  book,
  flagged,
  activeItem,
  onOpenItem,
  onOpenField,
  onOpenFacet,
  onAddItem,
  send,
}: ExplorerProps) {
  const keys = facetKeys(book);
  const [chosen, setChosen] = useState<string | null>(null);
  // Null means "whatever this book is mostly filed under", so a book gains a tree the moment it gains a
  // facet, without anyone going to look for the setting.
  const facet =
    chosen === null
      ? (primaryFacet(book) ?? FLAT)
      : chosen && keys.includes(chosen)
        ? chosen
        : FLAT;

  const [query, setQuery] = useState("");
  // Folded nodes, by the id each one draws itself under. Items start OPEN: the point of the tree is to show
  // what the book contains, and a book that opened as a list of closed boxes would answer nothing on sight.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [over, setOver] = useState<string | null>(null);
  const [dragged, setDragged] = useState<Dragged | null>(null);
  const [dropMark, setDropMark] = useState<DropMark | null>(null);

  const needle = query.trim().toLowerCase();
  // The search is over what a person would type: the item's name, its note, and the field keys it carries.
  // Not over formulas — a search that matched inside expressions would return most of the book most of the
  // time, and the thing being looked for here is a THING, not a mention of one. Searching field keys is also
  // how key drift gets found: type `weight` and the one item that did not say `mass` is what comes back.
  const items = needle
    ? book.items.filter(
        (item) =>
          item.name.toLowerCase().includes(needle) ||
          item.note.toLowerCase().includes(needle) ||
          Object.keys(item.fields).some((key) =>
            key.toLowerCase().includes(needle),
          ),
      )
    : book.items;

  const toggle = (id: string) => {
    const next = new Set(closed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setClosed(next);
  };

  const twist = (id: string, has: boolean) => (
    <button
      className="wexptwist"
      aria-expanded={has ? !closed.has(id) : undefined}
      disabled={!has}
      onClick={() => has && toggle(id)}
      title={closed.has(id) ? "Show what is under this" : "Fold this away"}
    >
      {has ? (closed.has(id) ? "▸" : "▾") : "·"}
    </button>
  );

  const renderField = (item: Item, key: string, depth: number) => {
    const mark =
      dropMark?.k === "field" && dropMark.id === `${item.id}:${key}`
        ? dropMark.side
        : null;
    return (
      <li key={`${item.id} ${key}`} className="wexpnode">
        <div
          className={`wexprow wexpfield${mark ? ` drop-${mark}` : ""}`}
          style={{ paddingLeft: `${depth * 12 + 20}px` }}
          draggable
          onDragStart={(event) => {
            event.stopPropagation();
            const value = JSON.stringify({ item: item.id, key });
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(FIELD_DRAG, value);
            setDragged({ k: "field", item: item.id, key });
          }}
          onDragEnd={() => {
            setDragged(null);
            setDropMark(null);
          }}
          onDragOver={(event) => {
            if (
              dragged?.k !== "field" ||
              dragged.item !== item.id ||
              dragged.key === key
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            const side =
              event.clientY < box.top + box.height / 2 ? "before" : "after";
            setDropMark({ k: "field", id: `${item.id}:${key}`, side });
          }}
          onDrop={(event) => {
            if (dragged?.k !== "field" || dragged.item !== item.id) return;
            event.preventDefault();
            event.stopPropagation();
            const order = Object.keys(item.fields);
            const source = order.indexOf(dragged.key);
            const target = order.indexOf(key);
            const side = dropMark?.side ?? "before";
            if (source >= 0 && target >= 0)
              send({
                type: "installSheet",
                book: fieldMoved(
                  book,
                  item.id,
                  dragged.key,
                  dropIndex(source, target, side),
                ),
              });
            setDragged(null);
            setDropMark(null);
          }}
        >
          <button
            className="wexplabel"
            onClick={() => onOpenField(item.id, key)}
            title={`Open ${item.name || "this item"} with the caret in ${key}; drag to reorder fields`}
          >
            {key}
          </button>
          <span className="wexpkind">{item.fields[key].k}</span>
        </div>
      </li>
    );
  };

  const renderItem = (item: Item, depth: number, groupValue: string | null) => {
    const keysHere = Object.keys(item.fields);
    const id = `item:${item.id}`;
    const mark =
      dropMark?.k === "item" && dropMark.id === item.id ? dropMark.side : null;
    return (
      <li key={item.id} className="wexpnode">
        <div
          className={`wexprow wexpitem${activeItem === item.id ? " on" : ""}${mark ? ` drop-${mark}` : ""}`}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(ITEM_DRAG, item.id);
            // Kept for drops arriving from older table code and for Firefox, which requires a plain payload.
            event.dataTransfer.setData("text/plain", item.id);
            setDragged({ k: "item", id: item.id });
          }}
          onDragEnd={() => {
            setDragged(null);
            setDropMark(null);
            setOver(null);
          }}
          onDragOver={(event) => {
            if (dragged?.k !== "item" || dragged.id === item.id) return;
            event.preventDefault();
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            const side =
              event.clientY < box.top + box.height / 2 ? "before" : "after";
            setDropMark({ k: "item", id: item.id, side });
          }}
          onDrop={(event) => {
            if (dragged?.k !== "item" || dragged.id === item.id) return;
            event.preventDefault();
            event.stopPropagation();
            const source = book.items.findIndex(
              (candidate) => candidate.id === dragged.id,
            );
            const target = book.items.findIndex(
              (candidate) => candidate.id === item.id,
            );
            const side = dropMark?.side ?? "before";
            if (source >= 0 && target >= 0) {
              send({
                type: "moveItem",
                item: dragged.id,
                to: dropIndex(source, target, side),
              });
              // Crossing a visible group boundary is both an ordering action and an explicit refile.
              if (facet && groupValue !== null) {
                const moved = book.items[source];
                if ((moved.facets[facet] ?? "") !== groupValue)
                  send({
                    type: "setFacet",
                    item: moved.id,
                    key: facet,
                    value: groupValue,
                  });
              }
            }
            setDragged(null);
            setDropMark(null);
          }}
        >
          {twist(id, keysHere.length > 0)}
          <button
            className="wexplabel"
            onClick={() => onOpenItem(item.id)}
            title={item.note || "Open this item; drag to reorder"}
          >
            {item.name || <i>unnamed</i>}
          </button>
          {flagged.has(item.id) && (
            <span className="wexpwarn" title="Something here needs attention">
              !
            </span>
          )}
        </div>
        {!closed.has(id) && keysHere.length > 0 && (
          <ul className="wexplist">
            {keysHere.map((key) => renderField(item, key, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  const renderGroup = (group: Group) => {
    const id = `facet:${group.value}:${group.depth}`;
    const has = group.items.length > 0 || group.children.length > 0;
    return (
      <li key={id} className="wexpnode">
        <div
          className={`wexprow wexpgroup${over === id ? " over" : ""}`}
          style={{ paddingLeft: `${group.depth * 12 + 4}px` }}
          onDragOver={(event) => {
            // Fields can only move among their siblings; a group accepts items for filing.
            if (dragged?.k === "field") return;
            event.preventDefault();
            setOver(id);
          }}
          onDragLeave={() =>
            setOver((current) => (current === id ? null : current))
          }
          onDrop={(event) => {
            event.preventDefault();
            const itemId =
              event.dataTransfer.getData(ITEM_DRAG) ||
              event.dataTransfer.getData("text/plain");
            // A drop files the item under the node it landed on. The unfiled bucket has no value, so
            // dropping there sends an empty one, which is how a facet is removed rather than blanked.
            if (itemId && facet)
              send({
                type: "setFacet",
                item: itemId,
                key: facet,
                value: group.value,
              });
            setOver(null);
          }}
        >
          {twist(id, has)}
          <button
            className="wexplabel"
            disabled={!group.value}
            onClick={() => group.value && onOpenFacet(group.key, group.value)}
            title={
              group.value
                ? `Open everything under ${group.key}: ${group.value}`
                : `Items with no ${facet || "facet"} yet`
            }
          >
            {group.label}
          </button>
          {groupHasProblem(group, flagged) && (
            <span
              className="wexpwarn"
              title="Something under here needs attention"
            >
              !
            </span>
          )}
          <button
            className="wexpgroupadd"
            aria-label={`Add an item${group.value ? ` under ${group.label}` : " without filing it"}`}
            title={`Add an item${group.value ? ` under ${group.key}: ${group.value}` : " without filing it"}`}
            onClick={() => {
              // An unnamed item would not match an active search, so clear it before putting the new item in
              // the tree. Opening its detail then puts the caret directly in the name.
              setQuery("");
              onAddItem(
                group.value
                  ? { key: group.key, value: group.value }
                  : undefined,
              );
            }}
          >
            +
          </button>
          <span className="wexpcount">{group.count}</span>
        </div>
        {!closed.has(id) && (
          <ul className="wexplist">
            {group.items.map((item) =>
              renderItem(item, group.depth + 1, group.value),
            )}
            {group.children.map(renderGroup)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="wexplorer">
      <div className="wexphead">
        <label className="wexpby">
          by
          <select
            value={facet}
            aria-label="Facet to build the tree from"
            onChange={(event) => setChosen(event.target.value)}
          >
            <option value={FLAT}>flat</option>
            {keys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        <input
          className="wexpsearch"
          value={query}
          placeholder="search"
          spellCheck={false}
          aria-label="Find an item or a field"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          className="wexpadd"
          aria-label="Add an item"
          title="Add an item"
          onClick={() => {
            setQuery("");
            onAddItem();
          }}
        >
          +
        </button>
      </div>

      {!book.items.length ? (
        <p className="whint wexphint">
          Nothing here yet. Add an item — a thing the boat is made of — and give
          it what is known about it.
        </p>
      ) : (
        <ul className="wexplist wexproot">
          {facet
            ? groupItems(items, [facet]).map(renderGroup)
            : items.map((item) => renderItem(item, 0, null))}
        </ul>
      )}

      {!needle && !keys.length && book.items.length > 0 && (
        <p className="wexpnote">
          Nothing is filed yet. Give an item a facet — <code>system</code>,{" "}
          <code>status</code>, anything — and this becomes the tree of it. A
          value may be a path, so <code>structure/hull/shell</code> nests.
        </p>
      )}
    </div>
  );
}
