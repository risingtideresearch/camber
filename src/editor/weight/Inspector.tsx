// ---------- the inspector: what one selection is worth, and what could move it ----------
//
// The third pane, and the answer to the question a table cell has no room for. A cell reads `= 1.24 t ±
// 0.09` and says nothing about where the 0.09 came from; here it is spelled out — both readings at once, the
// interval each implies, and the ranked guesses that own the spread, every one of them a link back to the
// cell it was typed in.
//
// ---------- it follows the SELECTION, not the view ----------
//
// So it works the same over a scalar, over one coordinate of a position, and over the position of a cut,
// which is why it can be the third pane of a table view that has no geometry to draw.
//
// ---------- a thing with parts leads with its parts ----------
//
// A scalar is one number and goes straight to the detail. A position and a cut are several, and there the
// pane opens on the LIST — three coordinates, or a position and everything the hull was asked about it —
// because the first question about a place is which part of it is badly known, and that is a comparison
// across rows rather than a reading of any one of them. Picking a row spells that one out underneath.
//
// ---------- nothing here computes an uncertainty ----------
//
// `read` produced every number on screen while the book was evaluated. The one exception is a cut's measured
// values, which are not cells and so have no `Reading` of their own: those are the position's own gradient
// scaled by the slope `slices.ts` measured beside the value — the identical chain rule `evaluate.ts` applies
// when a formula reads `.area`, so the ranking under a measurement names the same guesses as the ranking
// under the position it was cut at.

import { useState, type ReactElement } from "react";
import {
  findItem,
  isDerived,
  leafOf,
  leavesOf,
  type Field,
  type FieldLeaf,
  type Item,
  type WeightBook,
} from "../../core/sheet/book";
import {
  fieldUses,
  outputResult,
  resultAt,
  type BookResults,
  type CellResult,
} from "../../core/sheet/evaluate";
import {
  AREA,
  bounds,
  combine,
  EMPTY_GRADIENT,
  LENGTH,
  read,
  type Contribution,
  type Reading,
  type SourceTable,
} from "../../core/sheet/quantity";
import {
  SLICE_VALUE_FIELDS,
  sliceMeasurementKey,
  type SliceMeasurement,
  type SliceMeasurements,
  type SliceValueField,
} from "../../core/sheet/slices";
import { inUnit, pct, relative, sig, spreadText } from "./weightFormat";
import type { Focus } from "./ItemTable";

/** Put the caret in a cell — how every address in here is followed. */
export type Go = (itemId: string, fieldKey: string, leaf: FieldLeaf) => void;

export interface InspectorProps {
  readonly book: WeightBook;
  readonly results: BookResults;
  readonly measurements: SliceMeasurements;
  readonly focus: Focus | null;
  /** Which reading the rest of the panel is showing, so this can mark it as the one being quoted. */
  readonly reading: "worst" | "likely";
  readonly onGo: Go;
}

/** The same full spread reading for one of the book-level answers shown in the summary table. */
export function OutputInspector({
  book,
  results,
  name,
  reading,
  onGo,
}: Pick<InspectorProps, "book" | "results" | "reading" | "onGo"> & {
  readonly name: string;
}) {
  const result = outputResult(results, name);
  const source = book.outputs[name] ?? "";
  return (
    <div className="winspector">
      <Head address={`OUT.${name}`} kind="summary" />
      {source && <code className="winspsource">{source}</code>}
      {result?.error ? (
        <p className="winspbad">{result.error}</p>
      ) : !result?.reading || result.empty ? (
        <p className="whint">Nothing answers this value yet.</p>
      ) : (
        <>
          {result.unitWarning && (
            <p className="winspwarn">{result.unitWarning}</p>
          )}
          <Detail
            reading={result.reading}
            factor={result.unit?.factor ?? 1}
            unit={result.unit?.label ?? ""}
            which={reading}
            results={results}
            onGo={onGo}
          />
        </>
      )}
    </div>
  );
}

