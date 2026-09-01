// ---------- one item, and everything it carries ----------
//
// The view the page model could not express at all. An engine has a mass, a position and perhaps a cost, and
// under pages those were three rows on three tabs sharing a name by hand — so editing one thing meant
// visiting three places and hoping they still agreed. Here they are one record, and this is its form.
//
// It is also where the parts of an item that are not cells live: what it is filed under, its note, and which
// fields it has at all. The table can fill a blank cell in a column that already exists; this is where a
// field nothing else has gets made.
//
// ---------- a block folds ----------
//
// An item carrying six fields is six headers and up to eighteen formula cells, and a header already says what
// its cells repeat: the name, the unit, what the field is worth and whatever is wrong with it. So a block
// folds down to that header and its cells are not rendered at all while it is folded. Selecting a field from
// anywhere else — the explorer, the table, a driver in the inspector — unfolds it, because a selection that
// scrolled the pane to a folded block would be a selection that showed nothing.
//
// ---------- what a block is told ----------
//
// Three things are worked out ONCE for the card and handed down, because each costs a walk of the whole book
// and a block would otherwise ask for it per cell: the completion lists (`completionsFor`), what names each
// field (`fieldUsers`), and the state of a move in progress (`useFieldReorder`). A block computing its own
// would be quadratic in the size of a schedule, which is exactly the thing that grows.

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import type { DocumentCommand } from "../../core/commands";
import {
  blankField,
  DEFAULT_FIELD_KEY,
  facetKeys,
  fieldUnit,
  freeFieldKey,
  isDerived,
  leavesOf,
  type Field,
  type FieldKind,
  type FieldLeaf,
  type Item,
  type WeightBook,
} from "../../core/sheet/book";
import {
  fieldUsers,
  resultAt,
  type BookResults,
} from "../../core/sheet/evaluate";
import {
  SLICE_VALUE_FIELDS,
  sliceMeasurementKey,
  type SliceMeasurement,
  type SliceMeasurements,
  type SliceValueField,
} from "../../core/sheet/slices";
import { placementFor } from "./pointPlots";
import {
  Field as TextField,
  FormulaField,
  Grip,
  ResultIssue,
} from "./weightFields";
import { inUnit, nudgeKeys, showSpread, sig } from "./weightFormat";
import {
  completionsFor,
  isCoordinate,
  type Completion,
} from "./weightCompletions";
import type { Focus } from "./ItemTable";

export interface ItemDetailProps {
  readonly book: WeightBook;
  readonly item: Item;
  readonly results: BookResults;
  readonly measurements: SliceMeasurements;
  readonly reading: "worst" | "likely";
  readonly focus: Focus | null;
  /** This item was just made from outside the detail view, so its name is the next thing to author. */
  readonly autoFocusName?: boolean;
  readonly setFocus: (focus: Focus | null) => void;
  readonly send: (command: DocumentCommand) => void;
  readonly onDelete: () => void;
}

const KIND_LABEL: Record<FieldKind, string> = {
  scalar: "a value",
  point: "a position",
  cut: "a section through the hull",
};

// ---------- moving a field ----------

/**
 * Where the fields of one item are, while they are being moved.
 *
 * The drag state, the order a move shows before it lands, and the command are one subject: a block is a drop
 * target for whichever of its neighbours is in the air, its grip is the source, and the list clears the
 * insertion line when the pointer leaves. Held together here, a block takes one prop for all of it rather
 * than six, and none of the arithmetic is repeated per block.
 */
