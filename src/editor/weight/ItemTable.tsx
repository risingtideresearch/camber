// ---------- the grouped table ----------
//
// One row per item, one column per LEAF. A leaf is always a single scalar and always one cell, which is what
// lets a view over items carrying different kinds of field pose no problem at all: `mass` is one column, a
// point is three under a spanned header, a cut is its position and its area. There is only ever one kind of
// cell, and the header says which field it belongs to.
//
// Group headers come from the view's `groupBy` and carry a name and a count. Not a subtotal: that would need
// aggregation, and a number nothing can name is the thing the heading rows were.
//
// ---------- editing is the point ----------
//
// Every affordance the typed pages had lives here. The last line is an invitation rather than a button
// somewhere else, because a schedule is written by typing. Alt+arrow moves an item without a mouse. A blank
// cell is not dead space — clicking it gives that item the field the column is asking for, which is how a
// schedule fills out sideways as well as downwards.

import { useMemo, useState } from "react";
import type { DocumentCommand } from "../../core/commands";
import {
  fieldUnit,
  newId,
  type Field,
  type FieldLeaf,
  type Item,
  type WeightBook,
} from "../../core/sheet/book";
import { resultAt, type BookResults } from "../../core/sheet/evaluate";
import {
  sliceMeasurementKey,
  type SliceMeasurements,
} from "../../core/sheet/slices";
import type { Column, Row } from "../../core/sheet/views";
import { placementFor } from "./pointPlots";
import {
  Field as TextField,
  FormulaField,
  Grip,
  ResultIssue,
} from "./weightFields";
import { inUnit, nudgeKeys, showSpread, sig } from "./weightFormat";
import {
  globalCompletions,
  isCoordinate,
  siblingCompletions,
  type Completion,
} from "./weightCompletions";

export interface Focus {
  readonly item: string;
  readonly field: string | null;
  readonly leaf: FieldLeaf;
}

export interface ItemTableProps {
  readonly book: WeightBook;
  readonly rows: readonly Row[];
  readonly columns: readonly Column[];
  readonly results: BookResults;
  readonly measurements: SliceMeasurements;
  readonly reading: "worst" | "likely";
  readonly focus: Focus | null;
  readonly setFocus: (focus: Focus | null) => void;
  readonly onOpenItem: (itemId: string) => void;
  readonly send: (command: DocumentCommand) => void;
  /** The facet a drop between groups would set, when the view is grouped by exactly one. */
  readonly groupFacet: string | null;
}

/** The bands across the top: consecutive columns sharing a band merge into one spanned cell. */
function bandsOf(columns: readonly Column[]): { band: string; span: number }[] {
  const out: { band: string; span: number }[] = [];
  for (const column of columns) {
    const last = out[out.length - 1];
    if (last && last.band === column.band && column.band) last.span += 1;
    else out.push({ band: column.band, span: 1 });
  }
  return out;
}