/** Where the selected field is named, with every address following back to its formula cell. */
export function UsesInspector({
  book,
  results,
  focus,
  onGo,
}: Pick<InspectorProps, "book" | "results" | "focus" | "onGo">) {
  const item = focus ? findItem(book, focus.item) : undefined;
  const fieldKey = focus?.field;
  const field = item && fieldKey ? item.fields[fieldKey] : undefined;
  if (!item || !fieldKey || !field)
    return (
      <p className="whint wpad">
        Put the caret in a field and this lists every formula that names it.
      </p>
    );

  const uses = fieldUses(book, results, item.id, fieldKey);
  const sourceOf = (use: (typeof uses)[number]): string => {
    if (use.itemId === "OUT") return book.outputs[use.fieldKey] ?? "";
    const user = findItem(book, use.itemId);
    const usedField = user?.fields[use.fieldKey];
    if (!usedField) return "";
    return usedField.k === "point" && isDerived(usedField)
      ? usedField.from
      : (leafOf(usedField, use.leaf) ?? "");
  };

  return (
    <div className="winspector">
      <Head address={`${item.name || "unnamed"}.${fieldKey}`} kind="uses" />
      {uses.length ? (
        <>
          <p className="whint">
            {uses.length} formula{uses.length === 1 ? "" : "s"} name this field.
            Pick one to go to it.
          </p>
          <ul className="winspuses">
            {uses.map((use) => (
              <li key={use.address}>
                <button
                  onClick={() => onGo(use.itemId, use.fieldKey, use.leaf)}
                  title="Go to this formula"
                >
                  {use.address}
                </button>
                <code>{sourceOf(use)}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="whint">
          Nothing else names this field. It can be changed or removed without
          breaking another formula.
        </p>
      )}
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  const { book, focus } = props;
  const item = focus ? findItem(book, focus.item) : undefined;

  if (!item)
    return (
      <p className="whint wpad">
        Put the caret in a cell and this says what its spread is made of — which
        guesses it rests on, and how much of the doubt each one owns.
      </p>
    );

  // The item's name is selected rather than any one of its cells. Every leaf it carries, at a glance, is the
  // useful thing to say: it is the same question asked of the whole record instead of one cell of it.
  if (!focus?.field) return <ItemSpread {...props} item={item} />;

  const field = item.fields[focus.field];
  if (!field)
    return (
      <p className="whint wpad">
        {item.name || "This item"} has nothing called {focus.field} any more.
      </p>
    );

  return (
    <CellSpread
      {...props}
      // Moving to another field resets whichever row of this one was being read: `area` is a row of THIS cut
      // and means nothing on the next one.
      key={`${item.id} ${focus.field}`}
      item={item}
      fieldKey={focus.field}
      field={field}
      // `from` is an address, not a cell: a derived point states all three coordinates through it, and the
      // spread being asked about is x's. See `leavesOf`.
      leaf={focus.leaf === "from" ? "x" : focus.leaf}
    />
  );
}

interface CellProps extends InspectorProps {
  readonly item: Item;
  readonly fieldKey: string;
  readonly field: Field;
  readonly leaf: FieldLeaf;
}

function CellSpread(props: CellProps) {
  if (props.field.k === "point") return <PointSpread {...props} />;
  if (props.field.k === "cut") return <CutSpread {...props} />;
  return (
    <div className="winspector">
      <Head
        address={`${props.item.name || "unnamed"}.${props.fieldKey}`}
        kind="scalar"
      />
      <Authored {...props} />
    </div>
  );
}

const Head = ({
  address,
  kind,
}: {
  readonly address: string;
  readonly kind: string;
}) => (
  <header className="winsphead">
    <span className="winspaddress">{address}</span>
    <span className="winspkind">{kind}</span>
  </header>
);

// ---------- a position ----------

/**
 * Three coordinates, then whichever one has the caret.
 *
 * A place is not usefully read one axis at a time: a point known to a centimetre fore-and-aft and to half a
 * metre in height is one badly-known number and two good ones, and only the three together say so. Picking
 * an axis moves the CARET rather than only this pane — the row and the cell being edited are one selection,
 * and having them disagree would be a state nobody could describe.
 */
function PointSpread(props: CellProps) {
  const { results, item, fieldKey, leaf, onGo } = props;
  const rows = (["x", "y", "z"] as const).map((axis) =>
    cellRow(
      axis,
      resultAt(results, item.id, fieldKey, axis),
      axis === leaf,
      () => onGo(item.id, fieldKey, axis),
    ),
  );
  return (
    <div className="winspector">
      <Head
        address={`${item.name || "unnamed"}.${fieldKey}.${leaf}`}
        kind="point"
      />
      <PickTable rows={rows} />
      <p className="whint">
        Two coordinates leaning on the same guess move together, which is why
        the views draw a tilted region rather than the box these three numbers
        describe.
      </p>
      <Authored {...props} />
    </div>
  );
}

// ---------- a cut ----------

/**
 * The position, then everything the hull was asked about it.
 *
 * Only the first of those is a cell. The rest were measured, which is why they appear nowhere else in the
 * panel and why picking one still has something to say: a measurement inherits the position's uncertainty
 * through the local slope, so "what does not knowing this station to ±5 cm cost me in area" is a question
 * this pane can answer and the schedule cannot.
 */
function CutSpread(props: CellProps) {
  const { results, measurements, item, fieldKey, onGo } = props;
  // Which row is being read. The position is a cell and moves the caret with it; a measurement is not, so
  // its selection lives here and nowhere else.
  const [picked, setPicked] = useState<"pos" | SliceValueField>("pos");
  const position = resultAt(results, item.id, fieldKey, "pos");
  const measurement = measurements.get(sliceMeasurementKey(item.id, fieldKey));

  const measured = (key: SliceValueField): Reading | null =>
    measurement
      ? measuredReading(position, measurement, key, results.sources)
      : null;

  const rows: PickRow[] = [
    cellRow("pos", position, picked === "pos", () => {
      setPicked("pos");
      onGo(item.id, fieldKey, "pos");
    }),
    ...SLICE_VALUE_FIELDS.map((key) => {
      const reading = measured(key);
      return {
        key,
        label: key,
        value: measurement ? measurement[key] : null,
        unit: measuredUnit(key),
        spread: reading
          ? spreadText(reading.worst.lo, reading.worst.hi, 1)
          : "",
        // Six rows each saying the cut failed would drown the one message that explains why, below.
        note: "—",
        on: picked === key,
        onPick: () => setPicked(key),
      };
    }),
  ];

  const reading = picked === "pos" ? null : measured(picked);

  return (
    <div className="winspector">
      <Head
        address={`${item.name || "unnamed"}.${fieldKey}.${picked}`}
        kind="cut"
      />
      <PickTable rows={rows} />
      {!measurement && (
        <p className="winspbad">
          This has not produced a valid hull cut — check the position.
        </p>
      )}
      {picked === "pos" ? (
        <Authored {...props} leaf="pos" />
      ) : reading ? (
        <>
          <p className="whint">
            Measured off the hull, so nothing authored it. Its spread is the
            position's, carried through the local slope — the hull is not re-cut
            at either end of the range.
          </p>
          <Detail
            reading={reading}
            factor={1}
            unit={measuredUnit(picked)}
            which={props.reading}
            results={results}
            onGo={onGo}
          />
        </>
      ) : measurement ? (
        <p className="whint">
          Nothing can move this: the position it is cut at is exact.
        </p>
      ) : null}
    </div>
  );
}

const measuredUnit = (key: SliceValueField): string =>
  key === "area" ? "m²" : "m";

/**
 * What a measured cut value is worth, uncertainty and all.
 *
 * The position's gradient scaled by the slope, then read back through the book's own source table — so the
 * ranking under `area` names the guesses that move the POSITION, which is the only thing about a cut anyone
 * can go and improve. Null where the position is exact or would not work out, since there is then no
 * gradient to scale.
 */
function measuredReading(
  position: CellResult | undefined,
  measurement: SliceMeasurement,
  key: SliceValueField,
  sources: SourceTable,
): Reading | null {
  const quantity = position?.quantity;
  if (!quantity) return null;
  return read(
    {
      v: measurement[key],
      d: combine(quantity.d, measurement.derivative[key], EMPTY_GRADIENT, 0),
      dim: key === "area" ? AREA : LENGTH,
    },
    sources,
  );
}

// ---------- the row list ----------

interface PickRow {
  readonly key: string;
  readonly label: string;
  /** Null where the row could not be worked out at all. */
  readonly value: number | null;
  readonly unit: string;
  readonly spread: string;
  /** What to say in place of a number: an error, or why there is nothing here. */
  readonly note: string | null;
  readonly on: boolean;
  readonly onPick: () => void;
}

/** One row built from an evaluated cell. */
function cellRow(
  label: string,
  result: CellResult | undefined,
  on: boolean,
  onPick: () => void,
): PickRow {
  const factor = result?.unit?.factor ?? 1;
  const reading =
    result && !result.error && !result.empty ? result.reading : null;
  return {
    key: label,
    label,
    value: reading ? inUnit(reading.v, factor) : null,
    unit: result?.unit?.label ?? "",
    spread: reading
      ? spreadText(reading.worst.lo, reading.worst.hi, factor)
      : "",
    note: result?.error ?? "nothing written yet",
    on,
    onPick,
  };
}

/**
 * The parts of a thing, one row each, worst case throughout.
 *
 * Worst rather than whichever reading the toolbar is on, because this is the COMPARISON and not the quote:
 * it is asking which of these is the one to go and measure, and that answer must not change with a toggle
 * elsewhere. The row that is picked spells both readings out underneath.
 */
function PickTable({ rows }: { readonly rows: readonly PickRow[] }) {
  return (
    <table className="winspaxes">
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            className={`winsppick${row.on ? " on" : ""}`}
            onClick={row.onPick}
            title="Read this one in full"
          >
            <th>
              {/* The keyboard's way in. The whole row takes a pointer click because that is what a pointer
                  aims at, and the button stops the event so one gesture is not counted twice. */}
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  row.onPick();
                }}
              >
                {row.label}
              </button>
            </th>
            {row.value === null ? (
              <td colSpan={2} className="winspbad">
                {row.note ?? "—"}
              </td>
            ) : (
              <>
                <td>
                  {sig(row.value)}
                  {row.unit && (
                    <span className="winsprowunit"> {row.unit}</span>
                  )}
                </td>
                <td className="winspspread">{row.spread || "exact"}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- one authored cell, in full ----------

/** The cell as it was typed, and then what it works out to. */
function Authored({
  results,
  item,
  fieldKey,
  field,
  leaf,
  reading: which,
  onGo,
}: CellProps) {
  const result = resultAt(results, item.id, fieldKey, leaf);
  // A derived point's three coordinates all come off `from`, so that is the text to echo — `leafOf` would
  // hand back the coordinates it had before the derivation, which nothing is reading.
  const source =
    field.k === "point" && isDerived(field)
      ? field.from
      : (leafOf(field, leaf) ?? "");

  return (
    <>
      {source && <code className="winspsource">{source}</code>}
      {result?.error ? (
        <p className="winspbad">{result.error}</p>
      ) : !result?.reading || result.empty ? (
        <p className="whint">
          Nothing is written here yet, so there is nothing to be uncertain
          about.
        </p>
      ) : (
        <>
          {result.unitWarning && (
            <p className="winspwarn">{result.unitWarning}</p>
          )}
          <Detail
            reading={result.reading}
            factor={result.unit?.factor ?? 1}
            unit={result.unit?.label ?? ""}
            which={which}
            results={results}
            onGo={onGo}
          />
        </>
      )}
    </>
  );
}

// ---------- one number, in full ----------

/** Everything the pane has to say about a single value, wherever that value came from. */
function Detail({
  reading,
  factor,
  unit,
  which,
  results,
  onGo,
}: {
  readonly reading: Reading;
  readonly factor: number;
  readonly unit: string;
  readonly which: "worst" | "likely";
  readonly results: BookResults;
  readonly onGo: Go;
}) {
  return (
    <>
      <div className="winspvalue">
        <span className="winspnumber">{sig(inUnit(reading.v, factor))}</span>
        {unit && <span className="winspunit">{unit}</span>}
      </div>
      <Band reading={reading} factor={factor} />
      <Readings reading={reading} factor={factor} unit={unit} which={which} />
      <section className="winspsection">
        <h4>What drives it</h4>
        <Drivers
          terms={reading.terms}
          factor={factor}
          unit={unit}
          results={results}
          onGo={onGo}
        />
      </section>
    </>
  );
}

/**
 * The two readings drawn on one axis.
 *
 * Worst is the whole track, likely the band inside it, and the gap between the two edges is the honest
 * answer the summary's prose describes — which is far easier to see as a width than to reconstruct from four
 * numbers. A value nothing can move draws nothing: an empty track would read as a spread too small to see
 * rather than as no spread at all.
 */
function Band({
  reading,
  factor,
}: {
  readonly reading: Reading;
  readonly factor: number;
}) {
  const wl = inUnit(reading.worst.lo, factor);
  const wh = inUnit(reading.worst.hi, factor);
  const span = wl + wh;
  if (!(span > 0)) return null;
  const at = (x: number): string => `${(x / span) * 100}%`;
  const ll = inUnit(reading.likely.lo, factor);
  const lh = inUnit(reading.likely.hi, factor);
  const v = inUnit(reading.v, factor);
  return (
    <div className="winspband">
      <div className="winspworst">
        <div
          className="winsplikely"
          style={{ left: at(wl - ll), width: at(ll + lh) }}
        />
        <div className="winspnominal" style={{ left: at(wl) }} />
      </div>
      <div className="winspscale">
        <span>{sig(v - wl)}</span>
        <span>{sig(v + wh)}</span>
      </div>
    </div>
  );
}

function Readings({
  reading,
  factor,
  unit,
  which,
}: {
  readonly reading: Reading;
  readonly factor: number;
  readonly unit: string;
  readonly which: "worst" | "likely";
}) {
  const row = (
    kind: "worst" | "likely",
    label: string,
    hint: string,
  ): ReactElement => {
    const span = bounds(reading, kind);
    const spread = spreadText(reading[kind].lo, reading[kind].hi, factor);
    const share = relative(reading[kind].lo, reading[kind].hi, reading.v);
    return (
      <div className={`winspreading${kind === which ? " on" : ""}`}>
        <dt title={hint}>{label}</dt>
        <dd>
          <span className="winspspread">{spread || "exact"}</span>
          {share && <span className="winsprel">{share}</span>}
          <span className="winsprange">
            {sig(inUnit(span.lo, factor))} … {sig(inUnit(span.hi, factor))}{" "}
            {unit}
          </span>
        </dd>
      </div>
    );
  };
  return (
    <dl className="winspreadings">
      {row(
        "worst",
        "Worst case",
        "Everything wrong at once, in the same direction. A bound — but a linearized one.",
      )}
      {row(
        "likely",
        "Likely",
        "Independent errors, added in quadrature. The number to quote.",
      )}
    </dl>
  );
}

// ---------- the ranking ----------

/**
 * The sensitivity list: which guesses own the spread, largest share first.
 *
 * This is what the whole gradient design exists to produce, and the reason a line item has a name — a grid
 * could only have said "B7". Shared with the summary tab, which asks the same question of the book's own
 * answer.
 *
 * A label is a BUTTON wherever the source's cell is still there, because the next thing anyone does with
 * "82% of this is the crew" is go and look at the crew.
 */
export function Drivers({
  terms,
  factor,
  unit,
  results,
  onGo,
}: {
  readonly terms: readonly Contribution[];
  readonly factor: number;
  readonly unit: string;
  readonly results: BookResults;
  readonly onGo: Go | null;
}) {
  if (!terms.length)
    return (
      <p className="whint">
        Nothing here is uncertain yet. Write a <code>±</code> on a number — type{" "}
        <code>+-</code> and it becomes one — as <code>4.2 ± 0.3</code> or{" "}
        <code>160 ± 10%</code>, and this ranks the guesses by how much of the
        spread each one owns.
      </p>
    );
  return (
    <ul className="wterms">
      {terms.map((term) => {
        // The source carries the key of the cell its `±` was typed in, so the cell it came from is a lookup
        // rather than a search — and a cell deleted since the last evaluation simply does not resolve.
        const at = term.at ? results.cells.get(term.at) : undefined;
        const reach = spreadText(term.lo, term.hi, factor);
        return (
          <li key={term.source}>
            {at && onGo ? (
              <button
                className="wtermlabel wtermgo"
                title="Go to the cell this was written in"
                onClick={() => onGo(at.itemId, at.fieldKey, at.leaf)}
              >
                {term.label}
              </button>
            ) : (
              <span className="wtermlabel">{term.label}</span>
            )}
            <span className="wtermbar">
              <span
                className="wtermfill"
                style={{ width: `${Math.max(1, term.share * 100)}%` }}
              />
            </span>
            <span className="wtermshare">{pct(term.share)}</span>
            <span className="wtermreach" title="What this one alone can do">
              {reach} {unit}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- the item, rather than one of its cells ----------

/** The item selected by name: what it carries, and how well each of it is known. */
function ItemSpread({
  results,
  item,
  onGo,
}: InspectorProps & { readonly item: Item }) {
  return (
    <div className="winspector">
      <Head address={item.name || "unnamed item"} kind="item" />
      {item.note && <p className="whint">{item.note}</p>}
      {Object.keys(item.fields).length ? (
        <>
          <ul className="winspleaves">
            {Object.entries(item.fields).flatMap(([fieldKey, field]) =>
              leavesOf(field).map((leaf) => {
                const result = resultAt(results, item.id, fieldKey, leaf);
                const factor = result?.unit?.factor ?? 1;
                return (
                  <li key={`${fieldKey} ${leaf}`}>
                    <button
                      className="winspleafname"
                      onClick={() => onGo(item.id, fieldKey, leaf)}
                    >
                      {fieldKey}
                      {field.k === "scalar" ? "" : `.${leaf}`}
                    </button>
                    {result?.error ? (
                      <span className="winspbad">{result.error}</span>
                    ) : result?.reading && !result.empty ? (
                      <>
                        <span className="winspleafvalue">
                          {sig(inUnit(result.reading.v, factor))}{" "}
                          {result.unit?.label ?? ""}
                        </span>
                        <span className="winspspread">
                          {spreadText(
                            result.reading.worst.lo,
                            result.reading.worst.hi,
                            factor,
                          )}
                        </span>
                      </>
                    ) : (
                      <span className="whint">empty</span>
                    )}
                  </li>
                );
              }),
            )}
          </ul>
          <p className="whint">
            Worst case on each. Pick one and this says what its spread is made
            of.
          </p>
        </>
      ) : (
        <p className="whint">
          This item carries nothing yet. Give it a value, a position or a
          section, and its spread appears here.
        </p>
      )}
    </div>
  );
}