interface Reorder {
  /** The fields in the order to draw them: the authored one, or the move that has not landed yet. */
  readonly fields: readonly (readonly [string, Field])[];
  readonly dragging: string | null;
  /** The class fragment that draws the insertion line at `index`. */
  readonly dropMark: (index: number) => string;
  /** Move a field by a signed number of places, which is what Alt+↑/↓ asks for. */
  readonly nudge: (key: string, by: -1 | 1) => void;
  readonly gripProps: (key: string) => {
    readonly onDragStart: () => void;
    readonly onDragEnd: () => void;
  };
  readonly targetProps: (index: number) => {
    readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
    readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  /** On the list itself: leaving it must not leave the insertion line drawn behind. */
  readonly listProps: {
    readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
  };
}

function useFieldReorder(
  item: Item,
  send: (command: DocumentCommand) => void,
): Reorder {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const [pending, setPending] = useState<{
    readonly item: string;
    readonly base: Item["fields"];
    readonly keys: readonly string[];
  } | null>(null);

  // Show the move synchronously. As soon as the store publishes, `item.fields` gets a new identity and the
  // authored order takes over again; no effect or second render is needed to reconcile it.
  const order =
    pending?.item === item.id && pending.base === item.fields
      ? pending.keys
      : Object.keys(item.fields);
  const fields = order.flatMap((key) => {
    const field = item.fields[key];
    return field ? ([[key, field]] as const) : [];
  });

  const move = (key: string, to: number) => {
    const from = order.indexOf(key);
    const target = Math.max(0, Math.min(order.length - 1, to));
    if (from < 0 || from === target) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    setPending({ item: item.id, base: item.fields, keys: next });
    // The command says what the gesture was. Sending the whole reordered book instead would read as "replace
    // the whole weight estimate" in the timeline, and would carry every other cell along with it — which in a
    // replicated session means overwriting whatever another window changed while this drag was in the air.
    send({ type: "moveField", item: item.id, key, to: target });
  };

  // Which line of the list a pointer over the block at `index` is aiming at.
  const slotAt = (event: DragEvent<HTMLElement>, index: number): number => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? index : index + 1;
  };

  const stop = () => {
    setDragging(null);
    setDrop(null);
  };

  return {
    fields,
    dragging,
    dropMark: (index) =>
      drop === index
        ? " drop-before"
        : drop === fields.length && index === fields.length - 1
          ? " drop-after"
          : "",
    nudge: (key, by) => move(key, order.indexOf(key) + by),
    gripProps: (key) => ({
      onDragStart: () => setDragging(key),
      onDragEnd: stop,
    }),
    targetProps: (index) => ({
      onDragOver: (event) => {
        if (!dragging) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDrop(slotAt(event, index));
      },
      onDrop: (event) => {
        if (!dragging) return;
        event.preventDefault();
        const slot = slotAt(event, index);
        const from = order.indexOf(dragging);
        // `slot` names a line in the list before the dragged field is removed. Moving down closes one slot,
        // so translate that line to the final index the command expects.
        move(dragging, from >= 0 && from < slot ? slot - 1 : slot);
        stop();
      },
    }),
    listProps: {
      onDragLeave: (event) => {
        // Only when the pointer has genuinely left the list. Dragging from one block to the next fires this
        // too, and clearing there would make the insertion line flicker the whole way down.
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        setDrop(null);
      },
    },
  };
}

// ---------- the card ----------

