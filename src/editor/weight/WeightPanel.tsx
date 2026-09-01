// The weight estimate, as a panel.
//
// A SCHEDULE rather than a grid: every line has a name, and formulas refer to those names. What that buys is
// visible in two places on screen — a formula that reads `hull shell.mass * ply.density` instead of `B7*B8`,
// and the sensitivity rankings, which can only say "82% of the spread comes from crew" because the cell it
// was typed in has a name to give.
//
// ---------- the panel is an editor first ----------
//
// Everything here serves authoring. A view is an editing surface with a scope on it, not a report that
// happens to be editable — which is why the standard views are the ones that replace what the typed pages
// did, at the same size and with the same chrome, and why the cleverer ones are absent. A `split` view puts
// the profile or the hull INSIDE it at full width, exactly as the points and slices pages did.
//
// ---------- three panes ----------
//
//   the explorer   every item, filed by a facet, whatever the view is scoped to
//   the view       what is being edited
//   the inspector  what the selection IS — its spread, and the geometry editor where there is geometry
//
// The inspector follows the SELECTION rather than the view, which is what lets a table of plain values have a
// third pane at all: a cell can only afford to print `= 1.24 t ± 0.09`, and where that 0.09 came from is a
// question with an answer worth several lines. Its tabs are whatever the selection can be asked — the spread
// always, and the geometry where the view holds any — and `auto` picks the one the caret is standing in.
//
// There is ONE geometry pane, not one per field kind. A position and a cut go in the same drawing: a cut is a
// plane, a plane seen edge-on is a line, and a station drawn beside the points near it says more than a hull
// in 3-D with the cut floating on it ever did — which is why that view is gone rather than moved.
//
// Nothing here computes: `evaluate.ts` evaluates the whole book from the snapshot on every render, which
// costs microseconds. The expensive half is the HULL, and that arrives already measured on the stability
// worker's payload — the same sweep that panel needs, plus one extra cut.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Area, AreaGroup, AreaSeparator } from "polymorph-ui";
import type { DocumentCommand } from "../../core/commands";
import { FUNCTIONS } from "../../core/sheet/formula";
import { HULL_METRICS, HULL_POINTS } from "../../core/hullMetrics";
import {
  findItem,
  newId,
  primaryFacet,
  type Item,
  type View,
  type WeightBook,
} from "../../core/sheet/book";
import {
  facetView,
  resolveView,
  scopeItems,
  standardViews,
  SUMMARY_VIEW,
  viewColumns,
  viewRows,
} from "../../core/sheet/views";
import { cellKey, outputResult, OUTPUT_ITEM } from "../../core/sheet/evaluate";
import { hullOutlines, spreadRegion } from "../../core/sheet/points";
import { EMPTY_GRADIENT, LENGTH } from "../../core/sheet/quantity";
import { PointViews, type Move, type PlottedPoint } from "./PointViews";
import { plotCuts, plotPoints, snapTargets } from "./pointPlots";
import { Button } from "../../components/Button";
import {
  useDocumentDispatch,
  useDocumentRuntime,
  useDocumentSnapshot,
} from "../documentStoreHooks";
import { useEditorUi } from "../editorUi";
import { useStabilityAnalysis } from "../useStabilityAnalysis";
import { useWeightBookResults } from "../useWeightBookResults";
import { Explorer, type NewItemFiling } from "./Explorer";
import {
  Inspector,
  OutputInspector,
  UsesInspector,
  type Go,
} from "./Inspector";
import { ItemTable, type Focus } from "./ItemTable";
import { ItemDetail } from "./ItemDetail";
import { Problems, Summary } from "./Summary";
import { problemItems, problemsOf } from "../../core/sheet/views";
import "./WeightPanel.css";