export function ItemTable(props: ItemTableProps) {
  const { book, rows, columns, setFocus, send, groupFacet } = props;
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);

  // The expensive half of autocomplete, built once for the whole table rather than once per row — a
  // schedule is exactly the thing that grows, and per-row would be quadratic in its size.
  const globals = useMemo(
    () => ({
      plain: globalCompletions(book, false),
      coordinate: globalCompletions(book, true),
    }),
    [book],
  );

  const bands = bandsOf(columns);
  const hasBands = bands.some((band) => band.band);

  const toggle = (value: string) => {
    const next = new Set(closed);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setClosed(next);
  };

  // Which rows a fold hides: everything under a folded group, to any depth.
  const hidden = new Set<string>();
  let folding: number | null = null;
  for (const row of rows) {
    if (row.k === "group") {
      if (folding !== null && row.group.depth > folding) continue;
      folding = closed.has(row.group.value) ? row.group.depth : null;
      continue;
    }
    if (folding !== null) hidden.add(row.item.id);
  }

  const move = (itemId: string, to: number) =>
    send({ type: "moveItem", item: itemId, to });

  const addItem = (after: number, facetValue: string | null) => {
    const id = newId();
    send({ type: "addItem", id, name: "", after });
    if (facetValue && groupFacet)
      send({ type: "setFacet", item: id, key: groupFacet, value: facetValue });
    setFocus({ item: id, field: null, leaf: "formula" });
  };

  const lastIndex = book.items.length - 1;

  return (
    <table className="wsheet">
      <thead>
        {hasBands && (
          <tr className="wbandrow">
            <th />
            {bands.map((band, i) => (
              <th
                key={`${band.band}-${i}`}
                colSpan={band.span}
                className="wband"
              >
                {band.band}
              </th>
            ))}
            <th />
          </tr>
        )}
        <tr>
          <th className="wcolname">Item</th>
          {columns.map((column) => (
            <th
              key={`${column.fieldKey} ${column.label}`}
              className={`${column.source.k === "measure" ? "wcolmeasured" : ""}${column.kind === "scalar" ? " wcolscalar" : ""}`}
              title={
                column.source.k === "measure"
                  ? `${column.label} of ${column.fieldKey}, measured off the hull`
                  : undefined
              }
            >
              {column.label}
            </th>
          ))}
          <th className="wcolact" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) =>
          row.k === "group" ? (
            <tr
              key={`g${row.group.value}${row.group.depth}`}
              className="wgrouphead"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const itemId = event.dataTransfer.getData("text/plain");
                // Dropping onto a group header FILES the item, which is what dragging across a heading only
                // ever implied before. One command, and it says what was meant.
                if (itemId && groupFacet)
                  send({
                    type: "setFacet",
                    item: itemId,
                    key: groupFacet,
                    value: row.group.value,
                  });
              }}
            >
              <td colSpan={columns.length + 2}>
                <div
                  className="wgroupbar"
                  style={{ paddingLeft: `${row.group.depth * 14}px` }}
                >
                  <button
                    className="wexptwist"
                    aria-expanded={!closed.has(row.group.value)}
                    onClick={() => toggle(row.group.value)}
                  >
                    {closed.has(row.group.value) ? "▸" : "▾"}
                  </button>
                  <span className="wgroupname">{row.group.label}</span>
                  <span className="wgroupcount">
                    {row.group.count} item{row.group.count === 1 ? "" : "s"}
                  </span>
                  {groupFacet && row.group.value && (
                    <button
                      className="wgroupadd"
                      title={`Add an item filed under ${row.group.value}`}
                      onClick={() => addItem(lastIndex, row.group.value)}
                    >
                      +
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ) : hidden.has(row.item.id) ? null : (
            <ItemRow
              key={row.item.id}
              {...props}
              item={row.item}
              depth={row.depth}
              index={book.items.indexOf(row.item)}
              globals={globals}
              dragging={dragging === row.item.id}
              onDragStart={() => setDragging(row.item.id)}
              onDragEnd={() => setDragging(null)}
              onDropOn={(after) => {
                if (!dragging || dragging === row.item.id) return;
                const target = book.items.indexOf(row.item);
                move(dragging, after ? target : Math.max(0, target));
                setDragging(null);
              }}
              onNudge={(delta) =>
                move(row.item.id, book.items.indexOf(row.item) + delta)
              }
            />
          ),
        )}
        {/* The last line is an invitation, not a button somewhere else: a schedule is written by typing, and
            a table that ends in a blank row is a table you can keep going in. */}
        <tr className="waddrow">
          <td colSpan={columns.length + 2}>
            <button
              className="waddline"
              onClick={() => addItem(lastIndex, null)}
            >
              + add an item
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ---------- one item ----------

interface ItemRowProps extends ItemTableProps {
  readonly item: Item;
  readonly depth: number;
  readonly index: number;
  readonly globals: { plain: Completion[]; coordinate: Completion[] };
  readonly dragging: boolean;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly onDropOn: (after: boolean) => void;
  readonly onNudge: (delta: -1 | 1) => void;
}