export function ItemDetail(props: ItemDetailProps) {
  const { book, item, results, measurements, reading, focus, setFocus, send } =
    props;
  // Folded blocks, and the field whose name is waiting for the caret. Both are keyed by (item, field) rather
  // than by field alone: this component is not remounted when the detail view moves to another item, so
  // anything held under a bare key would carry over to a field of the same name on the next one.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reorder = useFieldReorder(item, send);

  const blockKey = (key: string) => `${item.id} ${key}`;
  const toggleFold = (key: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(blockKey(key))) next.add(blockKey(key));
      return next;
    });

  // Unfold whatever gets selected, so that a field chosen elsewhere is readable and not merely scrolled to.
  // Adjusted as the selection MOVES rather than in an effect, so the block is never painted folded and then
  // unfolded a frame later. The twisty stops the pointer before it reaches the header, so folding a block
  // that is already selected does not select it again and undo itself.
  const focused = focus?.item === item.id ? focus.field : null;
  const [lastFocused, setLastFocused] = useState<string | null>(focused);
  if (focused !== lastFocused) {
    setLastFocused(focused);
    if (focused && folded.has(blockKey(focused)))
      setFolded((prev) => {
        const next = new Set(prev);
        next.delete(`${item.id} ${focused}`);
        return next;
      });
  }

  // The two lists differ only in whether the cell being typed in is a coordinate, and the expensive half of
  // each is the same for every cell on the card. See the note at the top of this file.
  const completions = useMemo(
    () => ({
      coordinate: completionsFor(book, item, "x"),
      plain: completionsFor(book, item, "formula"),
    }),
    [book, item],
  );
  const users = useMemo(
    () => fieldUsers(book, results, item.id),
    [book, results, item.id],
  );

  return (
    <div className="wdetail">
      <header className="wdetailhead">
        <TextField
          // The keyed mount makes a newly-created item's one-shot autofocus work even though ItemDetail is
          // deliberately retained while navigation moves between items.
          key={props.autoFocusName ? `new-${item.id}` : "item-name"}
          value={item.name}
          placeholder="name this item"
          className="wdetailname"
          autoFocus={props.autoFocusName}
          onCommit={(name) => send({ type: "renameItem", item: item.id, name })}
        />
        <TextField
          value={item.note}
          placeholder="a note, for whoever reads this later"
          className="wdetailnote"
          onCommit={(note) =>
            send({ type: "setItemNote", item: item.id, note })
          }
        />
      </header>

      <Facets book={book} item={item} send={send} />

      <div className="wdetailfields" {...reorder.listProps}>
        {reorder.fields.length === 0 && (
          <p className="whint">
            This item carries nothing yet. Give it a value, a position, or a
            section — a field is made by naming it, and nothing has to declare
            it first.
          </p>
        )}
        {reorder.fields.map(([key, field], index) => (
          <FieldBlock
            key={key}
            item={item}
            fieldKey={key}
            field={field}
            index={index}
            results={results}
            measurements={measurements}
            reading={reading}
            completions={completions}
            reorder={reorder}
            users={users.get(key) ?? []}
            selected={focus?.item === item.id && focus.field === key}
            expanded={!folded.has(blockKey(key))}
            autoFocusName={justAdded === blockKey(key)}
            onSelect={(leaf) => setFocus({ item: item.id, field: key, leaf })}
            onToggleExpanded={() => toggleFold(key)}
            onNameFocused={() => setJustAdded(null)}
            send={send}
          />
        ))}
      </div>

      <div className="wdetailadd">
        {(["scalar", "point", "cut"] as const).map((kind) => (
          <button
            key={kind}
            title={`Add ${KIND_LABEL[kind]}`}
            onClick={() => {
              // A fresh field lands on a conventional key — `value`, `position` — and the very next thing
              // anyone does is name it. So it is selected, which scrolls the pane to it, and the caret starts
              // in its name rather than in a cell of a field that is not called anything yet.
              const key = freeFieldKey(item, DEFAULT_FIELD_KEY[kind]);
              send({ type: "addField", item: item.id, key, kind });
              setJustAdded(`${item.id} ${key}`);
              setFocus({
                item: item.id,
                field: key,
                leaf: leavesOf(blankField(kind))[0],
              });
            }}
          >
            + {KIND_LABEL[kind]}
          </button>
        ))}
      </div>

      <div className="wdetaildanger">
        {confirmDelete ? (
          <div className="wdeleteconfirm" role="alert">
            <span>Delete this item and all of its fields?</span>
            <button onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button className="danger" onClick={props.onDelete}>
              Delete
            </button>
          </div>
        ) : (
          <button
            className="wdeleteitem"
            title={`Delete ${item.name || "this item"} and all of its fields`}
            onClick={() => setConfirmDelete(true)}
          >
            Delete item…
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- how it is filed ----------

/**
 * The item's facets, as an editable list.
 *
 * Facets are the only thing here no formula can mention, and that is deliberate: filing is what a user must
 * stay free to change, so it must never appear in an address. Editing one here does the same thing dragging
 * the item onto a node in the explorer does — one `setFacet` — because they are the same statement.
 */
function Facets({
  book,
  item,
  send,
}: {
  readonly book: WeightBook;
  readonly item: Item;
  readonly send: (command: DocumentCommand) => void;
}) {
  const [key, setKey] = useState("");
  const known = facetKeys(book);
  const entries = Object.entries(item.facets);
  return (
    <div className="wfacets">
      {entries.map(([facet, value]) => (
        <label key={facet} className="wfacet">
          <span className="wfacetkey">{facet}</span>
          <TextField
            value={value}
            placeholder="unfiled"
            className="wfacetvalue"
            title="A path nests: structure/hull/shell. Empty unfiles it."
            onCommit={(next) =>
              send({ type: "setFacet", item: item.id, key: facet, value: next })
            }
          />
        </label>
      ))}
      <span className="wfacetadd">
        <input
          list="wfacetkeys"
          value={key}
          placeholder="+ file under…"
          spellCheck={false}
          aria-label="A facet to file this item under"
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !key.trim()) return;
            send({
              type: "setFacet",
              item: item.id,
              key: key.trim(),
              // A fresh facet starts unfiled rather than guessing a value; the field beside it is where the
              // value gets typed, and an empty one would simply be removed again.
              value: "unfiled",
            });
            setKey("");
          }}
        />
        <datalist id="wfacetkeys">
          {known.map((candidate) => (
            <option key={candidate} value={candidate} />
          ))}
        </datalist>
      </span>
    </div>
  );
}

// ---------- one field ----------