export function WeightPanel() {
  const snapshot = useDocumentSnapshot();
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const { perf, sampling } = useEditorUi();
  const { analysis } = useStabilityAnalysis(snapshot, perf);
  const book = snapshot.state.weights;
  const metrics = analysis?.metrics ?? null;

  // The schedule keeps one quiet, consistent reading; both interpretations are explained in the inspector.
  const reading = "worst" as const;
  const [viewId, setViewId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [sidePanel, setSidePanel] = useState<SidePanel>("auto");
  const [selectedOutput, setSelectedOutput] = useState("DISPLACEMENT");
  const [showReference, setShowReference] = useState(false);
  /** The fresh item whose detail-name field should take the caret when it opens. */
  const [newItemName, setNewItemName] = useState<string | null>(null);

  const hullSampling = sampling();
  const { measurements, results } = useWeightBookResults(
    book,
    model,
    hullSampling,
    metrics,
  );
  const send = (command: DocumentCommand) => void dispatch(command);

  const views = useMemo(() => standardViews(book), [book]);
  const view = resolveView(book, viewId);
  const items = useMemo(() => scopeItems(book, view.scope), [book, view]);
  const columns = useMemo(() => viewColumns(view, items), [view, items]);
  const rows = useMemo(() => viewRows(view, items), [view, items]);
  const problems = useMemo(
    () => problemsOf(book, results, cellKey),
    [book, results],
  );
  const flagged = useMemo(() => problemItems(problems), [problems]);

  // A drop onto a group header files the item, which only means anything when the view groups by exactly one
  // facet — with two levels there is no single answer to what a drop was aiming at.
  const groupFacet = view.groupBy.length === 1 ? view.groupBy[0] : null;

  const openItem = (itemId: string, focusName = false) => {
    setViewId(`item-${itemId}`);
    setFocus({ item: itemId, field: null, leaf: "formula" });
    setNewItemName(focusName ? itemId : null);
    setSidePanel("auto");
  };

  /**
   * Put the caret in one cell, wherever it is.
   *
   * The inspector's addresses are followed with this: a driver of a total is usually written on some other
   * item entirely, so an address that leaves the current scope opens the item it names rather than setting a
   * focus on a row that is not on screen.
   */
  const go: Go = (itemId, fieldKey, leaf) => {
    if (itemId === OUTPUT_ITEM) {
      setViewId(SUMMARY_VIEW);
      setSelectedOutput(fieldKey);
      return;
    }
    if (!items.some((item) => item.id === itemId)) openItem(itemId);
    setFocus({ item: itemId, field: fieldKey, leaf });
  };

  const createItem = (filing?: NewItemFiling) => {
    const id = newId();
    send({ type: "addItem", id, name: "", after: book.items.length - 1 });
    if (filing)
      send({
        type: "setFacet",
        item: id,
        key: filing.key,
        value: filing.value,
      });
    openItem(id, true);
  };
  const addItem = () => createItem();

  if (!book.items.length && !Object.keys(book.outputs).length)
    return (
      <div className="weightpanel">
        <div className="wempty">
          <p>This design has no weight estimate yet.</p>
          <p className="whint">
            An estimate is a list of <b>items</b> — the things the boat is made
            of — each carrying what is known about it: a mass, a position, a
            section through the hull. A formula names another item's field, as{" "}
            <code>ply.density * HULL.SHELL_AREA</code>, and how an item is{" "}
            <b>filed</b> is a separate matter that no formula mentions, so you
            can reorganise the whole estimate without rewriting a line of it.
          </p>
          <Button variant="primary" onClick={addItem}>
            Start an estimate
          </Button>
        </div>
      </div>
    );

  return (
    <div className="weightpanel">
      <div className="wpanes">
        <aside className="wsidebar">
          <Explorer
            book={book}
            flagged={flagged}
            activeItem={focus?.item ?? null}
            onOpenItem={openItem}
            onOpenField={(itemId, fieldKey) => {
              // Opening a field is opening its item with the caret already in that cell, which is what the
              // tree node means: a field is not a place of its own, it is part of a thing.
              setViewId(`item-${itemId}`);
              setFocus({ item: itemId, field: fieldKey, leaf: "formula" });
            }}
            onOpenFacet={(key, value) => {
              // The explorer's funnel: a node you were looking at becomes the view you are editing in, with
              // the same scope it drew. No view-builder to learn, because there is nothing to build.
              setViewId(facetView(key, value).id);
            }}
            onAddItem={createItem}
            send={send}
          />
        </aside>

        <div className="wmain">
          <ViewBar
            views={views}
            active={view}
            book={book}
            onPick={setViewId}
            onAddItem={addItem}
            inspectorShown={sidePanel !== "none"}
            onToggleInspector={() =>
              setSidePanel(sidePanel === "none" ? "auto" : "none")
            }
            referenceShown={showReference}
            onToggleReference={() => setShowReference((shown) => !shown)}
            problemCount={problems.length}
          />

          {showReference && <Reference book={book} />}

          <ViewBody
            {...{
              book,
              view,
              items,
              columns,
              rows,
              results,
              measurements,
              reading,
              focus,
              setFocus,
              openItem,
              onDeleteItem: (itemId: string) => {
                send({ type: "removeItem", item: itemId });
                setViewId(null);
                setFocus(null);
              },
              sidePanel,
              setSidePanel,
              selectedOutput,
              setSelectedOutput,
              newItemName,
              go,
              send,
              groupFacet,
              problems,
              model,
              hullSampling,
              metrics,
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------- the views on offer ----------

/**
 * Standard views only, for now.
 *
 * They are DERIVED — from which field kinds the book uses, which facets it uses, and what it answers — so a
 * `cost` field on three items produces a cost schedule with nothing declared anywhere, and the last one
 * deleted takes the schedule with it. Saved views, and the fork-on-edit that makes one, arrive with custom
 * columns; until then there is nothing here that could be edited into a stale copy of a generated thing.
 */
function ViewBar({
  views,
  active,
  book,
  onPick,
  onAddItem,
  inspectorShown,
  onToggleInspector,
  referenceShown,
  onToggleReference,
  problemCount,
}: {
  readonly views: readonly View[];
  readonly active: View;
  readonly book: WeightBook;
  readonly onPick: (id: string) => void;
  readonly onAddItem: () => void;
  readonly inspectorShown: boolean;
  readonly onToggleInspector: () => void;
  readonly referenceShown: boolean;
  readonly onToggleReference: () => void;
  readonly problemCount: number;
}) {
  const item =
    active.scope.k === "item" ? findItem(book, active.scope.item) : undefined;
  return (
    <div className="wviewbar" role="tablist">
      {views.map((view) => (
        <button
          key={view.id}
          role="tab"
          aria-selected={view.id === active.id}
          className={`wview${view.id === active.id ? " on" : ""}`}
          onClick={() => onPick(view.id)}
        >
          {view.name}
          {view.layout === "problems" && (
            <span
              className={`wproblembadge${problemCount ? "" : " empty"}`}
              title={
                problemCount
                  ? `${problemCount} thing${problemCount === 1 ? "" : "s"} to look at`
                  : undefined
              }
              aria-label={problemCount ? `${problemCount} problems` : undefined}
              aria-hidden={!problemCount}
            >
              {problemCount > 99 ? "99+" : problemCount}
            </span>
          )}
        </button>
      ))}
      {/* A view of one item, or of one facet value, is not on the list — there would be hundreds — so it
          appears beside it while you are in it, and leaving is clicking anything else. */}
      {active.scope.k === "item" && (
        <span className="wview on wviewad">{item?.name || "unnamed item"}</span>
      )}
      {active.scope.k === "facet" && (
        <span className="wview on wviewad">
          {active.scope.key}: {active.scope.value}
        </span>
      )}
      <span className="wspacer" />
      <button
        className="wviewtool wviewadd"
        onClick={onAddItem}
        title="Add an item"
        aria-label="Add an item"
      >
        +
      </button>
      {/* Problems has no selection for an inspector to describe. Everywhere else this is the inspector's
          only show/hide control, so opening and closing it do not compete with a second ×. */}
      {active.layout !== "problems" && (
        <button className="wviewtool" onClick={onToggleInspector}>
          {inspectorShown ? "Hide inspector" : "Show inspector"}
        </button>
      )}
      <button className="wviewtool" onClick={onToggleReference}>
        {referenceShown ? "Hide reference" : "What can I write?"}
      </button>
    </div>
  );
}

// ---------- the body, per layout ----------

interface BodyProps {
  readonly book: WeightBook;
  readonly view: View;
  readonly items: readonly Item[];
  readonly columns: ReturnType<typeof viewColumns>;
  readonly rows: ReturnType<typeof viewRows>;
  readonly results: ReturnType<typeof useWeightBookResults>["results"];
  readonly measurements: ReturnType<
    typeof useWeightBookResults
  >["measurements"];
  readonly reading: "worst" | "likely";
  readonly focus: Focus | null;
  readonly setFocus: (focus: Focus | null) => void;
  readonly openItem: (itemId: string) => void;
  readonly onDeleteItem: (itemId: string) => void;
  readonly sidePanel: SidePanel;
  readonly setSidePanel: (panel: SidePanel) => void;
  readonly selectedOutput: string;
  readonly setSelectedOutput: (name: string) => void;
  readonly newItemName: string | null;
  readonly go: Go;
  readonly send: (command: DocumentCommand) => void;
  readonly groupFacet: string | null;
  readonly problems: ReturnType<typeof problemsOf>;
  readonly model: ReturnType<typeof useDocumentRuntime>;
  readonly hullSampling: ReturnType<ReturnType<typeof useEditorUi>["sampling"]>;
  readonly metrics: unknown;
}

/**
 * What the third pane can be asked, and which of them the caret is standing in.
 *
 * `auto` is not a fourth panel — it is the rule that picks one of the other three, and it is the default
 * because the useful pane is nearly always the one the selection implies. Choosing explicitly pins it until
 * the pane is no longer on offer at all.
 */
export type SidePanel = "auto" | "spread" | "uses" | "geometry" | "none";

type Shown = "spread" | "uses" | "geometry";

const PANEL_LABEL: Record<Shown, string> = {
  spread: "Spread",
  uses: "Uses",
  geometry: "Geometry",
};

/** Keep the existing narrow-window stacking while handing both arrangements to the resizable layout. */
function useStackedWeightBody(): boolean {
  const query = "(max-width: 820px)";
  const [stacked, setStacked] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setStacked(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return stacked;
}

const WEIGHT_LAYOUT_KEY = {
  beside: "camber:weights:inspector-layout:beside",
  stacked: "camber:weights:inspector-layout:stacked",
} as const;

/** A stored resizable-panels layout, rejected rather than trusted if session data is stale or malformed. */
function storedWeightLayout(
  stacked: boolean,
): Record<string, number> | undefined {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(
        WEIGHT_LAYOUT_KEY[stacked ? "stacked" : "beside"],
      ) ?? "null",
    ) as unknown;
    if (!value || typeof value !== "object") return undefined;
    const layout = value as Record<string, unknown>;
    const view = layout["weight-view"];
    const inspector = layout["weight-inspector"];
    if (
      typeof view !== "number" ||
      !Number.isFinite(view) ||
      view <= 0 ||
      typeof inspector !== "number" ||
      !Number.isFinite(inspector) ||
      inspector <= 0
    )
      return undefined;
    return { "weight-view": view, "weight-inspector": inspector };
  } catch {
    // Storage can be unavailable in a restricted browser context; resizing should still work for this visit.
    return undefined;
  }
}

function storeWeightLayout(
  stacked: boolean,
  layout: Record<string, number>,
): void {
  try {
    sessionStorage.setItem(
      WEIGHT_LAYOUT_KEY[stacked ? "stacked" : "beside"],
      JSON.stringify(layout),
    );
  } catch {
    // Treat storage as an optional enhancement, not a requirement for using the inspector.
  }
}

function SideTabs({
  offers,
  shown,
  onPick,
}: {
  readonly offers: readonly Shown[];
  readonly shown: Shown;
  readonly onPick: (shown: Shown) => void;
}) {
  return (
    <div className="wsidetabs" role="tablist">
      {offers.map((offer) => (
        <button
          key={offer}
          role="tab"
          aria-selected={offer === shown}
          className={`wsidetab${offer === shown ? " on" : ""}`}
          onClick={() => onPick(offer)}
        >
          {PANEL_LABEL[offer]}
        </button>
      ))}
    </div>
  );
}

/**
 * The editing surface and its inspector share one user-resizable split.
 *
 * Spread and geometry deliberately receive the same default and constraints: changing the selection or the
 * inspector tab must change the answer in the pane, not move the whole schedule under the pointer.
 */
function ResizableBody({
  main,
  shown,
  side,
}: {
  readonly main: ReactNode;
  readonly shown: Shown | null;
  readonly side: ReactNode;
}) {
  const stacked = useStackedWeightBody();
  const defaultLayout = useMemo(
    () => (shown ? storedWeightLayout(stacked) : undefined),
    [shown, stacked],
  );
  return (
    <AreaGroup
      // Remount when the inspector is restored so the session layout is applied at group initialization.
      // The selected inspector tab is deliberately absent: switching its content must not change its size.
      key={`${stacked ? "stacked" : "beside"}-${shown ? "inspector" : "plain"}`}
      className="wbody"
      orientation={stacked ? "vertical" : "horizontal"}
      defaultLayout={defaultLayout}
      onLayoutChanged={(layout, meta) => {
        // Constraint changes and initial layout must not replace the size the user explicitly chose.
        if (shown && meta.isUserInteraction) storeWeightLayout(stacked, layout);
      }}
    >
      <Area
        id="weight-view"
        className="wviewpane"
        minSize={stacked ? "160px" : "450px"}
      >
        <div className="wscroll">{main}</div>
      </Area>
      {shown && (
        <>
          <AreaSeparator
            className="wsideseparator"
            aria-label="Resize inspector"
          />
          <Area
            id="weight-inspector"
            className={`wside ${shown}`}
            defaultSize={stacked ? "42%" : "380px"}
            minSize={stacked ? "180px" : "300px"}
            maxSize={stacked ? "70%" : "50%"}
            role="complementary"
            aria-label="Inspector"
          >
            {side}
          </Area>
        </>
      )}
    </AreaGroup>
  );
}

function ViewBody(props: BodyProps) {
  const { book, view, items, results, problems, openItem, send } = props;

  if (view.layout === "summary") return <SummaryBody {...props} />;

  if (view.layout === "problems")
    return (
      <div className="wscroll">
        <Problems problems={problems} onOpenItem={openItem} />
      </div>
    );

  const detail = view.layout === "detail" ? (items[0] ?? null) : null;
  if (view.layout === "detail" && !detail)
    return (
      <p className="whint wpad">
        That item is not here any more. Pick another from the explorer.
      </p>
    );

  // The geometry editor is on offer where the view holds geometry to draw — positions and cuts alike, since
  // they go in the same two projections. The spread always is: every cell has one, even where it is nothing
  // at all, and saying so is an answer.
  const fields = (detail ? [detail] : items).flatMap((item) =>
    Object.values(item.fields),
  );
  const hasGeometry = fields.some((field) => field.k !== "scalar");
  const focusedItem = props.focus
    ? items.find((item) => item.id === props.focus!.item)
    : undefined;
  const focusedField =
    focusedItem && props.focus?.field
      ? focusedItem.fields[props.focus.field]
      : undefined;
  const baseOffers: Shown[] = hasGeometry ? ["spread", "geometry"] : ["spread"];
  // Uses is a question about a particular field, not an item or a blank selection. Keep geometry in its
  // familiar position while adding the reverse-dependency view beside Spread.
  const offers: Shown[] = focusedField
    ? ["spread", "uses", ...baseOffers.filter((offer) => offer !== "spread")]
    : baseOffers;

  // The caret wins where it is in a cell: editing a coordinate or a station wants the drawing beside it,
  // editing a mass wants to know what the mass rests on. With no cell selected the view's own kind decides,
  // which is what keeps the successors to the points and slices pages opening as those pages did.
  const auto: Shown =
    focusedField && focusedField.k !== "scalar"
      ? "geometry"
      : focusedField
        ? "spread"
        : (view.layout === "split" || detail) && hasGeometry
          ? "geometry"
          : "spread";

  const shown: Shown | null =
    props.sidePanel === "none"
      ? null
      : offers.includes(props.sidePanel as Shown)
        ? (props.sidePanel as Shown)
        : offers.includes(auto)
          ? auto
          : "spread";

  return (
    <ResizableBody
      main={
        detail ? (
          <ItemDetail
            book={book}
            item={detail}
            results={results}
            measurements={props.measurements}
            reading={props.reading}
            focus={props.focus}
            autoFocusName={props.newItemName === detail.id}
            setFocus={props.setFocus}
            send={send}
            onDelete={() => props.onDeleteItem(detail.id)}
          />
        ) : (
          <ItemTable
            book={book}
            rows={props.rows}
            columns={props.columns}
            results={results}
            measurements={props.measurements}
            reading={props.reading}
            focus={props.focus}
            setFocus={props.setFocus}
            onOpenItem={openItem}
            send={send}
            groupFacet={props.groupFacet}
          />
        )
      }
      shown={shown}
      side={
        shown ? (
          <>
            <SideTabs
              offers={offers}
              shown={shown}
              onPick={props.setSidePanel}
            />
            <div className="wsidebody">
              {shown === "spread" ? (
                <Inspector
                  book={book}
                  results={results}
                  measurements={props.measurements}
                  focus={props.focus}
                  reading={props.reading}
                  onGo={props.go}
                />
              ) : shown === "uses" ? (
                <UsesInspector
                  book={book}
                  results={results}
                  focus={props.focus}
                  onGo={props.go}
                />
              ) : (
                <GeometryEditor {...props} items={detail ? [detail] : items} />
              )}
            </div>
          </>
        ) : null
      }
    />
  );
}

/** The summary uses the same table + inspector shape as every editing view. */
function SummaryBody(props: BodyProps) {
  // Geometry remains available even before both coordinates work out, so the pane can explain what is
  // missing instead of making the capability itself appear and disappear while formulas are edited.
  const offers: Shown[] = ["spread", "geometry"];
  const shown: Shown | null =
    props.sidePanel === "none"
      ? null
      : offers.includes(props.sidePanel as Shown)
        ? (props.sidePanel as Shown)
        : "spread";

  return (
    <ResizableBody
      main={
        <Summary
          book={props.book}
          results={props.results}
          reading={props.reading}
          selected={props.selectedOutput}
          onSelect={props.setSelectedOutput}
          send={props.send}
        />
      }
      shown={shown}
      side={
        shown ? (
          <>
            <SideTabs
              offers={offers}
              shown={shown}
              onPick={props.setSidePanel}
            />
            <div className="wsidebody">
              {shown === "spread" ? (
                <OutputInspector
                  book={props.book}
                  results={props.results}
                  name={props.selectedOutput}
                  reading={props.reading}
                  onGo={props.go}
                />
              ) : (
                <SummaryGeometry {...props} />
              )}
            </div>
          </>
        ) : null
      }
    />
  );
}

/** Draw the centre reported by LCG and VCG against the hull, including their joint spread. */
function SummaryGeometry(props: BodyProps) {
  const outlines = useMemo(
    () =>
      props.hullSampling ? hullOutlines(props.model, props.hullSampling) : null,
    [props.model, props.hullSampling],
  );
  const x = outputResult(props.results, "LCG");
  const z = outputResult(props.results, "VCG");
  const point = useMemo<PlottedPoint | null>(() => {
    if (!x?.reading || !z?.reading || !x.quantity || !z.quantity) return null;
    const y = { v: 0, d: EMPTY_GRADIENT, dim: LENGTH };
    return {
      id: "summary-cg",
      itemId: "OUT",
      fieldKey: "CG",
      name: "Centre of gravity",
      axes: {
        x: { value: x.reading.v, placement: null, factor: 1, empty: false },
        y: { value: 0, placement: null, factor: 1, empty: false },
        z: { value: z.reading.v, placement: null, factor: 1, empty: false },
      },
      xz: spreadRegion(
        x.quantity,
        z.quantity,
        props.results.sources,
        props.reading,
      ),
      yz: spreadRegion(y, z.quantity, props.results.sources, props.reading),
    };
  }, [x, z, props.results.sources, props.reading]);

  if (!outlines || !props.hullSampling || !point)
    return (
      <p className="whint wpad">
        LCG and VCG are needed to draw the reported centre.
      </p>
    );
  return (
    <PointViews
      model={props.model}
      sampling={props.hullSampling}
      outlines={outlines}
      points={[point]}
      cuts={[]}
      snaps={[]}
      activeId={point.id}
      reading={props.reading}
      onFocus={() => undefined}
      onMove={() => undefined}
    />
  );
}

/**
 * The hull's two projections, with everything the view holds drawn in them.
 *
 * Points and cuts share one editor because they share one drawing: a cut is a plane, a plane seen edge-on is
 * a line, and a station line beside the points near it is exactly the comparison anyone taking a section
 * wants. Selecting a station also decides where the section is cut, so picking one in the schedule shows the
 * hull where it actually falls — which was the only thing the separate 3-D view had to say.
 */
function GeometryEditor({
  book,
  items,
  results,
  measurements,
  reading,
  focus,
  setFocus,
  send,
  model,
  hullSampling,
}: BodyProps) {
  const outlines = useMemo(
    () => (hullSampling ? hullOutlines(model, hullSampling) : null),
    [model, hullSampling],
  );
  const plots = useMemo(
    () => plotPoints(items, results, reading),
    [items, results, reading],
  );
  // The cuts need the hull as well as the book: a station's attitude is the outline the hull produced, not
  // anything the schedule knows. Without a sweep they fall back to the line their position names.
  const cuts = useMemo(
    () =>
      plotCuts(items, results, reading, measurements, outlines?.frame ?? null),
    [items, results, reading, measurements, outlines],
  );
  const snaps = useMemo(() => snapTargets(book, results), [book, results]);

  /**
   * A point moved in one of the views.
   *
   * One command, however many coordinates the gesture touched: `sameGesture` tells two book edits apart by
   * their field, so a whole drag collapses into one undo step, and the three coordinates never sit
   * half-moved.
   */
  const movePoint = (id: string, move: Move) => {
    const point = plots.find((candidate) => candidate.id === id);
    if (!point) return;
    send({
      type: "setPointPosition",
      item: point.itemId,
      field: point.fieldKey,
      ...move,
    });
  };

  if (!outlines || !hullSampling)
    return (
      <p className="whint">
        The hull has not been swept yet, so there is nothing to place a point
        against. The coordinates beside this still evaluate.
      </p>
    );
  return (
    <PointViews
      model={model}
      sampling={hullSampling}
      outlines={outlines}
      points={plots}
      cuts={cuts}
      snaps={snaps}
      activeId={focus?.field ? `${focus.item} ${focus.field}` : null}
      reading={reading}
      onFocus={(id) => {
        // One id space over both, since a field key is unique within its item — so a press lands in whichever
        // of them it belongs to, and the leaf it wants is the one that kind of field has.
        const point = plots.find((candidate) => candidate.id === id);
        if (point) {
          setFocus({ item: point.itemId, field: point.fieldKey, leaf: "x" });
          return;
        }
        const cut = cuts.find((candidate) => candidate.id === id);
        if (cut)
          setFocus({ item: cut.itemId, field: cut.fieldKey, leaf: "pos" });
      }}
      onMove={movePoint}
    />
  );
}

// ---------- the reference ----------
// Built from the same tables the evaluator resolves against, so it cannot drift out of date.

function Reference({ book }: { readonly book: WeightBook }) {
  const example = book.items.find((item) => item.name) ?? null;
  const exampleKey = example ? Object.keys(example.fields)[0] : null;
  const facet = primaryFacet(book);
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
            term="area"
            hint="another field of THIS item — the scope you are in wins"
          />
          <Entry
            term={
              example && exampleKey
                ? `${example.name}.${exampleKey}`
                : "hull shell.mass"
            }
            hint="a field of another item — spaces in names are fine"
          />
          <Entry
            term="engine.cg.z"
            hint="one coordinate of another item's position"
          />
          <Entry
            term="a.mass + b.mass + c.mass"
            hint="a total is written out — groups do not add up yet"
          />
          <Entry term="OUT.DISPLACEMENT" hint="what this estimate answers" />
          <Entry term="total.mass * 7%" hint="a percentage is just ÷100" />
        </dl>
      </Section>
      <Section title="Filing">
        <dl>
          <Entry
            term={facet ? `${facet}: structure/hull` : "system: structure/hull"}
            hint="how an item is filed — a path nests, and the explorer draws the tree"
          />
          <Entry
            term="status: weighed"
            hint="a second facet cuts across the first — an item is in both"
          />
          <Entry
            term="(no formula names one)"
            hint="filing never appears in an address, so reorganising rewrites nothing"
          />
        </dl>
      </Section>
      <Section title="Positions and sections">
        <dl>
          <Entry
            term="engine.cg"
            hint="a point named bare means whichever coordinate the cell is"
          />
          <Entry
            term="2.1 ± 0.05"
            hint="a plain number can be dragged in the views; the ± rides along"
          />
          <Entry
            term="HULL.LCB + 2"
            hint="dragging moves the 2 and leaves the reference alone"
          />
          <Entry
            term="tank flat.section.pos"
            hint="sit on a cut, and follow it when the hull changes"
          />
          <Entry
            term="midship.section"
            hint="a cut bare is its centroid — weight by area for a centre of area"
          />
          <Entry
            term="midship.section.area"
            hint="also .openPerimeter, .closedPerimeter, .x, .y, .z"
          />
          <Entry
            term="HULL.SHELL_CG"
            hint="the shell's own centroid, to weigh in beside the points"
          />
          <Entry
            term="(m1 * a.cg + m2 * b.cg) / (m1 + m2)"
            hint="press ƒ on a point to state all three coordinates at once"
          />
        </dl>
      </Section>
      <Section title="The hull">
        <dl>
          {HULL_METRICS.map((spec) => (
            <Entry
              key={spec.name}
              term={`HULL.${spec.name}`}
              hint={spec.hint}
            />
          ))}
          {/* The measurements that are a place rather than a number. In a coordinate cell they name that
              coordinate, so the hull's own shell weighs into a centre of gravity beside the points. */}
          {HULL_POINTS.map((spec) => (
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
            hint="units go in the unit box beside a cell, not in the formula"
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