function ItemRow(props: ItemRowProps) {
  const {
    item,
    depth,
    columns,
    focus,
    setFocus,
    onOpenItem,
    send,
    dragging,
    onDragStart,
    onDragEnd,
    onDropOn,
    onNudge,
  } = props;
  const focused = focus?.item === item.id;
  return (
    <tr
      className={`wrow${focused ? " focused" : ""}${dragging ? " dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        onDropOn(event.clientY > box.top + box.height / 2);
      }}
      onKeyDown={nudgeKeys(onNudge)}
    >
      <td className="wcolname" style={{ paddingLeft: `${depth * 14}px` }}>
        <Grip
          payload={item.id}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
        <TextField
          value={item.name}
          placeholder="name"
          className="wname"
          onCommit={(name) => send({ type: "renameItem", item: item.id, name })}
          onFocus={() =>
            setFocus({ item: item.id, field: null, leaf: "formula" })
          }
        />
      </td>
      {columns.map((column) => (
        <Cell
          key={`${column.fieldKey} ${column.label}`}
          {...props}
          column={column}
        />
      ))}
      <td className="wcolact">
        <button
          className="wopen"
          title="Open this item on its own, with every field it carries"
          onClick={() => onOpenItem(item.id)}
        >
          ⤢
        </button>
        <button
          className="wremove"
          title="Remove this item"
          onClick={() => send({ type: "removeItem", item: item.id })}
        >
          ×
        </button>
      </td>
    </tr>
  );
}

// ---------- one cell ----------

function Cell({
  item,
  column,
  results,
  measurements,
  reading,
  setFocus,
  send,
  globals,
}: ItemRowProps & { readonly column: Column }) {
  const field: Field | undefined = item.fields[column.fieldKey];

  // A blank cell is not dead space. The column is a question, and giving the item the field it asks for is
  // the answer — so clicking here fills the schedule out sideways the way the add-line fills it downwards.
  if (!field || field.k !== column.kind)
    return (
      <td className="wcell wblank">
        <button
          className="wfill"
          title={`Give ${item.name || "this item"} a ${column.fieldKey}`}
          onClick={() =>
            send({
              type: "addField",
              item: item.id,
              key: column.fieldKey,
              kind: column.kind,
            })
          }
        >
          +
        </button>
      </td>
    );

  if (column.source.k === "measure") {
    const measured = measurements.get(
      sliceMeasurementKey(item.id, column.fieldKey),
    );
    const value = measured?.[column.source.measure];
    return (
      <td
        className="wcell wmeasured"
        title="Measured off the hull — not authored"
      >
        {value === undefined ? "—" : sig(value)}
      </td>
    );
  }

  const leaf = column.source.leaf;
  const result = resultAt(results, item.id, column.fieldKey, leaf);
  const text = (field as unknown as Record<string, string>)[leaf] ?? "";
  const factor = result?.unit?.factor ?? 1;
  const coordinate = isCoordinate(leaf);
  // Draggability is a property of the CELL, not a mode: a drag moves one literal inside it, and a cell with
  // no literal it may move is shown where it computes to and left alone.
  const placement = coordinate ? placementFor(text, result) : null;
  const bare = placement?.bare ?? false;
  // The unit belongs to the FIELD, not the leaf, so it is edited on the field's first column — which for a
  // scalar is the only one, and for a point is `x`.
  const firstLeaf = field.k === "point" ? "x" : leaf;

  return (
    <td className={`wcell${column.kind === "scalar" ? " wcellscalar" : ""}`}>
      <div className="wcellrow">
        <FormulaField
          value={text}
          error={result?.error ?? null}
          completions={
            coordinate
              ? [...siblingCompletions(item, true), ...globals.coordinate]
              : [...siblingCompletions(item, false), ...globals.plain]
          }
          onCommit={(formula) =>
            send({
              type: "setFieldFormula",
              item: item.id,
              field: column.fieldKey,
              leaf,
              formula,
            })
          }
          onFocus={() =>
            setFocus({ item: item.id, field: column.fieldKey, leaf })
          }
        />
        {leaf === firstLeaf && (
          <TextField
            value={fieldUnit(field)}
            // A derived unit shows as the placeholder rather than as text, so it reads as what the formula
            // works out to rather than as something the user typed and could delete.
            placeholder={
              result?.unitIsDerived ? (result.unit?.label ?? "—") : "—"
            }
            className={`wunit${result?.unitIsDerived ? " derived" : ""}`}
            title={
              result?.unitWarning ??
              (result?.unitIsDerived
                ? "What the formula works out to. Type another unit of the same kind to show it in that instead."
                : "What this is written in")
            }
            onCommit={(unit) =>
              send({
                type: "setFieldUnit",
                item: item.id,
                field: column.fieldKey,
                unit,
              })
            }
            onFocus={() =>
              setFocus({ item: item.id, field: column.fieldKey, leaf })
            }
          />
        )}
      </div>
      {result?.error ? (
        <ResultIssue message={result.error} severity="error" />
      ) : (
        <>
          {!bare && result?.reading && !result.empty && (
            <span
              className={`wcellval${placement || !coordinate ? "" : " fixed"}`}
            >
              = {sig(inUnit(result.reading.v, factor))}{" "}
              {showSpread(result.reading, factor, reading)}
            </span>
          )}
          <ResultIssue message={result?.unitWarning} severity="warning" />
        </>
      )}
    </td>
  );
}