interface FieldBlockProps {
  readonly item: Item;
  readonly fieldKey: string;
  readonly field: Field;
  readonly index: number;
  readonly results: BookResults;
  readonly measurements: SliceMeasurements;
  readonly reading: "worst" | "likely";
  readonly completions: {
    readonly coordinate: readonly Completion[];
    readonly plain: readonly Completion[];
  };
  readonly reorder: Reorder;
  /** What else names this field, by address — what removing it would break. */
  readonly users: readonly string[];
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly autoFocusName: boolean;
  readonly onSelect: (leaf: FieldLeaf) => void;
  readonly onToggleExpanded: () => void;
  readonly onNameFocused: () => void;
  readonly send: (command: DocumentCommand) => void;
}

/** The cell a field is selected AT when the field itself, rather than one of its cells, is chosen. */
const firstLeaf = (field: Field): FieldLeaf =>
  isDerived(field) && field.k === "point" ? "from" : leavesOf(field)[0];

function FieldBlock(props: FieldBlockProps) {
  const { field, fieldKey, index, reorder, selected, expanded } = props;
  const block = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!selected) return;
    const node = block.current;
    if (!node) return;
    // Selecting a block by clicking it must NOT scroll — it is already under the pointer, and a smooth scroll
    // in answer to your own click reads as the pane flinching. Only a selection made somewhere else can land
    // on a block that is off screen, and that is the one worth moving the pane for.
    const box = node.getBoundingClientRect();
    const pane = node.closest(".wscroll")?.getBoundingClientRect();
    if (
      box.top >= (pane?.top ?? 0) &&
      box.bottom <= (pane?.bottom ?? window.innerHeight)
    )
      return;
    node.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [selected]);

  return (
    <section
      ref={block}
      className={`wfieldblock ${field.k}${selected ? " selected" : ""}${
        reorder.dragging === fieldKey ? " dragging" : ""
      }${reorder.dropMark(index)}`}
      // On the block rather than on its grip, so a keyboard reorder works from any cell of the field — which
      // is the promise the grip's tooltip makes, and the place the grouped table hangs the same gesture.
      onKeyDown={nudgeKeys((delta) => reorder.nudge(fieldKey, delta))}
      {...reorder.targetProps(index)}
    >
      <FieldHeader {...props} />
      {expanded && <FieldCells {...props} />}
    </section>
  );
}

