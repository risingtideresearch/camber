import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DocumentCommand } from "../core/commands";
import { FUNCTIONS } from "../core/sheet/formula";
import { HULL_METRICS } from "../core/hullMetrics";
import { type Reading } from "../core/sheet/quantity";
import {
  FIRST_SHEET_NAME,
  freeSheetName,
  isHeading,
  newId,
  outputsSheet,
  rowNamed,
  type PageKind,
  type Sheet,
  type SheetRow,
  type SliceRow,
  type WeightBook,
} from "../core/sheet/book";
import { OUTPUTS, type OutputSpec } from "../core/sheet/outputs";
import {
  sliceMeasurementKey,
  type SliceMeasurement,
} from "../core/sheet/slices";
import { resultAt, type BookResults } from "../core/sheet/evaluate";
import { Button } from "../components/Button";
import { Dropdown } from "../components/Dropdown";
import { View3d } from "../components/View3d";
import {
  useDocumentDispatch,
  useDocumentRuntime,
  useDocumentSnapshot,
} from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { useStabilityAnalysis } from "./useStabilityAnalysis";
import { useWeightBookResults } from "./useWeightBookResults";
import { AutocompleteList } from "./WeightAutocomplete";
import { useAutocomplete } from "./useAutocomplete";
import { completionsFor, type Completion } from "./weightCompletions";
import "./WeightPanel.css";

// The weight estimate, as a panel.
//
// A SCHEDULE rather than a grid: every line has a name, and formulas refer to those names. What that buys is
// visible in two places on screen — a formula that reads `hull shell * ply density` instead of `B7*B8`, and
// the sensitivity list at the bottom, which can only say "82% of the spread comes from crew" because the row
// it was typed in has a name to give.
//
// The second axis is a PAGE, not a column: a weights page, a VCG page, an LCG page, each its own list of
// items, reaching across with `Weights.hull shell`. Columns would have forced them to share a row set and a
// row order, and they do not — a VCG page has a datum row the weights page has no use for.
//
// Nothing here computes: `evaluate.ts` evaluates the whole book from the snapshot on every render, which
// costs microseconds. The expensive half is the HULL, and that arrives already measured on the stability
// worker's payload — the same sweep that panel needs, plus one extra cut.

// ---------- formatting ----------

function sig(v: number): string {
  if (!isFinite(v)) return "—";
  const mag = Math.abs(v);
  if (mag === 0) return "0";
  if (mag >= 1000) return v.toFixed(0);
  if (mag >= 100) return v.toFixed(1);
  if (mag >= 10) return v.toFixed(2);
  if (mag >= 1) return v.toFixed(3);
  return v.toPrecision(3);
}

/** A value in whatever unit the row is being shown in. */
const inUnit = (value: number, factor: number): number =>
  factor && factor !== 0 ? value / factor : value;

