import { useMemo, useState } from "react";
import type { HullMetrics } from "../../core/hullMetrics";
import type { HullSampling } from "../../core/mesh";
import type { Model } from "../../core/model";
import {
  leavesOf,
  type SheetCommand,
  type ViewScope,
  type WeightBook,
} from "../../core/sheet/book";
import { cellKey, OUTPUT_ITEM } from "../../core/sheet/addresses";
import type { CellResult } from "../../core/sheet/evaluate";
import { OUTPUTS } from "../../core/sheet/outputs";
import { sameDim, type Dim, type Reading } from "../../core/sheet/quantity";
import { roleLeaves, roleTotals } from "../../core/sheet/rollups";
import { ROLES } from "../../core/sheet/roles";
import { resolveScenario } from "../../core/sheet/resolveScenario";
import { scenariosOf, SHARED_WORKSPACE } from "../../core/sheet/scenarios";
import { scopeItems, currentGroupMembers } from "../../core/sheet/views";
import { naturalUnit } from "../../core/sheet/units";
import { useWeightBookResults } from "../useWeightBookResults";
import { showSpread, sig } from "./weightFormat";
import type { RollupSelection } from "./FacetRollup";
import type { Focus } from "./ItemTable";
import { ScenarioGeometry } from "./ScenarioGeometry";
import { ScenarioInputs } from "./ScenarioTools";

type Value = { reading?: Reading; dim?: Dim; status?: string };
function cellValue(cell: CellResult | undefined): Value {
  if (!cell) return { status: "Not included" };
  if (cell.error || cell.unitWarning)
    return { status: cell.error ?? cell.unitWarning ?? "Error" };
  if (cell.empty) return { status: "Empty" };
  return cell.reading && cell.quantity
    ? { reading: cell.reading, dim: cell.quantity.dim }
    : { status: "Unavailable" };
}
function display(value: Value): string {
  if (value.status) return value.status;
  if (!value.reading || !value.dim) return "Unavailable";
  const unit = naturalUnit(value.dim);
  return `${sig(value.reading.v / unit.factor)} ${showSpread(value.reading, unit.factor, "worst")} ${unit.label}`;
}
function delta(a: Value, b: Value): string {
  if (
    a.status ||
    b.status ||
    !a.reading ||
    !b.reading ||
    !a.dim ||
    !b.dim ||
    !sameDim(a.dim, b.dim)
  )
    return "—";
  const unit = naturalUnit(a.dim),
    difference = b.reading.v - a.reading.v;
  return `${difference > 0 ? "+" : ""}${sig(difference / unit.factor)} ${unit.label}`;
}
interface ComparisonProps {
  readonly book: WeightBook;
  readonly active: string | null;
  readonly focus: Focus | null;
  readonly output: string | null;
  readonly scope: ViewScope;
  readonly totals?: boolean;
  readonly summary?: boolean;
  readonly rollup?: RollupSelection | null;
  readonly groupBy?: readonly string[];
  readonly model: Model;
  readonly sampling: HullSampling | null;
  readonly metrics: HullMetrics | null;
  readonly send: (command: SheetCommand) => void;
}

/** Comparison is selection-driven inspector content, never a replacement for the sheet. */
export function ScenarioComparison(props: ComparisonProps) {
  if (!scenariosOf(props.book).length)
    return (
      <section className="wscenario-inspector">
        <h3>Compare scenarios</h3>
        <p className="whint">
          You’re working in Shared. Create an alternative with{" "}
          <b>Scenario → New scenario</b>, then compare its results here.
        </p>
      </section>
    );
  return <Comparison {...props} />;
}