function FieldHeader({
  item,
  fieldKey,
  field,
  results,
  reading,
  reorder,
  users,
  expanded,
  autoFocusName,
  onSelect,
  onToggleExpanded,
  onNameFocused,
  send,
}: FieldBlockProps) {
  const derived = isDerived(field);
  // The unit belongs to the FIELD, so it is read off whichever cell comes first — they all carry the same one.
  const declared = resultAt(results, item.id, fieldKey, leavesOf(field)[0]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const remove = () =>
    send({ type: "removeField", item: item.id, key: fieldKey });

  return (
    <header
      // Selecting is what clicking a block's CHROME means — its name, its unit, its mode. The cells are not
      // included: each one reports the leaf it is through its own focus, and doing it here as well would
      // select the wrong leaf first and correct it a moment later.
      onPointerDown={() => onSelect(firstLeaf(field))}
    >
      <button
        type="button"
        className="wexptwist wfieldtwist"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Fold" : "Unfold"} ${fieldKey}`}
        title={expanded ? "Fold this field away" : "Show this field's cells"}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onToggleExpanded();
        }}
      >
        {expanded ? "▾" : "▸"}
      </button>
      <Grip
        payload={fieldKey}
        className="wfieldorder"
        title="Drag to reorder — or Alt+↑/↓ from any cell of this field"
        {...reorder.gripProps(fieldKey)}
      />
      <TextField
        value={fieldKey}
        placeholder="field"
        className="wfieldname"
        autoFocus={autoFocusName}
        onFocus={onNameFocused}
        title={`What formulas call this field on this item. A formula resolves it by name when the book is evaluated, so renaming this breaks every formula that named the old one${
          users.length ? `, and ${users.length} does: ${users.join(", ")}` : ""
        }.`}
        onCommit={(name) =>
          send({ type: "renameField", item: item.id, key: fieldKey, name })
        }
      />
      <TextField
        value={fieldUnit(field)}
        // No label beside it: a unit says what it is, and where it says nothing — a plain number, nothing
        // declared — the placeholder is the word itself rather than a dash that names neither the box nor
        // what to type in it. The grouped table's unit column reads the same way.
        placeholder={
          declared?.unitIsDerived ? (declared.unit?.label ?? "unit") : "unit"
        }
        className={`wunit${declared?.unitIsDerived ? " derived" : ""}`}
        ariaLabel="Unit"
        title={
          declared?.unitWarning ??
          (declared?.unitIsDerived
            ? "What the formula works out to. Type another unit of the same kind to show it in that instead."
            : "What this field is written in — one unit covers all of its cells.")
        }
        onCommit={(unit) =>
          send({ type: "setFieldUnit", item: item.id, field: fieldKey, unit })
        }
      />
      {field.k === "point" && (
        <button
          className={`wderive${derived ? " on" : ""}`}
          aria-pressed={derived}
          title={
            derived
              ? "Edit this position as three coordinates"
              : "State this position as one expression over other positions"
          }
          onClick={() =>
            send({
              type: "setFieldFormula",
              item: item.id,
              field: fieldKey,
              leaf: "from",
              formula: derived ? "" : "0",
            })
          }
        >
          {derived ? "Derived" : "Coordinates"}
        </button>
      )}
      {field.k === "cut" && (
        <select
          value={field.shape}
          aria-label="Cut shape"
          onChange={(event) =>
            send({
              type: "setCutShape",
              item: item.id,
              field: fieldKey,
              shape: event.target.value as "plane" | "station",
            })
          }
        >
          <option value="station">Station</option>
          <option value="plane">Horizontal</option>
        </select>
      )}
      {confirmRemove ? (
        <span className="wremoveconfirm" role="alert">
          <span>
            {users.length === 1
              ? `${users[0]} names this.`
              : `${users.length} fields name this.`}{" "}
            Remove it?
          </span>
          <button
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setConfirmRemove(false);
            }}
          >
            Cancel
          </button>
          <button
            className="danger"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              remove();
            }}
          >
            Remove
          </button>
        </span>
      ) : (
        <>
          <FieldSummary {...{ field, fieldKey, item, results, reading }} />
          <button
            type="button"
            className="wremovefield"
            aria-label={`Remove ${fieldKey}`}
            title={
              users.length
                ? `${users.length} other ${users.length === 1 ? "field names" : "fields name"} ${fieldKey} — ${users.join(", ")}. Removing it stops them resolving.`
                : `Remove ${fieldKey} from this item`
            }
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              // A field nothing names goes on one click. One that other formulas are built on asks first,
              // because what it breaks is elsewhere: those cells stop resolving, and nothing on this card
              // would otherwise have said so.
              if (users.length) setConfirmRemove(true);
              else remove();
            }}
          >
            ×
          </button>
        </>
      )}
    </header>
  );
}

function FieldCells({
  item,
  fieldKey,
  field,
  results,
  measurements,
  reading,
  completions,
  onSelect,
  send,
}: FieldBlockProps) {
  const derived = isDerived(field);
  const listFor = (leaf: FieldLeaf) =>
    isCoordinate(leaf) ? completions.coordinate : completions.plain;
  // One expression stands for all three coordinates and each is evaluated on its own, so a derivation can
  // fail on z alone — a sibling that is empty there, a place that binds per axis. Report the first of the
  // three to fail rather than x's, which would leave the other two broken with nothing on screen saying so.
  const firstError =
    leavesOf(field)
      .map((leaf) => resultAt(results, item.id, fieldKey, leaf)?.error)
      .find(Boolean) ?? null;

  return (
    <>
      {derived && field.k === "point" ? (
        <div className="wfieldcells">
          <label className="wfieldcell wide">
            <span>from</span>
            <FormulaField
              value={field.from}
              error={firstError}
              completions={listFor("x")}
              onCommit={(formula) =>
                send({
                  type: "setFieldFormula",
                  item: item.id,
                  field: fieldKey,
                  leaf: "from",
                  formula,
                })
              }
              onFocus={() => onSelect("from")}
            />
          </label>
        </div>
      ) : (
        <div className="wfieldcells">
          {leavesOf(field).map((leaf) => {
            const result = resultAt(results, item.id, fieldKey, leaf);
            const text =
              (field as unknown as Record<string, string>)[leaf] ?? "";
            return (
              <label key={leaf} className="wfieldcell">
                <span>{leavesOf(field).length > 1 ? leaf : fieldKey}</span>
                <FormulaField
                  value={text}
                  error={result?.error ?? null}
                  completions={listFor(leaf)}
                  onCommit={(formula) =>
                    send({
                      type: "setFieldFormula",
                      item: item.id,
                      field: fieldKey,
                      leaf,
                      formula,
                    })
                  }
                  onFocus={() => onSelect(leaf)}
                />
                {field.k !== "scalar" && (
                  <Readout
                    {...{ results, item, fieldKey, reading }}
                    leaf={leaf}
                    placement={
                      isCoordinate(leaf) ? placementFor(text, result) : null
                    }
                  />
                )}
              </label>
            );
          })}
        </div>
      )}

      {field.k === "cut" && (
        <Measured
          measurement={measurements.get(sliceMeasurementKey(item.id, fieldKey))}
        />
      )}
    </>
  );
}