/** The ± beside a value: one number when the two sides agree, two when they do not. */
function showSpread(
  reading: Reading,
  factor: number,
  which: "worst" | "likely",
): string {
  const lo = inUnit(reading[which].lo, factor);
  const hi = inUnit(reading[which].hi, factor);
  if (lo === 0 && hi === 0) return "";
  if (Math.abs(lo - hi) < 1e-12 * Math.max(1, Math.abs(hi)))
    return `± ${sig(hi)}`;
  return `−${sig(lo)} / +${sig(hi)}`;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

// ---------- the panel ----------

export function WeightPanel() {
  const snapshot = useDocumentSnapshot();
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const { perf, sampling, selection, curvature, stl } = useEditorUi();
  const { analysis } = useStabilityAnalysis(snapshot, perf);
  const book = snapshot.state.weights;
  const metrics = analysis?.metrics ?? null;

  const [reading, setReading] = useState<"worst" | "likely">("worst");
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const [showReference, setShowReference] = useState(false);
  // Collapsed groups are a VIEW preference, not part of the document: two windows on one session should be
  // able to look at different parts of the same schedule, and folding a heading is not an edit anyone would
  // want in their undo history.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const hullSampling = sampling();
  const { measurements: sliceMeasurements, results } = useWeightBookResults(
    book,
    model,
    hullSampling,
    metrics,
  );
  const send = (command: DocumentCommand) => void dispatch(command);

  const sheet =
    book.sheets.find((s) => s.id === activeSheet) ?? book.sheets[0] ?? null;
  const sliceOverlay = useMemo(() => {
    if (sheet?.kind !== "slices") return null;
    return {
      activeId: focusRow,
      entries: sheet.rows.flatMap((row) => {
        if (row.kind !== "slice") return [];
        const measurement = sliceMeasurements.get(
          sliceMeasurementKey(sheet.id, row.id),
        );
        return measurement ? [{ id: row.id, measurement }] : [];
      }),
    };
  }, [focusRow, sheet, sliceMeasurements]);
  // What the toolbar's tools act on: the item the caret was last in on this page.
  const focused = sheet?.rows.find((row) => row.id === focusRow) ?? null;

  const addSheet = (name: string, kind: PageKind = "scalars") => {
    const id = newId("p");
    send({ type: "addSheet", id, name: freeSheetName(book, name), kind });
    setActiveSheet(id);
    return id;
  };

  // `group` left undefined means "inherit from the item above", which is what the reducer does with it. That
  // is what makes the add-line at the bottom of the table continue the heading it sits under, the same way
  // the + on a row does.
  const addRow = (after: number) => {
    if (!sheet) return;
    const id = newId();
    send({ type: "addSheetRow", sheet: sheet.id, id, after });
    setFocusRow(id);
  };

  /**
   * A heading is a row, added like any other. It starts empty: items join it by being moved under it, which
   * is the only way to join one — there is no "put this item in that group" command, because position
   * already says it.
   */
  const addHeading = () => {
    if (!sheet) return;
    const id = newId("h");
    send({
      type: "addSheetRow",
      sheet: sheet.id,
      id,
      after: sheet.rows.length - 1,
      kind: "heading",
      name: "New group",
    });
    setFocusRow(id);
  };

  if (!book.sheets.length)
    return (
      <div className="weightpanel">
        <div className="wempty">
          <p>This design has no weight estimate yet.</p>
          <p className="whint">
            An estimate is a page of named items. Give one a name and write what
            it weighs; a formula can refer to any other item by name — spaces
            and all — and to the hull itself, as{" "}
            <code>HULL.SHELL_AREA * ply density</code>. Add more pages for the
            centres of gravity, and reach across with{" "}
            <code>Weights.hull shell</code>.
          </p>
          <Button variant="primary" onClick={() => addSheet(FIRST_SHEET_NAME)}>
            Start an estimate
          </Button>
        </div>
      </div>
    );

  return (
    <div className="weightpanel">
      <SheetTabs
        book={book}
        active={sheet}
        onPick={setActiveSheet}
        onAdd={(kind) => addSheet(kind === "slices" ? "Slices" : "Page", kind)}
        send={send}
      />

      {/* Adding is global; belonging is positional. A heading is a row, so an item is under whichever heading
          it sits under — dragging it there IS putting it there, and there is no second control saying so. The
          outputs are a toolbar tool for the opposite reason: there are exactly three of them however long the
          schedule gets, so a menu on every row would be twenty controls expressing three facts. */}
      <div className="wtoolbar">
        <Button onClick={() => addRow((sheet?.rows.length ?? 0) - 1)}>
          Add item
        </Button>
        <Button
          onClick={() => addHeading()}
          title="Add a heading. Items belong to the heading they sit under — drag them in, or Alt+↑/↓."
        >
          Add group
        </Button>
        <span className="wsep" />
        <OutputTool book={book} sheet={sheet} row={focused} send={dispatch} />
        <span className="wsep" />
        <span className="wtoolbarlabel">Show</span>
        <div className="wtoggle">
          <button
            className={reading === "worst" ? "on" : ""}
            onClick={() => setReading("worst")}
            title="Everything wrong at once, in the same direction. A bound — but a linearized one."
          >
            Worst case
          </button>
          <button
            className={reading === "likely" ? "on" : ""}
            onClick={() => setReading("likely")}
            title="Independent errors, added in quadrature. The number to quote."
          >
            Likely
          </button>
        </div>
        <span className="wspacer" />
        <Button onClick={() => setShowReference((v) => !v)}>
          {showReference ? "Hide reference" : "What can I write?"}
        </Button>
      </div>

      {showReference && <Reference book={book} sheet={sheet} />}

      <div className={sheet?.kind === "slices" ? "wslicebody" : "wbody"}>
        <div className="wscroll">
          {sheet && (
            <SheetTable
              book={book}
              sheet={sheet}
              results={results}
              reading={reading}
              focusRow={focusRow}
              setFocusRow={setFocusRow}
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              addRow={addRow}
              send={send}
              sliceMeasurements={sliceMeasurements}
            />
          )}
        </div>
        {sheet?.kind === "slices" && (
          <div className="wslicepreview">
            <View3d
              model={model}
              sampling={hullSampling ?? undefined}
              selection={selection}
              curvature={curvature}
              stl={stl}
              title="Hull slices"
              sliceOverlay={sliceOverlay}
            />
          </div>
        )}
      </div>

      <Footer
        book={book}
        sheet={sheet}
        results={results}
        focusRow={focusRow}
        hasHull={metrics !== null}
      />
    </div>
  );
}

// ---------- the tools ----------

/**
 * How a row on the outputs page refers to a row anywhere else.
 *
 * Always page-qualified, even on a one-page book: an answer is written once and then read from a page that is
 * not the one it names, so the short form would be wrong the moment a second page appeared.
 */
const aliasFor = (sheet: Sheet, row: SheetRow): string =>
  `${sheet.name}.${row.name}`;

/** The answers a given row is behind, by being what their formula aliases. */
function rolesAliasing(
  book: WeightBook,
  sheet: Sheet,
  row: SheetRow,
): string[] {
  const page = outputsSheet(book);
  if (!page || !row.name || sheet.kind === "outputs") return [];
  const alias = aliasFor(sheet, row);
  return OUTPUTS.filter((spec) => {
    const answer = rowNamed(page, spec.name);
    return answer?.kind === "item" && answer.formula.trim() === alias;
  }).map((spec) => spec.name);
}

/**
 * Which of the estimate's answers the focused item is.
 *
 * These are what the rest of the app reads — the stability panel takes the displacement and its tolerance
 * straight off them — so they are the estimate's exports, and there are exactly as many as `OUTPUTS` names.
 *
 * The gesture is the one that was always here: a checkable item saying "this row is the displacement". What
 * it WRITES changed. There is no nomination to store any more, so ticking one adds a row to the outputs page
 * whose formula names this row, making the page if the book has none; unticking removes that row. Both are
 * ordinary book edits, which is why they undo like anything else and need no command of their own.
 */
function OutputTool({
  book,
  sheet,
  row,
  send,
}: {
  readonly book: WeightBook;
  readonly sheet: Sheet | null;
  readonly row: SheetRow | null;
  readonly send: (command: DocumentCommand) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const page = outputsSheet(book);
  // An answer refers to its row by name, so an unnamed one cannot be an answer; and the outputs page holds
  // the answers themselves, so a row sitting there has nothing to be made into one.
  const usable =
    !!sheet &&
    !!row &&
    !isHeading(row) &&
    !!row.name &&
    sheet.kind === "scalars";
  const alias = usable ? aliasFor(sheet!, row!) : "";

  const assign = async (spec: OutputSpec, mine: boolean) => {
    setOpen(false);
    if (!usable) return;
    const answer = page ? rowNamed(page, spec.name) : undefined;
    // Ticking the one that is already ours means unticking it: the answer goes, and with it the claim.
    if (mine && page && answer) {
      await send({ type: "removeSheetRow", sheet: page.id, row: answer.id });
      return;
    }
    let pageId = page?.id;
    if (!pageId) {
      pageId = newId("p");
      await send({
        type: "addSheet",
        id: pageId,
        name: freeSheetName(book, "Outputs"),
        kind: "outputs",
      });
    }
    // An answer already claimed by another row keeps its identity and changes what it points at, so the
    // formula a user may have built on top of the alias is the only thing they lose.
    let rowId = answer?.id;
    if (!rowId) {
      rowId = newId();
      await send({
        type: "addSheetRow",
        sheet: pageId,
        id: rowId,
        after: page ? page.rows.length - 1 : -1,
      });
      await send({
        type: "renameSheetRow",
        sheet: pageId,
        row: rowId,
        name: spec.name,
      });
    }
    await send({
      type: "setSheetFormula",
      sheet: pageId,
      row: rowId,
      field: "formula",
      formula: alias,
    });
  };

  return (
    <Dropdown
      label="Use as"
      open={open && usable}
      onOpenChange={setOpen}
      align="left"
      menuLabel="Outputs"
      title={
        usable
          ? `Use "${row!.name}" as the estimate's displacement, VCG or LCG`
          : row && !isHeading(row) && !row.name
            ? "Name this item first — an answer refers to it by name"
            : "Select an item first — an output names the item the caret is in"
      }
      className={usable ? "" : "wtooloff"}
    >
      <div className="dd-section">
        <div className="dd-group">This item is the estimate's</div>
        {OUTPUTS.map((spec) => {
          const answer = page ? rowNamed(page, spec.name) : undefined;
          const mine =
            answer?.kind === "item" && answer.formula.trim() === alias;
          const elsewhere =
            !mine && answer?.kind === "item" && answer.formula.trim()
              ? answer.formula.trim()
              : null;
          return (
            <button
              key={spec.name}
              className={`wmenurow${mine ? " on" : ""}`}
              title={spec.hint}
              onClick={() => void assign(spec, mine)}
            >
              {mine ? "✓ " : ""}
              {spec.label === spec.name
                ? spec.name
                : `${spec.label} — ${spec.name}`}
              {elsewhere && <span className="wmenunote">{elsewhere}</span>}
            </button>
          );
        })}
      </div>
    </Dropdown>
  );
}

// ---------- the pages ----------

function SheetTabs({
  book,
  active,
  onPick,
  onAdd,
  send,
}: {
  readonly book: WeightBook;
  readonly active: Sheet | null;
  readonly onPick: (id: string) => void;
  readonly onAdd: (kind: "scalars" | "slices") => void;
  readonly send: (command: DocumentCommand) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [addMenu, setAddMenu] = useState<{ left: number; top: number } | null>(
    null,
  );
  const addWrap = useRef<HTMLSpanElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!addMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!addWrap.current?.contains(event.target as Node)) setAddMenu(null);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenu(null);
    };
    const closeMoved = () => setAddMenu(null);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeEscape);
    window.addEventListener("scroll", closeMoved, true);
    window.addEventListener("resize", closeMoved);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeEscape);
      window.removeEventListener("scroll", closeMoved, true);
      window.removeEventListener("resize", closeMoved);
    };
  }, [addMenu]);
  return (
    <div className="wtabs" role="tablist">
      {book.sheets.map((sheet) => {
        const on = sheet.id === active?.id;
        if (renaming === sheet.id)
          return (
            <input
              key={sheet.id}
              className="wtabedit"
              defaultValue={sheet.name}
              autoFocus
              spellCheck={false}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name && name !== sheet.name)
                  send({ type: "renameSheet", sheet: sheet.id, name });
                setRenaming(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.currentTarget.value = sheet.name;
                  event.currentTarget.blur();
                }
              }}
            />
          );
        // The outputs page is not a page OF the schedule, it is what the schedule answers — so it sits apart
        // from the pages you name and reorder. It cannot be renamed from here, because `OUT.` finds it by
        // kind and its name is decoration; and it goes when its last answer does, not by a ×.
        const answers = sheet.kind === "outputs";
        return (
          <button
            key={sheet.id}
            role="tab"
            aria-selected={on}
            className={`wtab${on ? " on" : ""}${answers ? " answers" : ""}`}
            onClick={() =>
              on && !answers ? setRenaming(sheet.id) : onPick(sheet.id)
            }
            title={
              answers
                ? "What this estimate answers: the displacement, VCG and LCG the rest of the app reads"
                : on
                  ? "Click again to rename this page"
                  : sheet.name
            }
          >
            {sheet.name}
            {on && !answers && book.sheets.length > 1 && (
              <span
                className="wtabclose"
                role="button"
                aria-label={`Remove ${sheet.name}`}
                title={`Remove ${sheet.name}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  if (
                    sheet.rows.length &&
                    !confirm(
                      `Remove the page "${sheet.name}" and its ${sheet.rows.length} items?`,
                    )
                  )
                    return;
                  send({ type: "removeSheet", sheet: sheet.id });
                }}
              >
                ×
              </span>
            )}
          </button>
        );
      })}
      <span className="wtabaddwrap" ref={addWrap}>
        <button
          ref={addButton}
          className="wtabadd"
          onClick={() => {
            if (addMenu) setAddMenu(null);
            else {
              const box = addButton.current?.getBoundingClientRect();
              if (box) setAddMenu({ left: box.left, top: box.bottom + 4 });
            }
          }}
          title="Add a page"
          aria-expanded={!!addMenu}
        >
          +
        </button>
        {addMenu && (
          <span className="wtabaddmenu" style={addMenu}>
            <button
              onClick={() => {
                setAddMenu(null);
                onAdd("scalars");
              }}
            >
              <b>Calculation page</b>
              <small>Named values and formulas</small>
            </button>
            <button
              onClick={() => {
                setAddMenu(null);
                onAdd("slices");
              }}
            >
              <b>Hull slices</b>
              <small>Stations and horizontal cuts</small>
            </button>
          </span>
        )}
      </span>
    </div>
  );
}

// ---------- the table ----------

interface TableProps {
  readonly book: WeightBook;
  readonly sheet: Sheet;
  readonly results: BookResults;
  readonly reading: "worst" | "likely";
  readonly focusRow: string | null;
  readonly setFocusRow: (id: string | null) => void;
  readonly collapsed: ReadonlySet<string>;
  readonly setCollapsed: (next: ReadonlySet<string>) => void;
  readonly addRow: (after: number, group?: string) => void;
  readonly send: (command: DocumentCommand) => void;
  readonly sliceMeasurements: ReadonlyMap<string, SliceMeasurement>;
}

function SheetTable(props: TableProps) {
  const { book, sheet, reading, collapsed, setCollapsed, addRow, send } = props;

  // Where a dragged row would land. Held here rather than per row because the indicator is drawn between
  // rows and only one may be showing.
  const [drag, setDrag] = useState<{ id: string; to: number } | null>(null);

  const completions = useMemo(() => completionsFor(book, sheet), [book, sheet]);

  /**
   * Move a row.
   *
   * That is the whole of it — there is no group to also set, because a heading is a row and an item belongs
   * to whichever heading it lands under. Dragging an item into a heading's block IS putting it in that group.
   */
  const moveRow = (id: string, to: number) => {
    const from = sheet.rows.findIndex((row) => row.id === id);
    if (from < 0) return;
    // `to` is an insertion point in the ORIGINAL list; removing the row first shifts everything after it.
    const target = Math.max(
      0,
      Math.min(sheet.rows.length - 1, to > from ? to - 1 : to),
    );
    if (target !== from)
      send({ type: "moveSheetRow", sheet: sheet.id, row: id, to: target });
  };

  /** One step up or down, for the keyboard: the other way into a group, and the only one without a mouse. */
  const nudge = (id: string, delta: -1 | 1) => {
    const from = sheet.rows.findIndex((row) => row.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= sheet.rows.length) return;
    send({ type: "moveSheetRow", sheet: sheet.id, row: id, to });
  };

  // Which rows a fold hides: everything after a folded heading, up to the next heading.
  const hidden = new Set<string>();
  let folding: string | null = null;
  for (const row of sheet.rows) {
    if (row.kind === "heading") {
      folding = collapsed.has(row.id) ? row.id : null;
      continue;
    }
    if (folding) hidden.add(row.id);
  }

  const toggle = (headingId: string) => {
    const next = new Set(collapsed);
    if (next.has(headingId)) next.delete(headingId);
    else next.add(headingId);
    setCollapsed(next);
  };

  const dropHere = () => {
    if (drag) moveRow(drag.id, drag.to);
    setDrag(null);
  };

  const dragProps = (i: number) => ({
    dragging: drag?.id === sheet.rows[i].id,
    onDragStart: () => setDrag({ id: sheet.rows[i].id, to: i }),
    onDragOver: (after: boolean) =>
      setDrag((d) => (d ? { ...d, to: i + (after ? 1 : 0) } : d)),
    onDrop: dropHere,
    onDragEnd: () => setDrag(null),
    onNudge: (delta: -1 | 1) => nudge(sheet.rows[i].id, delta),
  });

  return (
    <table className="wsheet">
      <thead>
        {sheet.kind === "slices" ? (
          <tr>
            <th className="wcolname">Slice</th>
            <th className="wcolshape">Cut</th>
            <th className="wcolpos">Position</th>
            <th className="wcolsection">Area / boundary</th>
            <th className="wcolcentroid">Centroid x / y / z</th>
            <th className="wcolact" />
          </tr>
        ) : (
          <tr>
            <th className="wcolname">Item</th>
            <th className="wcolformula">Formula</th>
            <th className="wcolunit">Unit</th>
            <th className="wcolvalue">Value</th>
            <th className="wcolspread">
              {reading === "worst" ? "Worst" : "Likely"}
            </th>
            <th className="wcolact" />
          </tr>
        )}
      </thead>
      <tbody>
        {sheet.rows.map((row, i) => (
          <Fragment key={row.id}>
            {drag && drag.to === i && (
              <tr className="wdropline">
                <td colSpan={6} />
              </tr>
            )}
            {row.kind === "heading" ? (
              <HeadingRow
                sheet={sheet}
                row={row}
                count={
                  sheet.rows
                    .slice(i + 1)
                    .findIndex((r) => r.kind === "heading") === -1
                    ? sheet.rows.length - i - 1
                    : sheet.rows
                        .slice(i + 1)
                        .findIndex((r) => r.kind === "heading")
                }
                folded={collapsed.has(row.id)}
                onToggle={() => toggle(row.id)}
                send={send}
                {...dragProps(i)}
              />
            ) : (
              !hidden.has(row.id) &&
              (row.kind === "slice" ? (
                <SliceRowView
                  {...props}
                  row={row}
                  index={i}
                  completions={completions}
                  {...dragProps(i)}
                />
              ) : (
                <Row
                  {...props}
                  row={row}
                  index={i}
                  completions={completions}
                  {...dragProps(i)}
                />
              ))
            )}
          </Fragment>
        ))}
        {drag && drag.to >= sheet.rows.length && (
          <tr className="wdropline">
            <td colSpan={6} />
          </tr>
        )}
        {/* The last line of the table is an invitation, not a button somewhere else: a schedule is written
            straight down, and reaching back to a toolbar between every item would break that rhythm. */}
        <tr
          className="waddrow"
          onClick={() => addRow(sheet.rows.length - 1)}
          onDragOver={(event) => {
            if (!drag) return;
            event.preventDefault();
            setDrag({ ...drag, to: sheet.rows.length });
          }}
          onDrop={dropHere}
        >
          <td colSpan={6}>
            <span className="waddmark">+</span>
            {sheet.rows.length ? "Add an item" : "Add the first item"}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * A heading, which is an ordinary row with a name and nothing else.
 *
 * It drags like any other row — moving one re-groups whatever falls between it and the next heading, which is
 * visible the moment it lands and is exactly what dragging a heading should mean.
 */
function HeadingRow({
  sheet,
  row,
  count,
  folded,
  onToggle,
  send,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onNudge,
}: {
  readonly sheet: Sheet;
  readonly row: SheetRow;
  readonly count: number;
  readonly folded: boolean;
  readonly onToggle: () => void;
  readonly send: (command: DocumentCommand) => void;
  readonly dragging: boolean;
  readonly onDragStart: () => void;
  readonly onDragOver: (after: boolean) => void;
  readonly onDrop: () => void;
  readonly onDragEnd: () => void;
  readonly onNudge: (delta: -1 | 1) => void;
}) {
  return (
    <tr
      className={`wgrouphead${folded ? " folded" : ""}${dragging ? " dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        onDragOver(event.clientY > box.top + box.height / 2);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onKeyDown={(event) => {
        if (!event.altKey) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onNudge(-1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onNudge(1);
        }
      }}
    >
      {/* The flex row goes INSIDE the cell, not on it: `display: flex` on a `<td>` takes it out of table
          layout, `colSpan` stops applying, and the cell shrinks to its content — leaving most of the row
          with nothing in it to catch a drop. */}
      <td colSpan={6}>
        <div className="wgroupbar">
          <Grip
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            rowId={row.id}
          />
          <button
            className="wfold"
            onClick={onToggle}
            aria-expanded={!folded}
            title={folded ? "Show these items" : "Hide these items"}
          >
            {folded ? "▸" : "▾"}
          </button>
          <input
            className="wgroupname"
            defaultValue={row.name}
            key={row.name}
            spellCheck={false}
            aria-label="Heading"
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name !== row.name)
                send({
                  type: "renameSheetRow",
                  sheet: sheet.id,
                  row: row.id,
                  name,
                });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = row.name;
                event.currentTarget.blur();
              }
            }}
          />
          <span className="wgroupcount">
            {count} item{count === 1 ? "" : "s"}
            {folded ? ", hidden" : ""}
          </span>
          <button
            className="wremove wgroupremove"
            title="Remove this heading. The items under it stay, and join whatever heading is above."
            onClick={() =>
              send({ type: "removeSheetRow", sheet: sheet.id, row: row.id })
            }
          >
            ×
          </button>
        </div>
      </td>
    </tr>
  );
}