function Comparison({
  book,
  active,
  focus,
  output,
  scope,
  totals = false,
  summary = false,
  rollup = null,
  groupBy = [],
  model,
  sampling,
  metrics,
  send,
}: ComparisonProps) {
  const scenarios = scenariosOf(book);
  // One side is always the workspace being edited, never an independent selection.
  const current = scenarios.some((s) => s.id === active) ? active : null;
  const [other, setOther] = useState<string | null>(null);
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const aBook = useMemo(() => resolveScenario(book, current), [book, current]);
  const bBook = useMemo(() => {
    const available = scenariosOf(book);
    const desired = available.some((s) => s.id === other) ? other : null;
    const comparison =
      desired !== current ? desired : current === null ? available[0].id : null;
    return resolveScenario(book, comparison);
  }, [book, other, current]);
  const aId = aBook.scenarioContext!.id,
    bId = bBook.scenarioContext!.id;
  const a = useWeightBookResults(aBook, model, sampling, metrics);
  const b = useWeightBookResults(bBook, model, sampling, metrics);
  const choices = [{ id: SHARED_WORKSPACE, name: "Shared" }, ...scenarios];
  const aName = aBook.scenarioContext!.name,
    bName = bBook.scenarioContext!.name;
  const item = book.items.find((i) => i.id === focus?.item);
  const fieldKey =
    focus?.field && item?.fields[focus.field] ? focus.field : null;
  const geometryItems = (world: WeightBook) => {
    const scoped = scopeItems(
      world,
      item ? { k: "item", item: item.id } : scope,
    );
    return !item && rollup && rollup.key !== "all"
      ? (currentGroupMembers(scoped, groupBy, rollup.key) ?? [])
      : scoped;
  };
  const rows: { id: string; label: string; a: Value; b: Value }[] = [];
  let title: string;
  if (item) {
    title = `${item.name || "Unnamed item"}${fieldKey ? `.${fieldKey}` : ""}`;
    for (const [key, field] of Object.entries(item.fields)) {
      if (fieldKey && fieldKey !== key) continue;
      const leaves = [
        ...leavesOf(field),
        ...(field.k === "cut" || field.k === "repetition" ? ["area"] : []),
      ];
      for (const leaf of leaves)
        rows.push({
          id: `${item.id}:${key}:${leaf}`,
          label: `${key}${leaf === "formula" ? "" : `.${leaf}`}`,
          a: cellValue(a.results.cells.get(cellKey(item.id, key, leaf))),
          b: cellValue(b.results.cells.get(cellKey(item.id, key, leaf))),
        });
    }
  } else if (output || (scope.k === "all" && !totals)) {
    title = output ?? "Book outputs";
    for (const spec of OUTPUTS.filter(
      (spec) => !output || spec.name === output,
    )) {
      const value = (result: typeof a) =>
        book.outputs[spec.name]?.trim()
          ? cellValue(result.results.cells.get(cellKey(OUTPUT_ITEM, spec.name)))
          : { status: "Empty" };
      rows.push({ id: spec.name, label: spec.name, a: value(a), b: value(b) });
    }
  } else {
    title = rollup
      ? `${rollup.label}.${rollup.role}${rollup.leaf === "value" ? "" : `.${rollup.leaf}`}`
      : scope.k === "facet"
        ? `${scope.key}: ${scope.value}`
        : "View totals";
    const members = (world: WeightBook) => {
      const scoped = scopeItems(world, scope);
      return rollup && rollup.key !== "all"
        ? (currentGroupMembers(scoped, groupBy, rollup.key) ?? [])
        : scoped;
    };
    const totals = [
      roleTotals(members(aBook), a.results),
      roleTotals(members(bBook), b.results),
    ];
    for (const role of ROLES.filter(
      (role) => !rollup || role.name === rollup.role,
    ))
      for (const leaf of roleLeaves(role).filter(
        (leaf) => !rollup || leaf === rollup.leaf,
      )) {
        const value = (index: number): Value => {
          const total = totals[index].get(role.name);
          return total?.issues.length
            ? { status: total.issues.join("; ") }
            : total?.contributors && total.readings[leaf] && total.values[leaf]
              ? { reading: total.readings[leaf], dim: total.values[leaf]!.dim }
              : { status: "No contributors" };
        };
        rows.push({
          id: `${role.name}:${leaf}`,
          label: `${role.label}${leaf === "value" ? "" : `.${leaf}`}`,
          a: value(0),
          b: value(1),
        });
      }
  }
  const visible = rows.filter(
    (row) =>
      !onlyDifferences || JSON.stringify(row.a) !== JSON.stringify(row.b),
  );
  return (
    <section className="wscenario-inspector">
      <div className="wscenario-compare-pickers">
        <div className="wscenario-current" aria-label="Current workspace">
          <span>Current workspace</span>
          <strong>{aName}</strong>
        </div>
        <label>
          Compare with
          <select
            aria-label="Compare scenario"
            value={bId}
            onChange={(event) =>
              setOther(
                event.target.value === SHARED_WORKSPACE
                  ? null
                  : event.target.value,
              )
            }
          >
            {choices
              .filter((s) => s.id !== aId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <header className="wscenario-selection">
        <h3>{title}</h3>
        <small className="whint">Follows your selection in the sheet.</small>
      </header>
      {rows.length > 1 && (
        <label className="wscenario-differences">
          <input
            type="checkbox"
            checked={onlyDifferences}
            onChange={(event) => setOnlyDifferences(event.target.checked)}
          />
          Only differences
        </label>
      )}
      {(a.error || b.error) && <p role="alert">{a.error || b.error}</p>}
      {(a.pending || b.pending) && (
        <p className="whint" role="status">
          Updating geometry…
        </p>
      )}
      {!visible.length && (
        <p className="whint">
          {rows.length ? "No result differences." : "No values to compare."}
        </p>
      )}
      {visible.map((row) => (
        <section className="wscenario-result" key={row.id}>
          {(rows.length > 1 || row.label !== title) && <h4>{row.label}</h4>}
          <dl>
            <div>
              <dt>{aName}</dt>
              <dd>{a.pending ? "Updating…" : display(row.a)}</dd>
            </div>
            <div>
              <dt>{bName}</dt>
              <dd>{b.pending ? "Updating…" : display(row.b)}</dd>
            </div>
            <div className="wscenario-delta">
              <dt>Difference</dt>
              <dd>{a.pending || b.pending ? "—" : delta(row.a, row.b)}</dd>
            </div>
          </dl>
        </section>
      ))}
      <p className="whint">
        Difference = other − current. Differences are nominal; each value
        retains its own uncertainty.
      </p>
      <ScenarioGeometry
        key={
          summary
            ? "summary"
            : JSON.stringify([item?.id, fieldKey, scope, rollup?.key])
        }
        contextual={!!fieldKey && item?.fields[fieldKey].k !== "point"}
        summary={summary}
        current={{
          name: aName,
          items: geometryItems(aBook),
          results: a.results,
          pending: a.pending,
        }}
        other={{
          name: bName,
          items: geometryItems(bBook),
          results: b.results,
          pending: b.pending,
        }}
        fieldKey={
          fieldKey && item?.fields[fieldKey].k === "point" ? fieldKey : null
        }
        model={model}
        sampling={sampling}
      />
      {item && fieldKey && (
        <ScenarioInputs
          book={book}
          item={item}
          fieldKey={fieldKey}
          workspaceIds={[
            aId === SHARED_WORKSPACE ? null : aId,
            bId === SHARED_WORKSPACE ? null : bId,
          ]}
          send={send}
        />
      )}
    </section>
  );
}