function FieldSummary({
  field,
  fieldKey,
  item,
  results,
  reading,
}: {
  readonly field: Field;
  readonly fieldKey: string;
  readonly item: Item;
  readonly results: BookResults;
  readonly reading: "worst" | "likely";
}) {
  const leaves =
    field.k === "point" ? (["x", "y", "z"] as const) : leavesOf(field);
  const values = leaves.map((leaf) =>
    resultAt(results, item.id, fieldKey, leaf),
  );
  const error = values.find((result) => result?.error)?.error;
  if (error) return <ResultIssue message={error} severity="error" />;
  if (!values.every((result) => result?.reading && !result.empty))
    return <span className="wfieldsummary empty">—</span>;

  const first = values[0]!;
  const factor = first.unit?.factor ?? 1;
  const unit = first.unit?.label ?? fieldUnit(field);
  const text = values
    .map((result) =>
      sig(inUnit(result!.reading!.v, result!.unit?.factor ?? factor)),
    )
    .join(" / ");
  const spread =
    values.length === 1 ? showSpread(first.reading!, factor, reading) : "";
  const summary = [text, spread, unit].filter(Boolean).join(" ");
  return (
    <span className="wfieldsummary" title={summary}>
      <span className="wfieldsummaryvalue">{text}</span>{" "}
      {spread && <span className="wfieldsummaryspread">{spread}</span>}{" "}
      {unit && <span className="wfieldsummaryunit">{unit}</span>}
      {values.length === 1 && (
        <ResultIssue message={first.unitWarning} severity="warning" />
      )}
    </span>
  );
}

function Readout({
  results,
  item,
  fieldKey,
  leaf,
  reading,
  placement = null,
}: {
  readonly results: BookResults;
  readonly item: Item;
  readonly fieldKey: string;
  readonly leaf: string;
  readonly reading: "worst" | "likely";
  readonly placement?: { bare: boolean } | null;
}) {
  const result = resultAt(
    results,
    item.id,
    fieldKey,
    leaf as Parameters<typeof resultAt>[3],
  );
  if (result?.error)
    return <ResultIssue message={result.error} severity="error" />;
  if (!result?.reading || result.empty || placement?.bare) return null;
  const factor = result.unit?.factor ?? 1;
  return (
    <>
      <span className="wcellval">
        = {sig(inUnit(result.reading.v, factor))}{" "}
        {showSpread(result.reading, factor, reading)} {result.unit?.label}
      </span>
      <ResultIssue message={result.unitWarning} severity="warning" />
    </>
  );
}

/**
 * How each measured value is labelled and written.
 *
 * A `Record` over `SliceValueField` rather than a list spelled out here: a value added to
 * `SLICE_VALUE_FIELDS` becomes nameable in a formula the moment it exists, and this pane is where it would
 * otherwise go quietly missing. Now it cannot compile until it has been given a name and a unit.
 */
const MEASURED: Record<SliceValueField, { label: string; unit: string }> = {
  area: { label: "area", unit: "m²" },
  closedPerimeter: { label: "closed perimeter", unit: "m" },
  openPerimeter: { label: "open perimeter", unit: "m" },
  x: { label: "centroid x", unit: "m" },
  y: { label: "centroid y", unit: "m" },
  z: { label: "centroid z", unit: "m" },
};

/** What a cut turned out to be. Measured off the hull, so read-only wherever it appears. */
function Measured({
  measurement,
}: {
  readonly measurement: SliceMeasurement | undefined;
}) {
  if (!measurement)
    return (
      <p className="wcellval bad">
        This has not produced a valid hull cut — check the position.
      </p>
    );
  return (
    <dl className="wmeasurelist">
      {SLICE_VALUE_FIELDS.map((name) => (
        <Fragment key={name}>
          <dt>{MEASURED[name].label}</dt>
          <dd>
            {sig(measurement[name])} {MEASURED[name].unit}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