/** The drag handle, shared by items and headings. */
function Grip({
  onDragStart,
  onDragEnd,
  rowId,
}: {
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly rowId: string;
}) {
  return (
    <span
      className="wdrag"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        // Firefox refuses to start a drag without payload, and the id is the useful thing to carry.
        event.dataTransfer.setData("text/plain", rowId);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      title="Drag to reorder — or Alt+↑/↓ from any field in this row"
      aria-hidden="true"
    >
      {/* Two columns of four on a square 4px pitch: the proportions a grip is expected to have. The size is
          stated in CSS as well as here because the editor sets `svg { width: 100% }` app-wide. */}
      <svg viewBox="0 0 6 16" width="6" height="16" aria-hidden="true">
        {[2, 6, 10, 14].map((y) => (
          <Fragment key={y}>
            <circle cx="1" cy={y} r="1" />
            <circle cx="5" cy={y} r="1" />
          </Fragment>
        ))}
      </svg>
    </span>
  );
}

interface RowProps extends TableProps {
  readonly row: SheetRow;
  readonly index: number;
  readonly completions: readonly Completion[];
  readonly dragging: boolean;
  readonly onDragStart: () => void;
  /** True when the pointer is in the lower half of the row, so the drop goes after it. */
  readonly onDragOver: (after: boolean) => void;
  readonly onDrop: () => void;
  readonly onDragEnd: () => void;
  readonly onNudge: (delta: -1 | 1) => void;
}

function SliceRowView({
  sheet,
  row,
  index,
  results,
  focusRow,
  setFocusRow,
  addRow,
  send,
  completions,
  sliceMeasurements,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onNudge,
}: Omit<RowProps, "row"> & { readonly row: SliceRow }) {
  const position = resultAt(results, sheet.id, row.id, "pos");
  const measured = sliceMeasurements.get(sliceMeasurementKey(sheet.id, row.id));
  const focused = focusRow === row.id;
  const values = measured
    ? `${sig(measured.area)} m² / ${sig(measured.openPerimeter)} m open / ${sig(measured.closedPerimeter)} m closed`
    : "—";
  const centroid = measured
    ? `${sig(measured.x)} / ${sig(measured.y)} / ${sig(measured.z)} m`
    : "—";
  const unphysicalLinearBound =
    measured &&
    position?.reading &&
    (["area", "openPerimeter", "closedPerimeter"] as const).some((field) => {
      const slope = measured.derivative[field];
      const downward =
        slope >= 0
          ? slope * position.reading!.worst.lo
          : -slope * position.reading!.worst.hi;
      return downward > measured[field];
    });
  return (
    <tr
      className={`wrow wslicerow${focused ? " focused" : ""}${dragging ? " dragging" : ""}`}
      onClick={() => setFocusRow(row.id)}
      onDragOver={(event) => {
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        onDragOver(event.clientY > box.top + box.height / 2);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onKeyDown={(event) => {
        if (!event.altKey) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onNudge(-1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onNudge(1);
        }
      }}
    >
      <td className="wcolname">
        <Grip onDragStart={onDragStart} onDragEnd={onDragEnd} rowId={row.id} />
        <Field
          value={row.name}
          placeholder="name"
          className="wname"
          onCommit={(name) =>
            send({ type: "renameSheetRow", sheet: sheet.id, row: row.id, name })
          }
          onFocus={() => setFocusRow(row.id)}
        />
      </td>
      <td className="wcolshape">
        <select
          value={row.shape}
          aria-label="Cut shape"
          onChange={(event) =>
            send({
              type: "setSliceShape",
              sheet: sheet.id,
              row: row.id,
              shape: event.target.value as SliceRow["shape"],
            })
          }
        >
          <option value="station">Station</option>
          <option value="plane">Horizontal</option>
        </select>
      </td>
      <td className="wcolpos">
        <FormulaField
          value={row.pos}
          error={position?.error ?? null}
          completions={completions}
          onCommit={(formula) =>
            send({
              type: "setSheetFormula",
              sheet: sheet.id,
              row: row.id,
              field: "pos",
              formula,
            })
          }
          onFocus={() => setFocusRow(row.id)}
        />
        <Field
          value={row.unit}
          placeholder={position?.unit?.label ?? "m"}
          className={`wpositionunit${position?.unitIsDerived ? " derived" : ""}`}
          title={position?.unitWarning ?? "Position unit"}
          onCommit={(unit) =>
            send({ type: "setSheetUnit", sheet: sheet.id, row: row.id, unit })
          }
          onFocus={() => setFocusRow(row.id)}
        />
      </td>
      <td className={!measured && row.pos ? "wcolsection bad" : "wcolsection"}>
        {values}
        {unphysicalLinearBound && (
          <span
            className="wwarn"
            title="The first-order uncertainty reaches below zero for this cut. Geometry is linearized at the nominal position; reduce the position spread or inspect its end cuts before using the worst-case extent."
          >
            !
          </span>
        )}
      </td>
      <td className="wcolcentroid">{centroid}</td>
      <td className="wcolact">
        <button
          title="Add a slice below this one"
          onClick={() => addRow(index)}
        >
          +
        </button>
        <button
          className="wremove"
          title="Remove this slice"
          onClick={() =>
            send({ type: "removeSheetRow", sheet: sheet.id, row: row.id })
          }
        >
          ×
        </button>
      </td>
    </tr>
  );
}

function Row({
  book,
  sheet,
  row,
  index,
  results,
  reading,
  focusRow,
  setFocusRow,
  addRow,
  send,
  completions,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onNudge,
}: RowProps) {
  const result = resultAt(results, sheet.id, row.id);
  // Which of the book's answers this row is behind. Read off the outputs page rather than from a stored
  // nomination — an answer is a row whose formula points here, so the badge follows the formula.
  const roles = isHeading(row) ? [] : rolesAliasing(book, sheet, row);
  const focused = focusRow === row.id;
  const factor = result?.unit?.factor ?? 1;

  return (
    <tr
      className={`wrow${focused ? " focused" : ""}${roles.length ? " output" : ""}${dragging ? " dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        onDragOver(event.clientY > box.top + box.height / 2);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      // Alt+↑/↓ moves the item without a mouse. Dragging is the discoverable way; this is the fast one, and
      // the only one available from the keyboard at all.
      onKeyDown={(event) => {
        if (!event.altKey) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onNudge(-1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onNudge(1);
        }
      }}
    >
      <td className="wcolname">
        <Grip onDragStart={onDragStart} onDragEnd={onDragEnd} rowId={row.id} />
        <Field
          value={row.name}
          placeholder="name"
          className="wname"
          onCommit={(name) =>
            send({ type: "renameSheetRow", sheet: sheet.id, row: row.id, name })
          }
          onFocus={() => setFocusRow(row.id)}
        />
      </td>
      <td className="wcolformula">
        <FormulaField
          value={row.kind === "item" ? row.formula : ""}
          error={result?.error ?? null}
          completions={completions}
          onCommit={(formula) =>
            send({
              type: "setSheetFormula",
              sheet: sheet.id,
              row: row.id,
              field: "formula",
              formula,
            })
          }
          onFocus={() => setFocusRow(row.id)}
        />
      </td>
      <td className="wcolunit">
        <Field
          value={row.kind === "item" || row.kind === "point" ? row.unit : ""}
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
              : undefined)
          }
          onCommit={(unit) =>
            send({ type: "setSheetUnit", sheet: sheet.id, row: row.id, unit })
          }
          onFocus={() => setFocusRow(row.id)}
        />
      </td>
      {!result || result.empty ? (
        <>
          <td className="wcolvalue" />
          <td className="wcolspread" />
        </>
      ) : result.error ? (
        <td className="wcolvalue bad" colSpan={2} title={result.error}>
          {result.error}
        </td>
      ) : (
        <>
          <td className="wcolvalue">
            {sig(inUnit(result.reading!.v, factor))}
            {result.unitWarning && (
              <span className="wwarn" title={result.unitWarning}>
                !
              </span>
            )}
          </td>
          <td className="wcolspread">
            {showSpread(result.reading!, factor, reading)}
          </td>
        </>
      )}
      <td className="wcolact">
        {/* What this item is TO the rest of the app, shown but not set here: the outputs are a toolbar tool,
            and its heading is simply where it sits. A row carries the marks it has earned rather than the
            controls that set them. */}
        {roles.map((role) => (
          <span key={role} className={`wrole r-${role.toLowerCase()}`}>
            {role === "DISPLACEMENT" ? "∆" : role}
          </span>
        ))}
        <button
          className="wadd"
          title="Add an item below this one"
          onClick={() => addRow(index)}
        >
          +
        </button>
        <button
          className="wremove"
          title="Remove this item"
          onClick={() =>
            send({ type: "removeSheetRow", sheet: sheet.id, row: row.id })
          }
        >
          ×
        </button>
      </td>
    </tr>
  );
}

// ---------- edit-on-blur fields ----------
//
// The store is authoritative and every keystroke would otherwise be a command, so a field holds its own draft
// while it has the caret and commits on blur or Enter. Escape puts back what the document says, which is the
// only way to abandon a half-typed formula without leaving it in the history.

function Field({
  value,
  placeholder,
  className,
  title,
  onCommit,
  onFocus,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly className?: string;
  readonly title?: string;
  readonly onCommit: (value: string) => void;
  readonly onFocus?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  return (
    <input
      ref={input}
      className={className}
      value={draft ?? value}
      placeholder={placeholder}
      title={title}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={onFocus}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") input.current?.blur();
        else if (event.key === "Escape") {
          setDraft(null);
          input.current?.blur();
        }
      }}
    />
  );
}

/**
 * The formula field: the same edit-on-blur contract, plus the two things a formula wants.
 *
 * `+-` becomes `±` as it is typed, because the real character is a nuisance on most keyboards and the
 * substitution is exact — the lexer already treats them as the same token, so nothing changes meaning; it
 * just stops looking like a workaround.
 */
function FormulaField({
  value,
  error,
  completions,
  onCommit,
  onFocus,
}: {
  readonly value: string;
  readonly error: string | null;
  readonly completions: readonly Completion[];
  readonly onCommit: (value: string) => void;
  readonly onFocus?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { suggest, active, setActive, refresh, close } =
    useAutocomplete(completions);
  const shown = draft ?? value;

  const setAll = (text: string, caret: number) => {
    setDraft(text);
    refresh(text, caret);
    // The caret has to be restored after React writes the value back, or typing `+-` would jump it to the end.
    requestAnimationFrame(() => {
      input.current?.setSelectionRange(caret, caret);
    });
  };

  const pick = (item: Completion) => {
    if (!suggest) return;
    const before = shown.slice(0, suggest.from);
    const after = shown.slice(input.current?.selectionStart ?? shown.length);
    const text = before + item.insert + after;
    setDraft(text);
    close();
    const caret = before.length + item.insert.length;
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
    });
  };

  return (
    <span className="wformulawrap">
      <input
        ref={input}
        className={`wformula${error ? " bad" : ""}`}
        value={shown}
        placeholder="—"
        title={error ?? undefined}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          const raw = event.target.value;
          const caret = event.target.selectionStart ?? raw.length;
          // Substitute as typed. The replacement is one character shorter, so the caret moves back by one
          // for each substitution that happened before it.
          const upTo = raw.slice(0, caret);
          const text = raw.replace(/\+-/g, "±");
          const shift = (upTo.match(/\+-/g)?.length ?? 0) * 1;
          setAll(text, caret - shift);
        }}
        onFocus={(event) => {
          onFocus?.();
          refresh(event.target.value, event.target.selectionStart ?? 0);
        }}
        onClick={(event) =>
          refresh(
            event.currentTarget.value,
            event.currentTarget.selectionStart ?? 0,
          )
        }
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft);
          setDraft(null);
          close();
        }}
        onKeyDown={(event) => {
          if (suggest) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((active + 1) % suggest.items.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                (active - 1 + suggest.items.length) % suggest.items.length,
              );
              return;
            }
            if (event.key === "Tab" || (event.key === "Enter" && suggest)) {
              event.preventDefault();
              pick(suggest.items[active]);
              return;
            }
          }
          if (event.key === "Enter") input.current?.blur();
          else if (event.key === "Escape") {
            if (suggest) close();
            else {
              setDraft(null);
              input.current?.blur();
            }
          } else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
            close();
        }}
      />
      {suggest && (
        <AutocompleteList suggest={suggest} active={active} onPick={pick} />
      )}
    </span>
  );
}

// ---------- what drives the spread ----------

function Footer({
  book,
  sheet,
  results,
  focusRow,
  hasHull,
}: {
  readonly book: WeightBook;
  readonly sheet: Sheet | null;
  readonly results: BookResults;
  readonly focusRow: string | null;
  readonly hasHull: boolean;
}) {
  const output = results.outputs.displacement;
  // The row on the outputs page that answers the displacement, and how it fared. Where it exists but has no
  // value, the footer says so rather than falling back to whatever the caret happens to be in.
  const outputsPage = outputsSheet(book);
  const nominatedRow = outputsPage
    ? (rowNamed(outputsPage, "DISPLACEMENT") ?? null)
    : null;
  const nominatedResult = nominatedRow
    ? resultAt(results, outputsPage!.id, nominatedRow.id)
    : undefined;

  const focused =
    sheet && focusRow ? resultAt(results, sheet.id, focusRow) : undefined;
  const subject = output ?? focused?.reading ?? null;
  const subjectName = output
    ? "the estimated displacement"
    : (sheet?.rows.find((r) => r.id === focusRow)?.name ?? "this item");

  const vcg = results.outputs.vcg;
  const lcg = results.outputs.lcg;

  return (
    <div className="wfooter">
      <div className="wsensitivity">
        <div className="wfootertitle">
          What drives the spread in {subjectName}
        </div>
        {!subject || subject.terms.length === 0 ? (
          <p className="whint">
            Nothing here is uncertain yet. Write a <code>±</code> on a number —
            type <code>+-</code> and it becomes one — as <code>4.2 ± 0.3</code>{" "}
            or <code>160 ± 10%</code>, and this ranks the guesses by how much of
            the answer's spread each one owns.
          </p>
        ) : (
          <ul className="wterms">
            {subject.terms.map((term) => (
              <li key={term.source}>
                <span className="wtermlabel">{term.label}</span>
                <span className="wtermbar">
                  <span
                    className="wtermfill"
                    style={{ width: `${Math.max(1, term.share * 100)}%` }}
                  />
                </span>
                <span className="wtermshare">{pct(term.share)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="wsummary">
        {output ? (
          <>
            <div className="wsummarylabel">Estimated displacement</div>
            <div className="wsummaryvalue">
              {sig(output.v / 1000)} <span className="wsummaryunit">t</span>
            </div>
            <div className="wsummaryspread">
              worst {showSpread(output, 1000, "worst")} · likely{" "}
              {showSpread(output, 1000, "likely")} t
            </div>
            {(vcg || lcg) && (
              <div className="wsummarycg">
                {vcg && (
                  <span>
                    VCG <b>{sig(vcg.v)}</b> m {showSpread(vcg, 1, "worst")}
                  </span>
                )}
                {lcg && (
                  <span>
                    LCG <b>{sig(lcg.v)}</b> m {showSpread(lcg, 1, "worst")}
                  </span>
                )}
              </div>
            )}
            <p className="whint">
              The gap between worst and likely is the honest answer. Worst
              assumes every guess errs the same way; likely assumes they are
              independent. Real estimating bias sits between them, and no
              arithmetic settles where.
            </p>
          </>
        ) : nominatedRow ? (
          <>
            <div className="wsummarylabel">Displacement unavailable</div>
            <p className="whint">
              <code>{nominatedRow.name}</code> is the estimated displacement,
              but it{" "}
              {nominatedResult?.empty
                ? "has nothing in it yet"
                : `cannot be worked out: ${nominatedResult?.error ?? "it did not evaluate"}`}
              .
            </p>
          </>
        ) : (
          <>
            <div className="wsummarylabel">No displacement chosen</div>
            <p className="whint">
              Mark an item with <span className="wkey">∆</span> to nominate it
              as the estimated displacement. The stability panel reads it from
              there, tolerance and all — and can follow it live.
            </p>
          </>
        )}
        {!hasHull && (
          <p className="wnote">
            The hull has not been measured — <code>HULL.*</code> will not
            resolve until it floats at its own waterline.
          </p>
        )}
        <p className="wnote">
          Measured at the current design waterline. Displacement sets the
          waterline, which sets the wetted area, which feeds the shell weight —
          this does not yet chase that loop.
        </p>
      </div>
    </div>
  );
}

// ---------- the reference ----------
// Built from the same tables the evaluator resolves against, so it cannot drift out of date.

function Reference({
  book,
  sheet,
}: {
  readonly book: WeightBook;
  readonly sheet: Sheet | null;
}) {
  const others = book.sheets.filter((s) => s.id !== sheet?.id);
  return (
    <div className="wreference">
      <Section title="Uncertainty">
        <dl>
          <Entry term="4.2 ± 0.3" hint="give or take 0.3 — type +- for the ±" />
          <Entry term="160 ± 10%" hint="give or take a tenth of 160" />
          <Entry
            term="900 ± [50, 200]"
            hint="50 below, 200 above — a one-sided guess"
          />
          <Entry term="[4.0, 4.5]" hint="somewhere in that range" />
        </dl>
      </Section>
      <Section title="Names">
        <dl>
          <Entry
            term="hull shell"
            hint="an item on this page — spaces are fine"
          />
          <Entry
            term="a + b + c"
            hint="a total is written out — headings do not add up"
          />
          {others.length ? (
            others
              .slice(0, 3)
              .map((other) => (
                <Entry
                  key={other.id}
                  term={`${other.name}.item`}
                  hint={`an item on ${other.name}`}
                />
              ))
          ) : (
            <Entry term="Page.item" hint="an item on another page" />
          )}
          <Entry term="total * 7%" hint="a percentage is just ÷100" />
        </dl>
      </Section>
      {sheet?.kind === "slices" && (
        <Section title="Slice results">
          <dl>
            <Entry term="slice.pos" hint="the cut position, in metres" />
            <Entry term="slice.area" hint="enclosed section area" />
            <Entry
              term="slice.openPerimeter"
              hint="hull-skin perimeter without closing segments"
            />
            <Entry
              term="slice.closedPerimeter"
              hint="complete perimeter including closing segments"
            />
            <Entry term="slice.x / .y / .z" hint="centroid coordinates" />
          </dl>
        </Section>
      )}
      <Section title="The hull">
        <dl>
          {HULL_METRICS.map((spec) => (
            <Entry
              key={spec.name}
              term={`HULL.${spec.name}`}
              hint={spec.hint}
            />
          ))}
        </dl>
      </Section>
      <Section title="Functions and units">
        <dl>
          {Object.entries(FUNCTIONS).map(([name, spec]) => (
            <Entry key={name} term={name} hint={spec.hint} />
          ))}
          <Entry
            term="kg · t · m · m2 · kg/m2"
            hint="units go in the Unit column, not the formula"
          />
        </dl>
      </Section>
    </div>
  );
}

const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <section className="wrefsection">
    <h3>{title}</h3>
    {children}
  </section>
);

const Entry = ({
  term,
  hint,
}: {
  readonly term: string;
  readonly hint: string;
}) => (
  <>
    <dt>{term}</dt>
    <dd>{hint}</dd>
  </>
);
